/** Builds playable recommendation batches for track, playlist, album and artist mixes. */
import {
  buildPlaylistBatch,
  buildSinglePoolBatch,
  buildTrackBatch,
} from "../algorithm/progressiveBlend"
import { getUpcomingQueueUris } from "../queue/queueManager"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { fetchProfilePool } from "../sources/profileTracks"
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

  const build = (exclusions: string[]) =>
    buildTrackBatch(
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
    const relaxedExclusions = buildHistoryRelaxedExclusions(
      {
        playedUris: sessionManager.getPlayedUris(),
        committedQueueUris: excludeUpcoming ? sessionManager.getQueuedUris() : [],
        visibleQueueUris: excludeUpcoming ? getUpcomingQueueUris() : [],
        quarantinedUris: sessionManager.getQuarantinedUris(),
      },
      Math.max(10, settings.artistSpacing * 2)
    )
    batch = build(relaxedExclusions)
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
