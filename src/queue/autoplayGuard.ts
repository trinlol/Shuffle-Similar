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

export const detectForeignInjection = (): string[] => {
  if (!guardEnabled || !sessionManager.isActive()) return []

  const current = getUpcomingQueueUris()
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

  const cleaned = current.filter((uri) => sessionManager.ownsQueueTrack(uri))
  lastKnownQueue = serializeQueue(cleaned.length > 0 ? cleaned : previous)
  return foreign
}
