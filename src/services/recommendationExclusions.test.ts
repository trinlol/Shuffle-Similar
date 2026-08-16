import { describe, expect, it } from "vitest"
import {
  buildHistoryRelaxedExclusions,
  buildRecommendationExclusions,
} from "./recommendationExclusions"

describe("buildRecommendationExclusions", () => {
  it("protects an ordinary refill from duplicating committed and visible queue tracks", () => {
    expect(buildRecommendationExclusions({
      playedUris: ["played"],
      committedQueueUris: ["queued-a"],
      visibleQueueUris: ["queued-b"],
      purpose: "refill",
    })).toEqual(["played", "queued-a", "queued-b"])
  })

  it("keeps already queued candidates eligible for immediate feedback reranking", () => {
    expect(buildRecommendationExclusions({
      playedUris: ["played"],
      committedQueueUris: ["skipped-neighbor", "better-fit"],
      visibleQueueUris: ["skipped-neighbor", "better-fit"],
      purpose: "rerank",
    })).toEqual(["played"])
  })

  it("never relaxes a session-quarantined playback failure", () => {
    expect(buildRecommendationExclusions({
      playedUris: [],
      committedQueueUris: ["failed"],
      visibleQueueUris: ["failed"],
      quarantinedUris: ["failed"],
      purpose: "rerank",
    })).toEqual(["failed"])

    expect(buildHistoryRelaxedExclusions({
      playedUris: ["old"],
      committedQueueUris: [],
      visibleQueueUris: [],
      quarantinedUris: ["failed"],
    }, 1)).toEqual(["old", "failed"])
  })

  it("relaxes only old playback history while always protecting the live queue", () => {
    expect(buildHistoryRelaxedExclusions({
      playedUris: ["old-a", "old-b", "recent-a", "recent-b"],
      committedQueueUris: ["queued-a"],
      visibleQueueUris: ["queued-b"],
    }, 2)).toEqual(["recent-a", "recent-b", "queued-a", "queued-b"])
  })
})
