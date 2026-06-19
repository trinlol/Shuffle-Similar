import type { BlendPhase } from "../session/types"

export type ShuffleSimilarSettings = {
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
  songBlendMode: "progressive" | "balanced" | "similar" | "library"
  playlistShuffleMode: "strict" | "blend" | "similar"
  artistShuffleMode: "strict" | "blend" | "similar"
}

const STORAGE_KEY = "shuffleSimilar:settings"
const LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY = "similarShuffle:settings"
const LEGACY_BETTER_SHUFFLE_STORAGE_KEY = "betterShuffle:settings"
const HISTORY_KEY = "shuffleSimilar:playHistory"
const LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY = "similarShuffle:playHistory"
const LEGACY_BETTER_SHUFFLE_HISTORY_KEY = "betterShuffle:playHistory"

export const DEFAULT_BLEND_PHASES: BlendPhase[] = [
  { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
  { maxPosition: 9, similarWeight: 0.7, profileWeight: 0.3 },
  { maxPosition: 19, similarWeight: 0.4, profileWeight: 0.6 },
  { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.2, profileWeight: 0.8 },
]

export const DEFAULT_SETTINGS: ShuffleSimilarSettings = {
  eraWindow: 3,
  artistSpacing: 3,
  refillThreshold: 3,
  initialQueueSize: 25,
  excludeSeedArtistEarly: true,
  historyPenaltyWindow: 200,
  deprioritizePopular: true,
  matchTempo: true,
  matchEnergy: true,
  matchValence: true,
  blendPhases: DEFAULT_BLEND_PHASES,
  songBlendMode: "progressive",
  playlistShuffleMode: "similar",
  artistShuffleMode: "strict",
}

const migrateLegacyStorage = (): void => {
  const legacyKeys = [
  LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY,
  LEGACY_BETTER_SHUFFLE_STORAGE_KEY,
  ]
  for (const legacyKey of legacyKeys) {
    const legacySettings = Spicetify.LocalStorage.get(legacyKey)
    if (legacySettings && !Spicetify.LocalStorage.get(STORAGE_KEY)) {
      Spicetify.LocalStorage.set(STORAGE_KEY, legacySettings)
      Spicetify.LocalStorage.remove(legacyKey)
      break
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

export const loadSettings = (): ShuffleSimilarSettings => {
  migrateLegacyStorage()

  try {
    const raw = Spicetify.LocalStorage.get(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS, blendPhases: [...DEFAULT_BLEND_PHASES] }
    const parsed = JSON.parse(raw) as Partial<ShuffleSimilarSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      blendPhases: parsed.blendPhases ?? [...DEFAULT_BLEND_PHASES],
    }
  } catch {
    return { ...DEFAULT_SETTINGS, blendPhases: [...DEFAULT_BLEND_PHASES] }
  }
}

export const saveSettings = (settings: ShuffleSimilarSettings): void => {
  Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(settings))
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
