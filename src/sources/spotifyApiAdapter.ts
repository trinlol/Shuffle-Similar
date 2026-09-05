export type OptionalSpotifyCapability = "recommendations" | "related-artists" | "audio-features"

export type OptionalCapabilityResult<T> =
  | { status: "ok"; value: T }
  | {
      status: "unsupported" | "circuit-open" | "timeout" | "quota-limited" | "error"
    }

export type CapabilitySnapshot = {
  capability: OptionalSpotifyCapability
  status: "unknown" | "available" | "unsupported" | "cooldown"
  consecutiveFailures: number
  openUntil: number
  lastFailure?: "unsupported" | "timeout" | "quota-limited" | "error"
}

export type OptionalSpotifyCapabilityGateOptions = {
  timeoutMs?: number
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
}

type CapabilityState = {
  available: boolean
  unsupported: boolean
  consecutiveFailures: number
  openUntil: number
  lastFailure?: "unsupported" | "timeout" | "quota-limited" | "error"
}

const CAPABILITIES: readonly OptionalSpotifyCapability[] = [
  "recommendations",
  "related-artists",
  "audio-features",
]

const emptyCapabilityState = (): CapabilityState => ({
  available: false,
  unsupported: false,
  consecutiveFailures: 0,
  openUntil: 0,
})

export class SourceTimeoutError extends Error {
  constructor() {
    super("Source request timed out")
    this.name = "SourceTimeoutError"
  }
}

export const runWithTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort()
        reject(new SourceTimeoutError())
      },
      Math.max(1, timeoutMs)
    )
  })

  try {
    const request = Promise.resolve().then(() => operation(controller.signal))
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const statusCode = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) return null
  const record = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const value = record.status ?? record.statusCode ?? record.response?.status
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value)
  return null
}

export class OptionalSpotifyCapabilityGate {
  private readonly states = new Map<OptionalSpotifyCapability, CapabilityState>()
  private readonly timeoutMs: number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(options: OptionalSpotifyCapabilityGateOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 4_000)
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 2))
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 5 * 60_000)
    this.now = options.now ?? Date.now
    for (const capability of CAPABILITIES) this.states.set(capability, emptyCapabilityState())
  }

  async run<T>(
    capability: OptionalSpotifyCapability,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<OptionalCapabilityResult<T>> {
    const state = this.states.get(capability) ?? emptyCapabilityState()
    const now = this.now()
    if (state.unsupported) return { status: "unsupported" }
    if (state.openUntil > now) return { status: "circuit-open" }

    try {
      const value = await runWithTimeout(operation, this.timeoutMs)
      this.states.set(capability, {
        available: true,
        unsupported: false,
        consecutiveFailures: 0,
        openUntil: 0,
      })
      return { status: "ok", value }
    } catch (error) {
      const code = statusCode(error)
      const failures = state.consecutiveFailures + 1
      if (code === 403 || code === 405 || code === 410) {
        this.states.set(capability, {
          available: false,
          unsupported: true,
          consecutiveFailures: failures,
          openUntil: Number.POSITIVE_INFINITY,
          lastFailure: "unsupported",
        })
        return { status: "unsupported" }
      }
      if (code === 429) {
        this.states.set(capability, {
          available: false,
          unsupported: false,
          consecutiveFailures: failures,
          openUntil: now + this.cooldownMs,
          lastFailure: "quota-limited",
        })
        return { status: "quota-limited" }
      }

      const timedOut = error instanceof SourceTimeoutError
      this.states.set(capability, {
        available: false,
        unsupported: false,
        consecutiveFailures: failures,
        openUntil: failures >= this.failureThreshold ? now + this.cooldownMs : 0,
        lastFailure: timedOut ? "timeout" : "error",
      })
      return { status: timedOut ? "timeout" : "error" }
    }
  }

  snapshot(): CapabilitySnapshot[] {
    const now = this.now()
    return CAPABILITIES.map((capability) => {
      const state = this.states.get(capability) ?? emptyCapabilityState()
      const status: CapabilitySnapshot["status"] = state.unsupported
        ? "unsupported"
        : state.openUntil > now
          ? "cooldown"
          : state.available
            ? "available"
            : "unknown"
      return {
        capability,
        status,
        consecutiveFailures: state.consecutiveFailures,
        openUntil: state.openUntil,
        lastFailure: state.lastFailure,
      }
    })
  }

  reset(): void {
    for (const capability of CAPABILITIES) this.states.set(capability, emptyCapabilityState())
  }
}

export class BoundedCache<Key, Value> {
  private readonly values = new Map<Key, Value>()
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  get size(): number {
    return this.values.size
  }

  has(key: Key): boolean {
    return this.values.has(key)
  }

  get(key: Key): Value | undefined {
    const value = this.values.get(key)
    if (value === undefined) return undefined
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  set(key: Key, value: Value): void {
    this.values.delete(key)
    this.values.set(key, value)
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as Key | undefined
      if (oldest === undefined) break
      this.values.delete(oldest)
    }
  }

  take(key: Key): Value | undefined {
    const value = this.values.get(key)
    this.values.delete(key)
    return value
  }

  clear(): void {
    this.values.clear()
  }
}

export const optionalSpotifyCapabilities = new OptionalSpotifyCapabilityGate()
