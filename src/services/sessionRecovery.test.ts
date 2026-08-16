import { describe, expect, it } from "vitest"
import {
  createSessionRecoveryStore,
  shouldRecoverSession,
} from "./sessionRecovery"

const seed = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed",
  artistName: "Artist",
  artistUri: "spotify:artist:artist",
  genres: [],
}

describe("session recovery", () => {
  it("persists a bounded active queue and restores only when Spotify is still playing that mix", () => {
    const values = new Map<string, string>()
    const store = createSessionRecoveryStore({
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    })
    store.save({ seed, queuedUris: ["spotify:track:one", "spotify:track:two"], position: 7 }, 1_000)

    const snapshot = store.load(2_000)
    expect(snapshot).toMatchObject({ seed, position: 7 })
    expect(shouldRecoverSession(snapshot, "spotify:track:one", [])).toBe(true)
    expect(shouldRecoverSession(snapshot, "spotify:track:outside", ["spotify:track:outside"])).toBe(false)
  })

  it("drops stale or malformed snapshots instead of reviving an unrelated session", () => {
    const values = new Map<string, string>()
    const store = createSessionRecoveryStore({
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    })
    store.save({ seed, queuedUris: ["spotify:track:one"], position: 0 }, 1_000)

    expect(store.load(1_000 + 25 * 60 * 60 * 1_000)).toBeNull()
    values.set("shuffleSimilar:activeSession:v1", "not json")
    expect(store.load(2_000)).toBeNull()
  })

  it("migrates v1 snapshots with empty adaptive state", () => {
    const values = new Map<string, string>()
    values.set("shuffleSimilar:activeSession:v1", JSON.stringify({
      version: 1,
      savedAt: 1_000,
      seed,
      queuedUris: ["spotify:track:one"],
      position: 2,
    }))
    const store = createSessionRecoveryStore({
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    })

    expect(store.load(2_000)).toMatchObject({
      version: 2,
      recentPositiveAnchors: [],
      familiarityLedger: [],
    })
  })
})
