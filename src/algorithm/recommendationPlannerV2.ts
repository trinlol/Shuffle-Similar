import { getTasteProfileConfidence, scoreTasteAffinity } from "../profile/tasteProfile"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSourceProvenance } from "../sources/provenance"
import type { SmartConfig } from "../storage/settings"
import {
  acousticDistanceV2,
  type BlendFamily,
  type CandidateProvenance,
  planSlateV2,
  type RankableCandidate,
  rankCandidatesV2,
  type SlateEvaluationMetrics,
} from "./rankingV2"

export type RecommendationMode = "track" | "artist" | "playlist" | "album" | "single"

export type RecommendationCandidatePool = {
  candidates: TrackCandidate[]
  source: string
  family: BlendFamily
  weight?: number
}

export type RecommendationPopularityDiagnostics = {
  knownRatio: number
  mean: number | null
  standardDeviation: number | null
  normalizedEntropy: number
}

export type RecommendationDiagnostics = {
  engine: "ranking-v2"
  mode: RecommendationMode
  requestedCount: number
  selectedCount: number
  inputCandidateCount: number
  normalizedArtistEntropy: number
  metadataCompleteness: number
  popularity: RecommendationPopularityDiagnostics
  rankReasons: Record<string, number>
  planReasons: Record<string, number>
  slate: SlateEvaluationMetrics
}

export type PlanRecommendationBatchV2Options = {
  mode: RecommendationMode
  seed?: SeedMetadata | null
  pools: RecommendationCandidatePool[]
  referenceTracks?: TrackCandidate[]
  excludedUris?: readonly string[]
  queueTailUris?: readonly string[]
  topTrackUris?: ReadonlySet<string>
  familiarUris?: ReadonlySet<string>
  discoveryHistory?: readonly boolean[]
  settings: SmartConfig
  count: number
  absoluteStartPosition?: number
  rngSeed?: string | number
}

const diagnosticsByBatch = new WeakMap<readonly TrackCandidate[], RecommendationDiagnostics>()

const SOURCE_RELIABILITY: Readonly<Record<string, number>> = Object.freeze({
  recommendations: 1,
  "inspired-by": 1.05,
  radio: 1,
  "genre-era-search": 0.85,
  "era-search": 0.65,
  "related-artists": 0.9,
  "album-peers": 0.65,
  "artist-discography": 0.9,
  "similar-discovery": 1,
  "profile-library": 0.9,
  "playlist-discovery": 1,
  "playlist-context": 0.9,
  "single-pool": 1,
  "taste-profile": 0.7,
})

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.max(minimum, Math.min(maximum, value))

const finitePopularity = (candidate: TrackCandidate): number | null =>
  typeof candidate.popularity === "number" && Number.isFinite(candidate.popularity)
    ? clamp(candidate.popularity, 0, 100)
    : null

const acousticProfile = (candidate: TrackCandidate | SeedMetadata | null | undefined) =>
  candidate
    ? {
        tempo: candidate.tempo,
        energy: candidate.energy,
        valence: candidate.valence,
        danceability: candidate.danceability,
        acousticness: candidate.acousticness,
        instrumentalness: candidate.instrumentalness,
      }
    : undefined

const mergeCandidate = (
  current: TrackCandidate | undefined,
  next: TrackCandidate
): TrackCandidate => {
  if (!current) return next
  const merged: TrackCandidate = { ...current }
  for (const [key, value] of Object.entries(next) as Array<
    [keyof TrackCandidate, TrackCandidate[keyof TrackCandidate]]
  >) {
    if (value !== undefined && value !== null && value !== "") {
      ;(merged as Record<keyof TrackCandidate, TrackCandidate[keyof TrackCandidate]>)[key] = value
    }
  }
  return merged
}

const contextAffinity = (
  candidate: TrackCandidate,
  seed: SeedMetadata | null | undefined,
  references: readonly TrackCandidate[],
  eraWindow: number
): number | undefined => {
  const seedDistance =
    seed && references.length > 0
      ? acousticDistanceV2(acousticProfile(candidate), acousticProfile(seed))
      : null
  const seedAffinity = seedDistance != null ? Math.exp(-2.2 * seedDistance) : undefined
  let referenceAffinity: number | undefined
  if (references.length > 0) {
    const distances = references
      .map((reference) =>
        acousticDistanceV2(acousticProfile(candidate), acousticProfile(reference))
      )
      .filter((distance): distance is number => distance != null)
      .sort((left, right) => left - right)
      .slice(0, 5)
    if (distances.length > 0) {
      const mean = distances.reduce((sum, distance) => sum + distance, 0) / distances.length
      referenceAffinity = Math.exp(-2.2 * mean)
    }
  }

  if (seedAffinity != null && referenceAffinity != null) {
    return 0.6 * seedAffinity + 0.4 * referenceAffinity
  }
  if (seedAffinity != null) return seedAffinity
  if (referenceAffinity != null) return referenceAffinity

  if (seed?.releaseYear != null && candidate.releaseYear != null) {
    const difference = Math.abs(candidate.releaseYear - seed.releaseYear)
    return Math.exp(-difference / Math.max(1, eraWindow))
  }
  return undefined
}

const percentileFor = (value: number, sorted: readonly number[]): number => {
  if (sorted.length <= 1) return 0.5
  let below = 0
  let equal = 0
  for (const entry of sorted) {
    if (entry < value) below += 1
    else if (entry === value) equal += 1
  }
  return clamp((below + Math.max(0, equal - 1) / 2) / (sorted.length - 1))
}

/**
 * Scores popularity against the observed candidate distribution rather than
 * treating a missing value as a magic 50. This keeps discovery broad without
 * turning the queue into either a chart list or an obscurity contest.
 */
const popularityAffinities = (
  candidates: readonly TrackCandidate[],
  seed: SeedMetadata | null | undefined,
  favorObscure: boolean
): Map<string, number> => {
  const values = candidates
    .map(finitePopularity)
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right)
  const result = new Map<string, number>()
  if (values.length === 0) return result

  const seedPopularity = seed ? finitePopularity(seed) : null
  const seedPercentile = seedPopularity == null ? 0.5 : percentileFor(seedPopularity, values)
  const target = favorObscure ? Math.min(0.4, seedPercentile) : seedPercentile
  const spread = favorObscure ? 0.3 : 0.36
  for (const candidate of candidates) {
    const popularity = finitePopularity(candidate)
    if (popularity == null) continue
    const percentile = percentileFor(popularity, values)
    const distributionFit = Math.exp(-0.5 * ((percentile - target) / spread) ** 2)
    const discovery = favorObscure ? 1 - percentile : 0.5
    result.set(candidate.uri, clamp(0.2 + 0.65 * distributionFit + 0.15 * discovery))
  }
  return result
}

const tasteAffinities = (
  candidates: readonly TrackCandidate[],
  settings: SmartConfig,
  genres: readonly string[]
): Map<string, number> => {
  const result = new Map<string, number>()
  if (!settings.tasteProfile) return result
  const now = settings.tasteProfileNow ?? settings.tasteProfile.updatedAt
  const confidence = getTasteProfileConfidence(settings.tasteProfile, now)
  if (!confidence.ready) return result
  for (const candidate of candidates) {
    const multiplier = scoreTasteAffinity(candidate, settings.tasteProfile, {
      genres,
      now,
      contextKey: settings.tasteContextKey,
    })
    if (Math.abs(multiplier - 1) > 1e-6) {
      result.set(candidate.uri, clamp((multiplier - 0.5) / 1.25))
    }
  }
  return result
}

const addRankedProvenance = (
  aggregates: Map<string, { track: TrackCandidate; provenance: CandidateProvenance[] }>,
  scored: Array<{ uri: string; score: number }>,
  source: string,
  family: BlendFamily
): void => {
  scored
    .sort((left, right) => right.score - left.score || left.uri.localeCompare(right.uri))
    .forEach((entry, index) => {
      aggregates.get(entry.uri)?.provenance.push({ source, family, rank: index + 1 })
    })
}

const normalizedEntropy = (values: readonly string[], maximumCategories: number): number => {
  if (values.length <= 1) return 0
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const denominator = Math.log(Math.min(values.length, maximumCategories))
  if (denominator <= 0) return 0
  const entropy = [...counts.values()].reduce((sum, count) => {
    const probability = count / values.length
    return sum - probability * Math.log(probability)
  }, 0)
  return clamp(entropy / denominator)
}

const artistKey = (candidate: TrackCandidate): string =>
  candidate.artistUri?.trim().toLocaleLowerCase() ||
  (candidate.artistName
    ? `name:${candidate.artistName.trim().toLocaleLowerCase().replace(/\s+/g, " ")}`
    : "metadata:unknown-artist")

const popularityDiagnostics = (
  tracks: readonly TrackCandidate[]
): RecommendationPopularityDiagnostics => {
  const known = tracks.map(finitePopularity).filter((value): value is number => value != null)
  if (known.length === 0) {
    return { knownRatio: 0, mean: null, standardDeviation: null, normalizedEntropy: 0 }
  }
  const mean = known.reduce((sum, value) => sum + value, 0) / known.length
  const variance = known.reduce((sum, value) => sum + (value - mean) ** 2, 0) / known.length
  const buckets = known.map((value) => String(Math.min(9, Math.floor(value / 10))))
  return {
    knownRatio: known.length / Math.max(1, tracks.length),
    mean,
    standardDeviation: Math.sqrt(variance),
    normalizedEntropy: normalizedEntropy(buckets, 10),
  }
}

const incrementReasons = (reasons: readonly string[], counts: Record<string, number>): void => {
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1
}

const stableSeed = (options: PlanRecommendationBatchV2Options, uris: readonly string[]): string =>
  [
    "ranking-v2",
    options.mode,
    options.seed?.uri ?? "no-seed",
    String(options.absoluteStartPosition ?? 0),
    ...(options.queueTailUris?.slice(-8) ?? []),
    ...uris,
  ].join("|")

export const planRecommendationBatchV2 = (
  options: PlanRecommendationBatchV2Options
): TrackCandidate[] => {
  const excluded = new Set(options.excludedUris ?? [])
  const metadataByUri = new Map<string, TrackCandidate>()
  const rememberMetadata = (candidate: TrackCandidate): void => {
    if (!candidate.uri) return
    metadataByUri.set(candidate.uri, mergeCandidate(metadataByUri.get(candidate.uri), candidate))
  }
  for (const pool of options.pools) {
    for (const candidate of pool.candidates) rememberMetadata(candidate)
  }
  for (const reference of options.referenceTracks ?? []) rememberMetadata(reference)
  if (options.seed) rememberMetadata(options.seed)
  const aggregates = new Map<string, { track: TrackCandidate; provenance: CandidateProvenance[] }>()
  const sourceWeights: Record<string, number> = {}
  const sourceRanks = new Map<string, number>()

  for (const pool of options.pools) {
    const weight =
      typeof pool.weight === "number" && Number.isFinite(pool.weight) ? Math.max(0, pool.weight) : 1
    pool.candidates.forEach((candidate) => {
      if (!candidate.uri?.startsWith("spotify:track:") || excluded.has(candidate.uri)) return
      const realSources = getSourceProvenance(candidate)
      const sources = realSources.length > 0 ? [...new Set(realSources)] : [pool.source]
      const provenance = sources.map((source) => {
        const rank = (sourceRanks.get(source) ?? 0) + 1
        sourceRanks.set(source, rank)
        sourceWeights[source] = Math.max(
          sourceWeights[source] ?? 0,
          weight * (SOURCE_RELIABILITY[source] ?? 0.8)
        )
        return { source, family: pool.family, rank } satisfies CandidateProvenance
      })
      const current = aggregates.get(candidate.uri)
      aggregates.set(candidate.uri, {
        track: mergeCandidate(current?.track, candidate),
        provenance: [...(current?.provenance ?? []), ...provenance],
      })
    })
  }

  const candidates = [...aggregates.values()].map((entry) => entry.track)
  const references = options.referenceTracks ?? []
  const contexts = new Map(
    candidates.map((candidate) => [
      candidate.uri,
      contextAffinity(candidate, options.seed, references, options.settings.eraWindow),
    ])
  )
  if (references.length > 0) {
    sourceWeights["playlist-context"] = 0.9
    addRankedProvenance(
      aggregates,
      [...contexts]
        .filter((entry): entry is [string, number] => entry[1] != null)
        .map(([uri, score]) => ({ uri, score })),
      "playlist-context",
      "profile"
    )
  }

  const genres = options.seed?.genres ?? []
  const tastes = tasteAffinities(candidates, options.settings, genres)
  if (tastes.size > 0) {
    sourceWeights["taste-profile"] = 0.7
    addRankedProvenance(
      aggregates,
      [...tastes].map(([uri, score]) => ({ uri, score })),
      "taste-profile",
      "profile"
    )
  }
  const popularity = popularityAffinities(
    candidates,
    options.seed,
    options.settings.deprioritizePopular
  )

  const rankable: RankableCandidate[] = [...aggregates.values()].map(({ track, provenance }) => ({
    uri: track.uri,
    title: track.trackName,
    artistUris: track.artistUri ? [track.artistUri] : undefined,
    artistNames: track.artistName ? [track.artistName] : undefined,
    albumUri: track.albumUri,
    acoustic: acousticProfile(track),
    provenance,
    signals: {
      contextAffinity: options.topTrackUris?.has(track.uri)
        ? (contexts.get(track.uri) ?? 1) * 0.45
        : contexts.get(track.uri),
      tasteAffinity: tastes.get(track.uri),
      novelty: popularity.get(track.uri),
    },
  }))

  const ranked = rankCandidatesV2(rankable, {
    sourceWeights,
    seedProfile: acousticProfile(options.seed),
    componentWeights: {
      fusion: 0.2,
      context: 0.12,
      taste: 0.17,
      acoustic: 0.08,
      novelty: 0.08,
      feedback: 0.35,
    },
    skipSignals: options.settings.skipFeedback?.map((skip) => ({
      artistUris: skip.artistUri ? [skip.artistUri] : undefined,
      artistNames: skip.artistName ? [skip.artistName] : undefined,
      acoustic: skip.profile,
      confidence: 1,
    })),
  })

  const candidateByUri = new Map(candidates.map((candidate) => [candidate.uri, candidate]))
  const queueTail = (options.queueTailUris ?? []).slice(-5).map((uri) => {
    const candidate = metadataByUri.get(uri)
    return {
      uri,
      title: candidate?.trackName,
      artistUris: candidate?.artistUri ? [candidate.artistUri] : undefined,
      artistNames: candidate?.artistName ? [candidate.artistName] : undefined,
      albumUri: candidate?.albumUri,
      acoustic: acousticProfile(candidate),
      provenance: [],
    } satisfies RankableCandidate
  })
  const plan = planSlateV2(ranked, {
    count: options.count,
    absoluteStartPosition: options.absoluteStartPosition,
    rngSeed:
      options.rngSeed ??
      stableSeed(
        options,
        ranked.map((candidate) => candidate.uri)
      ),
    blendPhases: options.settings.blendPhases.map((phase) => ({
      maxPosition: phase.maxPosition,
      similar: phase.similarWeight,
      profile: phase.profileWeight,
    })),
    queueTail,
    familiarUris: new Set([...(options.familiarUris ?? []), ...(options.topTrackUris ?? [])]),
    discoveryHistory: options.discoveryHistory,
  })
  const tracks = plan.items
    .map((item) => candidateByUri.get(item.candidate.uri))
    .filter((candidate): candidate is TrackCandidate => candidate != null)

  const rankReasons: Record<string, number> = {}
  const planReasons: Record<string, number> = {}
  for (const candidate of ranked) incrementReasons(candidate.reasonCodes, rankReasons)
  for (const item of plan.items) incrementReasons(item.reasonCodes, planReasons)
  const completeMetadata = tracks.filter(
    (track) => track.trackName && (track.artistUri || track.artistName) && track.albumUri
  ).length
  diagnosticsByBatch.set(tracks, {
    engine: "ranking-v2",
    mode: options.mode,
    requestedCount: Math.max(0, Math.floor(options.count)),
    selectedCount: tracks.length,
    inputCandidateCount: candidates.length,
    normalizedArtistEntropy: normalizedEntropy(tracks.map(artistKey), tracks.length),
    metadataCompleteness: tracks.length > 0 ? completeMetadata / tracks.length : 0,
    popularity: popularityDiagnostics(tracks),
    rankReasons,
    planReasons,
    slate: plan.metrics,
  })
  return tracks
}

export const getRecommendationDiagnostics = (
  batch: readonly TrackCandidate[]
): RecommendationDiagnostics | undefined => diagnosticsByBatch.get(batch)
