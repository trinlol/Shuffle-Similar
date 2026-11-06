/**
 * The only module that reads Spotify's queue internals.
 *
 * Spotify resolves queue operations before its local state changes, then
 * emits `queue_update` on `PlayerAPI._events` once the change has landed.
 * Waiting on that event, with polling as a fallback, replaces fixed sleeps.
 */

export type QueueEntry = { uri: string; provider: string | null }

export type PreviousQueueTrack = {
  uri: string
  trackName?: string
  artistUri?: string
  artistName?: string
}

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
  Queue?: { nextTracks?: unknown; prevTracks?: unknown; queueRevision?: unknown }
  Platform?: {
    PlayerAPI?: {
      _queue?: { _queueState?: { queued?: unknown; nextUp?: unknown; previous?: unknown } }
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

/** Spotify's internal queue state, read directly. Never throws. */
export const readInternalQueueSnapshot = (): QueueSnapshot => {
  try {
    const state = runtime()?.Platform?.PlayerAPI?._queue?._queueState
    if (!state) return EMPTY_SNAPSHOT
    // Spotify plays manually queued tracks before the context's next-up tracks.
    const entries = [...toEntries(state.queued), ...toEntries(state.nextUp)]
    return { entries, revision: readRevision(), source: "internal" }
  } catch {
    return EMPTY_SNAPSHOT
  }
}

/** Reads the upcoming queue, preferring the public queue, without ever throwing. */
export const readQueueSnapshot = (): QueueSnapshot => {
  try {
    const spicetify = runtime()
    if (!spicetify) return EMPTY_SNAPSHOT

    const publicEntries = toEntries(spicetify.Queue?.nextTracks)
    if (publicEntries.length > 0) {
      return { entries: publicEntries, revision: readRevision(), source: "public" }
    }
    return readInternalQueueSnapshot()
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

const toPreviousTrack = (track: unknown): PreviousQueueTrack | null => {
  if (typeof track !== "object" || track === null) return null
  const record = track as {
    uri?: unknown
    name?: unknown
    artists?: Array<{ uri?: unknown; name?: unknown }>
    metadata?: Record<string, unknown>
    contextTrack?: { uri?: unknown; metadata?: Record<string, unknown> }
  }
  const uri = record.uri ?? record.contextTrack?.uri
  if (typeof uri !== "string" || !uri.startsWith("spotify:track:")) return null
  const meta = record.metadata ?? record.contextTrack?.metadata
  const trackName =
    typeof record.name === "string" && record.name
      ? record.name
      : typeof meta?.title === "string" && meta.title
        ? meta.title
        : undefined
  const artistUri =
    typeof record.artists?.[0]?.uri === "string" && record.artists[0].uri
      ? record.artists[0].uri
      : typeof meta?.artist_uri === "string" && meta.artist_uri
        ? meta.artist_uri
        : undefined
  const artistName =
    typeof record.artists?.[0]?.name === "string" && record.artists[0].name
      ? record.artists[0].name
      : typeof meta?.artist_name === "string" && meta.artist_name
        ? meta.artist_name
        : undefined
  return { uri, trackName, artistUri, artistName }
}

/**
 * Previously played queue tracks exposed by Spotify's desktop queue state,
 * ordered most-recent-first. Never throws.
 */
export const readPreviousQueueTracks = (): PreviousQueueTrack[] => {
  try {
    const spicetify = runtime()
    if (!spicetify) return []
    const collect = (items: unknown): PreviousQueueTrack[] =>
      Array.isArray(items)
        ? items
            .map(toPreviousTrack)
            .filter((entry): entry is PreviousQueueTrack => entry !== null)
            .reverse()
        : []
    const publicPrev = collect(spicetify.Queue?.prevTracks)
    const internalPrev = collect(spicetify.Platform?.PlayerAPI?._queue?._queueState?.previous)
    const seen = new Set<string>()
    const merged: PreviousQueueTrack[] = []
    for (const entry of [...publicPrev, ...internalPrev]) {
      if (seen.has(entry.uri)) continue
      seen.add(entry.uri)
      merged.push(entry)
    }
    return merged
  } catch {
    return []
  }
}

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
