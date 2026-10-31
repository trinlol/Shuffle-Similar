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
  playHistoryEntries?: PlayHistoryEntry[]
}

export const PLAY_HISTORY_STORAGE_KEY = "shuffleSimilar:playHistory"
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
    historyPenaltyWindow: 200,
    deprioritizePopular,
    matchTempo: true,
    matchEnergy: true,
    matchValence: true,
    blendPhases: [
      { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
      { maxPosition: 9, similarWeight: 0.85, profileWeight: 0.15 },
      { maxPosition: 19, similarWeight: 0.75, profileWeight: 0.25 },
      { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.7, profileWeight: 0.3 },
    ],
  }
}

const migrateLegacyStorage = (): void => {
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

export type PlayHistoryEntry = {
  uri: string
  playedAt: number
}

const PLAY_HISTORY_MAX_ENTRIES = 400

const decodePlayHistory = (raw: string | null): PlayHistoryEntry[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry): PlayHistoryEntry | null => {
        if (typeof entry === "string") return { uri: entry, playedAt: 0 }
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as PlayHistoryEntry).uri === "string" &&
          typeof (entry as PlayHistoryEntry).playedAt === "number" &&
          Number.isFinite((entry as PlayHistoryEntry).playedAt)
        ) {
          return {
            uri: (entry as PlayHistoryEntry).uri,
            playedAt: (entry as PlayHistoryEntry).playedAt,
          }
        }
        return null
      })
      .filter((entry): entry is PlayHistoryEntry => entry !== null)
  } catch {
    return []
  }
}

export const loadPlayHistory = (storageKey = PLAY_HISTORY_STORAGE_KEY): PlayHistoryEntry[] => {
  migrateLegacyStorage()
  return decodePlayHistory(Spicetify.LocalStorage.get(storageKey))
}

/** URI-only view for legacy consumers that only need membership/order. */
export const loadPlayHistoryUris = (storageKey = PLAY_HISTORY_STORAGE_KEY): string[] =>
  loadPlayHistory(storageKey).map((entry) => entry.uri)

export const appendPlayHistory = (
  uri: string,
  maxWindow: number,
  storageKey = PLAY_HISTORY_STORAGE_KEY,
  playedAt = Date.now()
): void => {
  const history = loadPlayHistory(storageKey).filter((entry) => entry.uri !== uri)
  history.unshift({ uri, playedAt })
  const capped = history.slice(0, Math.max(1, Math.min(maxWindow, PLAY_HISTORY_MAX_ENTRIES)))
  Spicetify.LocalStorage.set(storageKey, JSON.stringify(capped))
}
