import { beforeAll, describe, expect, it, vi } from "vitest"
import { feedbackWeight, normalizeTempo, playlistAffinityWeight } from "./filters"
import { buildTrackBatch, buildPlaylistBatch, getBlendWeights } from "./progressiveBlend"
import { getSmartConfig } from "../storage/settings"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { sessionManager } from "../session/SessionManager"

beforeAll(() => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    LocalStorage: {
      get: () => null,
      set: () => undefined,
      remove: () => undefined,
      clear: () => undefined,
    },
  }
})

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed",
  releaseYear: 2004,
  popularity: 90,
  genres: [],
  tempo: 120,
  energy: 0.7,
  valence: 0.6,
}

describe("automatic recommendation scoring", () => {
  it("scores a playlist candidate against its nearest playlist references", () => {
    const close: TrackCandidate = {
      uri: "spotify:track:close",
      tempo: 120,
      energy: 0.7,
      valence: 0.6,
    }
    const far: TrackCandidate = {
      uri: "spotify:track:far",
      tempo: 200,
      energy: 0.1,
      valence: 0.1,
    }
    const playlist = [
      { uri: "spotify:track:a", tempo: 120, energy: 0.7, valence: 0.6 },
      { uri: "spotify:track:b", tempo: 122, energy: 0.68, valence: 0.62 },
    ]
    expect(playlistAffinityWeight(close, playlist)).toBeGreaterThan(playlistAffinityWeight(far, playlist))
  })

  it("never returns tracks already present in playlist mode", () => {
    const playlist: TrackCandidate[] = [{ uri: "spotify:track:existing", tempo: 120, energy: 0.7, valence: 0.6 }]
    const pool: TrackCandidate[] = [
      ...playlist,
      { uri: "spotify:track:new", artistUri: "spotify:artist:new", tempo: 121, energy: 0.7, valence: 0.6 },
    ]
    const result = buildPlaylistBatch(playlist, pool, [], [], getSmartConfig(seed), 5)
    expect(result.map((track) => track.uri)).toEqual(["spotify:track:new"])
  })

  it("normalizes tempo to the shared 0-1 feature scale", () => {
    expect(normalizeTempo(50)).toBe(0)
    expect(normalizeTempo(125)).toBe(0.5)
    expect(normalizeTempo(200)).toBe(1)
    expect(normalizeTempo(240)).toBe(1)
  })

  it("strongly penalizes the artist and acoustic profile of a skipped track", () => {
    const candidate: TrackCandidate = {
      uri: "spotify:track:candidate",
      artistUri: "spotify:artist:skipped",
      tempo: 121,
      energy: 0.71,
      valence: 0.59,
    }
    const weight = feedbackWeight(candidate, [{
      artistUri: "spotify:artist:skipped",
      profile: { tempo: 120, energy: 0.7, valence: 0.6 },
    }])
    expect(weight).toBeCloseTo(0.025)
  })

  it("uses the expected progressive blend phases", () => {
    const settings = getSmartConfig(seed)
    expect(settings.initialQueueSize).toBe(50)
    expect(settings.deprioritizePopular).toBe(false)
    expect(getBlendWeights(4, settings)).toEqual({ similarWeight: 1, profileWeight: 0 })
    expect(getBlendWeights(5, settings)).toEqual({ similarWeight: 0.7, profileWeight: 0.3 })
    expect(getBlendWeights(20, settings)).toEqual({ similarWeight: 0.2, profileWeight: 0.8 })
  })

  it("learns an early skip but not a substantially played track", () => {
    const skipped: TrackCandidate = {
      uri: "spotify:track:skipped",
      artistUri: "spotify:artist:skipped",
      tempo: 130,
      energy: 0.8,
    }
    const next = { uri: "spotify:track:next", artistUri: "spotify:artist:next" }
    const another = { uri: "spotify:track:another", artistUri: "spotify:artist:another" }
    sessionManager.startSession(seed)
    sessionManager.setPools([skipped, next, another], [])
    sessionManager.setQueuedUris([skipped.uri, next.uri, another.uri])
    sessionManager.transitionToTrack(skipped.uri)
    sessionManager.recordProgress(12_000, 180_000)
    sessionManager.transitionToTrack(next.uri)
    expect(sessionManager.getSkipFeedback()).toHaveLength(1)

    sessionManager.recordProgress(90_000, 180_000)
    sessionManager.transitionToTrack(another.uri)
    expect(sessionManager.getSkipFeedback()).toHaveLength(1)
    sessionManager.endSession()
  })

  it("preserves artist spacing in the returned queue", () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const pool: TrackCandidate[] = Array.from({ length: 12 }, (_, index) => ({
      uri: `spotify:track:${index}`,
      artistUri: `spotify:artist:${index % 4}`,
      albumUri: `spotify:album:${index}`,
      tempo: 120,
      energy: 0.7,
      valence: 0.6,
    }))
    const result = buildTrackBatch(seed, 0, [], pool, [], getSmartConfig(seed), 8)
    for (let index = 1; index < result.length; index += 1) {
      const recentArtists = result.slice(Math.max(0, index - 3), index).map((track) => track.artistUri)
      expect(recentArtists).not.toContain(result[index].artistUri)
    }
    vi.restoreAllMocks()
  })

  it("advances blend phases inside a single batch instead of freezing at its start", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    const similar = Array.from({ length: 10 }, (_, index) => ({
      uri: `spotify:track:similar-${index}`,
      artistUri: `spotify:artist:similar-${index}`,
    }))
    const profile = Array.from({ length: 10 }, (_, index) => ({
      uri: `spotify:track:profile-${index}`,
      artistUri: `spotify:artist:profile-${index}`,
    }))

    const result = buildTrackBatch(seed, 0, [], similar, profile, getSmartConfig(seed), 10)

    expect(result.slice(0, 4).every((track) => track.uri.includes("similar-"))).toBe(true)
    expect(result.slice(4).some((track) => track.uri.includes("profile-"))).toBe(true)
    vi.restoreAllMocks()
  })
})
