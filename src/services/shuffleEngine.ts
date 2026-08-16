import { buildTrackBatch, buildSinglePoolBatch, buildPlaylistBatch } from "../algorithm/progressiveBlend"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { fetchProfilePool, fetchAllPlaylistTracks, fetchTopTracks } from "../sources/profileTracks"
import { fetchSimilarPool, fetchPlaylistSimilarPool, enrichPlaylistTracks } from "../sources/similarTracks"
import { fetchSeedMetadata } from "../sources/trackMetadata"
import { getSmartConfig } from "../storage/settings"
import { detectForeignInjection, disableAutoplayGuard, enableAutoplayGuard, syncKnownQueue } from "../queue/autoplayGuard"
import {
  appendTracksToQueue,
  getConfirmedQueueOwnership,
  getUpcomingCount,
  getUpcomingQueueUris,
  detachFromPlaylistContext,
  playSeedAndQueue,
  replaceUpcomingQueue,
  replaceUpcomingQueueForNewMix,
  resolveShuffleSimilarPlaybackContext,
  shuffleUpcomingInPlace,
  isPlaylistContext,
  isArtistContext,
  isAlbumContext,
} from "../queue/queueManager"
import { filterPlayableUris, verifyQueuePlayability } from "../utils/playability"
import { enforceNativeShuffleOff } from "../ui/nativeShuffleGuard"
import { fisherYatesShuffle } from "../algorithm/shuffle"
import { getUriId } from "../utils/uri"
import { fetchArtistDiscographyTracks, fetchAlbumTracks } from "../sources/artistTracks"
import { LatestMixCoordinator } from "./mixCoordinator"
import {
  buildHistoryRelaxedExclusions,
  buildRecommendationExclusions,
} from "./recommendationExclusions"
import {
  createSessionRecoveryStore,
  shouldRecoverSession,
} from "./sessionRecovery"
import { createPrefetchCache } from "./prefetchCache"
import { assertQueueCompatibility } from "./compatibility"
import { QueueMutationCoordinator } from "../queue/queueMutationCoordinator"

type StartOptions = {
  forceRefreshPools?: boolean
  playSeed?: boolean
  replaceUpcoming?: boolean
  buildOnly?: boolean
}

const PROFILE_FOREGROUND_DEADLINE_MS = 4_500

const withForegroundDeadline = async <T>(
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

const getSessionConfig = (seed?: SeedMetadata | null) => {
  const now = Date.now()
  return {
    ...getSmartConfig(seed),
    skipFeedback: sessionManager.getSkipFeedback(),
    tasteProfile: sessionManager.getTasteProfile(now),
    tasteProfileNow: now,
    tasteContextKey: sessionManager.getTasteContextKey(now),
  }
}

const queueUrisFromBatch = async (batch: readonly TrackCandidate[]): Promise<string[]> => {
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

const ensurePools = async (seed: SeedMetadata, forceRefresh = false) => {
  const settings = getSessionConfig(seed)
  let similar = forceRefresh ? [] : sessionManager.getSimilarPool()
  let profile = forceRefresh ? [] : sessionManager.getProfilePool()

  ;[similar, profile] = await Promise.all([
    similar.length === 0 ? fetchSimilarPool(seed, settings) : Promise.resolve(similar),
    profile.length === 0
      ? withForegroundDeadline(fetchProfilePool(seed), [])
      : Promise.resolve(profile),
  ])

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
  const similarPool = await fetchPlaylistSimilarPool(playlistTracks, settings, 5)
  sessionManager.registerCandidates([...playlistTracks, ...similarPool])

  let batch = buildPlaylistBatch(
    playlistTracks,
    similarPool,
    excludeUris,
    sessionManager.getTopTracksBlacklist(),
    settings,
    settings.initialQueueSize,
    sessionManager.getPosition(),
    "playlist",
    sessionManager.getFamiliarityLedger().map((entry) => entry === "discovery")
  )

  // Last-resort fallback: only use playlist tracks if nothing else worked
  if (batch.length === 0) {
    batch = buildSinglePoolBatch(
      seed,
      similarPool,
      excludeUris,
      settings,
      settings.initialQueueSize,
      sessionManager.getPosition()
    )
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found.")
  }

  const queueUris = await queueUrisFromBatch(batch)
  if (queueUris.length === 0) throw new Error("No playable tracks were available for this mix")

  return { playableQueueUris: queueUris, settings, similarCount: similarPool.length, profileCount: playlistTracks.length }
}

const buildArtistPlayableBatch = async (excludeUpcoming = true) => {
  const artistTracks = sessionManager.getArtistTracks()
  if (artistTracks.length === 0) {
    throw new Error("Artist has no tracks.")
  }

  const seed = sessionManager.getSeed()!
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

  const similarTracks = await fetchSimilarPool(seed, settings)
  sessionManager.registerCandidates([...artistTracks, ...similarTracks])

  // Smart Mode: blend artist discography with similar recommendations
  let batch = buildTrackBatch(
    seed,
    sessionManager.getPosition(),
    excludeUris,
    similarTracks,
    artistTracks,
    settings,
    settings.initialQueueSize,
    sessionManager.getPlayHistory(),
    sessionManager.getRecentPositiveAnchors(),
    sessionManager.getFamiliarityLedger().map((entry) => entry === "discovery")
  )

  // Graceful fallback if batch is empty
  if (batch.length === 0) {
    batch = buildSinglePoolBatch(
      seed,
      artistTracks,
      excludeUris,
      settings,
      settings.initialQueueSize,
      sessionManager.getPosition()
    )
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found.")
  }

  const queueUris = await queueUrisFromBatch(batch)
  if (queueUris.length === 0) throw new Error("No playable tracks were available for this mix")

  return { playableQueueUris: queueUris, settings, similarCount: artistTracks.length, profileCount: 0 }
}

const buildPlayableBatch = async (
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

  let { similar, profile, settings } = await ensurePools(seed, forceRefreshPools)

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

  const build = (exclusions: string[]) => buildTrackBatch(
    seed,
    sessionManager.getPosition(),
    exclusions,
    similar,
    profile,
    settings,
    settings.initialQueueSize,
    [...sessionManager.getPlayHistory(), ...profile.map((candidate) => candidate.uri)],
    sessionManager.getRecentPositiveAnchors(),
    sessionManager.getFamiliarityLedger().map((entry) => entry === "discovery")
  )
  let batch = build(excludeUris)

  if (batch.length === 0 && !forceRefreshPools) {
    ;({ similar, profile, settings } = await ensurePools(seed, true))
    batch = build(excludeUris)
  }

  if (batch.length === 0) {
    const relaxedExclusions = buildHistoryRelaxedExclusions({
      playedUris: sessionManager.getPlayedUris(),
      committedQueueUris: excludeUpcoming ? sessionManager.getQueuedUris() : [],
      visibleQueueUris: excludeUpcoming ? getUpcomingQueueUris() : [],
      quarantinedUris: sessionManager.getQuarantinedUris(),
    }, Math.max(10, settings.artistSpacing * 2))
    batch = build(relaxedExclusions)
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found. Try again.")
  }

  const queueUris = await queueUrisFromBatch(batch)

  if (queueUris.length === 0) {
    throw new Error("Could not build a shuffle queue. Try another song.")
  }

  return { playableQueueUris: queueUris, settings, similarCount: similar.length, profileCount: profile.length }
}

type PreparedMix = {
  seed: SeedMetadata
  contextUri: string | null
  mode: "track" | "playlist" | "album" | "artist"
  playlistTracks: TrackCandidate[]
  topTracks: string[]
  artistTracks: TrackCandidate[]
  similarPool: TrackCandidate[]
  profilePool: TrackCandidate[]
  selected: TrackCandidate[]
  queueUris: string[]
  settings: ReturnType<typeof getSessionConfig>
}

const liveMixCoordinator = new LatestMixCoordinator()
const queueMutationCoordinator = new QueueMutationCoordinator()
let sessionRecoveryStore: ReturnType<typeof createSessionRecoveryStore> | null = null
const getSessionRecoveryStore = () => (sessionRecoveryStore ??= createSessionRecoveryStore())
const prefetchCache = createPrefetchCache()
let prefetchInFlight = false

const persistActiveSession = (): void => {
  const seed = sessionManager.getSeed()
  if (!seed || !sessionManager.isActive()) return
  getSessionRecoveryStore().save({
    seed,
    queuedUris: sessionManager.getQueuedUris(),
    position: sessionManager.getPosition(),
    recentPositiveAnchors: sessionManager.getRecentPositiveAnchors(),
    familiarityLedger: sessionManager.getFamiliarityLedger(),
  })
}

export const clearSimilarMixRecovery = (): void => getSessionRecoveryStore().clear()

const prefetchNextBatch = async (): Promise<void> => {
  if (!sessionManager.isActive() || sessionManager.isRefilling() || prefetchInFlight) return
  const seed = sessionManager.getSeed()
  if (!seed) return
  const settings = getSessionConfig(seed)
  if (getUpcomingCount() >= settings.refillThreshold + 8) return
  const revision = sessionManager.getRevision()
  if (prefetchCache.has(revision)) return

  prefetchInFlight = true
  try {
    const { playableQueueUris } = await buildPlayableBatch(seed, false)
    if (sessionManager.isActive() && sessionManager.getRevision() === revision) {
      prefetchCache.save({ revision, uris: playableQueueUris })
    }
  } catch (error) {
    // Prefetch is purely an optimisation; foreground refill remains authoritative.
    console.debug("[Shuffle Similar] prefetch skipped", error)
  } finally {
    prefetchInFlight = false
  }
}

/** Restores an already-visible queue after an extension reload without
 * rebuilding or taking over unrelated Spotify playback. */
export const recoverSimilarMixSession = async (): Promise<boolean> => {
  if (sessionManager.isActive()) return false
  const snapshot = getSessionRecoveryStore().load()
  const currentUri = Spicetify.Player.data?.item?.uri ?? null
  const visibleQueueUris = getUpcomingQueueUris()
  if (!snapshot || !shouldRecoverSession(snapshot, currentUri, visibleQueueUris)) return false

  sessionManager.resumeSession(
    snapshot.seed,
    visibleQueueUris.length > 0 ? visibleQueueUris : snapshot.queuedUris,
    snapshot.position,
    currentUri,
    {
      recentPositiveAnchors: snapshot.recentPositiveAnchors,
      familiarityLedger: snapshot.familiarityLedger,
    }
  )
  sessionManager.registerCandidates([{ ...snapshot.seed }])
  syncKnownQueue(sessionManager.getQueuedUris())
  enableAutoplayGuard()
  enforceNativeShuffleOff()
  return true
}

const prepareMix = async (seed: SeedMetadata, contextUri?: string | null): Promise<PreparedMix> => {
  const settings = getSessionConfig(seed)
  const base = {
    seed,
    contextUri: contextUri ?? null,
    playlistTracks: [] as TrackCandidate[],
    topTracks: [] as string[],
    artistTracks: [] as TrackCandidate[],
    similarPool: [] as TrackCandidate[],
    profilePool: [] as TrackCandidate[],
    settings,
  }

  let prepared: Omit<PreparedMix, "queueUris">
  if (contextUri && (isPlaylistContext(contextUri) || isAlbumContext(contextUri))) {
    const isAlbum = isAlbumContext(contextUri)
    const rawTracks = isAlbum
      ? await fetchAlbumTracks(contextUri)
      : await fetchAllPlaylistTracks(contextUri)
    const playlistTracks = await enrichPlaylistTracks(rawTracks)
    if (playlistTracks.length === 0) throw new Error("No playable tracks were found in this selection")
    const [topTracks, similarPool] = await Promise.all([
      isAlbum ? Promise.resolve([]) : fetchTopTracks(),
      fetchPlaylistSimilarPool(playlistTracks, settings, 5),
    ])
    const selected = buildPlaylistBatch(
      playlistTracks,
      similarPool,
      [seed.uri],
      topTracks,
      settings,
      settings.initialQueueSize,
      0,
      isAlbum ? "album" : "playlist"
    )
    prepared = {
      ...base,
      mode: isAlbum ? "album" : "playlist",
      playlistTracks,
      topTracks,
      similarPool,
      selected,
    }
  } else if (contextUri && isArtistContext(contextUri)) {
    const [artistTracks, similarPool] = await Promise.all([
      fetchArtistDiscographyTracks(contextUri),
      fetchSimilarPool(seed, settings),
    ])
    if (artistTracks.length === 0 && similarPool.length === 0) {
      throw new Error("No playable matches were found for this artist")
    }
    const selected = buildTrackBatch(
      seed,
      0,
      [seed.uri],
      similarPool,
      artistTracks,
      settings,
      settings.initialQueueSize
    )
    prepared = {
      ...base,
      mode: "artist",
      artistTracks,
      similarPool,
      profilePool: artistTracks,
      selected,
    }
  } else {
    const [similarPool, profilePool] = await Promise.all([
      fetchSimilarPool(seed, settings),
      withForegroundDeadline(fetchProfilePool(seed), []),
    ])
    if (similarPool.length === 0 && profilePool.length === 0) {
      throw new Error("No playable matches were found for this track")
    }
    const selected = buildTrackBatch(
      seed,
      0,
      [seed.uri],
      similarPool,
      profilePool,
      settings,
      settings.initialQueueSize
    )
    prepared = {
      ...base,
      mode: "track",
      similarPool,
      profilePool,
      selected,
    }
  }

  const queueUris = (await queueUrisFromBatch(prepared.selected)).filter((uri) => uri !== seed.uri)
  if (queueUris.length === 0) throw new Error("No playable matches were found for this selection")
  return { ...prepared, queueUris }
}

const commitPreparedSession = (prepared: PreparedMix): void => {
  if (prepared.mode === "playlist" || prepared.mode === "album") {
    sessionManager.startPlaylistSession(
      prepared.seed,
      prepared.contextUri!,
      prepared.playlistTracks,
      prepared.topTracks
    )
  } else if (prepared.mode === "artist") {
    sessionManager.startArtistSession(prepared.seed, prepared.contextUri!, prepared.artistTracks)
  } else {
    sessionManager.startSession(prepared.seed)
  }
  sessionManager.setPools(prepared.similarPool, prepared.profilePool)
  sessionManager.registerCandidates([
    ...prepared.playlistTracks,
    ...prepared.artistTracks,
    ...prepared.similarPool,
    ...prepared.profilePool,
    ...prepared.selected,
  ])
  sessionManager.setQueuedUris(prepared.queueUris)
  syncKnownQueue(prepared.queueUris)
  persistActiveSession()
}

export const startShuffleSimilar = async (
  seedUri: string,
  contextUri?: string | null,
  options: StartOptions = {}
) => {
  if (!options.buildOnly) assertQueueCompatibility()
  await sessionManager.initializeTasteIdentity()
  const generation = options.buildOnly ? null : liveMixCoordinator.begin()
  const seed = await fetchSeedMetadata(seedUri)
  if (generation != null) liveMixCoordinator.assertCurrent(generation)
  const prepared = await prepareMix(seed, contextUri)
  if (generation != null) liveMixCoordinator.assertCurrent(generation)
  const result = {
    seed,
    queueUris: prepared.queueUris,
  }
  if (options.buildOnly) return result

  await liveMixCoordinator.commit(generation!, async () => {
    prefetchCache.clear()
    sessionManager.invalidatePendingMutations()
    const currentUri = Spicetify.Player.data?.item?.uri ?? null
    const queueCommit = await queueMutationCoordinator.run(async () =>
      options.replaceUpcoming && currentUri
        ? await replaceUpcomingQueueForNewMix(currentUri, prepared.queueUris, seed.albumUri)
        : options.playSeed
          ? await playSeedAndQueue(
              seed.uri,
              prepared.queueUris,
              resolveShuffleSimilarPlaybackContext(contextUri, seed.albumUri)
            )
          : await replaceUpcomingQueue(currentUri ?? seed.uri, prepared.queueUris)
    )
    if (!queueCommit.verified) {
      const error = new Error("Spotify did not confirm the Similar Mix queue")
      ;(error as Error & { code?: string }).code = "SERVICE_UNAVAILABLE"
      throw error
    }
    await detachFromPlaylistContext(seed.albumUri)
    commitPreparedSession(prepared)
    sessionManager.setToggleEnabled(true)
    enableAutoplayGuard()
    enforceNativeShuffleOff()
  })

  Spicetify.showNotification(`Similar Mix ready · ${prepared.queueUris.length} tracks queued`)

  return result
}

export const startFromContextMenu = async (seedUri: string, contextUri?: string | null) => {
  return await startShuffleSimilar(seedUri, contextUri, {
    forceRefreshPools: true,
    playSeed: true,
    replaceUpcoming: false,
  })
}

export const buildFromContextMenu = async (seedUri: string, contextUri?: string | null) => {
  return await startShuffleSimilar(seedUri, contextUri, {
    forceRefreshPools: true,
    buildOnly: true,
  })
}

export const reshuffleFromCurrentTrack = async () => {
  const uri = Spicetify.Player.data?.item?.uri
  if (!uri) {
    throw new Error("Play a song first, then enable Shuffle Similar")
  }

  const playerContextUri = Spicetify.Player.data?.context?.uri ?? null
  await startShuffleSimilar(uri, playerContextUri, {
    forceRefreshPools: true,
    playSeed: false,
    replaceUpcoming: true,
  })
}

export const reshuffleOnToggleOff = async () => {
  const shuffled = await queueMutationCoordinator.run(shuffleUpcomingInPlace)
  if (!shuffled) return
  Spicetify.showNotification("Queue reshuffled")
}

let activeRefill: Promise<void> | null = null

const runRefillQueueIfNeeded = async (): Promise<void> => {
  if (!sessionManager.isActive()) return

  const seed = sessionManager.getSeed()
  if (!seed) return

  sessionManager.setRefilling(true)
  try {
    const revision = sessionManager.getRevision()
    const foreign = detectForeignInjection()
    if (foreign.length > 0) {
      const cleaned = getUpcomingQueueUris().filter((uri) => sessionManager.ownsQueueTrack(uri))
      const current = Spicetify.Player.data?.item?.uri
      await queueMutationCoordinator.run(() => replaceUpcomingQueue(current, cleaned))
    }

    const settings = getSessionConfig(seed)
    const upcoming = getUpcomingCount()
    if (upcoming >= settings.refillThreshold) return

    const playableQueueUris = prefetchCache.take(sessionManager.getRevision())
      ?? (await buildPlayableBatch(seed, false)).playableQueueUris
    const alreadyQueued = new Set(getUpcomingQueueUris())
    const batchUris = playableQueueUris
      .filter((uri) => !alreadyQueued.has(uri))
      .slice(0, settings.initialQueueSize)
    if (batchUris.length === 0) return
    if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return

    await queueMutationCoordinator.run(async () => {
      if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return
      await appendTracksToQueue(batchUris.map((uri) => ({ uri })))
    })
    if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return
    const merged = [...getUpcomingQueueUris(), ...batchUris]
    sessionManager.setQueuedUris(merged)
    syncKnownQueue(merged)
    persistActiveSession()
  } catch (error) {
    console.error("[Shuffle Similar] refill failed", error)
  } finally {
    sessionManager.setRefilling(false)
  }
}

export const refillQueueIfNeeded = async (): Promise<void> => {
  if (activeRefill) return await activeRefill
  activeRefill = runRefillQueueIfNeeded()
  try {
    await activeRefill
  } finally {
    activeRefill = null
  }
}

const rerankUpcomingAfterFeedback = async (): Promise<void> => {
  const seed = sessionManager.getSeed()
  if (!seed || !sessionManager.isActive()) return

  const revision = sessionManager.getRevision()
  prefetchCache.clear()
  const { playableQueueUris, settings } = await buildPlayableBatch(seed, false, false)
  if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return

  const currentUri = Spicetify.Player.data?.item?.uri ?? null
  const nextUris = playableQueueUris
    .filter((uri) => uri !== currentUri && uri !== seed.uri)
    .slice(0, settings.initialQueueSize)
  if (nextUris.length === 0) return

  const commit = await queueMutationCoordinator.run(async () => {
    if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) {
      return { requestedUris: [], actualUris: [], verified: false }
    }
    return await replaceUpcomingQueue(currentUri, nextUris)
  })
  if (!sessionManager.isActive() || sessionManager.getRevision() !== revision) return
  const committedUris = getConfirmedQueueOwnership(commit)
  if (committedUris.length === 0) return
  sessionManager.setQueuedUris(committedUris)
  syncKnownQueue(committedUris)
  persistActiveSession()
}

let playbackFailureRecovery: Promise<boolean> | null = null

const getImmediateOwnedRecoveryTrack = (): string | null => {
  const nextUri = getUpcomingQueueUris()[0]
  return nextUri && sessionManager.ownsQueueTrack(nextUri) && !sessionManager.isQuarantined(nextUri)
    ? nextUri
    : null
}

/** Repairs an owned unplayable track without converting an operational
 * failure into preference feedback. Duplicate watchdog decisions coalesce. */
export const handlePlaybackFailure = async (uri: string): Promise<boolean> => {
  if (playbackFailureRecovery) return await playbackFailureRecovery
  playbackFailureRecovery = (async () => {
    if (!sessionManager.isActive() || !sessionManager.ownsQueueTrack(uri)) return false
    if (sessionManager.isQuarantined(uri)) return false

    const observation = sessionManager.recordPlaybackFailure(uri)
    if (observation.type !== "play-failure") return false
    prefetchCache.clear()

    try {
      let nextOwnedUri = getImmediateOwnedRecoveryTrack()
      if (!nextOwnedUri) await refillQueueIfNeeded()
      if (Spicetify.Player.data?.item?.uri !== uri) return true
      nextOwnedUri = getImmediateOwnedRecoveryTrack()
      if (!nextOwnedUri) {
        Spicetify.showNotification("Similar Mix could not recover this unavailable track", true)
        return false
      }
      Spicetify.Player.next()
      void rerankUpcomingAfterFeedback().catch((error) => {
        console.warn("[Shuffle Similar] Could not refresh the queue after playback recovery", error)
      })
      return true
    } catch (error) {
      console.warn("[Shuffle Similar] Could not recover failed playback", error)
      Spicetify.showNotification("Similar Mix could not recover this unavailable track", true)
      return false
    }
  })()

  try {
    return await playbackFailureRecovery
  } finally {
    playbackFailureRecovery = null
  }
}

/** Records an intentional More/Less signal. A negative signal immediately
 * refreshes what comes next when Similar Mix is active. */
export const teachSimilarMixPreference = async (
  uri: string,
  sentiment: -1 | 1
): Promise<void> => {
  if (!uri.startsWith("spotify:track:")) throw new Error("Choose a Spotify track")
  const candidate = sessionManager.getCandidate(uri) ?? await fetchSeedMetadata(uri)
  sessionManager.registerCandidates([candidate])
  sessionManager.recordExplicitFeedback(candidate, sentiment)
  prefetchCache.clear()
  if (sentiment < 0 && sessionManager.isActive()) {
    await rerankUpcomingAfterFeedback()
  }
}

export const handleSongChange = async (): Promise<"active" | "stopped" | "ignored"> => {
  const uri = Spicetify.Player.data?.item?.uri
  if (!uri) return "ignored"

  if (!sessionManager.isToggleEnabled() || !sessionManager.isActive()) return "ignored"

  enforceNativeShuffleOff()
  const observation = sessionManager.transitionToTrack(uri)
  if (observation.type === "manual-context-exit") {
    disableAutoplayGuard()
    sessionManager.endSession()
    clearSimilarMixRecovery()
    prefetchCache.clear()
    return "stopped"
  }
  sessionManager.recordTrackPlayed(uri)
  if (observation.rerank === "immediate" && observation.type !== "play-failure") {
    try {
      await rerankUpcomingAfterFeedback()
    } catch (error) {
      console.warn("[Shuffle Similar] Could not adapt the upcoming queue", error)
    }
  }
  await refillQueueIfNeeded()
  void prefetchNextBatch()
  return "active"
}
