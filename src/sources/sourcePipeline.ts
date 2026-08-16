export type SourceStatus = "ok" | "empty" | "timeout" | "error" | "circuit-open"

export type SourceTask<T> = {
  id: string
  run: (signal: AbortSignal) => Promise<T>
}

export type SourceDiagnostic = {
  sourceId: string
  status: SourceStatus
  latencyMs: number
  message?: string
}

export type SourcePipelineResult<T> = {
  values: Array<{ sourceId: string; value: T }>
  diagnostics: SourceDiagnostic[]
  degraded: boolean
}

export type SourcePipelineOptions = {
  timeoutMs: number
  maxConcurrency: number
  failureThreshold?: number
  cooldownMs?: number
  maxHealthEntries?: number
  now?: () => number
}

export type SourceRunOptions<T> = {
  quorum?: (values: ReadonlyArray<{ sourceId: string; value: T }>) => boolean
  onLateValue?: (value: { sourceId: string; value: T }) => void
  foregroundDeadlineMs?: number
}

type SourceHealth = {
  consecutiveFailures: number
  openUntil: number
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message.slice(0, 160)
  return "Source request failed"
}

const isEmpty = (value: unknown): boolean => Array.isArray(value) && value.length === 0

export class SourcePipeline {
  private readonly health = new Map<string, SourceHealth>()
  private activeTasks = 0
  private readonly capacityWaiters: Array<{
    signal: AbortSignal
    resolve: (acquired: boolean) => void
  }> = []
  private readonly timeoutMs: number
  private readonly maxConcurrency: number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly maxHealthEntries: number
  private readonly now: () => number

  constructor(options: SourcePipelineOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs)
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency))
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 2)
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 60_000)
    this.maxHealthEntries = Math.max(1, Math.floor(options.maxHealthEntries ?? 64))
    this.now = options.now ?? Date.now
  }

  get healthEntryCount(): number {
    return this.health.size
  }

  reset(): void {
    this.health.clear()
  }

  private readHealth(id: string): SourceHealth {
    const health = this.health.get(id)
    if (!health) return { consecutiveFailures: 0, openUntil: 0 }
    this.health.delete(id)
    this.health.set(id, health)
    return health
  }

  private rememberHealth(id: string, health: SourceHealth): void {
    this.health.delete(id)
    this.health.set(id, health)
    while (this.health.size > this.maxHealthEntries) {
      const oldest = this.health.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.health.delete(oldest)
    }
  }

  private async acquireCapacity(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    if (this.activeTasks < this.maxConcurrency) {
      this.activeTasks += 1
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const waiter = { signal, resolve }
      const cancel = () => {
        const index = this.capacityWaiters.indexOf(waiter)
        if (index >= 0) this.capacityWaiters.splice(index, 1)
        resolve(false)
      }
      signal.addEventListener("abort", cancel, { once: true })
      waiter.resolve = (acquired) => {
        signal.removeEventListener("abort", cancel)
        resolve(acquired)
      }
      this.capacityWaiters.push(waiter)
    })
  }

  private releaseCapacity(): void {
    while (this.capacityWaiters.length > 0) {
      const next = this.capacityWaiters.shift()!
      if (next.signal.aborted) continue
      next.resolve(true)
      return
    }
    this.activeTasks = Math.max(0, this.activeTasks - 1)
  }

  async run<T>(
    tasks: SourceTask<T>[],
    options: SourceRunOptions<T> = {}
  ): Promise<SourcePipelineResult<T>> {
    const values: Array<{ sourceId: string; value: T }> = []
    const diagnostics: SourceDiagnostic[] = new Array(tasks.length)
    let nextIndex = 0
    let foregroundResolved = false
    const pendingLaunches = new AbortController()
    let resolveForeground: ((result: SourcePipelineResult<T>) => void) | null = null
    let foregroundTimer: ReturnType<typeof setTimeout> | null = null

    const snapshotResult = (): SourcePipelineResult<T> => ({
      values: [...values],
      diagnostics: diagnostics.filter((diagnostic): diagnostic is SourceDiagnostic => Boolean(diagnostic)),
      degraded: diagnostics.some((diagnostic) => Boolean(diagnostic) && diagnostic.status !== "ok"),
    })

    const finishForeground = () => {
      if (foregroundResolved) return
      foregroundResolved = true
      pendingLaunches.abort()
      if (foregroundTimer) clearTimeout(foregroundTimer)
      resolveForeground?.(snapshotResult())
    }

    const maybeResolveQuorum = () => {
      if (!options.quorum?.(values)) return
      finishForeground()
    }

    const worker = async () => {
      while (nextIndex < tasks.length && !foregroundResolved) {
        const index = nextIndex
        nextIndex += 1
        const task = tasks[index]
        const health = this.readHealth(task.id)
        const startedAt = this.now()

        if (health.openUntil > startedAt) {
          diagnostics[index] = {
            sourceId: task.id,
            status: "circuit-open",
            latencyMs: 0,
          }
          continue
        }

        const acquired = await this.acquireCapacity(pendingLaunches.signal)
        if (!acquired) break
        if (foregroundResolved) {
          this.releaseCapacity()
          break
        }
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined

        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new DOMException("Source request timed out", "TimeoutError"))
            }, this.timeoutMs)
          })
          const value = await Promise.race([task.run(controller.signal), timeout])
          const status: SourceStatus = isEmpty(value) ? "empty" : "ok"
          diagnostics[index] = {
            sourceId: task.id,
            status,
            latencyMs: Math.max(0, this.now() - startedAt),
          }
          const resultValue = { sourceId: task.id, value }
          if (foregroundResolved) options.onLateValue?.(resultValue)
          else {
            values.push(resultValue)
            maybeResolveQuorum()
          }
          this.rememberHealth(task.id, { consecutiveFailures: 0, openUntil: 0 })
        } catch (error) {
          const timedOut =
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "TimeoutError")
          const failures = health.consecutiveFailures + 1
          this.rememberHealth(task.id, {
            consecutiveFailures: failures,
            openUntil: failures >= this.failureThreshold ? this.now() + this.cooldownMs : 0,
          })
          diagnostics[index] = {
            sourceId: task.id,
            status: timedOut ? "timeout" : "error",
            latencyMs: Math.max(0, this.now() - startedAt),
            message: timedOut ? "Source timed out" : errorMessage(error),
          }
        } finally {
          if (timer) clearTimeout(timer)
          this.releaseCapacity()
        }
      }
    }

    const workerCount = Math.min(this.maxConcurrency, Math.max(1, tasks.length))
    const completion = Promise.all(Array.from({ length: workerCount }, () => worker()))
      .then(() => {
        if (!foregroundResolved) {
          finishForeground()
        }
      })
      .catch((error) => {
        console.warn("[Shuffle Similar] Source pipeline worker failed", error)
        if (!foregroundResolved) {
          finishForeground()
        }
      })

    return await new Promise<SourcePipelineResult<T>>((resolve) => {
      resolveForeground = resolve
      if (options.foregroundDeadlineMs != null) {
        foregroundTimer = setTimeout(
          finishForeground,
          Math.max(1, options.foregroundDeadlineMs)
        )
      }
      maybeResolveQuorum()
      void completion
    })
  }
}
