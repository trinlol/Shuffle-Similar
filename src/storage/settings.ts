import type { BlendPhase } from "../session/types"

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
}

const HISTORY_KEY = "shuffleSimilar:playHistory"
const LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY = "similarShuffle:playHistory"
const LEGACY_BETTER_SHUFFLE_HISTORY_KEY = "betterShuffle:playHistory"
const LEGACY_BETTER_SHUFFLE_STORAGE_KEY = "betterShuffle:settings"
const LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY = "similarShuffle:settings"
const STORAGE_KEY = "shuffleSimilar:settings"

export const getSmartConfig = (seed?: { releaseYear?: number; popularity?: number } | null): SmartConfig => {
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
    initialQueueSize: 25,
    excludeSeedArtistEarly: true,
    historyPenaltyWindow: 200,
    deprioritizePopular,
    matchTempo: true,
    matchEnergy: true,
    matchValence: true,
    blendPhases: [
      { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
      { maxPosition: 9, similarWeight: 0.7, profileWeight: 0.3 },
      { maxPosition: 19, similarWeight: 0.4, profileWeight: 0.6 },
      { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.2, profileWeight: 0.8 },
    ]
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

  const legacyHistoryKeys = [
    LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY,
    LEGACY_BETTER_SHUFFLE_HISTORY_KEY,
  ]
  for (const legacyKey of legacyHistoryKeys) {
    const legacyHistory = Spicetify.LocalStorage.get(legacyKey)
    if (legacyHistory && !Spicetify.LocalStorage.get(HISTORY_KEY)) {
      Spicetify.LocalStorage.set(HISTORY_KEY, legacyHistory)
      Spicetify.LocalStorage.remove(legacyKey)
      break
    }
  }
}

export const loadPlayHistory = (): string[] => {
  migrateLegacyStorage()

  try {
    const raw = Spicetify.LocalStorage.get(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((uri) => typeof uri === "string") : []
  } catch {
    return []
  }
}

export const appendPlayHistory = (uri: string, maxWindow: number): void => {
  const history = loadPlayHistory().filter((entry) => entry !== uri)
  history.unshift(uri)
  Spicetify.LocalStorage.set(HISTORY_KEY, JSON.stringify(history.slice(0, maxWindow)))
}
