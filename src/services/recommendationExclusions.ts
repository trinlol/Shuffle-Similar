export type RecommendationExclusionInput = {
  playedUris: readonly string[]
  committedQueueUris: readonly string[]
  visibleQueueUris: readonly string[]
  purpose: "refill" | "rerank"
}

/**
 * Refills must not duplicate anything already committed. Feedback reranks are
 * different: the existing upcoming tracks are the exact slate being
 * reconsidered, so only tracks that have actually played remain excluded.
 */
export const buildRecommendationExclusions = (
  input: RecommendationExclusionInput
): string[] => [...new Set([
  ...input.playedUris,
  ...(input.purpose === "refill" ? input.committedQueueUris : []),
  ...(input.purpose === "refill" ? input.visibleQueueUris : []),
])]

export const buildHistoryRelaxedExclusions = (
  input: Omit<RecommendationExclusionInput, "purpose">,
  recentPlayedLimit: number
): string[] => [...new Set([
  ...input.playedUris.slice(-Math.max(1, Math.floor(recentPlayedLimit))),
  ...input.committedQueueUris,
  ...input.visibleQueueUris,
])]
