import { describe, expect, it, vi } from "vitest"
import { TASTE_PROFILE_SCHEMA_VERSION, type TasteProfileState } from "../profile/tasteProfile"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { attachSourceProvenance } from "../sources/provenance"
import { getSmartConfig, type SmartConfig } from "../storage/settings"
import { filterProfilePoolForSeedCoherence, scoreGenreCompatibility } from "./genreAffinity"
import { buildPlaylistBatch, buildSinglePoolBatch, buildTrackBatch } from "./progressiveBlend"
import {
  canonicalKeysForTrack,
  type RankableCandidate,
  rankCandidatesV2,
  type SkipSignal,
} from "./rankingV2"
import { getRecommendationDiagnostics } from "./recommendationPlannerV2"

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
    const before = buildTrackBatch(seed, 0, [], [skippedNeighbor, alternative], [], settings, 1)
    const after = buildTrackBatch(
      seed,
      0,
      [],
      [skippedNeighbor, alternative],
      [],
      {
        ...settings,
        skipFeedback: [
          {
            artistUri: skippedNeighbor.artistUri,
            profile: { tempo: 120, energy: 0.7, valence: 0.6 },
          },
        ],
      },
      1
    )

    expect(before[0].uri).toBe(skippedNeighbor.uri)
    expect(after[0].uri).toBe(alternative.uri)
    expect(
      getRecommendationDiagnostics(after)?.rankReasons["rank:skip-penalized"]
    ).toBeGreaterThanOrEqual(1)
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
    expect(
      getRecommendationDiagnostics(batch)?.rankReasons["rank:multi-source"]
    ).toBeGreaterThanOrEqual(1)
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

  it("keeps the discovery floor above the late profile-heavy blend", () => {
    const profile = familyPool("profile", 20)
    const batch = buildTrackBatch(
      seed,
      20,
      [],
      familyPool("similar", 20),
      profile,
      settings,
      10,
      profile.map((track) => track.uri)
    )
    const diagnostics = getRecommendationDiagnostics(batch)

    expect(batch).toHaveLength(10)
    expect(diagnostics?.slate.discoveryEligibleCount).toBeGreaterThanOrEqual(4)
    expect(diagnostics?.slate.profileCount).toBeLessThanOrEqual(6)
  })

  it("produces completely disjoint, genre-faithful mixes for Gracie Abrams vs. Pardyalone even with a shared mixed library", () => {
    const gracieSeed: SeedMetadata = {
      uri: "spotify:track:gracie-here-you-come",
      trackId: "gracie-here-you-come",
      trackName: "Here You Come, There You Go",
      artistName: "Gracie Abrams",
      artistUri: "spotify:artist:gracie-abrams",
      albumUri: "spotify:album:gracie-secret-of-us",
      albumName: "The Secret of Us",
      genres: ["alt z", "indie pop", "singer-songwriter pop"],
      popularity: 78,
      releaseYear: 2026,
      tempo: 108,
      energy: 0.42,
      valence: 0.36,
      danceability: 0.56,
      acousticness: 0.68,
      instrumentalness: 0.0,
    }

    const pardyaloneSeed: SeedMetadata = {
      uri: "spotify:track:pardyalone-she-likes-my-tattoos",
      trackId: "pardyalone-she-likes-my-tattoos",
      trackName: "She Likes My Tattoos",
      artistName: "Pardyalone",
      artistUri: "spotify:artist:pardyalone",
      albumUri: "spotify:album:pardyalone-single",
      albumName: "She Likes My Tattoos",
      genres: ["emo rap", "melodic rap"],
      popularity: 61,
      releaseYear: 2025,
      tempo: 146,
      energy: 0.74,
      valence: 0.34,
      danceability: 0.72,
      acousticness: 0.14,
      instrumentalness: 0.0,
    }

    const indieSimilar: TrackCandidate[] = Array.from({ length: 12 }, (_, i) =>
      attachSourceProvenance(
        {
          uri: `spotify:track:indie-sim-${i}`,
          trackName: `Indie Ballad ${i}`,
          artistUri: `spotify:artist:indie-peer-${i}`,
          artistName: `Indie Peer ${i}`,
          albumUri: `spotify:album:indie-alb-${i}`,
          albumName: `Quiet Nights ${i}`,
          genres: i % 2 === 0 ? ["indie pop", "singer-songwriter"] : ["indie folk", "chamber pop"],
          popularity: 58 + (i % 15),
          releaseYear: 2023 + (i % 4),
          tempo: 102 + (i % 6) * 3,
          energy: 0.36 + (i % 4) * 0.05,
          valence: 0.32 + (i % 4) * 0.05,
          danceability: 0.52,
          acousticness: 0.64,
          instrumentalness: 0.01,
        },
        i % 2 === 0 ? "radio" : "inspired-by"
      )
    )

    const emoRapSimilar: TrackCandidate[] = Array.from({ length: 12 }, (_, i) =>
      attachSourceProvenance(
        {
          uri: `spotify:track:emorap-sim-${i}`,
          trackName: `Midnight Tattoos ${i}`,
          artistUri: `spotify:artist:emorap-peer-${i}`,
          artistName: `Melodic Rap Peer ${i}`,
          albumUri: `spotify:album:emorap-alb-${i}`,
          albumName: `Late Drive ${i}`,
          genres: i % 2 === 0 ? ["emo rap", "melodic rap"] : ["pop rap", "trap"],
          popularity: 54 + (i % 18),
          releaseYear: 2022 + (i % 4),
          tempo: 140 + (i % 6) * 3,
          energy: 0.7 + (i % 4) * 0.05,
          valence: 0.3 + (i % 4) * 0.05,
          danceability: 0.7,
          acousticness: 0.12,
          instrumentalness: 0.0,
        },
        i % 2 === 0 ? "radio" : "related-artists"
      )
    )

    // Noisy candidates that might pollute a broad search or user library:
    const noisyIntrusions: TrackCandidate[] = [
      {
        uri: "spotify:track:gracie-remaster-dup",
        trackName: "Here You Come, There You Go (Deluxe Edition)",
        artistUri: "spotify:artist:gracie-abrams",
        artistName: "Gracie Abrams",
        albumUri: "spotify:album:gracie-deluxe",
        genres: ["indie pop"],
      },
      {
        uri: "spotify:track:gracie-sped-up",
        trackName: "Indie Ballad (Sped Up / Nightcore)",
        artistUri: "spotify:artist:nightcore-uploader",
        artistName: "Nightcore Uploader",
        albumUri: "spotify:album:sped-up",
        genres: ["indie pop"],
      },
      {
        uri: "spotify:track:movie-score-intruder",
        trackName: "Main Title Theme",
        artistUri: "spotify:artist:film-composer",
        artistName: "Film Composer",
        albumUri: "spotify:album:ost",
        albumName: "Dune (Original Motion Picture Soundtrack)",
        genres: ["soundtrack", "orchestral soundtrack"],
        popularity: 68,
        instrumentalness: 0.88,
      },
      {
        uri: "spotify:track:deathcore-intruder",
        trackName: "Abyssal Breakdown",
        artistUri: "spotify:artist:deathcore-band",
        artistName: "Deathcore Band",
        albumUri: "spotify:album:brutal",
        genres: ["deathcore", "folk metal"],
        tempo: 185,
        energy: 0.98,
        acousticness: 0.01,
      },
    ]

    // Shared user library containing BOTH indie-folk favorites AND emo-rap favorites + noise:
    const sharedUserLibrary: TrackCandidate[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        attachSourceProvenance(
          {
            uri: `spotify:track:lib-indie-${i}`,
            trackName: `Saved Indie Song ${i}`,
            artistUri: `spotify:artist:lib-indie-${i}`,
            artistName: `Saved Indie Artist ${i}`,
            albumUri: `spotify:album:lib-indie-${i}`,
            genres: ["indie folk", "singer-songwriter"],
            popularity: 55,
            releaseYear: 2024,
            tempo: 106,
            energy: 0.4,
            valence: 0.38,
            acousticness: 0.7,
            instrumentalness: 0.0,
          },
          "liked-tracks"
        )
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        attachSourceProvenance(
          {
            uri: `spotify:track:lib-emorap-${i}`,
            trackName: `Saved Emo Rap Song ${i}`,
            artistUri: `spotify:artist:lib-emorap-${i}`,
            artistName: `Saved Emo Rap Artist ${i}`,
            albumUri: `spotify:album:lib-emorap-${i}`,
            genres: ["emo rap", "melodic rap"],
            popularity: 56,
            releaseYear: 2024,
            tempo: 144,
            energy: 0.75,
            valence: 0.35,
            acousticness: 0.12,
            instrumentalness: 0.0,
          },
          "liked-tracks"
        )
      ),
      ...noisyIntrusions,
    ]

    const gracieCoherentProfile = filterProfilePoolForSeedCoherence(
      sharedUserLibrary,
      gracieSeed,
      indieSimilar
    )
    const pardyCoherentProfile = filterProfilePoolForSeedCoherence(
      sharedUserLibrary,
      pardyaloneSeed,
      emoRapSimilar
    )

    const gracieMix = buildTrackBatch(
      gracieSeed,
      0,
      [gracieSeed.uri],
      [...indieSimilar, ...emoRapSimilar.slice(0, 3), ...noisyIntrusions],
      gracieCoherentProfile,
      getSmartConfig(gracieSeed),
      12
    )

    const pardyMix = buildTrackBatch(
      pardyaloneSeed,
      0,
      [pardyaloneSeed.uri],
      [...emoRapSimilar, ...indieSimilar.slice(0, 3), ...noisyIntrusions],
      pardyCoherentProfile,
      getSmartConfig(pardyaloneSeed),
      12
    )

    expect(gracieMix).toHaveLength(12)
    expect(pardyMix).toHaveLength(12)

    const gracieUris = new Set(gracieMix.map((track) => track.uri))
    const pardyUris = new Set(pardyMix.map((track) => track.uri))

    // Zero overlap between Gracie Abrams's mix and Pardyalone's mix:
    const overlap = [...gracieUris].filter((uri) => pardyUris.has(uri))
    expect(overlap).toEqual([])

    // Zero cross-genre intrusions, soundtracks, sped-up junk, or canonical seed duplicates:
    for (const track of gracieMix) {
      expect(track.uri).not.toMatch(/emorap|deathcore|movie-score|sped-up|remaster-dup/)
      const compat = scoreGenreCompatibility(gracieSeed.genres, track.genres)
      expect(compat).not.toBeNull()
      expect(compat ?? 0).toBeGreaterThanOrEqual(0.45)
    }

    for (const track of pardyMix) {
      expect(track.uri).not.toMatch(/indie|deathcore|movie-score|sped-up|remaster-dup/)
      const compat = scoreGenreCompatibility(pardyaloneSeed.genres, track.genres)
      expect(compat).not.toBeNull()
      expect(compat ?? 0).toBeGreaterThanOrEqual(0.45)
    }
  })

  it("demotes recently played history and rotates top-tier candidates across live exploration runs", () => {
    const pool: TrackCandidate[] = Array.from({ length: 16 }, (_, i) =>
      attachSourceProvenance(
        {
          uri: `spotify:track:peer-${i}`,
          trackName: `Peer Track ${i}`,
          artistUri: `spotify:artist:peer-${i}`,
          artistName: `Peer Artist ${i}`,
          albumUri: `spotify:album:peer-${i}`,
          genres: ["indie pop"],
          popularity: 56 + (i % 4),
          releaseYear: 2023,
          tempo: 118 + (i % 4),
          energy: 0.65,
          valence: 0.55,
          danceability: 0.63,
        },
        "radio"
      )
    )

    const overplayedUris = ["spotify:track:peer-0", "spotify:track:peer-1", "spotify:track:peer-2"]
    const freshFirst = buildTrackBatch(
      seed,
      0,
      [seed.uri],
      pool,
      [],
      getSmartConfig(seed),
      6,
      overplayedUris,
      [],
      [],
      {
        recentHistoryUris: overplayedUris,
        rngSeed: "freshness-check",
      }
    )

    // None of the just-heard tracks should dominate the top of a fresh 6-track selection when 13 equally strong unplayed peers exist.
    expect(freshFirst.slice(0, 5).every((track) => !overplayedUris.includes(track.uri))).toBe(true)

    // Two live sessions with distinct nonces and Boltzmann explorationBand rotate top-tier selections instead of replaying one static list.
    const runA = buildTrackBatch(
      seed,
      0,
      [seed.uri],
      pool,
      [],
      getSmartConfig(seed),
      10,
      [],
      [],
      [],
      {
        rngSeed: "live-session-nonce-a",
        explorationBand: 0.045,
      }
    ).map((track) => track.uri)
    const runB = buildTrackBatch(
      seed,
      0,
      [seed.uri],
      pool,
      [],
      getSmartConfig(seed),
      10,
      [],
      [],
      [],
      {
        rngSeed: "live-session-nonce-b",
        explorationBand: 0.045,
      }
    ).map((track) => track.uri)

    expect(runA).toHaveLength(10)
    expect(runB).toHaveLength(10)
    expect(runA).not.toEqual(runB)
  })

  it("strictly excludes alternate Single/Album/Deluxe/Remaster/Feat URIs of already-played songs via excludedCanonicalKeys", () => {
    const previouslyPlayed = [
      {
        uri: "spotify:track:close-to-you-single",
        trackName: "Close To You - Single Version",
        artistName: "Gracie Abrams",
      },
      {
        uri: "spotify:track:us-album",
        trackName: "us. (feat. Taylor Swift)",
        artistUri: "spotify:artist:gracie-abrams",
        artistName: "Gracie Abrams",
      },
      {
        uri: "spotify:track:that-so-true-orig",
        trackName: "That's So True",
        artistUri: "spotify:artist:gracie-abrams",
      },
    ]
    const excludedCanonicalKeys = previouslyPlayed.flatMap((track) => canonicalKeysForTrack(track))

    const candidatePool: TrackCandidate[] = [
      // Alternate Deluxe upload with artistUri + artistName (single only had artistName):
      {
        uri: "spotify:track:close-to-you-deluxe-999",
        trackName: "Close To You (Deluxe)",
        artistUri: "spotify:artist:gracie-abrams",
        artistName: "Gracie Abrams",
        albumUri: "spotify:album:secret-deluxe",
        genres: ["indie pop"],
      },
      // Alternate clean/base title without "(feat. Taylor Swift)":
      {
        uri: "spotify:track:us-clean-888",
        trackName: "us. - Explicit",
        artistUri: "spotify:artist:gracie-abrams",
        artistName: "Gracie Abrams",
        albumUri: "spotify:album:secret-clean",
        genres: ["indie pop"],
      },
      // Alternate remaster upload matching by artistUri only:
      {
        uri: "spotify:track:thats-so-true-remaster-777",
        trackName: "That's So True - 2026 Remaster",
        artistUri: "spotify:artist:gracie-abrams",
        albumUri: "spotify:album:secret-remaster",
        genres: ["indie pop"],
      },
      // Genuinely unplayed songs:
      {
        uri: "spotify:track:fresh-unplayed-1",
        trackName: "Brand New Song",
        artistUri: "spotify:artist:peer-1",
        artistName: "Phoebe Peer",
        albumUri: "spotify:album:fresh-1",
        genres: ["indie pop"],
      },
      {
        uri: "spotify:track:fresh-unplayed-2",
        trackName: "Never Heard Before",
        artistUri: "spotify:artist:peer-2",
        artistName: "Lizzy Peer",
        albumUri: "spotify:album:fresh-2",
        genres: ["indie pop"],
      },
    ]

    const batch = buildTrackBatch(
      seed,
      0,
      [seed.uri, ...previouslyPlayed.map((t) => t.uri)],
      candidatePool,
      [],
      getSmartConfig(seed),
      10,
      [],
      [],
      [],
      {
        excludedCanonicalKeys,
      }
    )

    expect(batch.map((track) => track.uri)).toEqual(
      expect.arrayContaining(["spotify:track:fresh-unplayed-1", "spotify:track:fresh-unplayed-2"])
    )
    expect(batch).toHaveLength(2)
  })

  it("damps habitual artists in favor of fresh similar artists via habitualArtistKeys", () => {
    const habitualArtistUri = "spotify:artist:habitual-star"
    const freshArtistUri = "spotify:artist:fresh-peer"

    const habitualCandidate: TrackCandidate = attachSourceProvenance(
      attachSourceProvenance(
        {
          uri: "spotify:track:habitual-song",
          trackName: "Habitual Song",
          artistUri: habitualArtistUri,
          artistName: "Habitual Star",
          albumUri: "spotify:album:habitual",
          genres: ["indie pop"],
          popularity: 50,
          tempo: 120,
          energy: 0.68,
          valence: 0.57,
        },
        "radio"
      ),
      "inspired-by"
    )

    const freshCandidate: TrackCandidate = attachSourceProvenance(
      {
        uri: "spotify:track:fresh-song",
        trackName: "Fresh Discovery Song",
        artistUri: freshArtistUri,
        artistName: "Fresh Peer",
        albumUri: "spotify:album:fresh",
        genres: ["indie pop"],
        popularity: 50,
        tempo: 120,
        energy: 0.68,
        valence: 0.57,
      },
      "radio"
    )

    // Without habitual damping: habitual candidate with dual consensus sources ranks first
    const baseline = buildTrackBatch(
      seed,
      0,
      [],
      [habitualCandidate, freshCandidate],
      [],
      settings,
      1,
      [],
      [],
      [],
      { rngSeed: "habitual-test" }
    )
    expect(baseline[0].uri).toBe("spotify:track:habitual-song")

    // With habitualArtistKeys: habitual candidate is damped by 0.62x, elevating the fresh artist
    const damped = buildTrackBatch(
      seed,
      0,
      [],
      [habitualCandidate, freshCandidate],
      [],
      settings,
      1,
      [],
      [],
      [],
      {
        rngSeed: "habitual-test",
        habitualArtistKeys: new Set([habitualArtistUri]),
      }
    )
    expect(damped[0].uri).toBe("spotify:track:fresh-song")
  })

  it("penalizes unplayed songs by a recently played artist via recentArtistKeys", () => {
    const justPlayedArtist = "spotify:artist:just-heard"
    const otherArtist = "spotify:artist:fresh-artist"

    // Candidate song has NEVER been played in history or queue:
    const unplayedByRecentArtist: TrackCandidate = {
      uri: "spotify:track:brand-new-song-by-same-artist",
      trackName: "Brand New Track",
      artistUri: justPlayedArtist,
      artistName: "Just Heard Artist",
      albumUri: "spotify:album:album-a",
      genres: ["indie pop"],
      popularity: 70,
      tempo: 120,
      energy: 0.68,
      valence: 0.57,
    }

    const alternativeCandidate: TrackCandidate = {
      uri: "spotify:track:other-artist-song",
      trackName: "Alternative Artist Track",
      artistUri: otherArtist,
      artistName: "Fresh Artist",
      albumUri: "spotify:album:album-b",
      genres: ["indie pop"],
      popularity: 62,
      tempo: 120,
      energy: 0.68,
      valence: 0.57,
    }

    // With recentArtistKeys marking that artist as just played:
    const batch = buildTrackBatch(
      seed,
      0,
      [],
      [unplayedByRecentArtist, alternativeCandidate],
      [],
      settings,
      1,
      [],
      [],
      [],
      {
        rngSeed: "recent-artist-test",
        recentArtistKeys: [justPlayedArtist],
      }
    )

    // Alternative artist is selected ahead of the unplayed song from the recently heard artist
    expect(batch[0].uri).toBe("spotify:track:other-artist-song")
  })

  it("demotes cross-session over-exposed tracks and artists via exposureMultipliers", () => {
    const overExposedTrack: TrackCandidate = {
      uri: "spotify:track:over-exposed-track",
      trackName: "Over Exposed Track",
      artistUri: "spotify:artist:over-exposed-artist",
      artistName: "Over Exposed Artist",
      albumUri: "spotify:album:over-exposed",
      genres: ["indie pop"],
      popularity: 80,
      tempo: 120,
      energy: 0.68,
      valence: 0.57,
    }

    const freshTrack: TrackCandidate = {
      uri: "spotify:track:fresh-under-exposed-track",
      trackName: "Fresh Under Exposed Track",
      artistUri: "spotify:artist:fresh-artist-2",
      artistName: "Fresh Artist 2",
      albumUri: "spotify:album:fresh-2",
      genres: ["indie pop"],
      popularity: 58,
      tempo: 120,
      energy: 0.68,
      valence: 0.57,
    }

    const exposureMultipliers = new Map<string, number>([
      ["spotify:track:over-exposed-track", 0.12], // heavy multi-session exposure penalty
      ["spotify:track:fresh-under-exposed-track", 1.0], // unexposed
    ])

    const batch = buildTrackBatch(
      seed,
      0,
      [],
      [overExposedTrack, freshTrack],
      [],
      settings,
      1,
      [],
      [],
      [],
      {
        rngSeed: "exposure-multiplier-test",
        exposureMultipliers,
      }
    )

    expect(batch[0].uri).toBe("spotify:track:fresh-under-exposed-track")
  })
})
