import { classifyPlaybackTransition, type PlaybackObservation } from "../feedback/playbackObserver"
import {
  createListeningContextKey,
  createSpicetifyLocalStorageAdapter,
  createTasteProfileStore,
  TASTE_PROFILE_STORAGE_KEY,
  type TasteProfileStore,
  type TasteSentiment,
} from "../profile/tasteProfile"
import {
  appendPlayHistory,
  getSmartConfig,
  loadPlayHistory,
  PLAY_HISTORY_STORAGE_KEY,
} from "../storage/settings"
import type { SeedMetadata, SkipFeedback, TrackCandidate } from "./types"

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
  quarantinedUris: Set<string>
  recentPositiveAnchors: TrackCandidate[]
  familiarityLedger: FamiliarityClassification[]
  confirmedHistoryUris: Set<string>
}

export type FamiliarityClassification = "familiar" | "discovery" | "unknown"

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
  quarantinedUris: new Set(),
  recentPositiveAnchors: [],
  familiarityLedger: [],
  confirmedHistoryUris: new Set(),
}

const candidateForUri = (uri: string): TrackCandidate | undefined => {
  if (state.seed?.uri === uri) return state.seed
  return state.candidateRegistry.get(uri)
}

const resetAdaptiveState = (): void => {
  state.quarantinedUris = new Set()
  state.recentPositiveAnchors = []
  state.familiarityLedger = []
  state.confirmedHistoryUris = new Set()
}

const rememberPositiveAnchor = (candidate: TrackCandidate): void => {
  if (candidate.uri === state.seed?.uri) return
  state.recentPositiveAnchors = [
    ...state.recentPositiveAnchors.filter((anchor) => anchor.uri !== candidate.uri),
    candidate,
  ].slice(-3)
}

const recordEncounteredFamiliarity = (uri: string): void => {
  const classification: FamiliarityClassification = state.profilePool.some(
    (candidate) => candidate.uri === uri
  )
    ? "familiar"
    : state.similarPool.some((candidate) => candidate.uri === uri)
      ? "discovery"
      : "unknown"
  state.familiarityLedger.push(classification)
  state.familiarityLedger = state.familiarityLedger.slice(-9)
}

let tasteProfileStore: TasteProfileStore | null = null
const TASTE_PROFILE_ANONYMOUS_KEY = `${TASTE_PROFILE_STORAGE_KEY}:anonymous-install`
const TASTE_PROFILE_LEGACY_CLAIM_KEY = "shuffleSimilar:tasteProfile:legacyClaimedBy"
const PLAY_HISTORY_ANONYMOUS_KEY = `${PLAY_HISTORY_STORAGE_KEY}:anonymous-install`
const PLAY_HISTORY_LEGACY_CLAIM_KEY = "shuffleSimilar:playHistory:legacyClaimedBy"
let playHistoryStorageKey = PLAY_HISTORY_ANONYMOUS_KEY
let identityInitialization: Promise<string | null> | null = null
const getTasteProfileStore = (): TasteProfileStore => {
  tasteProfileStore ??= createTasteProfileStore(
    createSpicetifyLocalStorageAdapter(),
    TASTE_PROFILE_ANONYMOUS_KEY
  )
  return tasteProfileStore
}

export const sessionManager = {
  initializeTasteIdentity: async (): Promise<string | null> => {
    if (!identityInitialization)
      identityInitialization = (async () => {
        try {
          const identity = (await Promise.race([
            Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me"),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("identity timeout")), 2_500)
            ),
          ])) as { account_id?: string; id?: string }
          const rawId = identity.account_id ?? identity.id
          if (!rawId) return null
          const accountId = rawId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 128)
          if (!accountId) return null
          const storage = createSpicetifyLocalStorageAdapter()
          const accountKey = `${TASTE_PROFILE_STORAGE_KEY}:account:${accountId}`
          const accountHistoryKey = `${PLAY_HISTORY_STORAGE_KEY}:account:${accountId}`
          try {
            if (!storage.get(accountKey) && !storage.get(TASTE_PROFILE_LEGACY_CLAIM_KEY)) {
              const legacy = storage.get(TASTE_PROFILE_STORAGE_KEY)
              if (legacy) storage.set(accountKey, legacy)
              storage.set(TASTE_PROFILE_LEGACY_CLAIM_KEY, accountId)
            }
            if (!storage.get(accountHistoryKey) && !storage.get(PLAY_HISTORY_LEGACY_CLAIM_KEY)) {
              const legacyHistory = storage.get(PLAY_HISTORY_STORAGE_KEY)
              if (legacyHistory) storage.set(accountHistoryKey, legacyHistory)
              storage.set(PLAY_HISTORY_LEGACY_CLAIM_KEY, accountId)
            }
          } catch {
            // Identity isolation still works even when legacy migration is unavailable.
          }
          tasteProfileStore = createTasteProfileStore(storage, accountKey)
          playHistoryStorageKey = accountHistoryKey
          return accountId
        } catch {
          getTasteProfileStore()
          playHistoryStorageKey = PLAY_HISTORY_ANONYMOUS_KEY
          return null
        }
      })()
    const pending = identityInitialization
    try {
      return await pending
    } finally {
      if (identityInitialization === pending) identityInitialization = null
    }
  },
  isActive: () => state.active,
  getRevision: () => state.revision,
  invalidatePendingMutations: () => {
    state.revision += 1
  },
  isToggleEnabled: () => state.toggleEnabled,
  setToggleEnabled: (enabled: boolean) => {
    state.toggleEnabled = enabled
  },
  getSeed: () => state.seed,
  getPosition: () => state.position,
  getPlayedUris: () => [...state.playedUris],
  getPlayHistory: () => loadPlayHistory(playHistoryStorageKey),
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
  getTasteContextKey: (now = Date.now()) =>
    createListeningContextKey(
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
  getQuarantinedUris: () => [...state.quarantinedUris],
  isQuarantined: (uri: string) => state.quarantinedUris.has(uri),
  getRecentPositiveAnchors: () => [...state.recentPositiveAnchors],
  getFamiliarityLedger: () => [...state.familiarityLedger],
  recordEncounteredFamiliarity: (uri: string) => {
    if (!sessionManager.ownsQueueTrack(uri) || state.quarantinedUris.has(uri)) return
    recordEncounteredFamiliarity(uri)
  },
  confirmPlayback: (uri: string): boolean => {
    if (state.confirmedHistoryUris.has(uri)) return false
    if (!sessionManager.ownsQueueTrack(uri) || state.quarantinedUris.has(uri)) return false
    state.confirmedHistoryUris.add(uri)
    const config = getSmartConfig(state.seed)
    appendPlayHistory(uri, config.historyPenaltyWindow, playHistoryStorageKey)
    return true
  },
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
    resetAdaptiveState()
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
    resetAdaptiveState()
    sessionManager.registerCandidates(playlistTracks)
  },

  startArtistSession: (seed: SeedMetadata, artistUri: string, artistTracks: TrackCandidate[]) => {
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
    resetAdaptiveState()
    sessionManager.registerCandidates(artistTracks)
  },

  /** Rehydrates only the minimal state required to keep an already-visible
   * Similar Mix queue alive after Spotify or Spicetify reloads. */
  resumeSession: (
    seed: SeedMetadata,
    queuedUris: string[],
    position: number,
    currentUri?: string | null,
    adaptiveState?: {
      recentPositiveAnchors?: TrackCandidate[]
      familiarityLedger?: FamiliarityClassification[]
    }
  ) => {
    sessionManager.startSession(seed)
    const activeUri = currentUri?.startsWith("spotify:track:") ? currentUri : seed.uri
    state.position = Math.max(0, Math.floor(position))
    state.currentTrackUri = activeUri
    state.playedUris = [...new Set([seed.uri, activeUri])]
    state.queuedUris = queuedUris.filter(
      (uri) => uri.startsWith("spotify:track:") && uri !== activeUri
    )
    state.recentPositiveAnchors = (adaptiveState?.recentPositiveAnchors ?? []).slice(-3)
    state.familiarityLedger = (adaptiveState?.familiarityLedger ?? []).slice(-9)
    sessionManager.registerCandidates(state.recentPositiveAnchors)
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
    resetAdaptiveState()
  },

  recordProgress: (progressMs: number, durationMs: number, repeatOne = false) => {
    const observedAt = Date.now()
    let repeated = false
    if (Number.isFinite(progressMs)) {
      if (state.lastProgressSampleMs != null && state.lastProgressObservedAt != null) {
        const mediaDelta = progressMs - state.lastProgressSampleMs
        const wallDelta = Math.max(0, observedAt - state.lastProgressObservedAt)
        const wrappedRepeat =
          repeatOne &&
          state.currentDurationMs > 0 &&
          state.lastProgressSampleMs >= state.currentDurationMs * 0.85 &&
          progressMs <= 5_000
        if (wrappedRepeat && state.currentTrackUri) {
          const candidate = candidateForUri(state.currentTrackUri)
          if (candidate && sessionManager.ownsQueueTrack(candidate.uri)) {
            getTasteProfileStore().record({
              type: "completion",
              candidate,
              occurredAt: observedAt,
              contextKey: sessionManager.getTasteContextKey(),
            })
            rememberPositiveAnchor(candidate)
            recordEncounteredFamiliarity(candidate.uri)
            repeated = true
            state.currentProgressMs = progressMs
          }
        } else if (mediaDelta < -5_000 || mediaDelta > wallDelta + 15_000) {
          state.seekDetected = true
        }
      }
      state.currentProgressMs = repeated
        ? progressMs
        : Math.max(state.currentProgressMs, progressMs)
      state.lastProgressSampleMs = progressMs
      state.lastProgressObservedAt = observedAt
    }
    if (Number.isFinite(durationMs) && durationMs > 0) state.currentDurationMs = durationMs
    return { repeated }
  },

  transitionToTrack: (uri: string): PlaybackObservation => {
    const previousUri = state.currentTrackUri
    const previousCandidate = previousUri ? candidateForUri(previousUri) : undefined
    const observation = classifyPlaybackTransition(
      {
        cause:
          previousUri && state.quarantinedUris.has(previousUri) ? "play-failure" : "songchange",
        previous: previousCandidate
          ? {
              candidate: previousCandidate,
              extensionOwned:
                sessionManager.ownsQueueTrack(previousUri!) ||
                state.quarantinedUris.has(previousUri!),
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
      if (
        previousCandidate &&
        previousUri !== state.seed?.uri &&
        (observation.type === "substantial-play" || observation.type === "completion")
      ) {
        rememberPositiveAnchor(previousCandidate)
      }
    }
    if (sessionManager.ownsQueueTrack(uri) && !state.quarantinedUris.has(uri)) {
      recordEncounteredFamiliarity(uri)
    }
    state.currentTrackUri = uri
    state.currentProgressMs = 0
    state.currentDurationMs = 0
    state.lastProgressSampleMs = null
    state.lastProgressObservedAt = null
    state.seekDetected = false
    return observation
  },

  recordPlaybackFailure: (uri: string): PlaybackObservation => {
    const candidate = candidateForUri(uri)
    const owned = sessionManager.ownsQueueTrack(uri)
    const observation = classifyPlaybackTransition(
      {
        cause: "play-failure",
        previous: candidate
          ? {
              candidate,
              extensionOwned: owned,
              progressMs: state.seekDetected ? null : state.currentProgressMs,
              durationMs: state.seekDetected ? null : state.currentDurationMs,
              context: {
                sessionId: String(state.revision),
                source: state.playlistUri ? "playlist" : state.artistUri ? "artist" : "track",
              },
            }
          : null,
        current: { uri, extensionOwned: owned },
      },
      Date.now
    )
    if (observation.type === "play-failure" && owned) {
      state.quarantinedUris.add(uri)
      state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri)
      if (state.playedUris.includes(uri) && !state.confirmedHistoryUris.has(uri)) {
        state.playedUris = state.playedUris.filter((playedUri) => playedUri !== uri)
        state.position = Math.max(0, state.position - 1)
      }
    }
    return observation
  },

  recordTrackPlayed: (uri: string): boolean => {
    if (!uri || uri === "spotify:delimiter" || !state.active) return false
    if (!sessionManager.ownsQueueTrack(uri) || state.playedUris.includes(uri)) return false
    state.playedUris.push(uri)
    state.position += 1
    state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri)
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
