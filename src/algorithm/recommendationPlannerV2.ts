import {
  getTasteProfileConfidence,
  scoreArtistHabitualPenalty,
  scoreTasteAffinity,
} from "../profile/tasteProfile"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSourceProvenance } from "../sources/provenance"
import type { SmartConfig } from "../storage/settings"
import {
  expandSeedGenresFromGraph,
  filterSoundtracksAndInstrumentals,
  hasDisqualifyingTitleMismatch,
  inferSeedGenres,
  isSonicOutlier,
  isSoundtrackSeed,
  isVocalSeed,
  scoreGenreCompatibility,
} from "./genreAffinity"
import {
  acousticDistanceV2,
  type BlendFamily,
  type CandidateProvenance,
  canonicalKeysForTrack,
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
  excludedCanonicalKeys?: readonly string[]
  queueTailUris?: readonly string[]
  recentHistoryUris?: readonly string[]
  habitualArtistKeys?: ReadonlySet<string>
  recentArtistKeys?: readonly string[]
  exposureMultipliers?: ReadonlyMap<string, number>
  topTrackUris?: ReadonlySet<string>
  familiarUris?: ReadonlySet<string>
  discoveryHistory?: readonly boolean[]
  settings: SmartConfig
  count: number
  absoluteStartPosition?: number
  rngSeed?: string | number
  explorationBand?: number
  explorationTemperature?: number
}

const diagnosticsByBatch = new WeakMap<readonly TrackCandidate[], RecommendationDiagnostics>()

const SOURCE_RELIABILITY: Readonly<Record<string, number>> = Object.freeze({
  recommendations: 1,
  "inspired-by": 1.05,
  radio: 1,
  "discovered-on": 0.95,
  "playlist-recommendations": 0.95,
  "related-artists": 0.92,
  "genre-era-search": 0.82,
  "era-search": 0.65,
  "fallback-search": 0.6,
  "album-peers": 0.65,
  "artist-discography": 0.9,
  "similar-discovery": 1,
  "profile-library": 0.88,
  "liked-tracks": 0.88,
  "liked-tracks-collection": 0.88,
  "profile-playlist": 0.85,
  "playlist-discovery": 1,
  "playlist-context": 0.45,
  "single-pool": 1,
  "taste-profile": 0.22,
})

const CONSENSUS_DISCOVERY_SOURCES = new Set([
  "recommendations",
  "inspired-by",
  "radio",
  "related-artists",
  "discovered-on",
])

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
    if (key === "genres") continue
    if (value !== undefined && value !== null && value !== "") {
      ;(merged as Record<keyof TrackCandidate, TrackCandidate[keyof TrackCandidate]>)[key] = value
    }
  }
  const mergedGenres = [
    ...new Set(
      [...(current.genres ?? []), ...(next.genres ?? [])]
        .filter((genre): genre is string => typeof genre === "string" && genre.trim().length > 0)
        .map((genre) => genre.trim())
    ),
  ]
  if (mergedGenres.length > 0) merged.genres = mergedGenres
  return merged
}

const contextAffinity = (
  candidate: TrackCandidate,
  seed: SeedMetadata | null | undefined,
  effectiveGenres: readonly string[],
  references: readonly TrackCandidate[],
  eraWindow: number
): number | undefined => {
  // Note: direct seed-to-candidate acoustic distance is already scored by
  // rankCandidatesV2's dedicated `acoustic` component (`options.seedProfile`).
  // Keeping `context` focused on genre compatibility, reference-track context,
  // and release-era alignment avoids double-counting seed acoustics.
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

  const genreCompat = scoreGenreCompatibility(effectiveGenres, candidate.genres)
  const eraAffinity =
    seed?.releaseYear != null && candidate.releaseYear != null
      ? Math.exp(-Math.abs(candidate.releaseYear - seed.releaseYear) / Math.max(1, eraWindow))
      : undefined

  const parts: Array<{ value: number; weight: number }> = []
  if (genreCompat !== null) parts.push({ value: genreCompat, weight: seed ? 0.68 : 0.45 })
  if (referenceAffinity !== undefined) {
    // In track-seed mode, keep reference tracks subordinate (0.16) to seed genre/era
    // so refills never drift away from the original clicked song.
    parts.push({ value: referenceAffinity, weight: seed ? 0.16 : 0.55 })
  }
  if (eraAffinity !== undefined) parts.push({ value: eraAffinity, weight: 0.16 })

  if (parts.length === 0) return undefined
  const weightSum = parts.reduce((sum, part) => sum + part.weight, 0)
  return clamp(parts.reduce((sum, part) => sum + part.value * part.weight, 0) / weightSum)
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
  settings: SmartConfig
): { values: Map<string, number>; positiveScores: Array<{ uri: string; score: number }> } => {
  const values = new Map<string, number>()
  const positiveScores: Array<{ uri: string; score: number }> = []
  if (!settings.tasteProfile) return { values, positiveScores }
  const now = settings.tasteProfileNow ?? settings.tasteProfile.updatedAt
  const confidence = getTasteProfileConfidence(settings.tasteProfile, now)
  if (!confidence.ready) return { values, positiveScores }
  for (const candidate of candidates) {
    const multiplier = scoreTasteAffinity(candidate, settings.tasteProfile, {
      genres: candidate.genres,
      now,
      contextKey: settings.tasteContextKey,
    })
    if (Math.abs(multiplier - 1) > 1e-6) {
      const normalized = clamp((multiplier - 0.5) / 1.25)
      values.set(candidate.uri, normalized)
      if (multiplier > 1.02) {
        positiveScores.push({ uri: candidate.uri, score: normalized })
      }
    }
  }
  return { values, positiveScores }
}

const historyFreshnessMultipliers = (
  candidates: readonly TrackCandidate[],
  recentHistoryUris: readonly string[] | undefined,
  metadataByUri: ReadonlyMap<string, TrackCandidate>
): Map<string, number> => {
  const multipliers = new Map<string, number>()
  if (!recentHistoryUris?.length) return multipliers

  const positionByUri = new Map<string, number>()
  const positionByCanonical = new Map<string, number>()
  recentHistoryUris.forEach((uri, index) => {
    if (!uri) return
    if (!positionByUri.has(uri)) positionByUri.set(uri, index)
    const known = metadataByUri.get(uri)
    if (known) {
      for (const canonical of canonicalKeysForTrack(known)) {
        if (!positionByCanonical.has(canonical)) {
          positionByCanonical.set(canonical, index)
        }
      }
    }
  })

  for (const candidate of candidates) {
    const directPos = positionByUri.get(candidate.uri)
    let canonicalPos: number | undefined
    for (const canonical of canonicalKeysForTrack(candidate)) {
      const observed = positionByCanonical.get(canonical)
      if (observed !== undefined && (canonicalPos === undefined || observed < canonicalPos)) {
        canonicalPos = observed
      }
    }
    const position =
      directPos !== undefined && canonicalPos !== undefined
        ? Math.min(directPos, canonicalPos)
        : (directPos ?? canonicalPos)
    if (position !== undefined) {
      // Smooth exponential recovery from 0.12 (just played) back toward 1.0 over ~120 plays.
      const freshness = clamp(0.12 + 0.88 * (1 - Math.exp(-position / 35)))
      multipliers.set(candidate.uri, freshness)
    }
  }

  return multipliers
}

const addRankedProvenance = (
  aggregates: Map<string, { track: TrackCandidate; provenance: CandidateProvenance[] }>,
  scored: Array<{ uri: string; score: number }>,
  source: string,
  familyOverride?: BlendFamily
): void => {
  scored
    .sort((left, right) => right.score - left.score || left.uri.localeCompare(right.uri))
    .forEach((entry, index) => {
      const existing = aggregates.get(entry.uri)
      if (!existing) return
      const family = familyOverride ?? existing.provenance[0]?.family ?? "similar"
      existing.provenance.push({ source, family, rank: index + 1 })
    })
}

const getCandidateArtistTokens = (candidate: {
  artistUri?: string
  artistName?: string
  artistUris?: string[]
  artistNames?: string[]
}): string[] => {
  const tokens: string[] = []
  if (candidate.artistUri) {
    tokens.push(candidate.artistUri.trim().toLowerCase())
  }
  if (candidate.artistUris) {
    for (const uri of candidate.artistUris) {
      if (uri) tokens.push(uri.trim().toLowerCase())
    }
  }
  if (candidate.artistName) {
    const norm = candidate.artistName.trim().toLowerCase().replace(/\s+/g, " ")
    tokens.push(`name:${norm}`)
    tokens.push(norm)
  }
  if (candidate.artistNames) {
    for (const name of candidate.artistNames) {
      if (name) {
        const norm = name.trim().toLowerCase().replace(/\s+/g, " ")
        tokens.push(`name:${norm}`)
        tokens.push(norm)
      }
    }
  }
  return tokens
}

type ArtistDamping = {
  artistFreshness: number
  habitualDamping: number
}

const artistFreshnessMultipliers = (
  candidates: readonly TrackCandidate[],
  options: PlanRecommendationBatchV2Options,
  metadataByUri: ReadonlyMap<string, TrackCandidate>
): Map<string, ArtistDamping> => {
  const result = new Map<string, ArtistDamping>()

  const recentArtistObservations: Array<Set<string>> = []

  for (const rawKey of options.recentArtistKeys ?? []) {
    const norm = rawKey.trim().toLowerCase()
    const set = new Set<string>([norm])
    if (norm.startsWith("name:")) {
      set.add(norm.slice(5).trim())
    }
    recentArtistObservations.push(set)
  }

  for (const uri of options.recentHistoryUris ?? []) {
    const track = metadataByUri.get(uri)
    if (!track) continue
    const tokens = getCandidateArtistTokens(track)
    if (tokens.length > 0) {
      recentArtistObservations.push(new Set(tokens))
    }
  }

  for (const candidate of candidates) {
    const candidateTokens = getCandidateArtistTokens(candidate)

    let artistPos: number | undefined
    let artistRecentOccurrences = 0

    if (candidateTokens.length > 0) {
      for (let index = 0; index < recentArtistObservations.length; index += 1) {
        const obs = recentArtistObservations[index]
        const matches = candidateTokens.some((token) => obs.has(token))
        if (matches) {
          if (artistPos === undefined) {
            artistPos = index
          }
          artistRecentOccurrences += 1
        }
      }
    }

    let artistFreshness = 1.0
    if (artistPos !== undefined && options.mode !== "artist") {
      const posDecay = clamp(0.24 + 0.76 * (1 - Math.exp(-artistPos / 18)))
      const freqDecay = Math.exp(-0.22 * Math.max(0, artistRecentOccurrences - 1))
      artistFreshness = clamp(posDecay * freqDecay, 0.15, 1.0)
    }

    let habitualDamping = 1.0
    if (options.mode !== "artist") {
      const tasteHabitual = scoreArtistHabitualPenalty(
        candidate,
        options.settings.tasteProfile,
        options.settings.tasteProfileNow
      )
      const isHabitual = Boolean(
        options.habitualArtistKeys &&
          candidateTokens.some((token) => options.habitualArtistKeys?.has(token))
      )
      habitualDamping = clamp(isHabitual ? tasteHabitual * 0.62 : tasteHabitual, 0.35, 1.0)
    }

    result.set(candidate.uri, { artistFreshness, habitualDamping })
  }

  return result
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
  if (options.seed?.uri) excluded.add(options.seed.uri)
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

  const excludedCanonical = new Set<string>(options.excludedCanonicalKeys ?? [])
  if (options.seed) {
    for (const key of canonicalKeysForTrack(options.seed)) {
      excludedCanonical.add(key)
    }
  }
  for (const uri of excluded) {
    const known = metadataByUri.get(uri)
    if (known) {
      for (const key of canonicalKeysForTrack(known)) {
        excludedCanonical.add(key)
      }
    }
  }

  const rawAggregates = new Map<
    string,
    { track: TrackCandidate; provenance: CandidateProvenance[] }
  >()
  const sourceWeights: Record<string, number> = {}
  const sourceRanks = new Map<string, number>()
  const artistCountBySource = new Map<string, number>()

  for (const pool of options.pools) {
    const weight =
      typeof pool.weight === "number" && Number.isFinite(pool.weight) ? Math.max(0, pool.weight) : 1
    pool.candidates.forEach((candidate) => {
      if (!candidate.uri?.startsWith("spotify:track:") || excluded.has(candidate.uri)) return
      const mergedKnown = metadataByUri.get(candidate.uri) ?? candidate
      if (canonicalKeysForTrack(mergedKnown).some((key) => excludedCanonical.has(key))) {
        return
      }
      const realSources = getSourceProvenance(candidate).filter(
        (source) => !source.startsWith("profile-playlist:")
      )
      const sources = realSources.length > 0 ? [...new Set(realSources)] : [pool.source]
      const provenance = sources.map((source) => {
        const rank = (sourceRanks.get(source) ?? 0) + 1
        sourceRanks.set(source, rank)
        sourceWeights[source] = Math.max(
          sourceWeights[source] ?? 0,
          weight * (SOURCE_RELIABILITY[source] ?? 0.8)
        )
        const aKey = artistKey(candidate)
        const sourceArtistKey = `${source}::${aKey}`
        const occurrence = (artistCountBySource.get(sourceArtistKey) ?? 0) + 1
        artistCountBySource.set(sourceArtistKey, occurrence)
        const effectiveRank = occurrence > 1 ? rank + (occurrence - 1) * 14 : rank
        return { source, family: pool.family, rank: effectiveRank } satisfies CandidateProvenance
      })
      const current = rawAggregates.get(candidate.uri)
      rawAggregates.set(candidate.uri, {
        track: mergeCandidate(current?.track, candidate),
        provenance: [...(current?.provenance ?? []), ...provenance],
      })
    })
  }

  const rawCandidates = [...rawAggregates.values()].map((entry) => entry.track)
  const references = options.referenceTracks ?? []
  const effectiveGenres = options.seed
    ? expandSeedGenresFromGraph(options.seed, rawCandidates)
    : inferSeedGenres({ genres: [] }, references)

  const vocalSession = options.seed
    ? isVocalSeed(options.seed)
    : references.length === 0 ||
      references.filter((ref) => isVocalSeed(ref)).length >= references.length / 2
  const soundtrackSession = options.seed
    ? isSoundtrackSeed(options.seed, effectiveGenres)
    : references.some((ref) =>
        isSoundtrackSeed({ albumName: ref.albumName, genres: ref.genres ?? [] })
      )

  const allowedAfterSoundtrackAndTitle = new Set(
    filterSoundtracksAndInstrumentals(rawCandidates, vocalSession, soundtrackSession)
      .filter((track) => !hasDisqualifyingTitleMismatch(options.seed ?? undefined, track))
      .map((track) => track.uri)
  )

  const baseEntries = [...rawAggregates.entries()].filter(([uri]) =>
    allowedAfterSoundtrackAndTitle.has(uri)
  )

  // Coherence gate: eliminate cross-genre intrusions and jarring sonic outliers
  // while preserving a safe non-starvation floor on tiny pools.
  const genreFilteredEntries = baseEntries.filter(([, entry]) => {
    const genreCompat = scoreGenreCompatibility(effectiveGenres, entry.track.genres)
    if (genreCompat !== null && genreCompat < 0.22) {
      const consensusHits = new Set(
        entry.provenance
          .map((hit) => hit.source)
          .filter((source) => CONSENSUS_DISCOVERY_SOURCES.has(source))
      )
      return consensusHits.size >= 2
    }
    return true
  })

  const activeAfterGenre =
    genreFilteredEntries.length > 0 || baseEntries.length === 0 ? genreFilteredEntries : baseEntries

  const sonicFilteredEntries = options.seed
    ? activeAfterGenre.filter(
        ([, entry]) => !isSonicOutlier(options.seed ?? undefined, entry.track)
      )
    : activeAfterGenre

  const coherentEntries =
    sonicFilteredEntries.length >= Math.min(3, activeAfterGenre.length)
      ? sonicFilteredEntries
      : activeAfterGenre

  const aggregates = new Map(coherentEntries)
  const candidates = [...aggregates.values()].map((entry) => entry.track)
  const contexts = new Map(
    candidates.map((candidate) => [
      candidate.uri,
      contextAffinity(
        candidate,
        options.seed,
        effectiveGenres,
        references,
        options.settings.eraWindow
      ),
    ])
  )
  if (references.length > 0) {
    sourceWeights["playlist-context"] = 0.45
    addRankedProvenance(
      aggregates,
      [...contexts]
        .filter((entry): entry is [string, number] => entry[1] != null)
        .map(([uri, score]) => ({ uri, score })),
      "playlist-context"
    )
  }

  const tastes = tasteAffinities(candidates, options.settings)
  if (tastes.positiveScores.length > 0) {
    sourceWeights["taste-profile"] = 0.22
    addRankedProvenance(aggregates, tastes.positiveScores, "taste-profile")
  }
  const popularity = popularityAffinities(
    candidates,
    options.seed,
    options.settings.deprioritizePopular
  )
  const historyFreshness = historyFreshnessMultipliers(
    candidates,
    options.recentHistoryUris,
    metadataByUri
  )
  const artistDampingByUri = artistFreshnessMultipliers(candidates, options, metadataByUri)

  const rankable: RankableCandidate[] = [...aggregates.values()].map(({ track, provenance }) => {
    const freshness = historyFreshness.get(track.uri)
    const { artistFreshness, habitualDamping } = artistDampingByUri.get(track.uri) ?? {
      artistFreshness: 1,
      habitualDamping: 1,
    }
    const exposureMult = options.exposureMultipliers?.get(track.uri) ?? 1.0
    const baseNovelty = popularity.get(track.uri)
    let compositeNovelty = clamp(
      (baseNovelty ?? 0.6) * (freshness ?? 1) * artistFreshness * habitualDamping * exposureMult
    )
    if (options.topTrackUris?.has(track.uri)) {
      compositeNovelty = clamp(compositeNovelty * 0.35)
    }

    return {
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
        tasteAffinity: tastes.values.get(track.uri),
        novelty: compositeNovelty,
      },
    }
  })

  const rawRanked = rankCandidatesV2(rankable, {
    sourceWeights,
    seedProfile: acousticProfile(options.seed),
    componentWeights: {
      fusion: 0.24,
      context: 0.23,
      acoustic: 0.18,
      novelty: 0.22,
      taste: 0.08,
      feedback: 0.05,
    },
    skipSignals: options.settings.skipFeedback?.map((skip) => ({
      artistUris: skip.artistUri ? [skip.artistUri] : undefined,
      artistNames: skip.artistName ? [skip.artistName] : undefined,
      acoustic: skip.profile,
      confidence: 1,
    })),
  })

  const ranked = rawRanked
    .map((candidate) => {
      const freshness = historyFreshness.get(candidate.uri)
      const trackFreshness = freshness !== undefined ? 0.52 + 0.48 * freshness : 1.0
      const { artistFreshness, habitualDamping } = artistDampingByUri.get(candidate.uri) ?? {
        artistFreshness: 1,
        habitualDamping: 1,
      }
      const exposureMult = options.exposureMultipliers?.get(candidate.uri) ?? 1.0
      const artistHabitualMultiplier = habitualDamping

      let adjustedScore =
        candidate.score * trackFreshness * artistFreshness * artistHabitualMultiplier * exposureMult

      if (
        vocalSession &&
        candidate.acoustic?.instrumentalness != null &&
        candidate.acoustic.instrumentalness > 0.22
      ) {
        const instPenalty = clamp(
          1 - 0.65 * ((candidate.acoustic.instrumentalness - 0.22) / 0.28),
          0.35,
          1
        )
        adjustedScore *= instPenalty
      }

      return {
        ...candidate,
        score: adjustedScore,
      }
    })
    .sort((left, right) => right.score - left.score || left.uri.localeCompare(right.uri))

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
    explorationBand: options.explorationBand,
    explorationTemperature: options.explorationTemperature,
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
