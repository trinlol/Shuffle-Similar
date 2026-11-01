import { buildPlaylistBatch, buildTrackBatch } from "../algorithm/progressiveBlend"
import { createQueueError } from "../diagnostics/failureReasons"
import { recordOperation } from "../diagnostics/operationLog"
import { disableAutoplayGuard, enableAutoplayGuard, syncKnownQueue } from "../queue/autoplayGuard"
import {
  detachFromPlaylistContext,
  getUpcomingQueueUris,
  isAlbumContext,
  isArtistContext,
  isPlaylistContext,
  playSeedAndQueue,
  queuePrefixMatches,
  replaceUpcomingQueue,
  replaceUpcomingQueueForNewMix,
  resolveShuffleSimilarPlaybackContext,
  shuffleUpcomingInPlace,
} from "../queue/queueManager"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { fetchAlbumTracks, fetchArtistDiscographyTracks } from "../sources/artistTracks"
import { fetchAllPlaylistTracks, fetchProfilePool, fetchTopTracks } from "../sources/profileTracks"
import {
  enrichPlaylistTracks,
  fetchPlaylistSimilarPool,
  fetchSimilarPool,
} from "../sources/similarTracks"
import { fetchSeedMetadata } from "../sources/trackMetadata"
import { assertQueueCompatibility } from "./compatibility"
import { getSessionConfig, queueUrisFromBatch, withForegroundDeadline } from "./mixBuilder"
import { LatestMixCoordinator } from "./mixCoordinator"
import { suppressNativeShuffle } from "./playbackEffects"
import { prefetchNextBatch, refillQueueIfNeeded } from "./refill"
import { shouldRecoverSession } from "./sessionRecovery"
import {
  clearSimilarMixRecovery,
  getSessionRecoveryStore,
  invalidatePrefetch,
  persistActiveSession,
  queueMutationCoordinator,
} from "./sessionState"

/** Start paths always assemble pools from scratch via `prepareMix`, so there is
 * deliberately no pool-reuse switch here; only refill reuses session pools. */
type StartOptions = {
  playSeed?: boolean
  replaceUpcoming?: boolean
  buildOnly?: boolean
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
  suppressNativeShuffle()
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
    if (playlistTracks.length === 0)
      throw new Error("No playable tracks were found in this selection")
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
  if ((prepared.mode === "playlist" || prepared.mode === "album") && prepared.contextUri) {
    sessionManager.startPlaylistSession(
      prepared.seed,
      prepared.contextUri,
      prepared.playlistTracks,
      prepared.topTracks
    )
  } else if (prepared.mode === "artist" && prepared.contextUri) {
    sessionManager.startArtistSession(prepared.seed, prepared.contextUri, prepared.artistTracks)
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
  if (options.buildOnly || generation == null) return result

  const startedAt = Date.now()
  await liveMixCoordinator.commit(generation, async () => {
    invalidatePrefetch()
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
      recordOperation({
        op: "mix.start",
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        counts: {
          requested: queueCommit.requestedUris.length,
          observed: queueCommit.actualUris.length,
        },
        reason: "queue_not_confirmed",
      })
      const prefixStatus = queuePrefixMatches(queueCommit.requestedUris, queueCommit.actualUris)
        ? "ordered prefix matched"
        : "ordered prefix differed"
      throw createQueueError(
        `Spotify did not confirm the Similar Mix queue ` +
          `(${queueCommit.actualUris.length}/${queueCommit.requestedUris.length} visible; ${prefixStatus})`,
        "queue_not_confirmed"
      )
    }
    await detachFromPlaylistContext(seed.albumUri)
    commitPreparedSession(prepared)
    sessionManager.setToggleEnabled(true)
    enableAutoplayGuard()
    suppressNativeShuffle()
  })

  recordOperation({
    op: "mix.start",
    outcome: "ok",
    durationMs: Date.now() - startedAt,
    counts: { queued: prepared.queueUris.length },
  })
  Spicetify.showNotification(`Similar Mix ready · ${prepared.queueUris.length} tracks queued`)

  return result
}

export const startFromContextMenu = async (seedUri: string, contextUri?: string | null) => {
  return await startShuffleSimilar(seedUri, contextUri, {
    playSeed: true,
    replaceUpcoming: false,
  })
}

export const buildFromContextMenu = async (seedUri: string, contextUri?: string | null) => {
  return await startShuffleSimilar(seedUri, contextUri, {
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
    playSeed: false,
    replaceUpcoming: true,
  })
}

export const reshuffleOnToggleOff = async () => {
  const shuffled = await queueMutationCoordinator.run(shuffleUpcomingInPlace)
  if (!shuffled) return
  Spicetify.showNotification("Queue reshuffled")
}

export const handleSongChange = async (): Promise<"active" | "stopped" | "ignored"> => {
  const uri = Spicetify.Player.data?.item?.uri
  if (!uri) return "ignored"

  if (!sessionManager.isToggleEnabled() || !sessionManager.isActive()) return "ignored"

  suppressNativeShuffle()
  const observation = sessionManager.transitionToTrack(uri)
  if (observation.type === "manual-context-exit") {
    disableAutoplayGuard()
    sessionManager.endSession()
    clearSimilarMixRecovery()
    invalidatePrefetch()
    return "stopped"
  }
  sessionManager.recordTrackPlayed(uri)
  if (observation.type === "early-skip") invalidatePrefetch()
  await refillQueueIfNeeded()
  void prefetchNextBatch()
  return "active"
}

// Public API that moved to focused modules; importers keep using ./shuffleEngine.
export { handlePlaybackFailure, teachSimilarMixPreference } from "./playbackRecovery"
export { refillQueueIfNeeded } from "./refill"
export { clearSimilarMixRecovery } from "./sessionState"
