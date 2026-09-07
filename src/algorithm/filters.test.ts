import { beforeAll, describe, expect, it, vi } from "vitest"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSmartConfig, type PlayHistoryEntry } from "../storage/settings"
import {
  applyRecentPlayBlackout,
  feedbackWeight,
  normalizeTempo,
  playlistAffinityWeight,
  recentPlayPenalty,
} from "./filters"
import { buildPlaylistBatch, buildTrackBatch, getBlendWeights } from "./progressiveBlend"

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
    expect(playlistAffinityWeight(close, playlist)).toBeGreaterThan(
      playlistAffinityWeight(far, playlist)
    )
  })

  it("never returns tracks already present in playlist mode", () => {
    const playlist: TrackCandidate[] = [
      { uri: "spotify:track:existing", tempo: 120, energy: 0.7, valence: 0.6 },
    ]
    const pool: TrackCandidate[] = [
      ...playlist,
      {
        uri: "spotify:track:new",
        artistUri: "spotify:artist:new",
        tempo: 121,
        energy: 0.7,
        valence: 0.6,
      },
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
    const weight = feedbackWeight(candidate, [
      {
        artistUri: "spotify:artist:skipped",
        profile: { tempo: 120, energy: 0.7, valence: 0.6 },
      },
    ])
    expect(weight).toBeCloseTo(0.025)
  })

  it("uses the expected seed-anchored blend phases", () => {
    const settings = getSmartConfig(seed)
    expect(settings.initialQueueSize).toBe(50)
    expect(settings.deprioritizePopular).toBe(false)
    expect(getBlendWeights(4, settings)).toEqual({ similarWeight: 1, profileWeight: 0 })
    expect(getBlendWeights(5, settings)).toEqual({ similarWeight: 0.85, profileWeight: 0.15 })
    expect(getBlendWeights(10, settings)).toEqual({ similarWeight: 0.75, profileWeight: 0.25 })
    expect(getBlendWeights(20, settings)).toEqual({ similarWeight: 0.7, profileWeight: 0.3 })
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
      const recentArtists = result
        .slice(Math.max(0, index - 3), index)
        .map((track) => track.artistUri)
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

describe("recent-play blackout", () => {
  const now = Date.UTC(2026, 8, 7)
  const DAY = 24 * 60 * 60 * 1_000

  it("hard-excludes tracks played within 14 days", () => {
    const history: PlayHistoryEntry[] = [
      { uri: "spotify:track:fresh", playedAt: now - 3 * DAY },
      { uri: "spotify:track:edge", playedAt: now - 14 * DAY + 1 },
    ]
    // Fillers keep the pool above the 15-survivor relaxation threshold so
    // the blackout actually applies instead of relaxing.
    const fillers = Array.from({ length: 14 }, (_, i) => ({ uri: `spotify:track:filler-${i}` }))
    const result = applyRecentPlayBlackout(
      [
        { uri: "spotify:track:fresh" },
        { uri: "spotify:track:edge" },
        { uri: "spotify:track:never" },
        ...fillers,
      ],
      history,
      now
    )
    const uris = result.map((t) => t.uri)
    expect(uris).not.toContain("spotify:track:fresh")
    expect(uris).not.toContain("spotify:track:edge")
    expect(uris).toContain("spotify:track:never")
    expect(result).toHaveLength(15)
  })

  it("relaxes to penalty-only when fewer than 15 candidates survive", () => {
    const history: PlayHistoryEntry[] = Array.from({ length: 20 }, (_, i) => ({
      uri: `spotify:track:recent-${i}`,
      playedAt: now - i * DAY,
    }))
    const candidates = history.map(({ uri }) => ({ uri }))
    const result = applyRecentPlayBlackout(candidates, history, now)
    expect(result).toHaveLength(20)
  })

  it("penalty is 0.35 at 14 days and decays linearly to 0 at 45 days", () => {
    expect(recentPlayPenalty(now - 14 * DAY, now)).toBeCloseTo(0.35)
    expect(recentPlayPenalty(now - 45 * DAY, now)).toBeCloseTo(0)
    expect(recentPlayPenalty(now - 100 * DAY, now)).toBe(0)
  })

  it("never-played tracks get no penalty", () => {
    expect(recentPlayPenalty(0, now)).toBe(0)
  })
})
