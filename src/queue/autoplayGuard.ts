import { sessionManager } from "../session/SessionManager"
import { getUpcomingQueueUris } from "./queueManager"
import { readInternalQueueSnapshot, readQueueSnapshot } from "./queueState"

const MAX_OBSERVED_USER_QUEUED = 128

type QueueEventsEmitter = {
  addListener?: (type: string, cb: () => void) => void
  removeListener?: (type: string, cb: () => void) => void
}

let lastKnownQueue = ""
let guardEnabled = false
let subscribedEventsRef: WeakRef<QueueEventsEmitter> | null = null
const observedUserQueuedUris = new Set<string>()

const rememberObservedUserQueuedUri = (uri: string) => {
  if (observedUserQueuedUris.has(uri)) {
    observedUserQueuedUris.delete(uri)
  }
  observedUserQueuedUris.add(uri)
  while (observedUserQueuedUris.size > MAX_OBSERVED_USER_QUEUED) {
    const oldest = observedUserQueuedUris.keys().next().value
    if (oldest === undefined) break
    observedUserQueuedUris.delete(oldest)
  }
}

const serializeQueue = (uris: string[]) => uris.join("|")

const onQueueUpdate = () => {
  if (!guardEnabled || !sessionManager.isActive()) return
  collectManualUserQueuedUris()
}

const getPlayerEvents = (): QueueEventsEmitter | undefined => {
  try {
    return (
      Spicetify as unknown as {
        Platform?: {
          PlayerAPI?: {
            _events?: QueueEventsEmitter
          }
        }
      }
    )?.Platform?.PlayerAPI?._events
  } catch {
    return undefined
  }
}

const subscribeQueueUpdates = () => {
  const events = getPlayerEvents()
  const currentSubscribed = subscribedEventsRef?.deref() ?? null
  if (currentSubscribed && currentSubscribed === events) return
  if (currentSubscribed) {
    try {
      currentSubscribed.removeListener?.("queue_update", onQueueUpdate)
    } catch {
      // Ignore teardown errors on replaced emitters.
    }
    subscribedEventsRef = null
  }
  if (typeof events?.addListener === "function") {
    try {
      events.addListener("queue_update", onQueueUpdate)
      subscribedEventsRef = new WeakRef(events)
    } catch {
      // Ignore when Spicetify runtime is not attached.
    }
  }
}

const unsubscribeQueueUpdates = () => {
  const currentSubscribed = subscribedEventsRef?.deref() ?? null
  subscribedEventsRef = null
  try {
    ;(currentSubscribed ?? getPlayerEvents())?.removeListener?.("queue_update", onQueueUpdate)
  } catch {
    // Ignore when Spicetify runtime is not attached.
  }
}

export const enableAutoplayGuard = () => {
  guardEnabled = true
  subscribeQueueUpdates()
}

export const disableAutoplayGuard = () => {
  guardEnabled = false
  lastKnownQueue = ""
  observedUserQueuedUris.clear()
  unsubscribeQueueUpdates()
}

export const syncKnownQueue = (uris: string[]) => {
  lastKnownQueue = serializeQueue(uris)
}

const collectManualUserQueuedUris = (): Set<string> => {
  const snapshot = readQueueSnapshot()
  const internalSnapshot = readInternalQueueSnapshot()
  if (snapshot.source === "none" && internalSnapshot.source === "none") return new Set()

  const manual = new Set<string>()
  for (const entry of [...snapshot.entries, ...internalSnapshot.entries]) {
    if (entry.provider === "queue" && !sessionManager.ownsQueueTrack(entry.uri)) {
      manual.add(entry.uri)
      rememberObservedUserQueuedUri(entry.uri)
    }
  }
  return manual
}

/** True when `uri` is a non-owned track explicitly queued by the listener ("Add to queue"). */
export const isUserQueuedDetourUri = (uri: string): boolean => {
  if (!uri || sessionManager.ownsQueueTrack(uri)) return false
  return collectManualUserQueuedUris().has(uri) || observedUserQueuedUris.has(uri)
}

/** True when the track currently playing was started from the listener's manual queue ("Add to queue"). */
export const isUserQueuedDetourTrack = (uri: string): boolean => {
  if (!uri || sessionManager.ownsQueueTrack(uri)) return false
  try {
    const item = Spicetify.Player.data?.item as
      | { uri?: string; provider?: string; metadata?: Record<string, string> }
      | undefined
    if (
      item?.uri === uri &&
      (item.provider === "queue" ||
        item.metadata?.provider === "queue" ||
        item.metadata?.is_queued === "true")
    ) {
      return true
    }
  } catch {
    // Fall back to queue snapshot observations below.
  }
  const manualUpcoming = collectManualUserQueuedUris()
  if (manualUpcoming.has(uri)) return true
  if (observedUserQueuedUris.has(uri)) {
    observedUserQueuedUris.delete(uri)
    return true
  }
  return false
}

const getPlayingUri = (): string | null => {
  try {
    return Spicetify.Player.data?.item?.uri ?? null
  } catch {
    return null
  }
}

/** Right after a track change Spotify's public queue can still list the track
 * that just started at index 0 for ~100ms. That entry is playing, not upcoming,
 * and must not make the queue look tampered with. */
const getUpcomingExcludingPlayingHead = (): string[] => {
  const upcoming = getUpcomingQueueUris()
  const playing = getPlayingUri()
  return playing && upcoming[0] === playing ? upcoming.slice(1) : upcoming
}

export const detectForeignInjection = (): string[] => {
  if (!guardEnabled || !sessionManager.isActive()) return []

  const current = getUpcomingExcludingPlayingHead()
  if (!lastKnownQueue) {
    lastKnownQueue = serializeQueue(current)
    return []
  }

  const previous = lastKnownQueue.split("|").filter(Boolean)
  const foreign = current.filter((uri) => !sessionManager.ownsQueueTrack(uri))
  if (foreign.length === 0) {
    lastKnownQueue = serializeQueue(current)
    return []
  }

  // Spotify appends context/autoplay tracks after the mix, and can silently
  // drop an owned track it cannot play. Neither is an injection: only a
  // non-owned track placed before the last owned track is. Requiring every
  // owned track at its exact index made one dropped track trigger a full
  // queue rebuild on every song change.
  let lastOwnedIndex = -1
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (sessionManager.ownsQueueTrack(current[index])) {
      lastOwnedIndex = index
      break
    }
  }
  if (lastOwnedIndex >= 0) {
    const manualUserQueued = collectManualUserQueuedUris()
    const injected = current
      .slice(0, lastOwnedIndex)
      .filter((uri) => !sessionManager.ownsQueueTrack(uri) && !manualUserQueued.has(uri))
    if (injected.length === 0) {
      lastKnownQueue = serializeQueue(
        current.filter((uri) => sessionManager.ownsQueueTrack(uri) || manualUserQueued.has(uri))
      )
      return []
    }
    lastKnownQueue = serializeQueue(
      current.filter((uri) => sessionManager.ownsQueueTrack(uri) || manualUserQueued.has(uri))
    )
    return injected
  }

  const cleaned = current.filter((uri) => sessionManager.ownsQueueTrack(uri))
  lastKnownQueue = serializeQueue(cleaned.length > 0 ? cleaned : previous)
  return foreign
}
