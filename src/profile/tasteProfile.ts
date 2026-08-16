import type { AcousticProfile, TrackCandidate } from "../session/types"

export const TASTE_PROFILE_SCHEMA_VERSION = 2 as const
export const TASTE_PROFILE_STORAGE_KEY = "shuffleSimilar:tasteProfile:v2"

const DAY_MS = 24 * 60 * 60 * 1_000
const POSITIVE_HALF_LIFE_MS = 60 * DAY_MS
const NEGATIVE_HALF_LIFE_MS = 21 * DAY_MS
const MIN_EFFECTIVE_OUTCOMES = 2.25
const MIN_DISTINCT_TRACKS = 3
const MAX_TRACK_SIGNALS = 240
const MAX_ARTIST_SIGNALS = 200
const MAX_GENRE_SIGNALS = 260
const MAX_POSITIVE_ACOUSTIC_SIGNALS = 140
const MAX_NEGATIVE_ACOUSTIC_SIGNALS = 140
const MAX_GENRES_PER_OUTCOME = 8
const MAX_KEY_LENGTH = 256
const MAX_GENRE_LENGTH = 80
const MAX_STORED_BYTES = 512 * 1_024

export const MAX_PROFILE_SIGNALS =
  MAX_TRACK_SIGNALS +
  MAX_ARTIST_SIGNALS +
  MAX_GENRE_SIGNALS +
  MAX_POSITIVE_ACOUSTIC_SIGNALS +
  MAX_NEGATIVE_ACOUSTIC_SIGNALS

export type TasteSentiment = -1 | 1

export type CategoricalTasteSignal = {
  key: string
  sentiment: TasteSentiment
  strength: number
  occurredAt: number
  contextKey?: string
}

export type AcousticTasteSignal = {
  profile: AcousticProfile
  strength: number
  occurredAt: number
  contextKey?: string
}

export type TasteProfileState = {
  version: typeof TASTE_PROFILE_SCHEMA_VERSION
  updatedAt: number
  signals: {
    tracks: CategoricalTasteSignal[]
    artists: CategoricalTasteSignal[]
    genres: CategoricalTasteSignal[]
    acousticPositive: AcousticTasteSignal[]
    acousticNegative: AcousticTasteSignal[]
  }
}

export type TastePlaybackOutcome = {
  type: "early-skip" | "substantial-play" | "completion"
  candidate: TrackCandidate
  genres?: readonly string[]
  occurredAt: number
  contextKey?: string
}

export type ExplicitTasteFeedback = {
  sentiment: TasteSentiment
  candidate: TrackCandidate
  genres?: readonly string[]
  occurredAt: number
  contextKey?: string
}

export type TasteScoringContext = {
  genres?: readonly string[]
  now: number
  contextKey?: string
}

export type TasteProfileConfidence = {
  ready: boolean
  confidence: number
  effectiveOutcomes: number
  distinctTracks: number
}

export type TasteProfileStorage = {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

export type SpicetifyLocalStorageLike = TasteProfileStorage

export type TasteProfileStore = {
  load: (now?: number) => TasteProfileState
  record: (outcome: TastePlaybackOutcome) => TasteProfileState
  recordFeedback: (feedback: ExplicitTasteFeedback) => TasteProfileState
  clear: () => void
}

const ACOUSTIC_KEYS = [
  "tempo",
  "energy",
  "valence",
  "danceability",
  "acousticness",
  "instrumentalness",
] as const satisfies readonly (keyof AcousticProfile)[]

type DecodeStatus = "current" | "migrated" | "missing" | "malformed" | "future"

type DecodeResult = {
  profile: TasteProfileState
  status: DecodeStatus
}

type LegacyEvent = {
  type?: unknown
  trackUri?: unknown
  artistUri?: unknown
  artistName?: unknown
  genres?: unknown
  acoustic?: unknown
  occurredAt?: unknown
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

const cleanKey = (value: unknown, maxLength = MAX_KEY_LENGTH): string | null => {
  if (typeof value !== "string") return null
  const cleaned = value.trim().slice(0, maxLength)
  return cleaned || null
}

const normalizeGenre = (value: unknown): string | null => {
  const cleaned = cleanKey(value, MAX_GENRE_LENGTH)
  return cleaned?.toLocaleLowerCase().replace(/\s+/g, " ") ?? null
}

const normalizeContextKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9:_-]+/g, "-").slice(0, 80)
  return normalized || undefined
}

/** A bounded local context label; it contains no track title or account data. */
export const createListeningContextKey = (source: string | undefined, now = Date.now()): string => {
  const hour = new Date(now).getHours()
  const dayPart = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "day" : "evening"
  const normalizedSource = normalizeContextKey(source) ?? "track"
  return `${normalizedSource}:${dayPart}`
}

const normalizeGenres = (genres: unknown): string[] => {
  if (!Array.isArray(genres)) return []
  const unique = new Set<string>()
  for (const value of genres) {
    const genre = normalizeGenre(value)
    if (genre) unique.add(genre)
    if (unique.size >= MAX_GENRES_PER_OUTCOME) break
  }
  return [...unique]
}

const artistKey = (candidate: Pick<TrackCandidate, "artistUri" | "artistName">): string | null => {
  const uri = cleanKey(candidate.artistUri)
  if (uri) return uri
  const name = cleanKey(candidate.artistName)
  return name ? `name:${name.toLocaleLowerCase().replace(/\s+/g, " ")}` : null
}

const sanitizeAcousticProfile = (value: unknown): AcousticProfile | null => {
  if (!isRecord(value)) return null
  const profile: AcousticProfile = {}
  let featureCount = 0

  for (const key of ACOUSTIC_KEYS) {
    const raw = value[key]
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue
    if (key === "tempo") {
      if (raw < 0 || raw > 400) continue
      profile[key] = raw
    } else {
      if (raw < 0 || raw > 1) continue
      profile[key] = raw
    }
    featureCount += 1
  }

  return featureCount >= 2 ? profile : null
}

const candidateAcousticProfile = (candidate: TrackCandidate): AcousticProfile | null =>
  sanitizeAcousticProfile(candidate)

const keepNewest = <T extends { occurredAt: number }>(signals: T[], limit: number): T[] => {
  if (signals.length <= limit) return signals
  return [...signals]
    .sort((left, right) => left.occurredAt - right.occurredAt)
    .slice(-limit)
}

const pruneProfile = (profile: TasteProfileState): TasteProfileState => ({
  ...profile,
  signals: {
    tracks: keepNewest(profile.signals.tracks, MAX_TRACK_SIGNALS),
    artists: keepNewest(profile.signals.artists, MAX_ARTIST_SIGNALS),
    genres: keepNewest(profile.signals.genres, MAX_GENRE_SIGNALS),
    acousticPositive: keepNewest(
      profile.signals.acousticPositive,
      MAX_POSITIVE_ACOUSTIC_SIGNALS
    ),
    acousticNegative: keepNewest(
      profile.signals.acousticNegative,
      MAX_NEGATIVE_ACOUSTIC_SIGNALS
    ),
  },
})

export const createEmptyTasteProfile = (now = Date.now()): TasteProfileState => ({
  version: TASTE_PROFILE_SCHEMA_VERSION,
  updatedAt: validTimestamp(now) ? now : 0,
  signals: {
    tracks: [],
    artists: [],
    genres: [],
    acousticPositive: [],
    acousticNegative: [],
  },
})

const outcomeDetails = (
  type: TastePlaybackOutcome["type"]
): { sentiment: TasteSentiment; strength: number } | null => {
  switch (type) {
    case "early-skip":
      return { sentiment: -1, strength: 1 }
    case "substantial-play":
      return { sentiment: 1, strength: 0.55 }
    case "completion":
      return { sentiment: 1, strength: 1 }
    default:
      return null
  }
}

const recordTasteSignal = (
  profile: TasteProfileState,
  input: ExplicitTasteFeedback,
  strength: number
): TasteProfileState => {
  if (!validTimestamp(input.occurredAt)) return profile

  const trackKey = cleanKey(input.candidate?.uri)
  if (!trackKey) return profile
  const contextKey = normalizeContextKey(input.contextKey)

  const categorical = (key: string): CategoricalTasteSignal => ({
    key,
    sentiment: input.sentiment,
    strength,
    occurredAt: input.occurredAt,
    contextKey,
  })
  const artists = [...profile.signals.artists]
  const matchedArtist = artistKey(input.candidate)
  if (matchedArtist) artists.push(categorical(matchedArtist))

  const genres = [...profile.signals.genres]
  for (const genre of normalizeGenres(input.genres)) genres.push(categorical(genre))

  const acousticPositive = [...profile.signals.acousticPositive]
  const acousticNegative = [...profile.signals.acousticNegative]
  const acoustic = candidateAcousticProfile(input.candidate)
  if (acoustic) {
    const signal: AcousticTasteSignal = {
      profile: acoustic,
      strength,
      occurredAt: input.occurredAt,
      contextKey,
    }
    if (input.sentiment > 0) acousticPositive.push(signal)
    else acousticNegative.push(signal)
  }

  return pruneProfile({
    version: TASTE_PROFILE_SCHEMA_VERSION,
    updatedAt: Math.max(profile.updatedAt, input.occurredAt),
    signals: {
      tracks: [...profile.signals.tracks, categorical(trackKey)],
      artists,
      genres,
      acousticPositive,
      acousticNegative,
    },
  })
}

export const recordPlaybackOutcome = (
  profile: TasteProfileState,
  outcome: TastePlaybackOutcome
): TasteProfileState => {
  const details = outcomeDetails(outcome.type)
  if (!details) return profile
  return recordTasteSignal(profile, {
    sentiment: details.sentiment,
    candidate: outcome.candidate,
    genres: outcome.genres,
    occurredAt: outcome.occurredAt,
    contextKey: outcome.contextKey,
  }, details.strength)
}

export const recordExplicitTasteFeedback = (
  profile: TasteProfileState,
  feedback: ExplicitTasteFeedback
): TasteProfileState => recordTasteSignal(profile, feedback, 1.5)

const sanitizeCategoricalSignal = (value: unknown): CategoricalTasteSignal | null => {
  if (!isRecord(value)) return null
  const key = cleanKey(value.key)
  const sentiment = value.sentiment
  const strength = value.strength
  const occurredAt = value.occurredAt
  if (
    !key ||
    (sentiment !== 1 && sentiment !== -1) ||
    typeof strength !== "number" ||
    !Number.isFinite(strength) ||
    strength <= 0 ||
    !validTimestamp(occurredAt)
  ) {
    return null
  }
  return { key, sentiment, strength: clamp(strength, 0.05, 1), occurredAt, contextKey: normalizeContextKey(value.contextKey) }
}

const sanitizeAcousticSignal = (value: unknown): AcousticTasteSignal | null => {
  if (!isRecord(value)) return null
  const profile = sanitizeAcousticProfile(value.profile)
  const strength = value.strength
  const occurredAt = value.occurredAt
  if (
    !profile ||
    typeof strength !== "number" ||
    !Number.isFinite(strength) ||
    strength <= 0 ||
    !validTimestamp(occurredAt)
  ) {
    return null
  }
  return { profile, strength: clamp(strength, 0.05, 1), occurredAt, contextKey: normalizeContextKey(value.contextKey) }
}

const sanitizeArray = <T>(
  value: unknown,
  sanitizer: (entry: unknown) => T | null
): T[] | null => {
  if (!Array.isArray(value)) return null
  return value.map(sanitizer).filter((entry): entry is T => entry !== null)
}

const parseCurrentProfile = (value: Record<string, unknown>, now: number): TasteProfileState | null => {
  if (!isRecord(value.signals)) return null
  const tracks = sanitizeArray(value.signals.tracks, sanitizeCategoricalSignal)
  const artists = sanitizeArray(value.signals.artists, sanitizeCategoricalSignal)
  const genres = sanitizeArray(value.signals.genres, sanitizeCategoricalSignal)
  const acousticPositive = sanitizeArray(value.signals.acousticPositive, sanitizeAcousticSignal)
  const acousticNegative = sanitizeArray(value.signals.acousticNegative, sanitizeAcousticSignal)
  if (!tracks || !artists || !genres || !acousticPositive || !acousticNegative) return null

  const latestSignal = [
    ...tracks,
    ...artists,
    ...genres,
    ...acousticPositive,
    ...acousticNegative,
  ].reduce((latest, signal) => Math.max(latest, signal.occurredAt), 0)
  const updatedAt = validTimestamp(value.updatedAt) ? value.updatedAt : latestSignal || now

  return pruneProfile({
    version: TASTE_PROFILE_SCHEMA_VERSION,
    updatedAt,
    signals: { tracks, artists, genres, acousticPositive, acousticNegative },
  })
}

const migrateV1Profile = (value: Record<string, unknown>, now: number): TasteProfileState | null => {
  if (!Array.isArray(value.events)) return null
  let profile = createEmptyTasteProfile(validTimestamp(value.updatedAt) ? value.updatedAt : now)
  const events = value.events
    .filter(isRecord)
    .filter((event): event is Record<string, unknown> & LegacyEvent => validTimestamp(event.occurredAt))
    .sort((left, right) => Number(left.occurredAt) - Number(right.occurredAt))
    .slice(-MAX_TRACK_SIGNALS)

  for (const event of events) {
    if (
      event.type !== "early-skip" &&
      event.type !== "substantial-play" &&
      event.type !== "completion"
    ) {
      continue
    }
    const uri = cleanKey(event.trackUri)
    if (!uri) continue
    const acoustic = sanitizeAcousticProfile(event.acoustic) ?? {}
    profile = recordPlaybackOutcome(profile, {
      type: event.type,
      candidate: {
        uri,
        artistUri: cleanKey(event.artistUri) ?? undefined,
        artistName: cleanKey(event.artistName) ?? undefined,
        ...acoustic,
      },
      genres: normalizeGenres(event.genres),
      occurredAt: event.occurredAt as number,
    })
  }
  return profile
}

const decodeProfile = (raw: string | null, now: number): DecodeResult => {
  if (!raw) return { profile: createEmptyTasteProfile(now), status: "missing" }
  if (raw.length > MAX_STORED_BYTES) {
    return { profile: createEmptyTasteProfile(now), status: "malformed" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { profile: createEmptyTasteProfile(now), status: "malformed" }
  }
  if (!isRecord(parsed) || typeof parsed.version !== "number") {
    return { profile: createEmptyTasteProfile(now), status: "malformed" }
  }
  if (parsed.version > TASTE_PROFILE_SCHEMA_VERSION) {
    return { profile: createEmptyTasteProfile(now), status: "future" }
  }

  const profile =
    parsed.version === TASTE_PROFILE_SCHEMA_VERSION
      ? parseCurrentProfile(parsed, now)
      : parsed.version === 1
        ? migrateV1Profile(parsed, now)
        : null
  if (!profile) return { profile: createEmptyTasteProfile(now), status: "malformed" }
  return {
    profile,
    status: parsed.version === TASTE_PROFILE_SCHEMA_VERSION ? "current" : "migrated",
  }
}

export const createSpicetifyLocalStorageAdapter = (
  storage: SpicetifyLocalStorageLike = Spicetify.LocalStorage
): TasteProfileStorage => ({
  get: (key) => storage.get(key),
  set: (key, value) => storage.set(key, value),
  remove: (key) => storage.remove(key),
})

export const createTasteProfileStore = (
  storage: TasteProfileStorage = createSpicetifyLocalStorageAdapter(),
  storageKey = TASTE_PROFILE_STORAGE_KEY
): TasteProfileStore => {
  const read = (now: number): DecodeResult => {
    let raw: string | null = null
    try {
      raw = storage.get(storageKey)
    } catch {
      return { profile: createEmptyTasteProfile(now), status: "missing" }
    }
    return decodeProfile(raw, now)
  }

  const repairIfNeeded = (decoded: DecodeResult): void => {
    if (decoded.status === "malformed") {
      try {
        storage.remove(storageKey)
      } catch {
        // A broken local store must never break playback.
      }
    } else if (decoded.status === "migrated") {
      try {
        storage.set(storageKey, JSON.stringify(decoded.profile))
      } catch {
        // The migrated in-memory profile is still safe to use for this session.
      }
    }
  }

  return {
    load: (now = Date.now()) => {
      const safeNow = validTimestamp(now) ? now : 0
      const decoded = read(safeNow)
      repairIfNeeded(decoded)
      return decoded.profile
    },
    record: (outcome) => {
      const safeNow = validTimestamp(outcome.occurredAt) ? outcome.occurredAt : 0
      const decoded = read(safeNow)
      repairIfNeeded(decoded)
      if (decoded.status === "future") return decoded.profile

      const updated = recordPlaybackOutcome(decoded.profile, outcome)
      try {
        storage.set(storageKey, JSON.stringify(updated))
      } catch {
        // Learning is best-effort and local storage failure must not interrupt playback.
      }
      return updated
    },
    recordFeedback: (feedback) => {
      const safeNow = validTimestamp(feedback.occurredAt) ? feedback.occurredAt : 0
      const decoded = read(safeNow)
      repairIfNeeded(decoded)
      if (decoded.status === "future") return decoded.profile

      const updated = recordExplicitTasteFeedback(decoded.profile, feedback)
      try {
        storage.set(storageKey, JSON.stringify(updated))
      } catch {
        // Explicit feedback remains best-effort and never interrupts playback.
      }
      return updated
    },
    clear: () => {
      try {
        storage.remove(storageKey)
      } catch {
        // Clearing an unavailable local store is already effectively complete.
      }
    },
  }
}

const signalDecay = (occurredAt: number, sentiment: TasteSentiment, now: number): number => {
  const age = Math.max(0, now - occurredAt)
  const halfLife = sentiment > 0 ? POSITIVE_HALF_LIFE_MS : NEGATIVE_HALF_LIFE_MS
  return 0.5 ** (age / halfLife)
}

export const getTasteProfileConfidence = (
  profile: TasteProfileState,
  now: number
): TasteProfileConfidence => {
  const effectiveOutcomes = profile.signals.tracks.reduce(
    (sum, signal) => sum + signal.strength * signalDecay(signal.occurredAt, signal.sentiment, now),
    0
  )
  const distinctTracks = new Set(profile.signals.tracks.map((signal) => signal.key)).size
  const sampleConfidence = 1 - Math.exp(-effectiveOutcomes / 5)
  const diversityConfidence = Math.min(1, distinctTracks / 4)
  const confidence = clamp(sampleConfidence * diversityConfidence, 0, 1)
  return {
    ready: effectiveOutcomes >= MIN_EFFECTIVE_OUTCOMES && distinctTracks >= MIN_DISTINCT_TRACKS,
    confidence,
    effectiveOutcomes,
    distinctTracks,
  }
}

const categoricalAffinity = (
  keys: ReadonlySet<string>,
  signals: readonly CategoricalTasteSignal[],
  now: number,
  contextKey?: string
): number | null => {
  let signed = 0
  let total = 0
  for (const signal of signals) {
    if (!keys.has(signal.key)) continue
    if (contextKey && signal.contextKey !== contextKey) continue
    const weight = signal.strength * signalDecay(signal.occurredAt, signal.sentiment, now)
    signed += signal.sentiment * weight
    total += weight
  }
  if (total === 0) return null
  const reliability = 1 - Math.exp(-total / 1.5)
  return clamp((signed / total) * reliability, -1, 1)
}

const normalizedAcousticValue = (key: keyof AcousticProfile, value: number): number =>
  key === "tempo" ? clamp((value - 50) / 150, 0, 1) : clamp(value, 0, 1)

const acousticDistance = (left: AcousticProfile, right: AcousticProfile): number | null => {
  const squaredDeltas: number[] = []
  for (const key of ACOUSTIC_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue === undefined || rightValue === undefined) continue
    const delta = normalizedAcousticValue(key, leftValue) - normalizedAcousticValue(key, rightValue)
    squaredDeltas.push(delta * delta)
  }
  if (squaredDeltas.length < 2) return null
  return Math.sqrt(squaredDeltas.reduce((sum, delta) => sum + delta, 0) / squaredDeltas.length)
}

const acousticAffinity = (
  candidate: AcousticProfile,
  positive: readonly AcousticTasteSignal[],
  negative: readonly AcousticTasteSignal[],
  now: number,
  contextKey?: string
): number | null => {
  let signed = 0
  let total = 0
  const accumulate = (signal: AcousticTasteSignal, sentiment: TasteSentiment): void => {
    if (contextKey && signal.contextKey !== contextKey) return
    const distance = acousticDistance(candidate, signal.profile)
    if (distance === null) return
    const similarity = Math.exp(-8 * distance * distance)
    const weight = signal.strength * signalDecay(signal.occurredAt, sentiment, now) * similarity
    signed += sentiment * weight
    total += weight
  }
  for (const signal of positive) accumulate(signal, 1)
  for (const signal of negative) accumulate(signal, -1)
  if (total === 0) return null
  const reliability = 1 - Math.exp(-total / 2)
  return clamp((signed / total) * reliability, -1, 1)
}

/**
 * Returns a deterministic recommendation weight multiplier. Cold profiles are
 * neutral (1); mature profiles stay within 0.5..1.75 so learning can guide,
 * but never fully veto, the existing diversity and discovery pipeline.
 */
export const scoreTasteAffinity = (
  candidate: TrackCandidate,
  profile: TasteProfileState,
  context: TasteScoringContext
): number => {
  const confidence = getTasteProfileConfidence(profile, context.now)
  if (!confidence.ready) return 1

  const components: Array<{ affinity: number | null; contextual: number | null; weight: number }> = []
  const track = cleanKey(candidate.uri)
  components.push({
    affinity: track
      ? categoricalAffinity(new Set([track]), profile.signals.tracks, context.now)
      : null,
    contextual: track && context.contextKey
      ? categoricalAffinity(new Set([track]), profile.signals.tracks, context.now, context.contextKey)
      : null,
    weight: 0.45,
  })

  const artist = artistKey(candidate)
  components.push({
    affinity: artist
      ? categoricalAffinity(new Set([artist]), profile.signals.artists, context.now)
      : null,
    contextual: artist && context.contextKey
      ? categoricalAffinity(new Set([artist]), profile.signals.artists, context.now, context.contextKey)
      : null,
    weight: 0.3,
  })

  const genres = new Set(normalizeGenres(context.genres))
  components.push({
    affinity:
      genres.size > 0
        ? categoricalAffinity(genres, profile.signals.genres, context.now)
        : null,
    contextual: genres.size > 0 && context.contextKey
      ? categoricalAffinity(genres, profile.signals.genres, context.now, context.contextKey)
      : null,
    weight: 0.2,
  })

  const acoustic = candidateAcousticProfile(candidate)
  components.push({
    affinity: acoustic
      ? acousticAffinity(
          acoustic,
          profile.signals.acousticPositive,
          profile.signals.acousticNegative,
        context.now
      )
      : null,
    contextual: acoustic && context.contextKey
      ? acousticAffinity(
          acoustic,
          profile.signals.acousticPositive,
          profile.signals.acousticNegative,
          context.now,
          context.contextKey
        )
      : null,
    weight: 0.4,
  })

  const available = components.filter(
    (component): component is { affinity: number; contextual: number | null; weight: number } => component.affinity !== null
  )
  if (available.length === 0) return 1
  const totalWeight = available.reduce((sum, component) => sum + component.weight, 0)
  const globalAffinity =
    available.reduce((sum, component) => sum + component.affinity * component.weight, 0) /
    totalWeight
  const contextual = available.filter(
    (component): component is { affinity: number; contextual: number; weight: number } => component.contextual !== null
  )
  const contextualWeight = contextual.reduce((sum, component) => sum + component.weight, 0)
  const contextualAffinity = contextualWeight > 0
    ? contextual.reduce((sum, component) => sum + component.contextual * component.weight, 0) / contextualWeight
    : null
  // Context can refine a mature global profile but never overpower it.
  const learnedAffinity = contextualAffinity == null
    ? globalAffinity
    : globalAffinity * 0.7 + contextualAffinity * 0.3
  return clamp(Math.exp(0.75 * confidence.confidence * learnedAffinity), 0.5, 1.75)
}
