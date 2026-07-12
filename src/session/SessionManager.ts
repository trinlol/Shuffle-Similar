import type { SeedMetadata, SkipFeedback, TrackCandidate } from "./types"
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
  currentTrackUri: string | null
  currentProgressMs: number
  currentDurationMs: number
  skipped: SkipFeedback[]
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
  currentTrackUri: null,
  currentProgressMs: 0,
  currentDurationMs: 0,
  skipped: [],
}

const candidateForUri = (uri: string): TrackCandidate | undefined => {
  if (state.seed?.uri === uri) return state.seed
  return [...state.similarPool, ...state.profilePool, ...state.playlistTracks, ...state.artistTracks]
    .find((candidate) => candidate.uri === uri)
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
  getSkipFeedback: () => [...state.skipped],

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
    state.currentTrackUri = seed.uri
    state.currentProgressMs = 0
    state.currentDurationMs = 0
    state.skipped = []
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
    state.currentTrackUri = seed.uri
    state.currentProgressMs = 0
    state.currentDurationMs = 0
    state.skipped = []
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
    state.currentTrackUri = seed.uri
    state.currentProgressMs = 0
    state.currentDurationMs = 0
    state.skipped = []
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
    state.currentTrackUri = null
    state.currentProgressMs = 0
    state.currentDurationMs = 0
    state.skipped = []
  },

  recordProgress: (progressMs: number, durationMs: number) => {
    if (Number.isFinite(progressMs)) {
      state.currentProgressMs = Math.max(state.currentProgressMs, progressMs)
    }
    if (Number.isFinite(durationMs) && durationMs > 0) state.currentDurationMs = durationMs
  },

  transitionToTrack: (uri: string) => {
    const previousUri = state.currentTrackUri
    const previousDurationMs = state.currentDurationMs
    if (previousUri && previousUri !== uri && previousDurationMs > 0) {
      const earlySkip = state.currentProgressMs < 30_000 || state.currentProgressMs / previousDurationMs < 0.35
      const skippedTrack = candidateForUri(previousUri)
      if (earlySkip && skippedTrack) {
        state.skipped.push({
          artistUri: skippedTrack.artistUri,
          artistName: skippedTrack.artistName,
          profile: {
            tempo: skippedTrack.tempo,
            energy: skippedTrack.energy,
            valence: skippedTrack.valence,
            danceability: skippedTrack.danceability,
            acousticness: skippedTrack.acousticness,
            instrumentalness: skippedTrack.instrumentalness,
          },
        })
        state.skipped = state.skipped.slice(-20)
      }
    }
    state.currentTrackUri = uri
    state.currentProgressMs = 0
    state.currentDurationMs = 0
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
