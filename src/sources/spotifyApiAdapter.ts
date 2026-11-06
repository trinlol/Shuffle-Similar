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
  persistState?: boolean
}

const CAPABILITY_GATE_STORAGE_KEY = "shuffleSimilar:capabilityGate:v1"
const PERSISTED_UNSUPPORTED_TTL_MS = 24 * 60 * 60_000

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
  private readonly inFlightProbes = new Map<
    OptionalSpotifyCapability,
    Promise<OptionalCapabilityResult<unknown>>
  >()
  private readonly timeoutMs: number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private readonly persistState: boolean
  private hydratedStorageRef: unknown = null

  constructor(options: OptionalSpotifyCapabilityGateOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 4_000)
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 2))
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 5 * 60_000)
    this.now = options.now ?? Date.now
    this.persistState = Boolean(options.persistState)
    for (const capability of CAPABILITIES) this.states.set(capability, emptyCapabilityState())
  }

  private getStorage(): {
    get: (key: string) => string | null
    set: (key: string, value: string) => void
    remove: (key: string) => void
  } | null {
    if (!this.persistState) return null
    try {
      const storage = typeof Spicetify !== "undefined" ? Spicetify.LocalStorage : undefined
      if (
        storage &&
        typeof storage.get === "function" &&
        typeof storage.set === "function" &&
        typeof storage.remove === "function"
      ) {
        return storage
      }
    } catch {
      // Ignore missing LocalStorage in isolated tests.
    }
    return null
  }

  private hydratePersistedState(now: number): void {
    const storage = this.getStorage()
    if (!storage || this.hydratedStorageRef === storage) return
    this.hydratedStorageRef = storage
    try {
      const raw = storage.get(CAPABILITY_GATE_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, { unsupportedAt?: number }>
      if (!parsed || typeof parsed !== "object") return
      for (const capability of CAPABILITIES) {
        const entry = parsed[capability]
        if (
          entry &&
          typeof entry.unsupportedAt === "number" &&
          now - entry.unsupportedAt < PERSISTED_UNSUPPORTED_TTL_MS
        ) {
          this.states.set(capability, {
            available: false,
            unsupported: true,
            consecutiveFailures: 1,
            openUntil: Number.POSITIVE_INFINITY,
            lastFailure: "unsupported",
          })
        }
      }
    } catch {
      // Ignore malformed storage state.
    }
  }

  private persistUnsupportedCapability(capability: OptionalSpotifyCapability, now: number): void {
    const storage = this.getStorage()
    if (!storage) return
    try {
      const raw = storage.get(CAPABILITY_GATE_STORAGE_KEY)
      const parsed = raw ? (JSON.parse(raw) as Record<string, { unsupportedAt?: number }>) : {}
      const next = parsed && typeof parsed === "object" ? { ...parsed } : {}
      next[capability] = { unsupportedAt: now }
      storage.set(CAPABILITY_GATE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Ignore storage write failures.
    }
  }

  async run<T>(
    capability: OptionalSpotifyCapability,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<OptionalCapabilityResult<T>> {
    const now = this.now()
    this.hydratePersistedState(now)
    const state = this.states.get(capability) ?? emptyCapabilityState()
    if (state.unsupported) return { status: "unsupported" }
    if (state.openUntil > now) return { status: "circuit-open" }

    const isInitialProbe = !state.available && state.consecutiveFailures === 0
    if (isInitialProbe) {
      const existingProbe = this.inFlightProbes.get(capability)
      if (existingProbe) {
        return (await existingProbe) as OptionalCapabilityResult<T>
      }
    }

    const execute = async (): Promise<OptionalCapabilityResult<T>> => {
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
        const currentState = this.states.get(capability) ?? emptyCapabilityState()
        const code = statusCode(error)
        const failures = currentState.consecutiveFailures + 1
        if (code === 403 || code === 404 || code === 405 || code === 410) {
          this.states.set(capability, {
            available: false,
            unsupported: true,
            consecutiveFailures: failures,
            openUntil: Number.POSITIVE_INFINITY,
            lastFailure: "unsupported",
          })
          this.persistUnsupportedCapability(capability, now)
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

    if (!isInitialProbe) {
      return await execute()
    }

    const probePromise = execute()
    this.inFlightProbes.set(capability, probePromise as Promise<OptionalCapabilityResult<unknown>>)
    try {
      return await probePromise
    } finally {
      if (this.inFlightProbes.get(capability) === probePromise) {
        this.inFlightProbes.delete(capability)
      }
    }
  }

  snapshot(): CapabilitySnapshot[] {
    const now = this.now()
    this.hydratePersistedState(now)
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
    this.inFlightProbes.clear()
    this.hydratedStorageRef = null
    for (const capability of CAPABILITIES) this.states.set(capability, emptyCapabilityState())
    const storage = this.getStorage()
    if (storage) {
      try {
        storage.remove(CAPABILITY_GATE_STORAGE_KEY)
      } catch {
        // Ignore storage errors.
      }
    }
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

export const optionalSpotifyCapabilities = new OptionalSpotifyCapabilityGate({
  persistState: true,
})
