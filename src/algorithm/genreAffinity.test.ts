import { describe, expect, it } from "vitest"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { attachSourceProvenance } from "../sources/provenance"
import { getSmartConfig } from "../storage/settings"
import {
  expandSeedGenresFromGraph,
  filterProfilePoolForSeedCoherence,
  filterSoundtracksAndInstrumentals,
  getParsedGenrePhraseCacheSize,
  hasDisqualifyingTitleMismatch,
  inferSeedGenres,
  isSonicOutlier,
  isSoundtrackSeed,
  isVocalSeed,
  scoreGenreCompatibility,
} from "./genreAffinity"
import { planRecommendationBatchV2 } from "./recommendationPlannerV2"

const gracieSeed: SeedMetadata = {
  uri: "spotify:track:gracie-here-you-come",
  trackId: "gracie-here-you-come",
  trackName: "Here You Come, There You Go",
  artistName: "Gracie Abrams",
  artistUri: "spotify:artist:gracie",
  albumName: "Here You Come, There You Go",
  releaseYear: 2026,
  genres: ["alt z", "indie pop", "singer-songwriter pop"],
  instrumentalness: 0.01,
  energy: 0.36,
  acousticness: 0.74,
  valence: 0.38,
  danceability: 0.52,
  tempo: 112,
}

const pardySeed: SeedMetadata = {
  uri: "spotify:track:pardy-tattoos",
  trackId: "pardy-tattoos",
  trackName: "She Likes My Tattoos",
  artistName: "Pardyalone",
  artistUri: "spotify:artist:pardyalone",
  albumName: "She Likes My Tattoos",
  releaseYear: 2024,
  genres: ["emo rap", "melodic rap"],
  instrumentalness: 0.0,
  energy: 0.68,
  acousticness: 0.18,
  valence: 0.32,
  danceability: 0.69,
  tempo: 140,
}

describe("genreAffinity", () => {
  it("scores Gracie Abrams high against indie-folk/singer-songwriter peers and below 0.20 against Pardyalone, metal, drill, EDM, or classical", () => {
    expect(
      scoreGenreCompatibility(gracieSeed.genres, ["indie folk", "singer-songwriter", "indie pop"])
    ).toBeGreaterThanOrEqual(0.78)
    expect(
      scoreGenreCompatibility(gracieSeed.genres, ["bedroom pop", "indie pop"])
    ).toBeGreaterThanOrEqual(0.8)

    expect(scoreGenreCompatibility(gracieSeed.genres, pardySeed.genres)).toBeLessThan(0.2)
    expect(
      scoreGenreCompatibility(gracieSeed.genres, ["uk drill", "ny drill", "trap"])
    ).toBeLessThan(0.16)
    expect(
      scoreGenreCompatibility(gracieSeed.genres, ["folk metal", "melodic death metal"])
    ).toBeLessThan(0.1)
    expect(
      scoreGenreCompatibility(gracieSeed.genres, ["big room", "progressive electro house"])
    ).toBeLessThan(0.35)
    expect(
      scoreGenreCompatibility(gracieSeed.genres, ["classical", "orchestral soundtrack"])
    ).toBeLessThan(0.1)
  })

  it("scores Pardyalone high against emo/melodic rap peers and below 0.20 against soft indie-folk, country, and classical", () => {
    expect(
      scoreGenreCompatibility(pardySeed.genres, ["emo rap", "melodic rap", "rap"])
    ).toBeGreaterThanOrEqual(0.9)
    expect(
      scoreGenreCompatibility(pardySeed.genres, ["cloud rap", "emo rap"])
    ).toBeGreaterThanOrEqual(0.88)

    expect(
      scoreGenreCompatibility(pardySeed.genres, ["indie folk", "singer-songwriter"])
    ).toBeLessThan(0.12)
    expect(
      scoreGenreCompatibility(pardySeed.genres, ["contemporary country", "honky tonk"])
    ).toBeLessThan(0.12)
    expect(scoreGenreCompatibility(pardySeed.genres, ["classical", "baroque"])).toBeLessThan(0.06)
  })

  it("never creates false genre matches from geographic or temporal noise modifiers", () => {
    expect(
      scoreGenreCompatibility(
        ["modern indie folk", "canadian singer-songwriter"],
        ["modern bollywood", "canadian metal"]
      )
    ).toBeLessThan(0.12)
  })

  it("infers consensus seed genres from high-affinity neighbors when seed genres are empty", () => {
    const inferred = inferSeedGenres({ genres: [] }, [
      attachSourceProvenance(
        {
          uri: "spotify:track:1",
          artistUri: "spotify:artist:phoebe",
          genres: ["indie pop", "indie folk", "la indie"],
        },
        "inspired-by"
      ),
      attachSourceProvenance(
        {
          uri: "spotify:track:2",
          artistUri: "spotify:artist:lizzy",
          genres: ["indie pop", "singer-songwriter", "indie folk"],
        },
        "radio"
      ),
      attachSourceProvenance(
        {
          uri: "spotify:track:3",
          artistUri: "spotify:artist:noah",
          genres: ["singer-songwriter", "indie folk"],
        },
        "related-artists"
      ),
    ])

    expect(inferred).toContain("indie folk")
    expect(inferred).toContain("indie pop")
    expect(inferred).toContain("singer-songwriter")
    expect(inferred).not.toContain("la indie")
  })

  it("rejects karaoke, nightcore, sped-up, and slowed+reverb variants unless seed matches", () => {
    expect(
      hasDisqualifyingTitleMismatch(gracieSeed, {
        trackName: "Close To You - Sped Up Nightcore Version",
      })
    ).toBe(true)
    expect(
      hasDisqualifyingTitleMismatch(gracieSeed, {
        trackName: "I Miss You, I'm Sorry (Karaoke Backing Track)",
      })
    ).toBe(true)
    expect(
      hasDisqualifyingTitleMismatch(
        { trackName: "Track (Slowed + Reverb)" },
        { trackName: "Another Song (Slowed + Reverb)" }
      )
    ).toBe(false)
  })

  it("enforces vocal & soundtrack leakage protection with the high-popularity vocal pop exception", () => {
    const candidates: TrackCandidate[] = [
      {
        uri: "spotify:track:score",
        albumName: "Dune (Original Motion Picture Soundtrack)",
        instrumentalness: 0.88,
        popularity: 72,
      },
      {
        uri: "spotify:track:score-genre",
        albumName: "Main Titles",
        genres: ["orchestral soundtrack", "film score"],
        instrumentalness: 0.15,
        popularity: 45,
      },
      {
        uri: "spotify:track:disney-hit",
        albumName: "Frozen (Original Motion Picture Soundtrack)",
        instrumentalness: 0.01,
        popularity: 81,
      },
      {
        uri: "spotify:track:normal-vocal",
        albumName: "The Secret of Us",
        instrumentalness: 0.02,
        popularity: 75,
      },
    ]

    const kept = filterSoundtracksAndInstrumentals(candidates, true, false)
    expect(kept.map((item) => item.uri)).toEqual([
      "spotify:track:disney-hit",
      "spotify:track:normal-vocal",
    ])
  })

  it("detects extreme sonic outliers when audio features are available", () => {
    expect(
      isSonicOutlier(gracieSeed, {
        energy: 0.96,
        acousticness: 0.01,
        valence: 0.15,
        danceability: 0.35,
        tempo: 185,
        instrumentalness: 0.02,
      })
    ).toBe(true)

    expect(
      isSonicOutlier(gracieSeed, {
        energy: 0.41,
        acousticness: 0.68,
        valence: 0.42,
        danceability: 0.55,
        tempo: 118,
        instrumentalness: 0.01,
      })
    ).toBe(false)
  })

  it("partitions a mixed user profilePool into disjoint coherent tracks for Gracie Abrams vs. Pardyalone", () => {
    const mixedLibrary: TrackCandidate[] = [
      {
        uri: "spotify:track:lib-phoebe",
        artistUri: "spotify:artist:phoebe",
        artistName: "Phoebe Bridgers",
        trackName: "Motion Sickness",
        genres: ["indie pop", "indie folk"],
        energy: 0.42,
        acousticness: 0.66,
      },
      {
        uri: "spotify:track:lib-lizzy",
        artistUri: "spotify:artist:lizzy",
        artistName: "Lizzy McAlpine",
        trackName: "ceilings",
        genres: ["indie folk", "singer-songwriter"],
        energy: 0.35,
        acousticness: 0.71,
      },
      {
        uri: "spotify:track:lib-juice",
        artistUri: "spotify:artist:juice",
        artistName: "Juice WRLD",
        trackName: "Lucid Dreams",
        genres: ["melodic rap", "emo rap"],
        energy: 0.66,
        acousticness: 0.22,
      },
      {
        uri: "spotify:track:lib-laroi",
        artistUri: "spotify:artist:laroi",
        artistName: "The Kid LAROI",
        trackName: "WITHOUT YOU",
        genres: ["melodic rap", "pop rap"],
        energy: 0.64,
        acousticness: 0.21,
      },
      {
        uri: "spotify:track:lib-zimmer",
        artistUri: "spotify:artist:zimmer",
        artistName: "Hans Zimmer",
        trackName: "Time",
        albumName: "Inception (Music from the Motion Picture)",
        genres: ["orchestral soundtrack"],
        instrumentalness: 0.91,
      },
      {
        uri: "spotify:track:lib-slayer",
        artistUri: "spotify:artist:slayer",
        artistName: "Slayer",
        trackName: "Raining Blood",
        genres: ["thrash metal"],
        energy: 0.99,
        acousticness: 0.001,
      },
    ]

    const gracieProfile = filterProfilePoolForSeedCoherence(mixedLibrary, gracieSeed, [
      {
        uri: "spotify:track:sim-noah",
        artistUri: "spotify:artist:noah",
        artistName: "Noah Kahan",
        genres: ["indie folk", "singer-songwriter"],
      },
    ])
    const pardyProfile = filterProfilePoolForSeedCoherence(mixedLibrary, pardySeed, [
      {
        uri: "spotify:track:sim-iann",
        artistUri: "spotify:artist:iann",
        artistName: "iann dior",
        genres: ["emo rap", "melodic rap"],
      },
    ])

    expect(gracieProfile.map((track) => track.uri)).toEqual([
      "spotify:track:lib-phoebe",
      "spotify:track:lib-lizzy",
    ])
    expect(pardyProfile.map((track) => track.uri)).toEqual([
      "spotify:track:lib-juice",
      "spotify:track:lib-laroi",
    ])
  })

  it("works algorithmically on unseen / fictional micro-genres without any hardcoded genre dictionary", () => {
    // Completely invented genre tags that do not exist anywhere in source code:
    const seedTags = ["nebula synthweave", "velvet drift"]
    expect(
      scoreGenreCompatibility(seedTags, ["aurora synthweave", "velvet drift"])
    ).toBeGreaterThan(0.8)
    // Head-modifier role inversion ("synthweave" as modifier on a different head "core") is penalized:
    expect(scoreGenreCompatibility(["nebula synthweave"], ["synthweave core"])).toBeLessThan(0.15)
    // Unrelated invented genres score 0:
    expect(scoreGenreCompatibility(seedTags, ["obsidian pulse", "ironpulse"])).toBe(0)

    // Dynamic graph co-occurrence learns a bridge genre ("lunar shimmer") from >= 2 compatible neighbors:
    const expanded = expandSeedGenresFromGraph({ genres: seedTags }, [
      attachSourceProvenance(
        {
          uri: "spotify:track:n1",
          artistUri: "spotify:artist:a1",
          genres: ["aurora synthweave", "lunar shimmer"],
        },
        "radio"
      ),
      attachSourceProvenance(
        {
          uri: "spotify:track:n2",
          artistUri: "spotify:artist:a2",
          genres: ["velvet drift", "lunar shimmer"],
        },
        "related-artists"
      ),
      attachSourceProvenance(
        {
          uri: "spotify:track:outlier",
          artistUri: "spotify:artist:a3",
          genres: ["obsidian pulse", "rogue tag"],
        },
        "radio"
      ),
    ])

    expect(expanded).toContain("lunar shimmer")
    expect(expanded).not.toContain("rogue tag")
    expect(scoreGenreCompatibility(expanded, ["lunar shimmer"])).toBeGreaterThan(0.75)
  })

  it("retains instrumental and score tracks when the seed track is an instrumental or soundtrack", () => {
    const scoreSeed: SeedMetadata = {
      uri: "spotify:track:interstellar-theme",
      trackId: "interstellar-theme",
      trackName: "Cornfield Chase",
      artistName: "Hans Zimmer",
      artistUri: "spotify:artist:zimmer",
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      genres: ["soundtrack", "orchestral score", "film score"],
      instrumentalness: 0.88,
      energy: 0.45,
      acousticness: 0.82,
      tempo: 100,
    }

    expect(isVocalSeed(scoreSeed)).toBe(false)
    expect(isSoundtrackSeed(scoreSeed)).toBe(true)

    const candidates: TrackCandidate[] = [
      {
        uri: "spotify:track:oppenheimer",
        trackName: "Can You Hear The Music",
        artistName: "Ludwig Göransson",
        albumName: "Oppenheimer (Original Motion Picture Soundtrack)",
        genres: ["film score", "orchestral soundtrack"],
        instrumentalness: 0.92,
        popularity: 75,
      },
      {
        uri: "spotify:track:classical-piano",
        trackName: "Nuvole Bianche",
        artistName: "Ludovico Einaudi",
        albumName: "Una Mattina",
        genres: ["neo-classical", "solo piano"],
        instrumentalness: 0.86,
        popularity: 68,
      },
      {
        uri: "spotify:track:vocal-pop",
        trackName: "Espresso",
        artistName: "Sabrina Carpenter",
        albumName: "Short n' Sweet",
        genres: ["pop"],
        instrumentalness: 0.0,
        popularity: 90,
      },
    ]

    const isVocal = isVocalSeed(scoreSeed)
    const isSoundtrack = isSoundtrackSeed(scoreSeed)
    const kept = filterSoundtracksAndInstrumentals(candidates, isVocal, isSoundtrack)

    expect(kept.map((t) => t.uri)).toEqual([
      "spotify:track:oppenheimer",
      "spotify:track:classical-piano",
      "spotify:track:vocal-pop",
    ])
  })

  it("enforces exact Disney / vocal pop exception boundary at popularity 59 vs 60 and instrumentalness < 0.2", () => {
    const boundaryCandidates: TrackCandidate[] = [
      {
        uri: "spotify:track:disney-pop-60",
        trackName: "How Far I'll Go",
        albumName: "Moana (Original Motion Picture Soundtrack)",
        instrumentalness: 0.05,
        popularity: 60,
      },
      {
        uri: "spotify:track:disney-pop-59",
        trackName: "Where You Are",
        albumName: "Moana (Original Motion Picture Soundtrack)",
        instrumentalness: 0.05,
        popularity: 59,
      },
      {
        uri: "spotify:track:disney-high-pop-borderline-instrumental",
        trackName: "Logo Theme",
        albumName: "Moana (Original Motion Picture Soundtrack)",
        instrumentalness: 0.2, // must be strictly < 0.2
        popularity: 85,
      },
      {
        uri: "spotify:track:disney-pop-019-inst",
        trackName: "I Am Moana (Song of the Ancestors)",
        albumName: "Moana (Original Motion Picture Soundtrack)",
        instrumentalness: 0.19, // < 0.2 and popularity >= 60
        popularity: 65,
      },
    ]

    const kept = filterSoundtracksAndInstrumentals(boundaryCandidates, true, false)
    expect(kept.map((t) => t.uri)).toEqual([
      "spotify:track:disney-pop-60",
      "spotify:track:disney-pop-019-inst",
    ])
  })

  it("filters unenriched tracks whose titles, albums, or genres indicate an instrumental in a vocal session", () => {
    const unenrichedCandidates: TrackCandidate[] = [
      {
        uri: "spotify:track:unenriched-title-inst",
        trackName: "Acoustic Guitar - Instrumental",
        albumName: "Unplugged Sessions",
        instrumentalness: undefined,
      },
      {
        uri: "spotify:track:unenriched-album-inst",
        trackName: "Track 4",
        albumName: "Ambient Instrumental Vol. 1",
        instrumentalness: undefined,
      },
      {
        uri: "spotify:track:unenriched-genre-inst",
        trackName: "Nocturne in E-flat",
        albumName: "Chopin Works",
        genres: ["solo piano", "classical"],
        instrumentalness: undefined,
      },
      {
        uri: "spotify:track:unenriched-piano-title",
        trackName: "Concerto in G Major",
        albumName: "Concertos",
        instrumentalness: undefined,
      },
      {
        uri: "spotify:track:unenriched-normal-vocal",
        trackName: "Summer Memories",
        albumName: "Bright Lights",
        genres: ["indie pop"],
        instrumentalness: undefined,
      },
    ]

    const kept = filterSoundtracksAndInstrumentals(unenrichedCandidates, true, false)
    expect(kept.map((t) => t.uri)).toEqual(["spotify:track:unenriched-normal-vocal"])
  })

  it("enforces vocal and soundtrack filtering on predominantly vocal playlist sessions", () => {
    const playlistReferences: TrackCandidate[] = [
      {
        uri: "spotify:track:ref-1",
        trackName: "Vocal Ref 1",
        instrumentalness: 0.01,
        genres: ["indie pop"],
      },
      {
        uri: "spotify:track:ref-2",
        trackName: "Vocal Ref 2",
        instrumentalness: 0.03,
        genres: ["singer-songwriter"],
      },
      {
        uri: "spotify:track:ref-3",
        trackName: "Vocal Ref 3",
        instrumentalness: 0.02,
        genres: ["folk pop"],
      },
      {
        uri: "spotify:track:ref-4",
        trackName: "Score Ref 4",
        instrumentalness: 0.85,
        genres: ["film score"],
      },
    ]

    const candidatePool: TrackCandidate[] = [
      {
        uri: "spotify:track:cand-score-soundtrack",
        trackName: "Main Titles",
        albumName: "Dune (Original Motion Picture Soundtrack)",
        genres: ["soundtrack", "orchestral soundtrack"],
        instrumentalness: 0.9,
        popularity: 70,
        energy: 0.5,
        valence: 0.4,
      },
      {
        uri: "spotify:track:cand-high-inst",
        trackName: "Meditation Drone",
        albumName: "Deep Ambient",
        genres: ["ambient"],
        instrumentalness: 0.85,
        popularity: 55,
        energy: 0.4,
        valence: 0.4,
      },
      {
        uri: "spotify:track:cand-vocal-peer-1",
        trackName: "Soft Whisper",
        artistUri: "spotify:artist:peer-1",
        albumName: "Daydream",
        genres: ["indie pop"],
        instrumentalness: 0.02,
        popularity: 62,
        energy: 0.45,
        valence: 0.42,
      },
      {
        uri: "spotify:track:cand-vocal-peer-2",
        trackName: "Gentle Wind",
        artistUri: "spotify:artist:peer-2",
        albumName: "Breeze",
        genres: ["singer-songwriter"],
        instrumentalness: 0.01,
        popularity: 64,
        energy: 0.42,
        valence: 0.4,
      },
    ]

    const dummySeed: SeedMetadata = {
      uri: "spotify:track:dummy",
      trackId: "dummy",
      trackName: "Dummy",
      artistName: "Dummy",
      artistUri: "spotify:artist:dummy",
      genres: ["indie pop"],
      popularity: 60,
    }

    const batch = planRecommendationBatchV2({
      mode: "playlist",
      referenceTracks: playlistReferences,
      pools: [
        {
          candidates: candidatePool,
          source: "playlist-discovery",
          family: "similar",
          weight: 1,
        },
      ],
      settings: getSmartConfig(dummySeed),
      count: 4,
    })

    const uris = batch.map((t) => t.uri)
    expect(uris).toContain("spotify:track:cand-vocal-peer-1")
    expect(uris).toContain("spotify:track:cand-vocal-peer-2")
    expect(uris).not.toContain("spotify:track:cand-score-soundtrack")
    expect(uris).not.toContain("spotify:track:cand-high-inst")
  })

  it("enforces per-artist cap of 2 and de-biases seed artist in profilePool filtering", () => {
    const favoredArtistUri = "spotify:artist:favored-indie"
    const fourTracksFromSameArtist: TrackCandidate[] = Array.from({ length: 4 }, (_, i) => ({
      uri: `spotify:track:favored-${i}`,
      artistUri: favoredArtistUri,
      artistName: "Favored Indie Artist",
      trackName: `Song ${i}`,
      genres: ["indie pop", "singer-songwriter"],
      energy: 0.4,
      acousticness: 0.7,
      instrumentalness: 0.01,
    }))

    const unrelatedSeedArtistTrack: TrackCandidate = {
      uri: "spotify:track:gracie-metal-experiment",
      artistUri: gracieSeed.artistUri,
      artistName: gracieSeed.artistName,
      trackName: "Brutal Screams",
      genres: ["heavy metal"],
      energy: 0.98,
      acousticness: 0.001,
    }

    const mixedProfilePool: TrackCandidate[] = [
      ...fourTracksFromSameArtist,
      unrelatedSeedArtistTrack,
    ]

    const similarNeighbors: TrackCandidate[] = [
      {
        uri: "spotify:track:sim-neighbor-1",
        artistUri: favoredArtistUri,
        genres: ["indie pop", "singer-songwriter"],
      },
    ]

    const coherent = filterProfilePoolForSeedCoherence(
      mixedProfilePool,
      gracieSeed,
      similarNeighbors
    )

    // Per-artist cap of 2:
    const favoredInOutput = coherent.filter((t) => t.artistUri === favoredArtistUri)
    expect(favoredInOutput.length).toBeLessThanOrEqual(2)

    // Seed artist de-biasing: the genre-mismatched track by the seed artist is NOT preserved
    expect(coherent.map((t) => t.uri)).not.toContain("spotify:track:gracie-metal-experiment")
  })

  it("caps parsedGenrePhraseCache at 2048 entries even across thousands of invalid or symbol-only inputs", () => {
    for (let i = 0; i < 2_500; i += 1) {
      scoreGenreCompatibility(
        ["indie pop"],
        [`${"!".repeat((i % 20) + 1)}${"?".repeat(Math.floor(i / 20) + 1)}`]
      )
    }
    expect(getParsedGenrePhraseCacheSize()).toBeLessThanOrEqual(2_048)
  })
})
