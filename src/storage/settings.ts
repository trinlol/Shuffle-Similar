import type { TasteProfileState } from "../profile/tasteProfile"
import type { BlendPhase, SkipFeedback } from "../session/types"

export type SmartConfig = {
  eraWindow: number
  artistSpacing: number
  refillThreshold: number
  initialQueueSize: number
  excludeSeedArtistEarly: boolean
  historyPenaltyWindow: number
  deprioritizePopular: boolean
  matchTempo: boolean
  matchEnergy: boolean
  matchValence: boolean
  blendPhases: BlendPhase[]
  skipFeedback?: SkipFeedback[]
  tasteProfile?: TasteProfileState
  tasteProfileNow?: number
  tasteContextKey?: string
}

export const PLAY_HISTORY_STORAGE_KEY = "shuffleSimilar:playHistory"
export const SEEN_TRACKS_STORAGE_KEY = "shuffleSimilar:seenTracks"
export const SEEN_CANONICAL_STORAGE_KEY = "shuffleSimilar:seenCanonical"
const LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY = "similarShuffle:playHistory"
const LEGACY_BETTER_SHUFFLE_HISTORY_KEY = "betterShuffle:playHistory"
const LEGACY_BETTER_SHUFFLE_STORAGE_KEY = "betterShuffle:settings"
const LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY = "similarShuffle:settings"
const STORAGE_KEY = "shuffleSimilar:settings"

export const getSmartConfig = (
  seed?: { releaseYear?: number; popularity?: number } | null
): SmartConfig => {
  const releaseYear = seed?.releaseYear
  const popularity = seed?.popularity

  // Dynamic Era Window: older music eras were broader, modern ones are tighter
  let eraWindow = 3
  if (releaseYear) {
    if (releaseYear < 1980) eraWindow = 8
    else if (releaseYear < 2000) eraWindow = 5
    else eraWindow = 3
  }

  // Dynamic Popularity Tuning: match the obscurity level of the seed track
  const deprioritizePopular = popularity == null || popularity < 75

  return {
    eraWindow,
    artistSpacing: 3,
    refillThreshold: 3,
    initialQueueSize: 50,
    excludeSeedArtistEarly: true,
    historyPenaltyWindow: 500,
    deprioritizePopular,
    matchTempo: true,
    matchEnergy: true,
    matchValence: true,
    blendPhases: [
      { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
      { maxPosition: 9, similarWeight: 0.8, profileWeight: 0.2 },
      { maxPosition: 19, similarWeight: 0.72, profileWeight: 0.28 },
      { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.65, profileWeight: 0.35 },
    ],
  }
}

const MAX_PLAY_HISTORY_CACHE_KEYS = 16
let lastMigratedStorageRef: WeakRef<object> | null = null
const playHistoryCache = new Map<string, { raw: string; entries: string[] }>()

const setPlayHistoryCacheEntry = (
  storageKey: string,
  value: { raw: string; entries: string[] }
): void => {
  if (playHistoryCache.has(storageKey)) {
    playHistoryCache.delete(storageKey)
  } else if (playHistoryCache.size >= MAX_PLAY_HISTORY_CACHE_KEYS) {
    const oldestKey = playHistoryCache.keys().next().value
    if (oldestKey !== undefined) {
      playHistoryCache.delete(oldestKey)
    }
  }
  playHistoryCache.set(storageKey, value)
}

const migrateLegacyStorage = (): void => {
  const storageRef = typeof Spicetify !== "undefined" ? Spicetify.LocalStorage : null
  if (!storageRef || lastMigratedStorageRef?.deref() === storageRef) return
  lastMigratedStorageRef = new WeakRef(storageRef)
  playHistoryCache.clear()

  // Clean up legacy setting storage keys to keep localStorage clean
  const legacyKeys = [
    LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY,
    LEGACY_BETTER_SHUFFLE_STORAGE_KEY,
    STORAGE_KEY,
  ]
  for (const key of legacyKeys) {
    if (Spicetify.LocalStorage.get(key)) {
      Spicetify.LocalStorage.remove(key)
    }
  }

  const legacyHistoryKeys = [LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY, LEGACY_BETTER_SHUFFLE_HISTORY_KEY]
  for (const legacyKey of legacyHistoryKeys) {
    const legacyHistory = Spicetify.LocalStorage.get(legacyKey)
    if (legacyHistory && !Spicetify.LocalStorage.get(PLAY_HISTORY_STORAGE_KEY)) {
      Spicetify.LocalStorage.set(PLAY_HISTORY_STORAGE_KEY, legacyHistory)
      Spicetify.LocalStorage.remove(legacyKey)
      break
    }
  }
}

export const loadPlayHistory = (storageKey = PLAY_HISTORY_STORAGE_KEY): string[] => {
  migrateLegacyStorage()

  try {
    const raw = Spicetify.LocalStorage.get(storageKey)
    if (!raw) {
      playHistoryCache.delete(storageKey)
      return []
    }
    const cached = playHistoryCache.get(storageKey)
    if (cached && cached.raw === raw) {
      return [...cached.entries]
    }
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed)
      ? parsed.filter((uri): uri is string => typeof uri === "string")
      : []
    setPlayHistoryCacheEntry(storageKey, { raw, entries })
    return [...entries]
  } catch {
    return []
  }
}

export const appendPlayHistoryEntries = (
  entries: readonly string[],
  maxWindow: number,
  storageKey = PLAY_HISTORY_STORAGE_KEY
): void => {
  const validEntries = [
    ...new Set(entries.filter((entry) => typeof entry === "string" && entry.length > 0)),
  ]
  if (validEntries.length === 0) return
  try {
    const history = loadPlayHistory(storageKey)
    if (
      history.length <= maxWindow &&
      validEntries.length <= history.length &&
      validEntries.every((entry, index) => history[index] === entry)
    ) {
      return
    }
    const validSet = new Set(validEntries)
    const remaining = history.filter((entry) => !validSet.has(entry))
    const nextEntries = [...validEntries, ...remaining].slice(0, maxWindow)
    const serialized = JSON.stringify(nextEntries)
    Spicetify.LocalStorage.set(storageKey, serialized)
    setPlayHistoryCacheEntry(storageKey, { raw: serialized, entries: nextEntries })
  } catch {
    // Storage may be absent in lightweight test harnesses without LocalStorage.
  }
}

export const appendPlayHistory = (
  uri: string,
  maxWindow: number,
  storageKey = PLAY_HISTORY_STORAGE_KEY
): void => {
  appendPlayHistoryEntries([uri], maxWindow, storageKey)
}
