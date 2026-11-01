import { vi } from "vitest"

/**
 * A Spotify stand-in that reproduces the timing measured on Spotify 1.3.6:
 * queue operations resolve before local state changes, `queue_update` fires
 * once the change lands, and a track change briefly leaves the new current
 * track at the head of the public queue.
 */
export type FakeSpotifyOptions = {
  /** Track playing at install time. */
  playing?: string | null
  /** Manually queued tracks at install time. */
  queued?: string[]
  /** Context tracks Spotify keeps after the queued ones. */
  contextTail?: string[]
  /** Time between an operation resolving and the queue state changing. */
  applyDelayMs?: number
  /** After a track change, the public queue still lists the new track first for this long. */
  headLagMs?: number
  /** Ignore a clear/add issued while an earlier update is still pending. */
  dropWhileStale?: boolean
  emitQueueUpdate?: boolean
  /** When false, `Spicetify.Queue.nextTracks` stays empty, as before Spotify hydrates it. */
  publicQueueHydrated?: boolean
}

type Listener = (event: { type: string; data: unknown }) => void

/** Shaped like Spotify 1.3.6 entries: no top-level `uri`. */
export type FakeQueueEntry = {
  contextTrack: { uri: string; metadata: { provider: string; is_queued: string } }
  provider: "queue" | "context"
  removed: boolean
  blocked: boolean
}

export type FakeSpotify = {
  install(): void
  /** Committed manually queued tracks. */
  queued(): string[]
  /** What `Spicetify.Queue.nextTracks` shows right now, including a lagging head. */
  upcoming(): string[]
  playing(): string | null
  /** Advance playback to the next track and fire `songchange`. */
  nextTrack(): void
  fireSongChange(): void
  listenerCount(event: string): number
  operations: Array<{ op: "clear" | "add"; count: number; atMs: number }>
}

const entry = (uri: string, provider: "queue" | "context"): FakeQueueEntry => ({
  contextTrack: { uri, metadata: { provider, is_queued: String(provider === "queue") } },
  provider,
  removed: false,
  blocked: false,
})

export const createFakeSpotify = (options: FakeSpotifyOptions = {}): FakeSpotify => {
  const applyDelayMs = options.applyDelayMs ?? 150
  const headLagMs = options.headLagMs ?? 80
  const emitQueueUpdate = options.emitQueueUpdate ?? true
  const publicQueueHydrated = options.publicQueueHydrated ?? true
  const startedAt = Date.now()

  let playing: string | null = options.playing ?? null
  let queued = [...(options.queued ?? [])]
  const context = [...(options.contextTail ?? [])]
  let staleHead: string | null = null
  let pendingUpdates = 0
  let revision = 1
  const listeners = new Map<string, Set<Listener>>()
  const songChangeListeners = new Set<() => void>()
  const operations: FakeSpotify["operations"] = []

  const visibleEntries = (): FakeQueueEntry[] => [
    ...(staleHead ? [entry(staleHead, "queue")] : []),
    ...queued.map((uri) => entry(uri, "queue")),
    ...context.map((uri) => entry(uri, "context")),
  ]

  const emit = (type: string) => {
    if (type === "queue_update" && !emitQueueUpdate) return
    const data = {
      current: playing ? entry(playing, "context") : null,
      queued: queued.map((uri) => entry(uri, "queue")),
      nextUp: context.map((uri) => entry(uri, "context")),
    }
    for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, data })
  }

  const scheduleApply = (nextQueued: string[]) => {
    pendingUpdates += 1
    setTimeout(() => {
      pendingUpdates -= 1
      queued = nextQueued
      revision += 1
      emit("queue_update")
    }, applyDelayMs)
  }

  const record = (op: "clear" | "add", count: number) =>
    operations.push({ op, count, atMs: Date.now() - startedAt })

  const isStale = () => pendingUpdates > 0 || staleHead !== null

  const fireSongChange = () => {
    for (const listener of [...songChangeListeners]) listener()
  }

  const nextTrack = () => {
    const next = queued.shift() ?? context.shift() ?? null
    playing = next
    staleHead = next
    revision += 1
    fireSongChange()
    setTimeout(() => {
      staleHead = null
      revision += 1
      emit("queue_update")
    }, headLagMs)
  }

  const playerApi = {
    clearQueue: async () => {
      record("clear", queued.length)
      if (options.dropWhileStale && isStale()) return
      scheduleApply([])
    },
    addToQueue: async (items: Array<{ uri: string }>) => {
      record("add", items.length)
      if (options.dropWhileStale && isStale()) return
      // Spotify rewrites from its current local snapshot, stale or not.
      scheduleApply([...queued, ...items.map((item) => item.uri)])
    },
    play: async (track: { uri: string }) => {
      playing = track.uri
    },
    getState: () => ({ sessionId: "fake-session" }),
    updateContext: async () => undefined,
    _events: {
      addListener: (type: string, listener: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)?.add(listener)
      },
      removeListener: (type: string, listener: Listener) => {
        listeners.get(type)?.delete(listener)
      },
    },
    _queue: {
      get _queue() {
        return { nextTracks: visibleEntries(), queueRevision: revision }
      },
      get _queueState() {
        return {
          current: playing ? entry(playing, "context") : null,
          queued: [
            ...(staleHead ? [entry(staleHead, "queue")] : []),
            ...queued.map((uri) => entry(uri, "queue")),
          ],
          nextUp: context.map((uri) => entry(uri, "context")),
        }
      },
    },
  }

  const install = () => {
    vi.stubGlobal("Spicetify", {
      Queue: {
        get nextTracks() {
          return publicQueueHydrated ? visibleEntries() : []
        },
        get queueRevision() {
          return String(revision)
        },
      },
      Player: {
        get data() {
          return { item: playing ? { uri: playing } : null }
        },
        addEventListener: (type: string, listener: () => void) => {
          if (type === "songchange") songChangeListeners.add(listener)
        },
        removeEventListener: (type: string, listener: () => void) => {
          if (type === "songchange") songChangeListeners.delete(listener)
        },
        getShuffle: () => false,
        setShuffle: () => undefined,
        next: () => nextTrack(),
      },
      Platform: { PlayerAPI: playerApi },
    })
  }

  return {
    install,
    queued: () => [...queued],
    upcoming: () => visibleEntries().map((item) => item.contextTrack.uri),
    playing: () => playing,
    nextTrack,
    fireSongChange,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    operations,
  }
}
