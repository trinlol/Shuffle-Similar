export type BlendFamily = "similar" | "profile"

export type CandidateProvenance = {
  source: string
  family: BlendFamily
  rank: number
  weight?: number
}

export type AcousticProfile = {
  tempo?: number
  energy?: number
  valence?: number
  danceability?: number
  acousticness?: number
  instrumentalness?: number
}

export type SkipSignal = {
  artistUris?: string[]
  artistNames?: string[]
  acoustic?: AcousticProfile
  confidence?: number
}

export type RankableCandidate = {
  uri: string
  title?: string
  artistUris?: string[]
  artistNames?: string[]
  albumUri?: string
  acoustic?: AcousticProfile
  provenance: CandidateProvenance[]
  signals?: {
    contextAffinity?: number
    tasteAffinity?: number
    novelty?: number
  }
}

export type ScoreComponent =
  | "fusion"
  | "context"
  | "taste"
  | "acoustic"
  | "novelty"
  | "feedback"

export type RankV2Options = {
  sourceWeights?: Record<string, number>
  rrfK?: number
  componentWeights?: Partial<Record<ScoreComponent, number>>
  seedProfile?: AcousticProfile
  skipSignals?: SkipSignal[]
}

export type ScoreBreakdown = {
  values: Record<ScoreComponent, number | null>
  baseWeights: Record<ScoreComponent, number>
  effectiveWeights: Record<ScoreComponent, number>
  contributions: Record<ScoreComponent, number>
  availableWeight: number
  total: number
}

export type RankedCandidate = RankableCandidate & {
  score: number
  fusionScore: number
  familyFusionScore: Record<BlendFamily, number>
  breakdown: ScoreBreakdown
  reasonCodes: RankReasonCode[]
}

export type ProgressiveBlendPhase = {
  maxPosition: number
  similar: number
  profile: number
}

export type PlanSlateV2Options = {
  count: number
  absoluteStartPosition?: number
  rngSeed?: string | number
  blendPhases?: ProgressiveBlendPhase[]
  queueTail?: RankableCandidate[]
  maxAcousticTransition?: number
  mmrLambda?: number
}

export type RankReasonCode =
  | "rank:multi-source"
  | "rank:top-source-hit"
  | "rank:context-match"
  | "rank:taste-match"
  | "rank:acoustic-match"
  | "rank:skip-penalized"
  | "rank:partial-metadata"

export type PlanReasonCode =
  | "blend:similar"
  | "blend:profile"
  | "blend:fallback"
  | "diversity:mmr"
  | "diversity:artist-floor"
  | "transition:acoustic-paced"
  | "relax:acoustic-transition"
  | "relax:album-spacing"
  | "relax:artist-spacing"
  | "relax:artist-cap"

export type PlannedTrack = {
  candidate: RankedCandidate
  absolutePosition: number
  dominantFamily: BlendFamily
  blendWeights: Record<BlendFamily, number>
  acousticDistanceFromPrevious: number | null
  reasonCodes: PlanReasonCode[]
}

export type SlatePlan = {
  items: PlannedTrack[]
  metrics: SlateEvaluationMetrics
}

export type SlateEvaluationMetrics = {
  requestedCount: number
  selectedCount: number
  artistSpacingViolations: number
  albumSpacingViolations: number
  canonicalDuplicateViolations: number
  maxArtistCountFirst20: number
  acousticTransitionViolations: number
  meanAcousticTransition: number | null
  uniqueArtistRatio: number
  sourceCoverage: number
  meanRankScore: number | null
  similarCount: number
  profileCount: number
  relaxedTrackCount: number
}

const SCORE_COMPONENTS: ScoreComponent[] = [
  "fusion",
  "context",
  "taste",
  "acoustic",
  "novelty",
  "feedback",
]

const DEFAULT_COMPONENT_WEIGHTS: Record<ScoreComponent, number> = {
  fusion: 0.3,
  context: 0.2,
  taste: 0.15,
  acoustic: 0.15,
  novelty: 0.05,
  feedback: 0.15,
}

const DEFAULT_BLEND_PHASES: ProgressiveBlendPhase[] = [
  { maxPosition: 4, similar: 1, profile: 0 },
  { maxPosition: 9, similar: 0.7, profile: 0.3 },
  { maxPosition: 19, similar: 0.4, profile: 0.6 },
  { maxPosition: Number.POSITIVE_INFINITY, similar: 0.2, profile: 0.8 },
]

const finitePositive = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

const finiteWeight = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback

const unitValue = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null

const buildBreakdown = (
  values: Record<ScoreComponent, number | null>,
  overrides: Partial<Record<ScoreComponent, number>> = {}
): ScoreBreakdown => {
  const baseWeights = { ...DEFAULT_COMPONENT_WEIGHTS }
  for (const component of SCORE_COMPONENTS) {
    const override = overrides[component]
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
      baseWeights[component] = override
    }
  }

  const availableWeight = SCORE_COMPONENTS.reduce(
    (sum, component) => sum + (values[component] == null ? 0 : baseWeights[component]),
    0
  )
  const effectiveWeights = {} as Record<ScoreComponent, number>
  const contributions = {} as Record<ScoreComponent, number>
  for (const component of SCORE_COMPONENTS) {
    const effective =
      values[component] == null || availableWeight <= 0
        ? 0
        : baseWeights[component] / availableWeight
    effectiveWeights[component] = effective
    contributions[component] = (values[component] ?? 0) * effective
  }
  const total = SCORE_COMPONENTS.reduce(
    (sum, component) => sum + contributions[component],
    0
  )

  return { values, baseWeights, effectiveWeights, contributions, availableWeight, total }
}

export const weightedReciprocalRankFusion = (
  provenance: CandidateProvenance[],
  sourceWeights: Record<string, number> = {},
  rrfK = 60
): number => {
  const bestHitBySource = new Map<string, CandidateProvenance>()
  for (const hit of provenance) {
    const rank = Math.max(1, Math.floor(finitePositive(hit.rank, 1)))
    const previous = bestHitBySource.get(hit.source)
    if (!previous || rank < previous.rank) bestHitBySource.set(hit.source, { ...hit, rank })
  }

  let total = 0
  for (const hit of bestHitBySource.values()) {
    const sourceWeight = finiteWeight(sourceWeights[hit.source], 1)
    const hitWeight = finiteWeight(hit.weight, 1)
    total += (sourceWeight * hitWeight) / (Math.max(0, rrfK) + hit.rank)
  }
  return total
}

export const createSeededRng = (seed: string | number = 0): (() => number) => {
  const text = String(seed)
  let state = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index)
    state = Math.imul(state, 0x01000193)
  }
  state >>>= 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const dominantFamilyFor = (candidate: RankableCandidate): BlendFamily => {
  const rankedFamilyScores = (candidate as Partial<RankedCandidate>).familyFusionScore
  if (rankedFamilyScores) {
    return rankedFamilyScores.profile > rankedFamilyScores.similar ? "profile" : "similar"
  }
  let similar = 0
  let profile = 0
  for (const hit of candidate.provenance) {
    const value = finiteWeight(hit.weight, 1) / Math.max(1, hit.rank)
    if (hit.family === "profile") profile += value
    else similar += value
  }
  return profile > similar ? "profile" : "similar"
}

const getBlendWeights = (
  absolutePosition: number,
  phases: ProgressiveBlendPhase[]
): Record<BlendFamily, number> => {
  const phase =
    phases.find((candidate) => absolutePosition <= candidate.maxPosition) ??
    phases[phases.length - 1] ??
    DEFAULT_BLEND_PHASES[DEFAULT_BLEND_PHASES.length - 1]
  const similar = Math.max(0, phase.similar)
  const profile = Math.max(0, phase.profile)
  const total = similar + profile
  return total > 0
    ? { similar: similar / total, profile: profile / total }
    : { similar: 0.5, profile: 0.5 }
}

const normalizedText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")

export const canonicalizeTrackTitle = (title: string | undefined): string => {
  if (!title) return ""
  const withoutVersionTags = title
    .replace(
      /\s*[\[(][^)\]]*(?:remaster(?:ed)?|live|radio edit|edit|version|mix|mono|stereo|acoustic|demo|session)[^)\]]*[)\]]/gi,
      " "
    )
    .replace(
      /\s*[\u002d\u2013\u2014]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?(?:\s+\d{4})?|live(?:\s+at|\s+from)?|radio edit|edit|version|mix|mono|stereo|acoustic|demo|session).*$/i,
      ""
    )
  return normalizedText(withoutVersionTags)
}

const artistKeys = (candidate: RankableCandidate): string[] => {
  const values = candidate.artistUris?.length ? candidate.artistUris : candidate.artistNames ?? []
  return [...new Set(values.map(normalizedText).filter(Boolean))]
}

export const canonicalTrackKey = (candidate: RankableCandidate): string => {
  const title = canonicalizeTrackTitle(candidate.title)
  if (!title) return candidate.uri
  const artists = artistKeys(candidate).sort().join("+")
  // A title is only a safe duplicate identity when it can be paired with an
  // artist. Partial metadata such as generic "Intro" titles must remain
  // distinct instead of collapsing unrelated tracks into one unknown bucket.
  if (!artists) return candidate.uri
  return `${title}::${artists}`
}

export const normalizeTempoV2 = (tempo: number): number =>
  Math.max(0, Math.min(1, (tempo - 50) / 150))

export const acousticDistanceV2 = (
  left: AcousticProfile | undefined,
  right: AcousticProfile | undefined
): number | null => {
  if (!left || !right) return null
  const pairs: Array<[number | undefined, number | undefined, boolean?]> = [
    [left.tempo, right.tempo, true],
    [left.energy, right.energy],
    [left.valence, right.valence],
    [left.danceability, right.danceability],
    [left.acousticness, right.acousticness],
    [left.instrumentalness, right.instrumentalness],
  ]
  const squaredDeltas = pairs.flatMap(([a, b, tempo]) => {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return []
    const normalizedA = tempo ? normalizeTempoV2(a) : Math.max(0, Math.min(1, a))
    const normalizedB = tempo ? normalizeTempoV2(b) : Math.max(0, Math.min(1, b))
    return [(normalizedA - normalizedB) ** 2]
  })
  if (squaredDeltas.length < 2) return null
  return Math.sqrt(
    squaredDeltas.reduce((sum, squaredDelta) => sum + squaredDelta, 0) /
      squaredDeltas.length
  )
}

const overlaps = (left: string[], right: string[]): boolean => {
  if (left.length === 0 || right.length === 0) return false
  const rightSet = new Set(right)
  return left.some((value) => rightSet.has(value))
}

type SoftConstraint = "acoustic" | "album" | "artistSpacing" | "artistCap"

const constraintViolations = (
  candidate: RankedCandidate,
  items: PlannedTrack[],
  absolutePosition: number,
  queueTail: RankableCandidate[],
  maxAcousticTransition: number
): SoftConstraint[] => {
  const violations: SoftConstraint[] = []
  const candidateArtists = artistKeys(candidate)
  const history = [...queueTail, ...items.map((item) => item.candidate)]
  const recentArtists = history.slice(-5).flatMap(artistKeys)
  if (overlaps(candidateArtists, recentArtists)) violations.push("artistSpacing")

  if (
    candidate.albumUri &&
    history.slice(-4).some((item) => item.albumUri === candidate.albumUri)
  ) {
    violations.push("album")
  }

  if (absolutePosition < 20 && candidateArtists.length > 0) {
    const counts = new Map<string, number>()
    const absoluteStartPosition = absolutePosition - items.length
    const queueTailStartPosition = absoluteStartPosition - queueTail.length
    for (let index = 0; index < queueTail.length; index += 1) {
      const tailPosition = queueTailStartPosition + index
      if (tailPosition < 0 || tailPosition >= 20) continue
      for (const artist of artistKeys(queueTail[index])) {
        counts.set(artist, (counts.get(artist) ?? 0) + 1)
      }
    }
    for (const item of items.filter((entry) => entry.absolutePosition < 20)) {
      for (const artist of artistKeys(item.candidate)) {
        counts.set(artist, (counts.get(artist) ?? 0) + 1)
      }
    }
    if (candidateArtists.some((artist) => (counts.get(artist) ?? 0) >= 2)) {
      violations.push("artistCap")
    }
  }

  const previous = history[history.length - 1]
  const transitionDistance = acousticDistanceV2(previous?.acoustic, candidate.acoustic)
  if (transitionDistance != null && transitionDistance > maxAcousticTransition) {
    violations.push("acoustic")
  }

  return violations
}

const RELAXATION_ORDER: SoftConstraint[][] = [
  [],
  ["acoustic"],
  ["acoustic", "album"],
  ["acoustic", "album", "artistSpacing"],
  ["acoustic", "album", "artistSpacing", "artistCap"],
]

const relaxationReason = (constraint: SoftConstraint): PlanReasonCode => {
  if (constraint === "acoustic") return "relax:acoustic-transition"
  if (constraint === "album") return "relax:album-spacing"
  if (constraint === "artistSpacing") return "relax:artist-spacing"
  return "relax:artist-cap"
}

export const evaluateSlateV2 = (
  items: PlannedTrack[],
  requestedCount = items.length,
  options: Pick<PlanSlateV2Options, "queueTail" | "maxAcousticTransition"> = {}
): SlateEvaluationMetrics => {
  let artistSpacingViolations = 0
  let albumSpacingViolations = 0
  let canonicalDuplicateViolations = 0
  const earlyArtistCounts = new Map<string, number>()
  const transitionDistances: number[] = []
  let acousticTransitionViolations = 0
  const maxAcousticTransition = options.maxAcousticTransition ?? 0.42
  const queueTail = options.queueTail ?? []
  const seenCanonical = new Set(queueTail.map(canonicalTrackKey))
  const artistSignatures = new Set<string>()
  const sources = new Set<string>()
  let scoreTotal = 0
  let similarCount = 0
  let profileCount = 0
  let relaxedTrackCount = 0
  const absoluteStartPosition = items[0]?.absolutePosition ?? 0
  const queueTailStartPosition = absoluteStartPosition - queueTail.length
  for (let index = 0; index < queueTail.length; index += 1) {
    const tailPosition = queueTailStartPosition + index
    if (tailPosition < 0 || tailPosition >= 20) continue
    for (const artist of artistKeys(queueTail[index])) {
      earlyArtistCounts.set(artist, (earlyArtistCounts.get(artist) ?? 0) + 1)
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const candidateArtists = artistKeys(item.candidate)
    const priorCandidates = [
      ...queueTail,
      ...items.slice(0, index).map((entry) => entry.candidate),
    ]
    const recentArtists = priorCandidates.slice(-5).flatMap(artistKeys)
    if (overlaps(candidateArtists, recentArtists)) artistSpacingViolations += 1
    if (
      item.candidate.albumUri &&
      priorCandidates.slice(-4).some((candidate) => candidate.albumUri === item.candidate.albumUri)
    ) {
      albumSpacingViolations += 1
    }
    const canonical = canonicalTrackKey(item.candidate)
    if (seenCanonical.has(canonical)) canonicalDuplicateViolations += 1
    seenCanonical.add(canonical)
    if (item.absolutePosition < 20) {
      for (const artist of candidateArtists) {
        earlyArtistCounts.set(artist, (earlyArtistCounts.get(artist) ?? 0) + 1)
      }
    }
    const artistSignature = candidateArtists.sort().join("+")
    if (artistSignature) artistSignatures.add(artistSignature)
    for (const hit of item.candidate.provenance) sources.add(hit.source)
    scoreTotal += item.candidate.score
    if (item.dominantFamily === "similar") similarCount += 1
    else profileCount += 1
    if (item.reasonCodes.some((reason) => reason.startsWith("relax:"))) {
      relaxedTrackCount += 1
    }
    const previous = index > 0 ? items[index - 1].candidate : queueTail[queueTail.length - 1]
    const transitionDistance = acousticDistanceV2(previous?.acoustic, item.candidate.acoustic)
    if (transitionDistance != null) {
      transitionDistances.push(transitionDistance)
      if (transitionDistance > maxAcousticTransition) acousticTransitionViolations += 1
    }
  }

  return {
    requestedCount,
    selectedCount: items.length,
    artistSpacingViolations,
    albumSpacingViolations,
    canonicalDuplicateViolations,
    maxArtistCountFirst20: Math.max(0, ...earlyArtistCounts.values()),
    acousticTransitionViolations,
    meanAcousticTransition:
      transitionDistances.length > 0
        ? transitionDistances.reduce((sum, distance) => sum + distance, 0) /
          transitionDistances.length
        : null,
    uniqueArtistRatio: items.length > 0 ? artistSignatures.size / items.length : 0,
    sourceCoverage: sources.size,
    meanRankScore: items.length > 0 ? scoreTotal / items.length : null,
    similarCount,
    profileCount,
    relaxedTrackCount,
  }
}

const candidateSimilarity = (
  candidate: RankableCandidate,
  other: RankableCandidate
): number => {
  let similarity = 0
  if (overlaps(artistKeys(candidate), artistKeys(other))) similarity = Math.max(similarity, 0.85)
  if (candidate.albumUri && candidate.albumUri === other.albumUri) similarity = Math.max(similarity, 0.9)
  const acousticDistance = acousticDistanceV2(candidate.acoustic, other.acoustic)
  if (acousticDistance != null) similarity = Math.max(similarity, 1 - Math.min(1, acousticDistance))
  const sources = new Set(candidate.provenance.map((hit) => hit.source))
  const otherSources = new Set(other.provenance.map((hit) => hit.source))
  if (sources.size > 0 && otherSources.size > 0) {
    const intersection = [...sources].filter((source) => otherSources.has(source)).length
    const union = new Set([...sources, ...otherSources]).size
    similarity = Math.max(similarity, (intersection / union) * 0.35)
  }
  return similarity
}

const skipArtistKeys = (skip: SkipSignal): string[] => {
  const values = skip.artistUris?.length ? skip.artistUris : skip.artistNames ?? []
  return [...new Set(values.map(normalizedText).filter(Boolean))]
}

const feedbackAffinity = (
  candidate: RankableCandidate,
  skipSignals: SkipSignal[] | undefined
): number | null => {
  if (!skipSignals?.length) return null
  let comparable = false
  const candidateArtists = artistKeys(candidate)
  const artistEvidence: number[] = []
  const acousticEvidence: number[] = []

  for (const skip of skipSignals.slice(-32)) {
    const confidence = Math.max(0, Math.min(1, skip.confidence ?? 1))
    const skippedArtists = skipArtistKeys(skip)
    if (candidateArtists.length > 0 && skippedArtists.length > 0) {
      comparable = true
      if (overlaps(candidateArtists, skippedArtists)) artistEvidence.push(confidence)
    }
    const distance = acousticDistanceV2(candidate.acoustic, skip.acoustic)
    if (distance != null) {
      comparable = true
      if (distance <= 0.18) acousticEvidence.push(confidence)
    }
  }

  if (!comparable) return null
  const boundedEvidence = (values: readonly number[]): number => {
    if (values.length === 0) return 0
    const maximum = Math.max(...values)
    const residual = values.reduce((sum, value) => sum + value, 0) - maximum
    return Math.min(1, maximum + (1 - maximum) * (residual / (1 + residual)))
  }
  // Repeated observations can increase confidence, but never multiply a
  // candidate toward zero. The strongest supported penalty remains the 90%
  // artist response from the recommendation heuristic.
  const penalty = Math.max(
    0.9 * boundedEvidence(artistEvidence),
    0.75 * boundedEvidence(acousticEvidence)
  )
  return Math.max(0.1, Math.min(1, 1 - penalty))
}

export const rankCandidatesV2 = (
  candidates: RankableCandidate[],
  options: RankV2Options = {}
): RankedCandidate[] => {
  const scored = candidates.map((candidate) => ({
    candidate,
    fusionScore: weightedReciprocalRankFusion(
      candidate.provenance,
      options.sourceWeights,
      options.rrfK
    ),
    familyFusionScore: {
      similar: weightedReciprocalRankFusion(
        candidate.provenance.filter((hit) => hit.family === "similar"),
        options.sourceWeights,
        options.rrfK
      ),
      profile: weightedReciprocalRankFusion(
        candidate.provenance.filter((hit) => hit.family === "profile"),
        options.sourceWeights,
        options.rrfK
      ),
    },
  }))
  const maxFusion = Math.max(0, ...scored.map((entry) => entry.fusionScore))

  return scored
    .map(({ candidate, fusionScore, familyFusionScore }) => {
      const normalizedFusion = maxFusion > 0 ? fusionScore / maxFusion : null
      const seedDistance = acousticDistanceV2(candidate.acoustic, options.seedProfile)
      const acousticAffinity = seedDistance == null ? null : Math.exp(-2.5 * seedDistance)
      const learnedFeedbackAffinity = feedbackAffinity(candidate, options.skipSignals)
      const values: Record<ScoreComponent, number | null> = {
        fusion: normalizedFusion,
        context: unitValue(candidate.signals?.contextAffinity),
        taste: unitValue(candidate.signals?.tasteAffinity),
        acoustic: acousticAffinity,
        novelty: unitValue(candidate.signals?.novelty),
        feedback: learnedFeedbackAffinity,
      }
      const breakdown = buildBreakdown(values, options.componentWeights)
      const reasonCodes: RankReasonCode[] = []
      if (new Set(candidate.provenance.map((hit) => hit.source)).size > 1) {
        reasonCodes.push("rank:multi-source")
      }
      if (candidate.provenance.some((hit) => hit.rank <= 3)) {
        reasonCodes.push("rank:top-source-hit")
      }
      if ((values.context ?? 0) >= 0.7) reasonCodes.push("rank:context-match")
      if ((values.taste ?? 0) >= 0.7) reasonCodes.push("rank:taste-match")
      if ((values.acoustic ?? 0) >= 0.7) reasonCodes.push("rank:acoustic-match")
      if (values.feedback != null && values.feedback < 0.7) {
        reasonCodes.push("rank:skip-penalized")
      }
      if (
        !candidate.title ||
        artistKeys(candidate).length === 0 ||
        !candidate.albumUri
      ) {
        reasonCodes.push("rank:partial-metadata")
      }
      return {
        ...candidate,
        fusionScore,
        familyFusionScore,
        score: breakdown.availableWeight > 0 ? breakdown.total : 0.5,
        breakdown,
        reasonCodes,
      }
    })
    .sort((left, right) => right.score - left.score || left.uri.localeCompare(right.uri))
}

export const planSlateV2 = (
  rankedCandidates: RankedCandidate[],
  options: PlanSlateV2Options
): SlatePlan => {
  const count = Math.max(0, Math.floor(options.count))
  const start = Math.max(0, Math.floor(options.absoluteStartPosition ?? 0))
  const phases = options.blendPhases?.length ? options.blendPhases : DEFAULT_BLEND_PHASES
  const rng = createSeededRng(options.rngSeed)
  const queueTail = options.queueTail ?? []
  const maxAcousticTransition = options.maxAcousticTransition ?? 0.42
  const mmrLambda = Math.max(0, Math.min(1, options.mmrLambda ?? 0.72))
  const seenCanonical = new Set(queueTail.map(canonicalTrackKey))
  const seenUris = new Set(queueTail.map((candidate) => candidate.uri))
  let remaining = rankedCandidates.filter((candidate) => {
    if (seenUris.has(candidate.uri)) return false
    const canonical = canonicalTrackKey(candidate)
    if (seenCanonical.has(canonical)) return false
    seenCanonical.add(canonical)
    return true
  })
  const items: PlannedTrack[] = []
  const expected: Record<BlendFamily, number> = { similar: 0, profile: 0 }
  const selected: Record<BlendFamily, number> = { similar: 0, profile: 0 }

  while (items.length < count && remaining.length > 0) {
    const absolutePosition = start + items.length
    const blendWeights = getBlendWeights(absolutePosition, phases)
    expected.similar += blendWeights.similar
    expected.profile += blendWeights.profile
    const similarDeficit = expected.similar - selected.similar
    const profileDeficit = expected.profile - selected.profile
    const desiredFamily =
      Math.abs(similarDeficit - profileDeficit) < 1e-9
        ? rng() < 0.5
          ? "similar"
          : "profile"
        : similarDeficit > profileDeficit
          ? "similar"
          : "profile"
    let feasible: RankedCandidate[] = []
    let allowedRelaxations: SoftConstraint[] = []
    for (const allowed of RELAXATION_ORDER) {
      const allowedSet = new Set(allowed)
      feasible = remaining.filter((candidate) =>
        constraintViolations(
          candidate,
          items,
          absolutePosition,
          queueTail,
          maxAcousticTransition
        ).every((violation) => allowedSet.has(violation))
      )
      if (feasible.length > 0) {
        allowedRelaxations = allowed
        break
      }
    }
    if (feasible.length === 0) break
    let usedArtistFloor = false
    if (absolutePosition < 20) {
      const queueTailStart = start - queueTail.length
      const earlyArtists = new Set<string>()
      queueTail.forEach((candidate, index) => {
        const tailPosition = queueTailStart + index
        if (tailPosition < 0 || tailPosition >= 20) return
        for (const artist of artistKeys(candidate)) earlyArtists.add(artist)
      })
      for (const item of items) {
        if (item.absolutePosition >= 20) continue
        for (const artist of artistKeys(item.candidate)) earlyArtists.add(artist)
      }
      const targetAfterPick = Math.min(15, Math.ceil(((absolutePosition + 1) * 15) / 20))
      if (earlyArtists.size < targetAfterPick) {
        const novelArtists = feasible.filter((candidate) => {
          const artists = artistKeys(candidate)
          return artists.length > 0 && artists.every((artist) => !earlyArtists.has(artist))
        })
        if (novelArtists.length > 0) {
          feasible = novelArtists
          usedArtistFloor = true
        }
      }
    }
    const preferred = feasible.filter(
      (candidate) => dominantFamilyFor(candidate) === desiredFamily
    )
    const usedBlendFallback = preferred.length === 0
    const pool = usedBlendFallback ? feasible : preferred
    const selectedCandidates = [...queueTail, ...items.map((item) => item.candidate)]
    const objectives = pool.map((candidate) => {
      const redundancy = selectedCandidates.length
        ? Math.max(...selectedCandidates.map((other) => candidateSimilarity(candidate, other)))
        : 0
      return {
        candidate,
        objective: mmrLambda * candidate.score - (1 - mmrLambda) * redundancy,
      }
    })
    const bestScore = Math.max(...objectives.map((entry) => entry.objective))
    const tied = objectives.filter((entry) => Math.abs(entry.objective - bestScore) < 1e-12)
    const picked = (tied[Math.floor(rng() * tied.length)] ?? objectives[0]).candidate
    const dominantFamily = dominantFamilyFor(picked)
    const previous = selectedCandidates[selectedCandidates.length - 1]
    const acousticDistanceFromPrevious = acousticDistanceV2(
      previous?.acoustic,
      picked.acoustic
    )
    const reasonCodes: PlanReasonCode[] = [
      dominantFamily === "similar" ? "blend:similar" : "blend:profile",
      "diversity:mmr",
    ]
    if (usedArtistFloor) reasonCodes.push("diversity:artist-floor")
    if (usedBlendFallback) reasonCodes.push("blend:fallback")
    if (
      acousticDistanceFromPrevious != null &&
      acousticDistanceFromPrevious <= maxAcousticTransition
    ) {
      reasonCodes.push("transition:acoustic-paced")
    }
    const pickedViolations = new Set(
      constraintViolations(
        picked,
        items,
        absolutePosition,
        queueTail,
        maxAcousticTransition
      )
    )
    for (const relaxation of allowedRelaxations) {
      if (pickedViolations.has(relaxation)) {
        reasonCodes.push(relaxationReason(relaxation))
      }
    }

    items.push({
      candidate: picked,
      absolutePosition,
      dominantFamily,
      blendWeights,
      acousticDistanceFromPrevious,
      reasonCodes,
    })
    selected[dominantFamily] += 1
    remaining = remaining.filter((candidate) => candidate.uri !== picked.uri)
  }

  return {
    items,
    metrics: evaluateSlateV2(items, count, { queueTail, maxAcousticTransition }),
  }
}
