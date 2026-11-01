/** Recovers from unplayable owned tracks and records explicit More/Less feedback. */
import { recordOperation } from "../diagnostics/operationLog"
import { getUpcomingQueueUris } from "../queue/queueManager"
import { sessionManager } from "../session/SessionManager"
import { fetchSeedMetadata } from "../sources/trackMetadata"
import { refillQueueIfNeeded, rerankUpcomingAfterFeedback } from "./refill"
import { invalidatePrefetch } from "./sessionState"

let playbackFailureRecovery: Promise<boolean> | null = null

const getImmediateOwnedRecoveryTrack = (): string | null => {
  const nextUri = getUpcomingQueueUris()[0]
  return nextUri && sessionManager.ownsQueueTrack(nextUri) && !sessionManager.isQuarantined(nextUri)
    ? nextUri
    : null
}

/** Repairs an owned unplayable track without converting an operational
 * failure into preference feedback. Duplicate watchdog decisions coalesce. */
export const handlePlaybackFailure = async (uri: string): Promise<boolean> => {
  if (playbackFailureRecovery) return await playbackFailureRecovery
  playbackFailureRecovery = (async () => {
    if (!sessionManager.isActive() || !sessionManager.ownsQueueTrack(uri)) return false
    if (sessionManager.isQuarantined(uri)) return false

    const observation = sessionManager.recordPlaybackFailure(uri)
    if (observation.type !== "play-failure") return false
    invalidatePrefetch()

    try {
      let nextOwnedUri = getImmediateOwnedRecoveryTrack()
      if (!nextOwnedUri) await refillQueueIfNeeded()
      if (Spicetify.Player.data?.item?.uri !== uri) return true
      nextOwnedUri = getImmediateOwnedRecoveryTrack()
      if (!nextOwnedUri) {
        recordOperation({
          op: "recovery.play_failure",
          outcome: "failed",
          reason: "recovery_no_replacement",
        })
        Spicetify.showNotification("Similar Mix could not recover this unavailable track", true)
        return false
      }
      recordOperation({ op: "recovery.play_failure", outcome: "ok" })
      Spicetify.Player.next()
      void rerankUpcomingAfterFeedback().catch((error) => {
        console.warn("[Shuffle Similar] Could not refresh the queue after playback recovery", error)
      })
      return true
    } catch (error) {
      recordOperation({ op: "recovery.play_failure", outcome: "failed", reason: "recovery_failed" })
      console.warn("[Shuffle Similar] Could not recover failed playback", error)
      Spicetify.showNotification("Similar Mix could not recover this unavailable track", true)
      return false
    }
  })()

  try {
    return await playbackFailureRecovery
  } finally {
    playbackFailureRecovery = null
  }
}

/** Records an intentional More/Less signal. A negative signal immediately
 * refreshes what comes next when Similar Mix is active. */
export const teachSimilarMixPreference = async (uri: string, sentiment: -1 | 1): Promise<void> => {
  if (!uri.startsWith("spotify:track:")) throw new Error("Choose a Spotify track")
  const candidate = sessionManager.getCandidate(uri) ?? (await fetchSeedMetadata(uri))
  sessionManager.registerCandidates([candidate])
  sessionManager.recordExplicitFeedback(candidate, sentiment)
  invalidatePrefetch()
  if (sentiment < 0 && sessionManager.isActive()) {
    await rerankUpcomingAfterFeedback()
  }
}
