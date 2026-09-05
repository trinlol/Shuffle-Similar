import { beforeAll, describe, expect, it } from "vitest"
import {
  computeHistoryWeights,
  dedupeCandidates,
  excludeArtist,
  filterPlayableCandidates,
  getRecentKeys,
  pickFromPool,
} from "../algorithm/filters"
import { getBlendWeights } from "../algorithm/progressiveBlend"
import {
  acousticDistanceV2,
  canonicalTrackKey,
  createSeededRng,
  planSlateV2,
  type RankableCandidate,
  rankCandidatesV2,
} from "../algorithm/rankingV2"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { SourcePipeline } from "../sources/sourcePipeline"
import { getSmartConfig } from "../storage/settings"

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

type SystemName = "legacy" | "v2"

type ComparableMetrics = {
  canonicalDuplicates: number
  artistSpacingViolations: number
  albumSpacingViolations: number
  maxArtistCountFirst20: number
  uniqueArtistsFirst20: number
  meanAcousticTransition: number
}

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Synthetic Seed",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed",
  genres: [],
  popularity: 50,
}

const fixture = (fixtureIndex: number): RankableCandidate[] =>
  Array.from({ length: 80 }, (_, index) => {
    const artist = (index * 7 + fixtureIndex * 3) % 29
    const album = (index * 11 + fixtureIndex) % 31
    const version = index % 17 === 1
    const canonicalGroup = version ? index - 1 : index
    const acousticBand = (index + fixtureIndex) % 4
    const profiles = [
      { tempo: 72, energy: 0.12, valence: 0.18, danceability: 0.28 },
      { tempo: 108, energy: 0.42, valence: 0.4, danceability: 0.52 },
      { tempo: 148, energy: 0.72, valence: 0.68, danceability: 0.7 },
      { tempo: 194, energy: 0.94, valence: 0.88, danceability: 0.86 },
    ]
    const family = index % 2 === 0 ? "similar" : "profile"
    return {
      uri: `spotify:track:fixture-${fixtureIndex}-${index}`,
      title: version
        ? `Fixture ${fixtureIndex} Track ${canonicalGroup} - 2024 Remaster`
        : `Fixture ${fixtureIndex} Track ${canonicalGroup}`,
      artistUris: [`spotify:artist:${artist}`],
      artistNames: [`Artist ${artist}`],
      albumUri: `spotify:album:${album}`,
      acoustic: profiles[acousticBand],
      provenance: [
        { source: family === "similar" ? "radio" : "library", family, rank: index + 1 },
        ...(index % 5 === 0
          ? [{ source: "search", family: "similar" as const, rank: 1 + (index % 10) }]
          : []),
      ],
      signals: {
        contextAffinity: 0.45 + ((index * 13) % 50) / 100,
        tasteAffinity: 0.4 + ((index * 17) % 55) / 100,
        novelty: 0.55 + ((index * 19) % 40) / 100,
      },
    }
  })

const toLegacyCandidate = (candidate: RankableCandidate): TrackCandidate => ({
  uri: candidate.uri,
  trackName: candidate.title,
  artistUri: candidate.artistUris?.[0],
  artistName: candidate.artistNames?.[0],
  albumUri: candidate.albumUri,
  popularity: 50,
  ...candidate.acoustic,
})

const toRankableCandidate = (candidate: TrackCandidate): RankableCandidate => ({
  uri: candidate.uri,
  title: candidate.trackName,
  artistUris: candidate.artistUri ? [candidate.artistUri] : undefined,
  artistNames: candidate.artistName ? [candidate.artistName] : undefined,
  albumUri: candidate.albumUri,
  acoustic: {
    tempo: candidate.tempo,
    energy: candidate.energy,
    valence: candidate.valence,
    danceability: candidate.danceability,
    acousticness: candidate.acousticness,
    instrumentalness: candidate.instrumentalness,
  },
  provenance: [],
})

const withSeededMathRandom = <T>(rngSeed: string, run: () => T): T => {
  const original = Math.random
  Math.random = createSeededRng(rngSeed)
  try {
    return run()
  } finally {
    Math.random = original
  }
}

const buildLegacy = (candidates: RankableCandidate[], rngSeed: string): RankableCandidate[] => {
  let similar = candidates
    .filter((candidate) => candidate.provenance.some((hit) => hit.family === "similar"))
    .map(toLegacyCandidate)
  let profile = candidates
    .filter((candidate) => candidate.provenance.some((hit) => hit.family === "profile"))
    .map(toLegacyCandidate)
  const settings = getSmartConfig(seed)
  similar = excludeArtist(
    dedupeCandidates(filterPlayableCandidates(similar)),
    seed.artistUri,
    seed.artistName
  )
  profile = excludeArtist(
    dedupeCandidates(filterPlayableCandidates(profile)),
    seed.artistUri,
    seed.artistName
  )
  const similarHistoryWeights = computeHistoryWeights(similar, [], settings.historyPenaltyWindow)
  const profileHistoryWeights = computeHistoryWeights(profile, [], settings.historyPenaltyWindow)
  const selected = withSeededMathRandom(rngSeed, () => {
    const output: TrackCandidate[] = []
    while (output.length < 20 && (similar.length > 0 || profile.length > 0)) {
      const blend = getBlendWeights(output.length + 1, settings)
      const useSimilar =
        similar.length > 0 &&
        (profile.length === 0 ||
          Math.random() <
            blend.similarWeight / Math.max(0.0001, blend.similarWeight + blend.profileWeight))
      const pool = useSimilar ? similar : profile
      const picked = pickFromPool(pool, {
        recentKeys: getRecentKeys(output, settings.artistSpacing),
        artistSpacing: settings.artistSpacing,
        albumSpacing: 2,
        favorObscure: settings.deprioritizePopular,
        historyWeights: useSimilar ? similarHistoryWeights : profileHistoryWeights,
        seedYear: seed.releaseYear,
        eraWindow: settings.eraWindow,
      })
      if (!picked) break
      output.push(picked)
      similar = similar.filter((candidate) => candidate.uri !== picked.uri)
      profile = profile.filter((candidate) => candidate.uri !== picked.uri)
    }
    return output
  })
  return selected.map(toRankableCandidate)
}

const buildV2 = (candidates: RankableCandidate[], rngSeed: string): RankableCandidate[] =>
  planSlateV2(rankCandidatesV2(candidates), {
    count: 20,
    absoluteStartPosition: 0,
    rngSeed,
    maxAcousticTransition: 0.42,
  }).items.map((item) => item.candidate)

const artistKeys = (candidate: RankableCandidate): string[] =>
  candidate.artistUris?.length ? candidate.artistUris : (candidate.artistNames ?? [])

const evaluateComparable = (items: RankableCandidate[]): ComparableMetrics => {
  const canonical = new Set<string>()
  let canonicalDuplicates = 0
  let artistSpacingViolations = 0
  let albumSpacingViolations = 0
  const first20ArtistCounts = new Map<string, number>()
  const transitions: number[] = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const key = canonicalTrackKey(item)
    if (canonical.has(key)) canonicalDuplicates += 1
    canonical.add(key)

    const artists = new Set(artistKeys(item))
    if (
      items
        .slice(Math.max(0, index - 5), index)
        .some((prior) => artistKeys(prior).some((artist) => artists.has(artist)))
    ) {
      artistSpacingViolations += 1
    }
    if (
      item.albumUri &&
      items.slice(Math.max(0, index - 4), index).some((prior) => prior.albumUri === item.albumUri)
    ) {
      albumSpacingViolations += 1
    }
    if (index < 20) {
      for (const artist of artists) {
        first20ArtistCounts.set(artist, (first20ArtistCounts.get(artist) ?? 0) + 1)
      }
    }
    if (index > 0) {
      const distance = acousticDistanceV2(items[index - 1].acoustic, item.acoustic)
      if (distance != null) transitions.push(distance)
    }
  }

  return {
    canonicalDuplicates,
    artistSpacingViolations,
    albumSpacingViolations,
    maxArtistCountFirst20: Math.max(0, ...first20ArtistCounts.values()),
    uniqueArtistsFirst20: first20ArtistCounts.size,
    meanAcousticTransition:
      transitions.length > 0
        ? transitions.reduce((sum, distance) => sum + distance, 0) / transitions.length
        : 0,
  }
}

const qualityScore = (metrics: ComparableMetrics): number =>
  // Fifteen artists is the declared slate-diversity gate. Rewarding arbitrary
  // diversity beyond that floor would incorrectly prefer a less coherent mix
  // even when both systems have already satisfied the listener-facing rule.
  Math.min(15, metrics.uniqueArtistsFirst20) * 4 -
  metrics.canonicalDuplicates * 30 -
  metrics.artistSpacingViolations * 12 -
  metrics.albumSpacingViolations * 8 -
  Math.max(0, metrics.maxArtistCountFirst20 - 2) * 15 -
  metrics.meanAcousticTransition * 30

const blindCompare = (
  outputs: Record<SystemName, RankableCandidate[]>,
  rngSeed: string
): { winner: SystemName; labels: Record<"A" | "B", SystemName> } => {
  const swap = createSeededRng(`blind:${rngSeed}`)() >= 0.5
  const labels: Record<"A" | "B", SystemName> = swap
    ? { A: "v2", B: "legacy" }
    : { A: "legacy", B: "v2" }
  const scores = {
    A: qualityScore(evaluateComparable(outputs[labels.A])),
    B: qualityScore(evaluateComparable(outputs[labels.B])),
  }
  const winningLabel = scores.A >= scores.B ? "A" : "B"
  return { winner: labels[winningLabel], labels }
}

describe("Better Shuffle 2.0 independent recommendation gate", () => {
  it("wins a randomized hidden-label comparison against the legacy selector", () => {
    let v2Wins = 0
    let labelsWithV2AsA = 0
    const transitions: Array<{ legacy: number; v2: number }> = []
    const nonV2Winners: Array<{
      fixtureIndex: number
      legacy: ComparableMetrics
      v2: ComparableMetrics
    }> = []

    for (let fixtureIndex = 0; fixtureIndex < 24; fixtureIndex += 1) {
      const candidates = fixture(fixtureIndex)
      const rngSeed = `comparison-${fixtureIndex}`
      const outputs = {
        legacy: buildLegacy(candidates, rngSeed),
        v2: buildV2(candidates, rngSeed),
      }
      const result = blindCompare(outputs, rngSeed)
      if (result.winner === "v2") v2Wins += 1
      else {
        nonV2Winners.push({
          fixtureIndex,
          legacy: evaluateComparable(outputs.legacy),
          v2: evaluateComparable(outputs.v2),
        })
      }
      if (result.labels.A === "v2") labelsWithV2AsA += 1
      transitions.push({
        legacy: evaluateComparable(outputs.legacy).meanAcousticTransition,
        v2: evaluateComparable(outputs.v2).meanAcousticTransition,
      })
    }

    expect(labelsWithV2AsA).toBeGreaterThan(5)
    expect(labelsWithV2AsA).toBeLessThan(19)
    expect(nonV2Winners).toEqual([])
    expect(v2Wins).toBe(24)
    expect(transitions.reduce((sum, pair) => sum + pair.v2, 0)).toBeLessThan(
      transitions.reduce((sum, pair) => sum + pair.legacy, 0)
    )
  })

  it("meets every hard slate constraint when the pool permits it", () => {
    for (let fixtureIndex = 0; fixtureIndex < 12; fixtureIndex += 1) {
      const candidates = fixture(fixtureIndex)
      const output = buildV2(candidates, `hard-gates-${fixtureIndex}`)
      const metrics = evaluateComparable(output)

      expect(output).toHaveLength(20)
      expect(metrics.canonicalDuplicates).toBe(0)
      expect(metrics.artistSpacingViolations).toBe(0)
      expect(metrics.albumSpacingViolations).toBe(0)
      expect(metrics.maxArtistCountFirst20).toBeLessThanOrEqual(2)
      expect(metrics.uniqueArtistsFirst20).toBeGreaterThanOrEqual(15)
    }
  })

  it("keeps at least fifteen artists in the first twenty despite a high-score head", () => {
    const highScoreHead: RankableCandidate[] = Array.from({ length: 10 }, (_, artist) =>
      Array.from({ length: 2 }, (_, track) => ({
        uri: `spotify:track:head-${artist}-${track}`,
        title: `Head ${artist} ${track}`,
        artistUris: [`spotify:artist:head-${artist}`],
        albumUri: `spotify:album:head-${artist}-${track}`,
        provenance: [
          { source: `head-source-${artist}-${track}`, family: "similar" as const, rank: 1 },
        ],
        signals: { contextAffinity: 1, tasteAffinity: 1, novelty: 1 },
      }))
    ).flat()
    const diverseTail: RankableCandidate[] = Array.from({ length: 20 }, (_, artist) => ({
      uri: `spotify:track:tail-${artist}`,
      title: `Tail ${artist}`,
      artistUris: [`spotify:artist:tail-${artist}`],
      albumUri: `spotify:album:tail-${artist}`,
      provenance: [{ source: `tail-source-${artist}`, family: "similar" as const, rank: 1 }],
      signals: { contextAffinity: 0, tasteAffinity: 0, novelty: 0 },
    }))
    const output = planSlateV2(rankCandidatesV2([...highScoreHead, ...diverseTail]), {
      count: 20,
      rngSeed: "adversarial-artist-floor",
    }).items.map((item) => item.candidate)

    expect(evaluateComparable(output).uniqueArtistsFirst20).toBeGreaterThanOrEqual(15)
  })

  it("is byte-for-byte deterministic for the same fixture and seed", () => {
    const candidates = fixture(99)
    const first = buildV2(candidates, "determinism").map((candidate) => candidate.uri)
    const second = buildV2(candidates, "determinism").map((candidate) => candidate.uri)
    expect(first).toEqual(second)
  })

  it("immediately suppresses the skipped artist and acoustic neighborhood", () => {
    const skippedArtist = "spotify:artist:skipped"
    const candidates: RankableCandidate[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        uri: `spotify:track:skipped-${index}`,
        title: `Skipped Neighbor ${index}`,
        artistUris: [skippedArtist],
        albumUri: `spotify:album:skipped-${index}`,
        acoustic: { tempo: 120 + index, energy: 0.7, valence: 0.6 },
        provenance: [{ source: "radio", family: "similar" as const, rank: index + 1 }],
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        uri: `spotify:track:alternative-${index}`,
        title: `Alternative ${index}`,
        artistUris: [`spotify:artist:alternative-${index}`],
        albumUri: `spotify:album:alternative-${index}`,
        acoustic: { tempo: 155 + (index % 20), energy: 0.45, valence: 0.4 },
        provenance: [{ source: "radio", family: "similar" as const, rank: 10 + index }],
      })),
    ]
    const before = planSlateV2(rankCandidatesV2(candidates), {
      count: 10,
      rngSeed: "skip-before",
    }).items.map((item) => item.candidate)
    const after = planSlateV2(
      rankCandidatesV2(candidates, {
        skipSignals: [
          {
            artistUris: [skippedArtist],
            acoustic: { tempo: 122, energy: 0.7, valence: 0.6 },
            confidence: 1,
          },
        ],
      }),
      { count: 10, rngSeed: "skip-before" }
    ).items.map((item) => item.candidate)
    const countSkippedArtist = (items: RankableCandidate[]) =>
      items.filter((candidate) => candidate.artistUris?.includes(skippedArtist)).length

    expect(countSkippedArtist(before)).toBeGreaterThan(0)
    expect(countSkippedArtist(after)).toBe(0)
  })

  it("degrades safely with sparse metadata and a failed discovery source", async () => {
    const sparse = Array.from({ length: 12 }, (_, index) => ({
      uri: `spotify:track:sparse-${index}`,
      provenance: [{ source: "healthy", family: "similar" as const, rank: index + 1 }],
    }))
    const sparsePlan = planSlateV2(rankCandidatesV2(sparse), {
      count: 10,
      rngSeed: "sparse",
    })
    expect(sparsePlan.items).toHaveLength(10)
    expect(new Set(sparsePlan.items.map((item) => item.candidate.uri)).size).toBe(10)

    const pipeline = new SourcePipeline({ timeoutMs: 50, maxConcurrency: 2 })
    const result = await pipeline.run([
      { id: "failed", run: async () => Promise.reject(new Error("synthetic outage")) },
      { id: "healthy", run: async () => sparse },
    ])
    expect(result.degraded).toBe(true)
    expect(result.values.flatMap((entry) => entry.value)).toEqual(sparse)
    expect(result.diagnostics.find((entry) => entry.sourceId === "failed")?.status).toBe("error")
  })

  it("does not collapse same-title tracks when artist identity is missing", () => {
    const partialMetadata: RankableCandidate[] = [
      {
        uri: "spotify:track:intro-one",
        title: "Intro",
        provenance: [{ source: "healthy", family: "similar", rank: 1 }],
      },
      {
        uri: "spotify:track:intro-two",
        title: "Intro",
        provenance: [{ source: "healthy", family: "similar", rank: 2 }],
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        uri: `spotify:track:partial-${index}`,
        title: `Partial ${index}`,
        provenance: [{ source: "healthy", family: "similar" as const, rank: index + 3 }],
      })),
    ]
    const output = planSlateV2(rankCandidatesV2(partialMetadata), {
      count: partialMetadata.length,
      rngSeed: "missing-artist-identity",
    }).items.map((item) => item.candidate.uri)

    expect(output).toContain("spotify:track:intro-one")
    expect(output).toContain("spotify:track:intro-two")
  })
})
