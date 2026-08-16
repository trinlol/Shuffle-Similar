import { beforeAll, afterEach, describe, expect, it, vi } from "vitest"
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

  it("quarantines an owned playback failure without teaching or advancing", () => {
    const failed = { uri: "spotify:track:failed", artistUri: "spotify:artist:failed" }
    sessionManager.startSession(seed)
    sessionManager.registerCandidates([failed])
    sessionManager.setQueuedUris([failed.uri])
    sessionManager.transitionToTrack(failed.uri)
    sessionManager.recordTrackPlayed(failed.uri)
    const skipCountBeforeFailure = sessionManager.getSkipFeedback().length

    const observation = sessionManager.recordPlaybackFailure(failed.uri)

    expect(observation).toMatchObject({ type: "play-failure", tasteOutcome: null })
    expect(sessionManager.getQuarantinedUris()).toEqual([failed.uri])
    expect(sessionManager.getQueuedUris()).toEqual([])
    expect(sessionManager.getPosition()).toBe(0)
    expect(sessionManager.getSkipFeedback()).toHaveLength(skipCountBeforeFailure)

    const next = { uri: "spotify:track:next-after-failure", artistUri: "spotify:artist:next" }
    sessionManager.registerCandidates([next])
    sessionManager.setQueuedUris([next.uri])
    expect(sessionManager.transitionToTrack(next.uri)).toMatchObject({
      type: "play-failure",
      tasteOutcome: null,
    })
    expect(sessionManager.getSkipFeedback()).toHaveLength(skipCountBeforeFailure)
  })

  it("keeps only three distinct recent positive anchors", () => {
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      uri: `spotify:track:positive-${index}`,
      artistUri: `spotify:artist:positive-${index}`,
    }))
    const next = { uri: "spotify:track:next", artistUri: "spotify:artist:next" }
    sessionManager.startSession(seed)
    sessionManager.registerCandidates([...candidates, next])
    sessionManager.setQueuedUris([...candidates.map((candidate) => candidate.uri), next.uri])

    for (const candidate of candidates) {
      sessionManager.transitionToTrack(candidate.uri)
      sessionManager.recordProgress(100_000, 120_000)
    }
    sessionManager.transitionToTrack(next.uri)

    expect(sessionManager.getRecentPositiveAnchors().map((candidate) => candidate.uri)).toEqual(
      candidates.slice(1).map((candidate) => candidate.uri)
    )
  })

  it("persists only the last nine encountered familiarity classifications", () => {
    sessionManager.startSession(seed)
    const candidates = Array.from({ length: 11 }, (_, index) => ({
      uri: `spotify:track:familiarity-${index}`,
      artistUri: `spotify:artist:familiarity-${index}`,
    }))
    sessionManager.setPools(
      candidates.filter((_, index) => index % 2 === 0),
      candidates.filter((_, index) => index % 2 === 1)
    )
    sessionManager.setQueuedUris(candidates.map((candidate) => candidate.uri))
    for (let index = 0; index < 11; index += 1) {
      sessionManager.recordEncounteredFamiliarity(candidates[index].uri)
    }

    expect(sessionManager.getFamiliarityLedger()).toHaveLength(9)
    expect(sessionManager.getFamiliarityLedger()[0]).toBe("discovery")
  })

  it("does not count unplayed future queue entries toward discovery history", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      uri: `spotify:track:future-${index}`,
      artistUri: `spotify:artist:future-${index}`,
    }))
    sessionManager.startSession(seed)
    sessionManager.setPools(candidates, [])
    sessionManager.setQueuedUris(candidates.map((candidate) => candidate.uri))

    expect(sessionManager.getFamiliarityLedger()).toEqual([])
    sessionManager.transitionToTrack(candidates[0].uri)
    expect(sessionManager.getFamiliarityLedger()).toEqual(["discovery"])
  })

  it("learns a repeat-one wrap as positive evidence without advancing", () => {
    const repeated = { uri: "spotify:track:repeat", artistUri: "spotify:artist:repeat" }
    sessionManager.startSession(seed)
    sessionManager.registerCandidates([repeated])
    sessionManager.setQueuedUris([repeated.uri])
    sessionManager.transitionToTrack(repeated.uri)
    sessionManager.recordTrackPlayed(repeated.uri)
    const positionBeforeRepeat = sessionManager.getPosition()

    sessionManager.recordProgress(110_000, 120_000, true)
    const result = sessionManager.recordProgress(1_000, 120_000, true)

    expect(result.repeated).toBe(true)
    expect(sessionManager.getPosition()).toBe(positionBeforeRepeat)
    expect(sessionManager.getRecentPositiveAnchors().map((candidate) => candidate.uri)).toContain(
      repeated.uri
    )
  })

  it("isolates confirmed play history when the Spotify account changes", async () => {
    memory.clear()
    const cosmosGet = vi.fn(async () => ({ account_id: "account-a" }))
    ;(globalThis as unknown as {
      Spicetify: { CosmosAsync: { get: typeof cosmosGet } }
    }).Spicetify.CosmosAsync = { get: cosmosGet }
    expect(await sessionManager.initializeTasteIdentity()).toBe("account-a")

    const first = { uri: "spotify:track:account-a", artistUri: "spotify:artist:a" }
    sessionManager.startSession(seed)
    sessionManager.registerCandidates([first])
    sessionManager.setQueuedUris([first.uri])
    expect(sessionManager.confirmPlayback(first.uri)).toBe(true)

    cosmosGet.mockResolvedValue({ account_id: "account-b" })
    expect(await sessionManager.initializeTasteIdentity()).toBe("account-b")
    expect(sessionManager.getPlayHistory()).toEqual([])

    const second = { uri: "spotify:track:account-b", artistUri: "spotify:artist:b" }
    sessionManager.startSession(seed)
    sessionManager.registerCandidates([second])
    sessionManager.setQueuedUris([second.uri])
    expect(sessionManager.confirmPlayback(second.uri)).toBe(true)

    expect(JSON.parse(memory.get("shuffleSimilar:playHistory:account:account-a") ?? "[]"))
      .toEqual([first.uri])
    expect(JSON.parse(memory.get("shuffleSimilar:playHistory:account:account-b") ?? "[]"))
      .toEqual([second.uri])
  })
})
