/**
 * The only module that reads Spotify's queue internals.
 *
 * Spotify resolves queue operations before its local state changes, then
 * emits `queue_update` on `PlayerAPI._events` once the change has landed.
 * Waiting on that event, with polling as a fallback, replaces fixed sleeps.
 */

export type QueueEntry = { uri: string; provider: string | null }

export type QueueSnapshot = {
  entries: QueueEntry[]
  revision: string | null
  source: "public" | "internal" | "none"
}

type QueueEvents = {
  addListener?: (type: string, listener: () => void) => void
  removeListener?: (type: string, listener: () => void) => void
}

const DELIMITER = "spotify:delimiter"
const EMPTY_SNAPSHOT: QueueSnapshot = { entries: [], revision: null, source: "none" }

const toEntry = (track: unknown): QueueEntry | null => {
  if (typeof track !== "object" || track === null) return null
  const record = track as {
    uri?: unknown
    provider?: unknown
    contextTrack?: { uri?: unknown; metadata?: { provider?: unknown } }
  }
  const uri = record.uri ?? record.contextTrack?.uri
  if (typeof uri !== "string" || uri === DELIMITER) return null
  const provider = record.provider ?? record.contextTrack?.metadata?.provider
  return { uri, provider: typeof provider === "string" ? provider : null }
}

const toEntries = (tracks: unknown): QueueEntry[] =>
  Array.isArray(tracks)
    ? tracks.map(toEntry).filter((entry): entry is QueueEntry => entry !== null)
    : []

/** The slice of the Spicetify runtime this module reads, all of it optional. */
type QueueRuntime = {
  Queue?: { nextTracks?: unknown; queueRevision?: unknown }
  Platform?: {
    PlayerAPI?: {
      _queue?: { _queueState?: { queued?: unknown; nextUp?: unknown } }
      _events?: QueueEvents
    }
  }
}

const runtime = (): QueueRuntime | undefined => {
  try {
    return typeof Spicetify === "undefined" ? undefined : (Spicetify as unknown as QueueRuntime)
  } catch {
    return undefined
  }
}

const readRevision = (): string | null => {
  try {
    const revision = runtime()?.Queue?.queueRevision
    return revision == null ? null : String(revision)
  } catch {
    return null
  }
}

/** Reads the upcoming queue without ever throwing. */
export const readQueueSnapshot = (): QueueSnapshot => {
  try {
    const spicetify = runtime()
    if (!spicetify) return EMPTY_SNAPSHOT

    const publicEntries = toEntries(spicetify.Queue?.nextTracks)
    if (publicEntries.length > 0) {
      return { entries: publicEntries, revision: readRevision(), source: "public" }
    }

    const state = spicetify.Platform?.PlayerAPI?._queue?._queueState
    if (!state) return EMPTY_SNAPSHOT
    // Spotify plays manually queued tracks before the context's next-up tracks.
    const internalEntries = [...toEntries(state.queued), ...toEntries(state.nextUp)]
    return { entries: internalEntries, revision: readRevision(), source: "internal" }
  } catch {
    return EMPTY_SNAPSHOT
  }
}

/** Manually queued URIs, deduplicated, in play order. */
export const queuedUris = (snapshot: QueueSnapshot = readQueueSnapshot()): string[] => [
  ...new Set(
    snapshot.entries.filter((entry) => entry.provider === "queue").map((entry) => entry.uri)
  ),
]

const queueEvents = (): QueueEvents | null => {
  try {
    const events = runtime()?.Platform?.PlayerAPI?._events
    return events && typeof events.addListener === "function" ? events : null
  } catch {
    return null
  }
}

/**
 * Resolves as soon as `predicate` holds for the live queue, re-checking on
 * every `queue_update` event and every `pollMs` tick. Never rejects.
 */
export const waitForQueue = (
  predicate: (snapshot: QueueSnapshot) => boolean,
  options: { timeoutMs: number; pollMs?: number }
): Promise<{ met: boolean; snapshot: QueueSnapshot }> =>
  new Promise((resolve) => {
    let settled = false
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const events = queueEvents()

    const holds = (snapshot: QueueSnapshot): boolean => {
      try {
        return predicate(snapshot)
      } catch {
        return false
      }
    }

    const finish = (met: boolean, snapshot: QueueSnapshot) => {
      if (settled) return
      settled = true
      if (pollTimer) clearInterval(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      try {
        events?.removeListener?.("queue_update", check)
      } catch {
        // A broken emitter must not keep the wait alive.
      }
      resolve({ met, snapshot })
    }

    function check() {
      const snapshot = readQueueSnapshot()
      if (holds(snapshot)) finish(true, snapshot)
    }

    check()
    if (settled) return

    try {
      events?.addListener?.("queue_update", check)
    } catch {
      // Polling below still resolves the wait.
    }
    pollTimer = setInterval(check, Math.max(1, options.pollMs ?? 100))
    timeoutTimer = setTimeout(
      () => finish(false, readQueueSnapshot()),
      Math.max(0, options.timeoutMs)
    )
  })
