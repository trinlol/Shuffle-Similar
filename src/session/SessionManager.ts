import type { SeedMetadata, TrackCandidate } from "./types"
import { appendPlayHistory, getSmartConfig } from "../storage/settings"

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
  playlistUri: string | null
  playlistTracks: TrackCandidate[]
  topTracksBlacklist: string[]
  artistUri: string | null
  artistTracks: TrackCandidate[]
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
  playlistUri: null,
  playlistTracks: [],
  topTracksBlacklist: [],
  artistUri: null,
  artistTracks: [],
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
  isPlaylistSession: () => Boolean(state.playlistUri),
  getPlaylistTracks: () => state.playlistTracks,
  getTopTracksBlacklist: () => state.topTracksBlacklist,
  isArtistSession: () => Boolean(state.artistUri),
  getArtistTracks: () => state.artistTracks,

  startSession: (seed: SeedMetadata) => {
    state.active = true
    state.seed = seed
    state.playedUris = [seed.uri]
    state.queuedUris = []
    state.position = 0
    state.similarPool = []
    state.profilePool = []
    state.playlistUri = null
    state.playlistTracks = []
    state.topTracksBlacklist = []
    state.artistUri = null
    state.artistTracks = []
  },

  startPlaylistSession: (
    seed: SeedMetadata,
    playlistUri: string,
    playlistTracks: TrackCandidate[],
    topTracks: string[]
  ) => {
    state.active = true
    state.seed = seed
    state.playedUris = [seed.uri]
    state.queuedUris = []
    state.position = 0
    state.similarPool = []
    state.profilePool = []
    state.playlistUri = playlistUri
    state.playlistTracks = playlistTracks
    state.topTracksBlacklist = topTracks
    state.artistUri = null
    state.artistTracks = []
  },

  startArtistSession: (
    seed: SeedMetadata,
    artistUri: string,
    artistTracks: TrackCandidate[]
  ) => {
    state.active = true
    state.seed = seed
    state.playedUris = [seed.uri]
    state.queuedUris = []
    state.position = 0
    state.similarPool = []
    state.profilePool = []
    state.playlistUri = null
    state.playlistTracks = []
    state.topTracksBlacklist = []
    state.artistUri = artistUri
    state.artistTracks = artistTracks
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
    state.playlistUri = null
    state.playlistTracks = []
    state.topTracksBlacklist = []
    state.artistUri = null
    state.artistTracks = []
  },


  recordTrackPlayed: (uri: string) => {
    if (!uri || uri === "spotify:delimiter") return
    if (!state.playedUris.includes(uri)) {
      state.playedUris.push(uri)
    }
    state.position += 1
    state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri)
    const config = getSmartConfig(state.seed)
    appendPlayHistory(uri, config.historyPenaltyWindow)
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
