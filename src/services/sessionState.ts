/** State shared by the start, refill and recovery paths: the queue mutation lane,
 * the prefetch cache and session persistence. Kept separate to avoid import cycles. */
import { QueueMutationCoordinator } from "../queue/queueMutationCoordinator"
import { sessionManager } from "../session/SessionManager"
import { createPrefetchCache } from "./prefetchCache"
import { createSessionRecoveryStore } from "./sessionRecovery"
export const queueMutationCoordinator = new QueueMutationCoordinator()
let sessionRecoveryStore: ReturnType<typeof createSessionRecoveryStore> | null = null
export const getSessionRecoveryStore = () => (sessionRecoveryStore ??= createSessionRecoveryStore())
export const prefetchCache = createPrefetchCache()
export let prefetchGeneration = 0

export const invalidatePrefetch = (): void => {
  prefetchGeneration += 1
  prefetchCache.clear()
}

export const persistActiveSession = (): void => {
  const seed = sessionManager.getSeed()
  if (!seed || !sessionManager.isActive()) return
  getSessionRecoveryStore().save({
    seed,
    queuedUris: sessionManager.getQueuedUris(),
    position: sessionManager.getPosition(),
    recentPositiveAnchors: sessionManager.getRecentPositiveAnchors(),
    familiarityLedger: sessionManager.getFamiliarityLedger(),
  })
}

export const clearSimilarMixRecovery = (): void => getSessionRecoveryStore().clear()
