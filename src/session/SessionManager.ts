import type { SeedMetadata, SkipFeedback, TrackCandidate } from "./types"
import { appendPlayHistory, getSmartConfig } from "../storage/settings"
import { classifyPlaybackTransition, type PlaybackObservation } from "../feedback/playbackObserver"
import {
  createListeningContextKey,
  createTasteProfileStore,
  type TasteProfileStore,
  type TasteSentiment,
} from "../profile/tasteProfile"

type SessionState = {
  revision: number
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
  lastProgressSampleMs: number | null
  lastProgressObservedAt: number | null
  seekDetected: boolean
  skipped: SkipFeedback[]
  candidateRegistry: Map<string, TrackCandidate>
}

const state: SessionState = {
  revision: 0,
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
  lastProgressSampleMs: null,
  lastProgressObservedAt: null,
  seekDetected: false,
  skipped: [],
  candidateRegistry: new Map(),
}

const candidateForUri = (uri: string): TrackCandidate | undefined => {
  if (state.seed?.uri === uri) return state.seed
  return state.candidateRegistry.get(uri)
}

let tasteProfileStore: TasteProfileStore | null = null
const getTasteProfileStore = (): TasteProfileStore => {
  tasteProfileStore ??= createTasteProfileStore()
  return tasteProfileStore
}

export const sessionManager = {
  isActive: () => state.active,
  getRevision: () => state.revision,
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
    sessionManager.registerCandidates([...similar, ...profile])
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
  getTasteProfile: (now = Date.now()) => getTasteProfileStore().load(now),
  getTasteContextKey: (now = Date.now()) => createListeningContextKey(
    state.playlistUri ? "playlist" : state.artistUri ? "artist" : "track",
    now
  ),
  clearTasteProfile: () => getTasteProfileStore().clear(),
  recordExplicitFeedback: (candidate: TrackCandidate, sentiment: TasteSentiment) => {
    if (!candidate.uri?.startsWith("spotify:track:")) return
    getTasteProfileStore().recordFeedback({
      sentiment,
      candidate,
      genres: state.seed?.genres,
      occurredAt: Date.now(),
      contextKey: sessionManager.getTasteContextKey(),
    })
  },
  getCandidate: (uri: string) => candidateForUri(uri),
  getRegisteredCandidates: () => [...state.candidateRegistry.values()],
  registerCandidates: (candidates: TrackCandidate[]) => {
    for (const candidate of candidates) {
      if (!candidate.uri?.startsWith("spotify:track:")) continue
      const current = state.candidateRegistry.get(candidate.uri)
      state.candidateRegistry.set(candidate.uri, current ? { ...current, ...candidate } : candidate)
    }
  },

  startSession: (seed: SeedMetadata) => {
    state.revision += 1
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
    state.lastProgressSampleMs = null
    state.lastProgressObservedAt = null
    state.seekDetected = false
    state.skipped = []
    state.candidateRegistry = new Map([[seed.uri, seed]])
  },

  startPlaylistSession: (
    seed: SeedMetadata,
    playlistUri: string,
    playlistTracks: TrackCandidate[],
    topTracks: string[]
  ) => {
    state.revision += 1
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
    state.lastProgressSampleMs = null
    state.lastProgressObservedAt = null
    state.seekDetected = false
    state.skipped = []
    state.candidateRegistry = new Map([[seed.uri, seed]])
    sessionManager.registerCandidates(playlistTracks)
  },

  startArtistSession: (
    seed: SeedMetadata,
    artistUri: string,
    artistTracks: TrackCandidate[]
  ) => {
    state.revision += 1
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
    state.lastProgressSampleMs = null
    state.lastProgressObservedAt = null
    state.seekDetected = false
    state.skipped = []
    state.candidateRegistry = new Map([[seed.uri, seed]])
    sessionManager.registerCandidates(artistTracks)
  },

  /** Rehydrates only the minimal state required to keep an already-visible
   * Similar Mix queue alive after Spotify or Spicetify reloads. */
  resumeSession: (
    seed: SeedMetadata,
    queuedUris: string[],
    position: number,
    currentUri?: string | null
  ) => {
    sessionManager.startSession(seed)
    const activeUri = currentUri?.startsWith("spotify:track:") ? currentUri : seed.uri
    state.position = Math.max(0, Math.floor(position))
    state.currentTrackUri = activeUri
    state.playedUris = [...new Set([seed.uri, activeUri])]
    state.queuedUris = queuedUris.filter(
      (uri) => uri.startsWith("spotify:track:") && uri !== activeUri
    )
    state.toggleEnabled = true
  },

  endSession: () => {
    state.revision += 1
    state.active = false
    state.toggleEnabled = false
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
    state.lastProgressSampleMs = null
    state.lastProgressObservedAt = null
    state.seekDetected = false
    state.skipped = []
    state.candidateRegistry = new Map()
  },

  recordProgress: (progressMs: number, durationMs: number) => {
    const observedAt = Date.now()
    if (Number.isFinite(progressMs)) {
      if (state.lastProgressSampleMs != null && state.lastProgressObservedAt != null) {
        const mediaDelta = progressMs - state.lastProgressSampleMs
        const wallDelta = Math.max(0, observedAt - state.lastProgressObservedAt)
        if (mediaDelta < -5_000 || mediaDelta > wallDelta + 15_000) {
          state.seekDetected = true
        }
      }
      state.currentProgressMs = Math.max(state.currentProgressMs, progressMs)
      state.lastProgressSampleMs = progressMs
      state.lastProgressObservedAt = observedAt
    }
    if (Number.isFinite(durationMs) && durationMs > 0) state.currentDurationMs = durationMs
  },

  transitionToTrack: (uri: string): PlaybackObservation => {
    const previousUri = state.currentTrackUri
    const previousCandidate = previousUri ? candidateForUri(previousUri) : undefined
    const observation = classifyPlaybackTransition(
      {
        cause: "songchange",
        previous: previousCandidate
          ? {
              candidate: previousCandidate,
              extensionOwned: sessionManager.ownsQueueTrack(previousUri!),
              progressMs: state.seekDetected ? null : state.currentProgressMs,
              durationMs: state.seekDetected ? null : state.currentDurationMs,
              context: {
                sessionId: String(state.revision),
                source: state.playlistUri ? "playlist" : state.artistUri ? "artist" : "track",
                genres: previousUri === state.seed?.uri ? state.seed.genres : undefined,
              },
            }
          : null,
        current: {
          uri,
          extensionOwned: sessionManager.ownsQueueTrack(uri),
        },
      },
      Date.now
    )

    if (observation.tasteOutcome) {
      getTasteProfileStore().record({
        ...observation.tasteOutcome,
        contextKey: sessionManager.getTasteContextKey(),
      })
      if (observation.type === "early-skip") {
        const skippedTrack = observation.candidate
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
    state.lastProgressSampleMs = null
    state.lastProgressObservedAt = null
    state.seekDetected = false
    return observation
  },


  recordTrackPlayed: (uri: string): boolean => {
    if (!uri || uri === "spotify:delimiter" || !state.active) return false
    if (!sessionManager.ownsQueueTrack(uri) || state.playedUris.includes(uri)) return false
    state.playedUris.push(uri)
    state.position += 1
    state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri)
    const config = getSmartConfig(state.seed)
    appendPlayHistory(uri, config.historyPenaltyWindow)
    return true
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
