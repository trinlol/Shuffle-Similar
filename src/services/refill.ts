/** Keeps an active mix topped up and re-ranks what comes next after feedback. */
import { recordOperation } from "../diagnostics/operationLog"
import { detectForeignInjection, syncKnownQueue } from "../queue/autoplayGuard"
import {
  appendTracksToQueue,
  getConfirmedQueueOwnership,
  getUpcomingCount,
  getUpcomingQueueUris,
  replaceUpcomingQueue,
} from "../queue/queueManager"
import { sessionManager } from "../session/SessionManager"
import { buildPlayableBatch, getSessionConfig } from "./mixBuilder"
import {
  invalidatePrefetch,
  persistActiveSession,
  prefetchCache,
  prefetchGeneration,
  queueMutationCoordinator,
} from "./sessionState"

let prefetchInFlight = false
export const prefetchNextBatch = async (): Promise<void> => {
  if (!sessionManager.isActive() || sessionManager.isRefilling() || prefetchInFlight) return
  const seed = sessionManager.getSeed()
  if (!seed) return
  const settings = getSessionConfig(seed)
  if (getUpcomingCount() >= settings.refillThreshold + 8) return
  const revision = sessionManager.getRevision()
  const generation = prefetchGeneration
  if (prefetchCache.has(revision, generation)) return

  prefetchInFlight = true
  try {
    const { playableQueueUris } = await buildPlayableBatch(seed, false)
    if (
      sessionManager.isActive() &&
      sessionManager.getRevision() === revision &&
      prefetchGeneration === generation
    ) {
      prefetchCache.save({ revision, generation, uris: playableQueueUris })
    }
  } catch (error) {
    // Prefetch is purely an optimisation; foreground refill remains authoritative.
    console.debug("[Shuffle Similar] prefetch skipped", error)
  } finally {
    prefetchInFlight = false
  }
}

let activeRefill: Promise<void> | null = null

const runRefillQueueIfNeeded = async (): Promise<void> => {
  if (!sessionManager.isActive()) return

  const seed = sessionManager.getSeed()
  if (!seed) return

  sessionManager.setRefilling(true)
  try {
    const revision = sessionManager.getRevision()
    const foreign = detectForeignInjection()
    if (foreign.length > 0) {
      recordOperation({
        op: "guard.foreign_cleanup",
        outcome: "info",
        counts: { foreign: foreign.length },
      })
      const cleaned = getUpcomingQueueUris().filter((uri) => sessionManager.ownsQueueTrack(uri))
      const current = Spicetify.Player.data?.item?.uri
      await queueMutationCoordinator.run(() => replaceUpcomingQueue(current, cleaned))
    }

    const settings = getSessionConfig(seed)
    const ownedUpcoming = sessionManager.getQueuedUris()
    const upcoming = ownedUpcoming.length
    if (upcoming >= settings.refillThreshold) return

    const playableQueueUris =
      prefetchCache.take(sessionManager.getRevision(), prefetchGeneration) ??
      (await buildPlayableBatch(seed, false)).playableQueueUris
    const alreadyQueued = new Set(getUpcomingQueueUris())
    const batchUris = playableQueueUris
      .filter((uri) => !alreadyQueued.has(uri))
      .slice(0, settings.initialQueueSize)
    if (batchUris.length === 0) return
    if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return

    await queueMutationCoordinator.run(async () => {
      if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return
      await appendTracksToQueue(batchUris.map((uri) => ({ uri })))
    })
    if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return
    recordOperation({ op: "refill.append", outcome: "ok", counts: { tracks: batchUris.length } })
    // Spotify may append context/autoplay entries after the owned prefix.
    // Keep those visible for playback, but never count or adopt them as ours.
    const merged = [...ownedUpcoming, ...batchUris]
    sessionManager.setQueuedUris(merged)
    syncKnownQueue(merged)
    persistActiveSession()
  } catch (error) {
    recordOperation({ op: "refill.append", outcome: "failed", reason: "refill_failed" })
    console.error("[Shuffle Similar] refill failed", error)
  } finally {
    sessionManager.setRefilling(false)
  }
}

export const refillQueueIfNeeded = async (): Promise<void> => {
  if (activeRefill) return await activeRefill
  activeRefill = runRefillQueueIfNeeded()
  try {
    await activeRefill
  } finally {
    activeRefill = null
  }
}

export const rerankUpcomingAfterFeedback = async (): Promise<void> => {
  const seed = sessionManager.getSeed()
  if (!seed || !sessionManager.isActive()) return

  const revision = sessionManager.getRevision()
  invalidatePrefetch()
  const { playableQueueUris, settings } = await buildPlayableBatch(seed, false, false)
  if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return

  const currentUri = Spicetify.Player.data?.item?.uri ?? null
  const nextUris = playableQueueUris
    .filter((uri) => uri !== currentUri && uri !== seed.uri)
    .slice(0, settings.initialQueueSize)
  if (nextUris.length === 0) return

  const commit = await queueMutationCoordinator.run(async () => {
    if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) {
      return { requestedUris: [], actualUris: [], verified: false }
    }
    return await replaceUpcomingQueue(currentUri, nextUris)
  })
  if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return
  const committedUris = getConfirmedQueueOwnership(commit)
  if (committedUris.length === 0) return
  sessionManager.setQueuedUris(committedUris)
  syncKnownQueue(committedUris)
  persistActiveSession()
}
