import type { SeedMetadata } from "../session/types"

export const ACTIVE_SESSION_STORAGE_KEY = "shuffleSimilar:activeSession:v1"
const SESSION_SCHEMA_VERSION = 1
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_QUEUE_URIS = 100

export type SessionRecoveryStorage = {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

export type ActiveSessionSnapshot = {
  version: typeof SESSION_SCHEMA_VERSION
  savedAt: number
  seed: SeedMetadata
  queuedUris: string[]
  position: number
}

export type ActiveSessionInput = Pick<ActiveSessionSnapshot, "seed" | "queuedUris" | "position">

const safeTrackUris = (uris: readonly string[]): string[] => [
  ...new Set(uris.filter((uri) => typeof uri === "string" && uri.startsWith("spotify:track:"))),
].slice(0, MAX_QUEUE_URIS)

const validSeed = (value: unknown): value is SeedMetadata => {
  if (!value || typeof value !== "object") return false
  const seed = value as Partial<SeedMetadata>
  return (
    typeof seed.uri === "string" && seed.uri.startsWith("spotify:track:") &&
    typeof seed.trackId === "string" &&
    typeof seed.trackName === "string" &&
    typeof seed.artistName === "string" &&
    typeof seed.artistUri === "string" &&
    Array.isArray(seed.genres) && seed.genres.every((genre) => typeof genre === "string")
  )
}

const sanitizeSnapshot = (value: unknown, now: number): ActiveSessionSnapshot | null => {
  if (!value || typeof value !== "object") return null
  const snapshot = value as Partial<ActiveSessionSnapshot>
  if (snapshot.version !== SESSION_SCHEMA_VERSION || !validSeed(snapshot.seed)) return null
  if (typeof snapshot.savedAt !== "number" || !Number.isFinite(snapshot.savedAt)) return null
  if (snapshot.savedAt > now + 60_000 || now - snapshot.savedAt > MAX_SESSION_AGE_MS) return null
  if (!Array.isArray(snapshot.queuedUris)) return null
  const queuedUris = safeTrackUris(snapshot.queuedUris)
  if (queuedUris.length === 0) return null
  return {
    version: SESSION_SCHEMA_VERSION,
    savedAt: snapshot.savedAt,
    seed: snapshot.seed,
    queuedUris,
    position: typeof snapshot.position === "number" && Number.isFinite(snapshot.position)
      ? Math.max(0, Math.floor(snapshot.position))
      : 0,
  }
}

export const createSessionRecoveryStore = (storage: SessionRecoveryStorage = Spicetify.LocalStorage) => ({
  save: (input: ActiveSessionInput, now = Date.now()): ActiveSessionSnapshot | null => {
    const snapshot = sanitizeSnapshot({
      version: SESSION_SCHEMA_VERSION,
      savedAt: now,
      seed: input.seed,
      queuedUris: input.queuedUris,
      position: input.position,
    }, now)
    if (!snapshot) return null
    try {
      storage.set(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      return null
    }
    return snapshot
  },
  load: (now = Date.now()): ActiveSessionSnapshot | null => {
    try {
      const raw = storage.get(ACTIVE_SESSION_STORAGE_KEY)
      if (!raw) return null
      const snapshot = sanitizeSnapshot(JSON.parse(raw), now)
      if (!snapshot) storage.remove(ACTIVE_SESSION_STORAGE_KEY)
      return snapshot
    } catch {
      try { storage.remove(ACTIVE_SESSION_STORAGE_KEY) } catch { /* ignore */ }
      return null
    }
  },
  clear: (): void => {
    try { storage.remove(ACTIVE_SESSION_STORAGE_KEY) } catch { /* ignore */ }
  },
})

/** Avoid resurrecting a mix unless the current playback or visible queue still belongs to it. */
export const shouldRecoverSession = (
  snapshot: ActiveSessionSnapshot | null,
  currentUri: string | null | undefined,
  visibleQueueUris: readonly string[]
): boolean => {
  if (!snapshot) return false
  const known = new Set([snapshot.seed.uri, ...snapshot.queuedUris])
  if (currentUri && known.has(currentUri)) return true
  return visibleQueueUris.some((uri) => known.has(uri))
}
