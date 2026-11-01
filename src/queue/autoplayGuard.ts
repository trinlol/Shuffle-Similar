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
    const injected = current
      .slice(0, lastOwnedIndex)
      .filter((uri) => !sessionManager.ownsQueueTrack(uri))
    if (injected.length === 0) {
      lastKnownQueue = serializeQueue(sessionManager.getQueuedUris())
      return []
    }
    lastKnownQueue = serializeQueue(current.filter((uri) => sessionManager.ownsQueueTrack(uri)))
    return injected
  }

  const cleaned = current.filter((uri) => sessionManager.ownsQueueTrack(uri))
  lastKnownQueue = serializeQueue(cleaned.length > 0 ? cleaned : previous)
  return foreign
}
