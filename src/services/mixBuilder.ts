/** Builds playable recommendation batches for track, playlist, album and artist mixes. */
import { filterProfilePoolForSeedCoherence } from "../algorithm/genreAffinity"
import {
  type BatchPlanningOptions,
  buildPlaylistBatch,
  buildSinglePoolBatch,
  buildTrackBatch,
} from "../algorithm/progressiveBlend"
import { canonicalKeysForTrack } from "../algorithm/rankingV2"
import { getUpcomingQueueUris } from "../queue/queueManager"
import { readPreviousQueueTracks } from "../queue/queueState"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import * as profileTrackSources from "../sources/profileTracks"
import { mergeCandidatesWithProvenance } from "../sources/provenance"
import {
  enrichPlaylistTracks,
  fetchPlaylistSimilarPool,
  fetchSimilarPool,
} from "../sources/similarTracks"
import { getSmartConfig } from "../storage/settings"
import { filterPlayableUris, verifyQueuePlayability } from "../utils/playability"
import {
  buildHistoryRelaxedExclusions,
  buildRecommendationExclusions,
} from "./recommendationExclusions"

const PROFILE_FOREGROUND_DEADLINE_MS = 4_500
const RECENTLY_PLAYED_DEADLINE_MS = 2_000
const RECENTLY_PLAYED_CACHE_TTL_MS = 10_000

export type RecentHistorySnapshot = {
  uris: string[]
  canonicalKeys: string[]
  recentArtistKeys: string[]
  habitualArtistKeys: string[]
  topTrackUris: string[]
}

let cachedSpotifyRecent: {
  runtimeRef: unknown
  fetchedAt: number
  tracks: TrackCandidate[]
} | null = null

export const withForegroundDeadline = async <T>(
  work: Promise<T>,
  fallback: T,
  deadlineMs = PROFILE_FOREGROUND_DEADLINE_MS
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const getSessionConfig = (seed?: SeedMetadata | null) => {
  const now = Date.now()
  return {
    ...getSmartConfig(seed),
    skipFeedback: sessionManager.getSkipFeedback(),
    tasteProfile: sessionManager.getTasteProfile(now),
    tasteProfileNow: now,
    tasteContextKey: sessionManager.getTasteContextKey(now),
  }
}

export const queueUrisFromBatch = async (batch: readonly TrackCandidate[]): Promise<string[]> => {
  const syntacticallyPlayable = await filterPlayableUris(batch.map((track) => track.uri))
  const verification = await verifyQueuePlayability(syntacticallyPlayable)
  if (verification.rejectedUris.length > 0) {
    console.info(
      `[Shuffle Similar] Removed ${verification.rejectedUris.length} unavailable track${
        verification.rejectedUris.length === 1 ? "" : "s"
      } before queueing`
    )
  }
  return verification.playableUris
}

const fetchSpotifyRecentlyPlayedTracks = async (bypassCache = false): Promise<TrackCandidate[]> => {
  const runtimeRef = typeof Spicetify === "undefined" ? null : Spicetify
  const now = Date.now()
  if (
    !bypassCache &&
    cachedSpotifyRecent &&
    cachedSpotifyRecent.runtimeRef === runtimeRef &&
    now - cachedSpotifyRecent.fetchedAt < RECENTLY_PLAYED_CACHE_TTL_MS
  ) {
    return cachedSpotifyRecent.tracks
  }

  let fetcher: (() => Promise<TrackCandidate[]>) | undefined
  try {
    fetcher = profileTrackSources.fetchRecentlyPlayedTracks
  } catch {
    return []
  }
  if (typeof fetcher !== "function") return []

  const tracks = await withForegroundDeadline(
    fetcher().catch(() => []),
    [],
    RECENTLY_PLAYED_DEADLINE_MS
  )
  const validTracks = tracks.filter((track) => Boolean(track?.uri))
  if (validTracks.length > 0) {
    sessionManager.registerCandidates(validTracks)
  }
  cachedSpotifyRecent = {
    runtimeRef,
    fetchedAt: Date.now(),
    tracks: validTracks,
  }
  return validTracks
}

type LivePlayerHistoryEntry = {
  uri: string
  trackName?: string
  artistUri?: string
  artistName?: string
}

const collectLiveDesktopPlayerHistory = (): LivePlayerHistoryEntry[] => {
  const entries: LivePlayerHistoryEntry[] = []
  try {
    const playerData =
      typeof Spicetify === "undefined"
        ? undefined
        : (
            Spicetify as {
              Player?: {
                data?: {
                  item?: {
                    uri?: string
                    name?: string
                    artists?: Array<{ uri?: string; name?: string }>
                    metadata?: Record<string, string>
                  }
                  previousItems?: Array<{
                    uri?: string
                    name?: string
                    artists?: Array<{ uri?: string; name?: string }>
                    metadata?: Record<string, string>
                  }>
                }
              }
            }
          ).Player?.data
    const toEntry = (
      item:
        | {
            uri?: string
            name?: string
            artists?: Array<{ uri?: string; name?: string }>
            metadata?: Record<string, string>
          }
        | undefined
    ): LivePlayerHistoryEntry | null => {
      if (!item?.uri?.startsWith("spotify:track:")) return null
      return {
        uri: item.uri,
        trackName: item.name || item.metadata?.title || undefined,
        artistUri: item.artists?.[0]?.uri || item.metadata?.artist_uri || undefined,
        artistName: item.artists?.[0]?.name || item.metadata?.artist_name || undefined,
      }
    }
    const current = toEntry(playerData?.item)
    if (current) entries.push(current)
    const previousItems = Array.isArray(playerData?.previousItems)
      ? [...playerData.previousItems].reverse()
      : []
    for (const prev of previousItems) {
      const parsed = toEntry(prev)
      if (parsed) entries.push(parsed)
    }
  } catch {
    // Player state is optional in isolated test environments.
  }

  for (const prevQueueTrack of readPreviousQueueTracks()) {
    entries.push(prevQueueTrack)
  }
  return entries
}

/**
 * Merges current-session played tracks, cross-session seen tracks & canonical
 * song keys, persisted confirmed play history, live Spotify desktop player/queue
 * previous tracks, and Spotify's cross-device `/v1/me/player/recently-played`.
 */
export const collectRecentHistorySnapshot = async (
  options: { includeSpotifyRecent?: boolean; bypassCache?: boolean } = {}
): Promise<RecentHistorySnapshot> => {
  const includeSpotifyRecent = options.includeSpotifyRecent ?? true
  const sessionRecent = [...sessionManager.getPlayedUris()].reverse()
  let seenTracks: string[] = []
  let seenCanonical: string[] = []
  let persistedHistory: string[] = []
  try {
    seenTracks = sessionManager.getSeenTrackUris()
    seenCanonical = sessionManager.getSeenCanonicalKeys()
    persistedHistory = sessionManager.getPlayHistory()
  } catch {
    seenTracks = []
    seenCanonical = []
    persistedHistory = []
  }

  const liveDesktopEntries = collectLiveDesktopPlayerHistory()

  let topArtistsFetcher:
    | (() => Promise<{ artistUris: string[]; artistNames: string[] }>)
    | undefined
  let topTracksFetcher: (() => Promise<string[]>) | undefined
  if (includeSpotifyRecent) {
    try {
      topArtistsFetcher = (
        profileTrackSources as {
          fetchTopArtists?: () => Promise<{ artistUris: string[]; artistNames: string[] }>
        }
      ).fetchTopArtists
    } catch {
      topArtistsFetcher = undefined
    }
    try {
      topTracksFetcher = profileTrackSources.fetchTopTracks
    } catch {
      topTracksFetcher = undefined
    }
  }

  const [spotifyRecentTracks, topArtistsResult, topTracksResult] = includeSpotifyRecent
    ? await Promise.all([
        fetchSpotifyRecentlyPlayedTracks(Boolean(options.bypassCache)),
        typeof topArtistsFetcher === "function"
          ? withForegroundDeadline(
              topArtistsFetcher().catch(() => ({ artistUris: [], artistNames: [] })),
              { artistUris: [], artistNames: [] },
              1_500
            )
          : Promise.resolve({ artistUris: [], artistNames: [] }),
        typeof topTracksFetcher === "function"
          ? withForegroundDeadline(
              topTracksFetcher().catch(() => []),
              [],
              1_500
            )
          : Promise.resolve([]),
      ])
    : [[], { artistUris: [], artistNames: [] }, []]

  if (liveDesktopEntries.length > 0 || spotifyRecentTracks.length > 0) {
    try {
      sessionManager.rememberPlayedTracks([...liveDesktopEntries, ...spotifyRecentTracks])
    } catch {
      // Passive persistence is best-effort in minimal test mocks.
    }
  }

  const uris = [
    ...new Set([
      ...sessionRecent,
      ...liveDesktopEntries.map((entry) => entry.uri),
      ...seenTracks,
      ...persistedHistory,
      ...spotifyRecentTracks.map((track) => track.uri),
    ]),
  ].filter((uri) => uri.startsWith("spotify:track:"))

  const canonicalSet = new Set<string>(seenCanonical)
  for (const entry of liveDesktopEntries) {
    for (const key of canonicalKeysForTrack(entry)) canonicalSet.add(key)
  }
  for (const track of spotifyRecentTracks) {
    for (const key of canonicalKeysForTrack(track)) canonicalSet.add(key)
  }
  for (const uri of uris) {
    const known = sessionManager.getCandidate(uri)
    if (known) {
      for (const key of canonicalKeysForTrack(known)) canonicalSet.add(key)
    }
  }

  const recentArtistKeysSet = new Set<string>()
  const pushArtistKey = (artistUri?: string, artistName?: string) => {
    if (artistUri) recentArtistKeysSet.add(artistUri.trim().toLowerCase())
    if (artistName) {
      const norm = artistName.trim().toLowerCase().replace(/\s+/g, " ")
      recentArtistKeysSet.add(`name:${norm}`)
    }
  }

  for (const uri of sessionRecent) {
    const known = sessionManager.getCandidate(uri)
    if (known) pushArtistKey(known.artistUri, known.artistName)
  }
  for (const entry of liveDesktopEntries) {
    pushArtistKey(entry.artistUri, entry.artistName)
  }
  for (const track of spotifyRecentTracks) {
    pushArtistKey(track.artistUri, track.artistName)
  }
  const seenArtistKeys =
    (
      sessionManager as unknown as {
        getSeenArtistKeys?: () => string[]
      }
    ).getSeenArtistKeys?.() ?? []
  for (const key of seenArtistKeys) {
    if (key) recentArtistKeysSet.add(key.trim().toLowerCase())
  }

  let habitualArtistKeys: string[] = []
  let topTrackUris: string[] = []

  if (includeSpotifyRecent) {
    const habitualSet = new Set<string>()
    for (const uri of topArtistsResult?.artistUris ?? []) {
      if (uri) habitualSet.add(uri.trim().toLowerCase())
    }
    for (const name of topArtistsResult?.artistNames ?? []) {
      if (name) {
        const norm = name.trim().toLowerCase().replace(/\s+/g, " ")
        habitualSet.add(`name:${norm}`)
      }
    }
    habitualArtistKeys = [...habitualSet]
    topTrackUris = [
      ...new Set(
        (topTracksResult ?? [])
          .map((item) =>
            typeof item === "string" ? item : ((item as { uri?: string })?.uri ?? "")
          )
          .filter((uri) => uri.startsWith("spotify:track:"))
      ),
    ]
  } else {
    try {
      const sources = profileTrackSources as Record<string, unknown>
      const getCached = sources.getCachedAffinityKeys as
        | (() => {
            habitualArtistKeys: string[]
            topTrackUris: string[]
          })
        | undefined
      const cached = getCached?.()
      if (cached) {
        habitualArtistKeys = cached.habitualArtistKeys ?? []
        topTrackUris = cached.topTrackUris ?? []
      }
    } catch {
      // In minimal test mocks or if not implemented yet, fallback gracefully
    }
  }

  return {
    uris,
    canonicalKeys: [...canonicalSet],
    recentArtistKeys: [...recentArtistKeysSet],
    habitualArtistKeys,
    topTrackUris,
  }
}

export const collectRecentHistoryUris = async (includeSpotifyRecent = true): Promise<string[]> => {
  const snapshot = await collectRecentHistorySnapshot({ includeSpotifyRecent })
  return snapshot.uris
}

/**
 * Strictly strips any previously played URIs or canonical title+artist matches
 * from a candidate selection, relaxing only if zero unplayed tracks remain.
 */
export const filterOutPreviouslyPlayed = (
  tracks: readonly TrackCandidate[],
  seedUri: string | null | undefined,
  history: RecentHistorySnapshot,
  extraExcludedUris: readonly string[] = []
): TrackCandidate[] => {
  const excludedUriSet = new Set<string>([
    ...(seedUri ? [seedUri] : []),
    ...history.uris,
    ...extraExcludedUris,
  ])
  const excludedCanonicalSet = new Set<string>(history.canonicalKeys)
  if (seedUri) {
    const seedKnown = sessionManager.getCandidate(seedUri)
    if (seedKnown) {
      for (const key of canonicalKeysForTrack(seedKnown)) excludedCanonicalSet.add(key)
    }
  }

  const unplayed = tracks.filter((track) => {
    if (!track.uri?.startsWith("spotify:track:") || excludedUriSet.has(track.uri)) return false
    const registered = sessionManager.getCandidate(track.uri)
    const keys = canonicalKeysForTrack({
      uri: track.uri,
      trackName: track.trackName ?? registered?.trackName,
      artistUri: track.artistUri ?? registered?.artistUri,
      artistName: track.artistName ?? registered?.artistName,
    })
    return !keys.some((key) => excludedCanonicalSet.has(key))
  })

  if (unplayed.length > 0) return unplayed
  return tracks.filter((track) => track.uri !== seedUri && !extraExcludedUris.includes(track.uri))
}

export const createLiveBatchPlanningOptions = (
  recentHistoryUris: readonly string[],
  seedKey: string,
  queueTailUris?: readonly string[],
  excludedCanonicalKeys?: readonly string[],
  snapshot?: Partial<RecentHistorySnapshot>,
  exposureMultipliers?: ReadonlyMap<string, number>
): BatchPlanningOptions => ({
  recentHistoryUris,
  excludedCanonicalKeys,
  queueTailUris,
  recentArtistKeys: snapshot?.recentArtistKeys,
  habitualArtistKeys: snapshot?.habitualArtistKeys
    ? new Set(snapshot.habitualArtistKeys)
    : undefined,
  topTrackUris: snapshot?.topTrackUris ? new Set(snapshot.topTrackUris) : undefined,
  exposureMultipliers,
  rngSeed: `${seedKey}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
  explorationBand: 0.1,
  explorationTemperature: 0.042,
})

const currentSessionQueueTail = (seed?: SeedMetadata | null): string[] => {
  const tail = [...sessionManager.getPlayedUris(), ...sessionManager.getQueuedUris()]
  if (tail.length > 0) return tail
  return seed?.uri ? [seed.uri] : []
}

const ensurePools = async (seed: SeedMetadata, forceRefresh = false) => {
  const settings = getSessionConfig(seed)
  let similar = forceRefresh ? [] : sessionManager.getSimilarPool()
  let profile = forceRefresh ? [] : sessionManager.getProfilePool()
  const hadCachedProfile = profile.length > 0 && !forceRefresh

  ;[similar, profile] = await Promise.all([
    similar.length === 0 ? fetchSimilarPool(seed, settings) : Promise.resolve(similar),
    profile.length === 0
      ? withForegroundDeadline(profileTrackSources.fetchProfilePool(seed), [])
      : Promise.resolve(profile),
  ])

  if (!hadCachedProfile && profile.length > 0) {
    profile = filterProfilePoolForSeedCoherence(profile, seed, similar)
  }

  sessionManager.setPools(similar, profile)
  return { similar, profile, settings }
}

const buildPlaylistPlayableBatch = async (excludeUpcoming = true) => {
  const playlistTracks = await enrichPlaylistTracks(sessionManager.getPlaylistTracks())
  if (playlistTracks.length === 0) {
    throw new Error("Playlist has no tracks.")
  }

  const seed = sessionManager.getSeed()
  const settings = getSessionConfig(seed)
  const playedUris = sessionManager.getPlayedUris()
  const queuedUris = sessionManager.getQueuedUris()
  const upcomingQueueUris = excludeUpcoming ? getUpcomingQueueUris() : []
  const excludeUris = buildRecommendationExclusions({
    playedUris,
    committedQueueUris: queuedUris,
    visibleQueueUris: upcomingQueueUris,
    quarantinedUris: sessionManager.getQuarantinedUris(),
    purpose: excludeUpcoming ? "refill" : "rerank",
  })

  // Smart Mode: blend playlist tracks (50% weight) with similar recommendations (50% weight)
  const [similarPool, history] = await Promise.all([
    fetchPlaylistSimilarPool(playlistTracks, settings, 5),
    collectRecentHistorySnapshot({ includeSpotifyRecent: false }),
  ])
  sessionManager.registerCandidates([...playlistTracks, ...similarPool])
  const exposureMultipliers = (
    sessionManager as unknown as {
      getExposureMultipliers?: (c: readonly TrackCandidate[]) => Map<string, number>
    }
  ).getExposureMultipliers?.([...similarPool, ...playlistTracks])
  const hardExclusions = [...new Set([...excludeUris, ...history.uris])]
  const planningOptions = createLiveBatchPlanningOptions(
    history.uris,
    seed?.uri ?? "playlist",
    currentSessionQueueTail(seed),
    history.canonicalKeys,
    history,
    exposureMultipliers
  )

  let batch = filterOutPreviouslyPlayed(
    buildPlaylistBatch(
      playlistTracks,
      similarPool,
      hardExclusions,
      sessionManager.getTopTracksBlacklist(),
      settings,
      settings.initialQueueSize,
      sessionManager.getPosition(),
      "playlist",
      sessionManager.getFamiliarityLedger().map((entry) => entry === "discovery"),
      planningOptions
    ),
    seed?.uri,
    history,
    excludeUris
  )

  // Last-resort fallback: only relax history if literally zero unplayed tracks exist
  if (batch.length === 0) {
    const relaxedOptions = createLiveBatchPlanningOptions(
      history.uris,
      seed?.uri ?? "playlist",
      currentSessionQueueTail(seed),
      undefined,
      history,
      exposureMultipliers
    )
    batch = buildSinglePoolBatch(
      seed,
      similarPool,
      excludeUris,
      settings,
      settings.initialQueueSize,
      sessionManager.getPosition(),
      relaxedOptions
    )
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found.")
  }

  const queueUris = await queueUrisFromBatch(batch)
  if (queueUris.length === 0) throw new Error("No playable tracks were available for this mix")

  return {
    playableQueueUris: queueUris,
    settings,
    similarCount: similarPool.length,
    profileCount: playlistTracks.length,
  }
}

const buildArtistPlayableBatch = async (excludeUpcoming = true) => {
  const artistTracks = sessionManager.getArtistTracks()
  if (artistTracks.length === 0) {
    throw new Error("Artist has no tracks.")
  }

  const seed = sessionManager.getSeed()
  if (!seed) throw new Error("Artist mix has no seed track.")
  const settings = getSessionConfig(seed)
  const playedUris = sessionManager.getPlayedUris()
  const queuedUris = sessionManager.getQueuedUris()
  const upcomingQueueUris = excludeUpcoming ? getUpcomingQueueUris() : []
  const excludeUris = buildRecommendationExclusions({
    playedUris,
    committedQueueUris: queuedUris,
    visibleQueueUris: upcomingQueueUris,
    quarantinedUris: sessionManager.getQuarantinedUris(),
    purpose: excludeUpcoming ? "refill" : "rerank",
  })

  const [similarTracks, history] = await Promise.all([
    fetchSimilarPool(seed, settings),
    collectRecentHistorySnapshot({ includeSpotifyRecent: false }),
  ])
  sessionManager.registerCandidates([...artistTracks, ...similarTracks])
  const exposureMultipliers = (
    sessionManager as unknown as {
      getExposureMultipliers?: (c: readonly TrackCandidate[]) => Map<string, number>
    }
  ).getExposureMultipliers?.([...similarTracks, ...artistTracks])
  const hardExclusions = [...new Set([...excludeUris, ...history.uris])]
  const planningOptions = createLiveBatchPlanningOptions(
    history.uris,
    seed.uri,
    currentSessionQueueTail(seed),
    history.canonicalKeys,
    history,
    exposureMultipliers
  )

  // Smart Mode: blend artist discography with similar recommendations
  let batch = filterOutPreviouslyPlayed(
    buildTrackBatch(
      seed,
      sessionManager.getPosition(),
      hardExclusions,
      similarTracks,
      artistTracks,
      settings,
      settings.initialQueueSize,
      history.uris,
      sessionManager.getRecentPositiveAnchors(),
      sessionManager.getFamiliarityLedger().map((entry) => entry === "discovery"),
      planningOptions
    ),
    seed.uri,
    history,
    excludeUris
  )

  // Graceful fallback only if zero unplayed tracks remain
  if (batch.length === 0) {
    const relaxedOptions = createLiveBatchPlanningOptions(
      history.uris,
      seed.uri,
      currentSessionQueueTail(seed),
      history.canonicalKeys,
      history,
      exposureMultipliers
    )
    batch = buildSinglePoolBatch(
      seed,
      artistTracks,
      excludeUris,
      settings,
      settings.initialQueueSize,
      sessionManager.getPosition(),
      relaxedOptions
    )
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found.")
  }

  const queueUris = await queueUrisFromBatch(batch)
  if (queueUris.length === 0) throw new Error("No playable tracks were available for this mix")

  return {
    playableQueueUris: queueUris,
    settings,
    similarCount: artistTracks.length,
    profileCount: 0,
  }
}

export const buildPlayableBatch = async (
  seed: SeedMetadata,
  forceRefreshPools: boolean,
  excludeUpcoming = true
) => {
  if (sessionManager.isPlaylistSession()) {
    return await buildPlaylistPlayableBatch(excludeUpcoming)
  }
  if (sessionManager.isArtistSession()) {
    return await buildArtistPlayableBatch(excludeUpcoming)
  }

  let [{ similar, profile, settings }, history] = await Promise.all([
    ensurePools(seed, forceRefreshPools),
    collectRecentHistorySnapshot({ includeSpotifyRecent: forceRefreshPools }),
  ])

  if (similar.length === 0 && profile.length === 0) {
    throw new Error("Could not find tracks for Shuffle Similar. Try another song.")
  }

  const excludeUris = buildRecommendationExclusions({
    playedUris: sessionManager.getPlayedUris(),
    committedQueueUris: sessionManager.getQueuedUris(),
    visibleQueueUris: excludeUpcoming ? getUpcomingQueueUris() : [],
    quarantinedUris: sessionManager.getQuarantinedUris(),
    purpose: excludeUpcoming ? "refill" : "rerank",
  })

  const exposureMultipliers = (
    sessionManager as unknown as {
      getExposureMultipliers?: (c: readonly TrackCandidate[]) => Map<string, number>
    }
  ).getExposureMultipliers?.([...similar, ...profile])

  const hardExclusions = [...new Set([...excludeUris, ...history.uris])]
  const strictPlanningOptions = createLiveBatchPlanningOptions(
    history.uris,
    seed.uri,
    currentSessionQueueTail(seed),
    history.canonicalKeys,
    history,
    exposureMultipliers
  )

  const build = (exclusions: string[], options: BatchPlanningOptions = strictPlanningOptions) =>
    buildTrackBatch(
      seed,
      sessionManager.getPosition(),
      exclusions,
      similar,
      profile,
      settings,
      settings.initialQueueSize,
      [...history.uris, ...profile.map((candidate) => candidate.uri)],
      sessionManager.getRecentPositiveAnchors(),
      sessionManager.getFamiliarityLedger().map((entry) => entry === "discovery"),
      options
    )

  let batch = filterOutPreviouslyPlayed(build(hardExclusions), seed.uri, history, excludeUris)

  if (batch.length < Math.min(10, settings.initialQueueSize) && history.uris.length > 0) {
    const deepSimilar = await fetchSimilarPool(seed, settings, { deepDiscovery: true })
    if (deepSimilar.length > 0) {
      similar = mergeCandidatesWithProvenance([...similar, ...deepSimilar])
      sessionManager.setPools(similar, profile)
      const expandedBatch = filterOutPreviouslyPlayed(
        build(hardExclusions),
        seed.uri,
        history,
        excludeUris
      )
      if (expandedBatch.length > batch.length) {
        batch = expandedBatch
      }
    }
  }

  if (batch.length === 0 && !forceRefreshPools) {
    ;({ similar, profile, settings } = await ensurePools(seed, true))
    batch = filterOutPreviouslyPlayed(build(hardExclusions), seed.uri, history, excludeUris)
  }

  if (batch.length === 0) {
    const relaxedOptions = createLiveBatchPlanningOptions(
      history.uris,
      seed.uri,
      currentSessionQueueTail(seed),
      history.canonicalKeys,
      history,
      exposureMultipliers
    )
    const relaxedExclusions = buildHistoryRelaxedExclusions(
      {
        playedUris: sessionManager.getPlayedUris(),
        committedQueueUris: excludeUpcoming ? sessionManager.getQueuedUris() : [],
        visibleQueueUris: excludeUpcoming ? getUpcomingQueueUris() : [],
        quarantinedUris: sessionManager.getQuarantinedUris(),
      },
      Math.max(10, settings.artistSpacing * 2)
    )
    batch = build(relaxedExclusions, relaxedOptions)
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found. Try again.")
  }

  const queueUris = await queueUrisFromBatch(batch)

  if (queueUris.length === 0) {
    throw new Error("Could not build a shuffle queue. Try another song.")
  }

  return {
    playableQueueUris: queueUris,
    settings,
    similarCount: similar.length,
    profileCount: profile.length,
  }
}
