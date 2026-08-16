import { beforeAll, afterEach, describe, expect, it } from "vitest"
import { sessionManager } from "./SessionManager"
import type { SeedMetadata, TrackCandidate } from "./types"

const memory = new Map<string, string>()

beforeAll(() => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    LocalStorage: {
      get: (key: string) => memory.get(key) ?? null,
      set: (key: string, value: string) => memory.set(key, value),
      remove: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
    },
  }
})

afterEach(() => sessionManager.endSession())

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed",
  genres: [],
}

describe("SessionManager v2 invariants", () => {
  it("learns from generated playlist candidates registered after planning", () => {
    const generated: TrackCandidate = {
      uri: "spotify:track:generated",
      artistUri: "spotify:artist:generated",
      tempo: 128,
      energy: 0.8,
    }
    const next = { uri: "spotify:track:next", artistUri: "spotify:artist:next" }
    sessionManager.startPlaylistSession(seed, "spotify:playlist:test", [], [])
    sessionManager.registerCandidates([generated, next])
    sessionManager.setQueuedUris([generated.uri, next.uri])
    sessionManager.transitionToTrack(generated.uri)
    sessionManager.recordProgress(8_000, 180_000)
    sessionManager.transitionToTrack(next.uri)

    expect(sessionManager.getSkipFeedback()).toHaveLength(1)
    expect(sessionManager.getCandidate(generated.uri)).toEqual(generated)
  })

  it("does not advance position for duplicate or foreign songchange events", () => {
    const planned = { uri: "spotify:track:planned", artistUri: "spotify:artist:planned" }
    sessionManager.startSession(seed)
    sessionManager.registerCandidates([planned])
    sessionManager.setQueuedUris([planned.uri])

    expect(sessionManager.recordTrackPlayed(planned.uri)).toBe(true)
    expect(sessionManager.recordTrackPlayed(planned.uri)).toBe(false)
    expect(sessionManager.recordTrackPlayed("spotify:track:foreign")).toBe(false)
    expect(sessionManager.getPosition()).toBe(1)
  })

  it("keeps an active session intact when Spotify inserts an ad", () => {
    const planned = { uri: "spotify:track:planned", artistUri: "spotify:artist:planned" }
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([planned])
    sessionManager.setQueuedUris([planned.uri])
    sessionManager.recordProgress(4_000, 180_000)

    const observation = sessionManager.transitionToTrack("spotify:ad:break-1")

    expect(observation).toMatchObject({ type: "ignored", reason: "interstitial" })
    expect(sessionManager.isActive()).toBe(true)
    expect(sessionManager.isToggleEnabled()).toBe(true)
    expect(sessionManager.getQueuedUris()).toEqual([planned.uri])
    expect(sessionManager.getSkipFeedback()).toHaveLength(0)
  })

  it("resumes a persisted queue without replaying already-consumed tracks", () => {
    sessionManager.resumeSession(
      seed,
      ["spotify:track:current", "spotify:track:next"],
      12,
      "spotify:track:current"
    )

    expect(sessionManager.isActive()).toBe(true)
    expect(sessionManager.isToggleEnabled()).toBe(true)
    expect(sessionManager.getPosition()).toBe(12)
    expect(sessionManager.getPlayedUris()).toContain("spotify:track:current")
    expect(sessionManager.getQueuedUris()).toEqual(["spotify:track:next"])
  })
})
