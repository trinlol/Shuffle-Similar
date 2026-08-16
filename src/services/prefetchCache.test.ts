import { describe, expect, it } from "vitest"
import { createPrefetchCache } from "./prefetchCache"

describe("prefetch cache", () => {
  it("only returns a fresh result for the same session revision once", () => {
    const cache = createPrefetchCache(100)
    cache.save({ revision: 4, uris: ["spotify:track:one", "spotify:track:two"] }, 1_000)
    expect(cache.take(3, 1_010)).toBeNull()

    cache.save({ revision: 4, uris: ["spotify:track:one", "spotify:track:two"] }, 1_000)
    expect(cache.take(4, 1_050)).toEqual(["spotify:track:one", "spotify:track:two"])
    expect(cache.take(4, 1_050)).toBeNull()
  })

  it("expires stale planned queues before a refill can use them", () => {
    const cache = createPrefetchCache(100)
    cache.save({ revision: 4, uris: ["spotify:track:one"] }, 1_000)
    expect(cache.has(4, 1_101)).toBe(false)
    expect(cache.take(4, 1_101)).toBeNull()
  })
})
