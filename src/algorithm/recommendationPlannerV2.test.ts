import { describe, expect, it, vi } from "vitest"
import {
  TASTE_PROFILE_SCHEMA_VERSION,
  type TasteProfileState,
} from "../profile/tasteProfile"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { attachSourceProvenance } from "../sources/provenance"
import type { SmartConfig } from "../storage/settings"
import { buildPlaylistBatch, buildSinglePoolBatch, buildTrackBatch } from "./progressiveBlend"
import { getRecommendationDiagnostics } from "./recommendationPlannerV2"
import { rankCandidatesV2, type RankableCandidate, type SkipSignal } from "./rankingV2"

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed Song",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed",
  albumUri: "spotify:album:seed",
  genres: ["indie pop"],
  popularity: 62,
  releaseYear: 2022,
  tempo: 120,
  energy: 0.68,
  valence: 0.57,
  danceability: 0.65,
}

const settings: SmartConfig = {
  eraWindow: 3,
  artistSpacing: 3,
  refillThreshold: 3,
  initialQueueSize: 50,
  excludeSeedArtistEarly: true,
  historyPenaltyWindow: 200,
  deprioritizePopular: true,
  matchTempo: true,
  matchEnergy: true,
  matchValence: true,
  blendPhases: [
    { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
    { maxPosition: 9, similarWeight: 0.7, profileWeight: 0.3 },
    { maxPosition: 19, similarWeight: 0.4, profileWeight: 0.6 },
    { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.2, profileWeight: 0.8 },
  ],
}

const familyPool = (family: "similar" | "profile", count: number): TrackCandidate[] =>
  Array.from({ length: count }, (_, index) => ({
    uri: `spotify:track:${family}-${index}`,
    trackName: `${family} track ${index}`,
    artistUri: `spotify:artist:${family}-${index}`,
    artistName: `${family} artist ${index}`,
    albumUri: `spotify:album:${family}-${index}`,
    popularity: 20 + ((index * 11) % 70),
    releaseYear: 2019 + (index % 5),
    tempo: 112 + (index % 7) * 2,
    energy: 0.52 + (index % 5) * 0.06,
    valence: 0.42 + (index % 4) * 0.08,
    danceability: 0.55 + (index % 3) * 0.08,
  }))

describe("production Similar Mix v2 integration", () => {
  it("buildTrackBatch is deterministic and returns v2 planning diagnostics", () => {
    const similar = familyPool("similar", 18)
    const profile = familyPool("profile", 18)

    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.999)
    const first = buildTrackBatch(seed, 0, [], similar, profile, settings, 16)
    const second = buildTrackBatch(seed, 0, [], similar, profile, settings, 16)
    vi.restoreAllMocks()

    expect(second.map((track) => track.uri)).toEqual(first.map((track) => track.uri))
    expect(getRecommendationDiagnostics(first)).toMatchObject({
      engine: "ranking-v2",
      mode: "track",
      requestedCount: 16,
      selectedCount: first.length,
    })
    expect(getRecommendationDiagnostics(first)?.normalizedArtistEntropy).toBeGreaterThan(0.9)
  })

  it("buildPlaylistBatch uses playlist context provenance and v2 slate constraints", () => {
    const playlist = familyPool("profile", 6).map((track, index) => ({
      ...track,
      uri: `spotify:track:playlist-${index}`,
      tempo: 118 + index,
      energy: 0.6 + index * 0.01,
      valence: 0.5 + index * 0.01,
    }))
    const candidates = familyPool("similar", 24).map((track, index) => ({
      ...track,
      trackName: index === 1 ? "similar track 0 - Remastered 2025" : track.trackName,
      tempo: 117 + (index % 8),
      energy: 0.57 + (index % 6) * 0.025,
      valence: 0.47 + (index % 5) * 0.025,
    }))

    const batch = buildPlaylistBatch(playlist, candidates, [], [], settings, 12)
    const diagnostics = getRecommendationDiagnostics(batch)

    expect(batch).toHaveLength(12)
    expect(batch.every((track) => !track.uri.includes("playlist-"))).toBe(true)
    expect(diagnostics).toMatchObject({
      engine: "ranking-v2",
      mode: "playlist",
      slate: {
        canonicalDuplicateViolations: 0,
        artistSpacingViolations: 0,
        albumSpacingViolations: 0,
      },
    })
    expect(diagnostics?.slate.sourceCoverage).toBeGreaterThanOrEqual(2)
    expect(diagnostics?.normalizedArtistEntropy).toBeGreaterThan(0.9)
  })

  it("fuses real discovery-source provenance instead of flattening it to one pool", () => {
    const singleSource = attachSourceProvenance(
      { ...familyPool("similar", 1)[0], uri: "spotify:track:single-source" },
      "recommendations"
    )
    const consensus = attachSourceProvenance(
      attachSourceProvenance(
        { ...familyPool("similar", 1)[0], uri: "spotify:track:consensus" },
        "radio"
      ),
      "inspired-by"
    )

    const batch = buildTrackBatch(
      seed,
      0,
      [],
      [singleSource, consensus],
      [],
      { ...settings, deprioritizePopular: false },
      1
    )

    expect(batch.map((track) => track.uri)).toEqual(["spotify:track:consensus"])
    expect(getRecommendationDiagnostics(batch)?.slate.sourceCoverage).toBe(2)
  })

  it("carries artist, album, and acoustic constraints across a refill boundary", () => {
    const tail: TrackCandidate = {
      uri: "spotify:track:tail",
      trackName: "Tail",
      artistUri: "spotify:artist:tail",
      albumUri: "spotify:album:tail",
      tempo: 120,
      energy: 0.65,
      valence: 0.55,
    }
    const candidates: TrackCandidate[] = [
      tail,
      { ...tail, uri: "spotify:track:artist-repeat", albumUri: "spotify:album:a" },
      {
        ...tail,
        uri: "spotify:track:album-repeat",
        artistUri: "spotify:artist:b",
      },
      {
        ...tail,
        uri: "spotify:track:acoustic-jump",
        artistUri: "spotify:artist:c",
        albumUri: "spotify:album:c",
        tempo: 200,
        energy: 0.05,
        valence: 0.05,
      },
      {
        ...tail,
        uri: "spotify:track:boundary-safe",
        artistUri: "spotify:artist:d",
        albumUri: "spotify:album:d",
        tempo: 122,
      },
    ]

    const batch = buildTrackBatch(seed, 5, [tail.uri], candidates, [], settings, 1)

    expect(batch.map((track) => track.uri)).toEqual(["spotify:track:boundary-safe"])
    expect(getRecommendationDiagnostics(batch)?.slate).toMatchObject({
      artistSpacingViolations: 0,
      albumSpacingViolations: 0,
      acousticTransitionViolations: 0,
    })
  })

  it("buildTrackBatch immediately moves away from skipped taste evidence", () => {
    const skippedNeighbor: TrackCandidate = {
      uri: "spotify:track:skipped-neighbor",
      trackName: "Skipped Neighbor",
      artistUri: "spotify:artist:skipped",
      albumUri: "spotify:album:skipped",
      tempo: 120,
      energy: 0.7,
      valence: 0.6,
    }
    const alternative: TrackCandidate = {
      ...skippedNeighbor,
      uri: "spotify:track:alternative",
      trackName: "Alternative",
      artistUri: "spotify:artist:alternative",
      albumUri: "spotify:album:alternative",
      tempo: 148,
      energy: 0.52,
      valence: 0.43,
    }
    const before = buildTrackBatch(
      seed,
      0,
      [],
      [skippedNeighbor, alternative],
      [],
      settings,
      1
    )
    const after = buildTrackBatch(
      seed,
      0,
      [],
      [skippedNeighbor, alternative],
      [],
      {
        ...settings,
        skipFeedback: [{
          artistUri: skippedNeighbor.artistUri,
          profile: { tempo: 120, energy: 0.7, valence: 0.6 },
        }],
      },
      1
    )

    expect(before[0].uri).toBe(skippedNeighbor.uri)
    expect(after[0].uri).toBe(alternative.uri)
    expect(getRecommendationDiagnostics(after)?.rankReasons["rank:skip-penalized"]).toBeGreaterThanOrEqual(1)
  })

  it("bounds aggregate skip evidence instead of multiplying it toward zero", () => {
    const candidate: RankableCandidate = {
      uri: "spotify:track:repeat-evidence",
      title: "Repeat Evidence",
      artistUris: ["spotify:artist:skipped"],
      albumUri: "spotify:album:repeat-evidence",
      acoustic: { tempo: 120, energy: 0.7, valence: 0.6 },
      provenance: [{ source: "radio", family: "similar", rank: 1 }],
    }
    const signal: SkipSignal = {
      artistUris: ["spotify:artist:skipped"],
      acoustic: { tempo: 120, energy: 0.7, valence: 0.6 },
      confidence: 1,
    }
    const one = rankCandidatesV2([candidate], { skipSignals: [signal] })[0]
    const repeated = rankCandidatesV2([candidate], {
      skipSignals: Array.from({ length: 100 }, () => signal),
    })[0]

    expect(one.breakdown.values.feedback).toBeGreaterThanOrEqual(0.1)
    expect(repeated.breakdown.values.feedback).toBe(one.breakdown.values.feedback)
  })

  it("uses a mature persistent taste profile in the real track-batch path", () => {
    const now = 50_000
    const tasteProfile: TasteProfileState = {
      version: TASTE_PROFILE_SCHEMA_VERSION,
      updatedAt: now,
      signals: {
        tracks: Array.from({ length: 4 }, (_, index) => ({
          key: `spotify:track:history-${index}`,
          sentiment: 1 as const,
          strength: 1,
          occurredAt: now,
        })),
        artists: [
          { key: "spotify:artist:negative", sentiment: -1, strength: 1, occurredAt: now },
          { key: "spotify:artist:positive", sentiment: 1, strength: 1, occurredAt: now },
          { key: "spotify:artist:positive", sentiment: 1, strength: 1, occurredAt: now },
        ],
        genres: [],
        acousticPositive: [],
        acousticNegative: [],
      },
    }
    const negative: TrackCandidate = {
      ...familyPool("similar", 1)[0],
      uri: "spotify:track:negative",
      artistUri: "spotify:artist:negative",
    }
    const positive: TrackCandidate = {
      ...negative,
      uri: "spotify:track:positive",
      artistUri: "spotify:artist:positive",
    }

    const batch = buildTrackBatch(
      seed,
      0,
      [],
      [negative, positive],
      [],
      { ...settings, tasteProfile, tasteProfileNow: now },
      1
    )

    expect(batch[0].uri).toBe(positive.uri)
    expect(getRecommendationDiagnostics(batch)?.rankReasons["rank:multi-source"]).toBeGreaterThanOrEqual(1)
    expect(getRecommendationDiagnostics(batch)?.slate.sourceCoverage).toBeGreaterThanOrEqual(2)
  })

  it("uses the observed popularity distribution without inventing missing values", () => {
    const chartHit: TrackCandidate = {
      ...familyPool("similar", 1)[0],
      uri: "spotify:track:chart-hit",
      trackName: "Chart Hit",
      artistUri: "spotify:artist:chart-hit",
      albumUri: "spotify:album:chart-hit",
      popularity: 95,
    }
    const discoveryFit: TrackCandidate = {
      ...chartHit,
      uri: "spotify:track:discovery-fit",
      trackName: "Discovery Fit",
      artistUri: "spotify:artist:discovery-fit",
      albumUri: "spotify:album:discovery-fit",
      popularity: 35,
    }
    const missingPopularity: TrackCandidate = {
      ...chartHit,
      uri: "spotify:track:missing-popularity",
      trackName: "Missing Popularity",
      artistUri: "spotify:artist:missing-popularity",
      albumUri: "spotify:album:missing-popularity",
      popularity: undefined,
    }

    const chosen = buildTrackBatch(
      seed,
      0,
      [],
      [chartHit, discoveryFit],
      [],
      { ...settings, deprioritizePopular: true },
      1
    )
    const complete = buildTrackBatch(
      seed,
      0,
      [],
      [chartHit, discoveryFit, missingPopularity],
      [],
      { ...settings, deprioritizePopular: true },
      3
    )

    expect(chosen[0].uri).toBe(discoveryFit.uri)
    expect(getRecommendationDiagnostics(complete)?.popularity).toMatchObject({
      knownRatio: 2 / 3,
    })
    expect(getRecommendationDiagnostics(complete)?.popularity.mean).toBe(65)
  })

  it("keeps sparse partial-metadata tracks distinct and degrades safely on a thin pool", () => {
    const sparse = Array.from({ length: 12 }, (_, index) => ({
      uri: `spotify:track:sparse-${index}`,
    }))
    const sparseBatch = buildTrackBatch(seed, 0, [], sparse, [], settings, 10)
    expect(sparseBatch).toHaveLength(10)
    expect(new Set(sparseBatch.map((track) => track.uri)).size).toBe(10)
    expect(getRecommendationDiagnostics(sparseBatch)).toMatchObject({
      metadataCompleteness: 0,
      slate: { canonicalDuplicateViolations: 0 },
    })

    const thin = [
      {
        uri: "spotify:track:thin-a",
        artistUri: "spotify:artist:thin",
        albumUri: "spotify:album:thin",
      },
      {
        uri: "spotify:track:thin-b",
        artistUri: "spotify:artist:thin",
        albumUri: "spotify:album:thin",
      },
    ]
    const thinBatch = buildTrackBatch(seed, 0, [], thin, [], settings, 8)
    expect(thinBatch).toHaveLength(2)
    expect(getRecommendationDiagnostics(thinBatch)).toMatchObject({
      requestedCount: 8,
      selectedCount: 2,
    })
    expect(getRecommendationDiagnostics(thinBatch)?.slate.relaxedTrackCount).toBeGreaterThan(0)
  })

  it("routes artist-discography and single-pool fallback modes through v2", () => {
    const similar = familyPool("similar", 6)
    const discography = familyPool("profile", 5).map((track, index) => ({
      ...track,
      uri: `spotify:track:discography-${index}`,
      artistUri: seed.artistUri,
      artistName: seed.artistName,
    }))
    const artistBatch = buildTrackBatch(seed, 0, [], similar, discography, settings, 8)
    expect(getRecommendationDiagnostics(artistBatch)?.mode).toBe("artist")
    expect(artistBatch.some((track) => track.uri.includes("discography-"))).toBe(true)

    const fallbackBatch = buildSinglePoolBatch(seed, similar, [], settings, 4)
    expect(fallbackBatch).toHaveLength(4)
    expect(getRecommendationDiagnostics(fallbackBatch)).toMatchObject({
      engine: "ranking-v2",
      mode: "single",
    })

    const albumBatch = buildPlaylistBatch(
      familyPool("profile", 3),
      similar,
      [],
      [],
      settings,
      4,
      0,
      "album"
    )
    expect(getRecommendationDiagnostics(albumBatch)?.mode).toBe("album")
  })

  it("applies progressive blend phases from the absolute production position", () => {
    const batch = buildTrackBatch(
      seed,
      20,
      [],
      familyPool("similar", 20),
      familyPool("profile", 20),
      settings,
      10
    )
    const diagnostics = getRecommendationDiagnostics(batch)

    expect(batch).toHaveLength(10)
    expect(diagnostics?.slate.profileCount).toBeGreaterThanOrEqual(7)
    expect(diagnostics?.slate.similarCount).toBeLessThanOrEqual(3)
  })
})
