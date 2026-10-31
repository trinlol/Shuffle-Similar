import { sessionManager } from "../session/SessionManager"
import { getUpcomingQueueUris } from "./queueManager"

let lastKnownQueue = ""
let guardEnabled = false

const serializeQueue = (uris: string[]) => uris.join("|")

export const enableAutoplayGuard = () => {
  guardEnabled = true
}

export const disableAutoplayGuard = () => {
  guardEnabled = false
  lastKnownQueue = ""
}

export const syncKnownQueue = (uris: string[]) => {
  lastKnownQueue = serializeQueue(uris)
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

  const ownedQueue = sessionManager.getQueuedUris()
  const completeOwnedPrefix =
    ownedQueue.length > 0 &&
    current.length >= ownedQueue.length &&
    ownedQueue.every((uri, index) => current[index] === uri)
  if (completeOwnedPrefix) {
    lastKnownQueue = serializeQueue(ownedQueue)
    return []
  }

  const cleaned = current.filter((uri) => sessionManager.ownsQueueTrack(uri))
  lastKnownQueue = serializeQueue(cleaned.length > 0 ? cleaned : previous)
  return foreign
}
