import type { SeedMetadata, TrackCandidate } from "./types"
import { appendPlayHistory, loadSettings } from "../storage/settings"

type SessionState = {
  active: boolean
  toggleEnabled: boolean
  seed: SeedMetadata | null
  playedUris: string[]
  queuedUris: string[]
  position: number
  similarPool: TrackCandidate[]
  profilePool: TrackCandidate[]
  isRefilling: boolean
}

const state: SessionState = {
  active: false,
  toggleEnabled: false,
  seed: null,
  playedUris: [],
  queuedUris: [],
  position: 0,
  similarPool: [],
  profilePool: [],
  isRefilling: false,
}

export const sessionManager = {
  isActive: () => state.active,
  isToggleEnabled: () => state.toggleEnabled,
  setToggleEnabled: (enabled: boolean) => {
    state.toggleEnabled = enabled
  },
  getSeed: () => state.seed,
  getPosition: () => state.position,
  getPlayedUris: () => [...state.playedUris],
  getQueuedUris: () => [...state.queuedUris],
  getSimilarPool: () => state.similarPool,
  getProfilePool: () => state.profilePool,
  setPools: (similar: TrackCandidate[], profile: TrackCandidate[]) => {
    state.similarPool = similar
    state.profilePool = profile
  },
  isRefilling: () => state.isRefilling,
  setRefilling: (value: boolean) => {
    state.isRefilling = value
  },

  startSession: (seed: SeedMetadata) => {
    state.active = true
    state.seed = seed
    state.playedUris = [seed.uri]
    state.queuedUris = []
    state.position = 0
    state.similarPool = []
    state.profilePool = []
  },

  endSession: () => {
    state.active = false
    state.seed = null
    state.playedUris = []
    state.queuedUris = []
    state.position = 0
    state.similarPool = []
    state.profilePool = []
    state.isRefilling = false
  },

  recordTrackPlayed: (uri: string) => {
    if (!uri || uri === "spotify:delimiter") return
    if (!state.playedUris.includes(uri)) {
      state.playedUris.push(uri)
    }
    state.position += 1
    state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri)
    const settings = loadSettings()
    appendPlayHistory(uri, settings.historyPenaltyWindow)
  },

  setQueuedUris: (uris: string[]) => {
    state.queuedUris = uris.filter((uri) => uri !== "spotify:delimiter")
  },

  ownsQueueTrack: (uri: string) => {
    if (!state.active) return false
    if (state.seed?.uri === uri) return true
    return state.queuedUris.includes(uri) || state.playedUris.includes(uri)
  },
}
