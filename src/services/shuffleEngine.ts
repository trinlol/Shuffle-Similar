import { filterProfilePoolForSeedCoherence } from "../algorithm/genreAffinity"
import { buildPlaylistBatch, buildTrackBatch } from "../algorithm/progressiveBlend"
import { createQueueError } from "../diagnostics/failureReasons"
import { recordOperation } from "../diagnostics/operationLog"
import {
  disableAutoplayGuard,
  enableAutoplayGuard,
  isUserQueuedDetourTrack,
  syncKnownQueue,
} from "../queue/autoplayGuard"
import {
  clearUpcomingQueue,
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
import { mergeCandidatesWithProvenance } from "../sources/provenance"
import {
  enrichPlaylistTracks,
  fetchPlaylistSimilarPool,
  fetchSimilarPool,
} from "../sources/similarTracks"
import { fetchSeedMetadata } from "../sources/trackMetadata"
import { assertQueueCompatibility } from "./compatibility"
import {
  collectRecentHistorySnapshot,
  createLiveBatchPlanningOptions,
  filterOutPreviouslyPlayed,
  getSessionConfig,
  queueUrisFromBatch,
  withForegroundDeadline,
} from "./mixBuilder"
import { LatestMixCoordinator } from "./mixCoordinator"
import { suppressNativeShuffle } from "./playbackEffects"
import { prefetchNextBatch, refillQueueIfNeeded, rerankUpcomingAfterFeedback } from "./refill"
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
      playedUris: snapshot.playedUris,
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
    const [topTracks, similarPool, history] = await Promise.all([
      isAlbum ? Promise.resolve([]) : fetchTopTracks(),
      fetchPlaylistSimilarPool(playlistTracks, settings, 5),
      collectRecentHistorySnapshot({ includeSpotifyRecent: true }),
    ])
    const exposureMultipliers = (
      sessionManager as unknown as {
        getExposureMultipliers?: (c: readonly TrackCandidate[]) => Map<string, number>
      }
    ).getExposureMultipliers?.([...similarPool, ...playlistTracks])
    const strictPlanningOptions = createLiveBatchPlanningOptions(
      history.uris,
      seed.uri,
      [seed.uri],
      history.canonicalKeys,
      history,
      exposureMultipliers
    )
    const hardExclusions = [...new Set([seed.uri, ...history.uris])]
    let selected = filterOutPreviouslyPlayed(
      buildPlaylistBatch(
        playlistTracks,
        similarPool,
        hardExclusions,
        topTracks,
        settings,
        settings.initialQueueSize,
        0,
        isAlbum ? "album" : "playlist",
        [],
        strictPlanningOptions
      ),
      seed.uri,
      history
    )
    if (selected.length === 0) {
      const relaxedOptions = createLiveBatchPlanningOptions(
        history.uris,
        seed.uri,
        [seed.uri],
        history.canonicalKeys,
        history,
        exposureMultipliers
      )
      selected = buildPlaylistBatch(
        playlistTracks,
        similarPool,
        [seed.uri],
        topTracks,
        settings,
        settings.initialQueueSize,
        0,
        isAlbum ? "album" : "playlist",
        [],
        relaxedOptions
      )
    }
    prepared = {
      ...base,
      mode: isAlbum ? "album" : "playlist",
      playlistTracks,
      topTracks,
      similarPool,
      selected,
    }
  } else if (contextUri && isArtistContext(contextUri)) {
    let [artistTracks, similarPool, history] = await Promise.all([
      fetchArtistDiscographyTracks(contextUri),
      fetchSimilarPool(seed, settings),
      collectRecentHistorySnapshot({ includeSpotifyRecent: true }),
    ])
    if (artistTracks.length === 0 && similarPool.length === 0) {
      throw new Error("No playable matches were found for this artist")
    }
    const exposureMultipliers = (
      sessionManager as unknown as {
        getExposureMultipliers?: (c: readonly TrackCandidate[]) => Map<string, number>
      }
    ).getExposureMultipliers?.([...similarPool, ...artistTracks])
    const strictPlanningOptions = createLiveBatchPlanningOptions(
      history.uris,
      seed.uri,
      [seed.uri],
      history.canonicalKeys,
      history,
      exposureMultipliers
    )
    const hardExclusions = [...new Set([seed.uri, ...history.uris])]
    let selected = filterOutPreviouslyPlayed(
      buildTrackBatch(
        seed,
        0,
        hardExclusions,
        similarPool,
        artistTracks,
        settings,
        settings.initialQueueSize,
        history.uris,
        [],
        [],
        strictPlanningOptions
      ),
      seed.uri,
      history
    )
    if (selected.length < Math.min(15, settings.initialQueueSize) && history.uris.length > 0) {
      const deepSimilar = await fetchSimilarPool(seed, settings, { deepDiscovery: true })
      if (deepSimilar.length > 0) {
        similarPool = mergeCandidatesWithProvenance([...similarPool, ...deepSimilar])
        const expanded = filterOutPreviouslyPlayed(
          buildTrackBatch(
            seed,
            0,
            hardExclusions,
            similarPool,
            artistTracks,
            settings,
            settings.initialQueueSize,
            history.uris,
            [],
            [],
            strictPlanningOptions
          ),
          seed.uri,
          history
        )
        if (expanded.length > selected.length) selected = expanded
      }
    }
    if (selected.length === 0) {
      const relaxedOptions = createLiveBatchPlanningOptions(
        history.uris,
        seed.uri,
        [seed.uri],
        history.canonicalKeys,
        history,
        exposureMultipliers
      )
      selected = buildTrackBatch(
        seed,
        0,
        [seed.uri],
        similarPool,
        artistTracks,
        settings,
        settings.initialQueueSize,
        history.uris,
        [],
        [],
        relaxedOptions
      )
    }
    prepared = {
      ...base,
      mode: "artist",
      artistTracks,
      similarPool,
      profilePool: artistTracks,
      selected,
    }
  } else {
    let [similarPool, rawProfilePool, history] = await Promise.all([
      fetchSimilarPool(seed, settings),
      withForegroundDeadline(fetchProfilePool(seed), []),
      collectRecentHistorySnapshot({ includeSpotifyRecent: true }),
    ])

    const artistCounts = new Map<string, number>()
    const artistKeysByNorm = new Map<string, string[]>()
    for (const track of rawProfilePool) {
      const tokens: string[] = []
      if (track.artistUri) tokens.push(track.artistUri.trim().toLowerCase())
      if (track.artistName) {
        const norm = track.artistName.trim().toLowerCase().replace(/\s+/g, " ")
        tokens.push(`name:${norm}`)
        tokens.push(norm)
      }
      const primary = tokens[0]
      if (primary) {
        artistCounts.set(primary, (artistCounts.get(primary) ?? 0) + 1)
        artistKeysByNorm.set(primary, tokens)
      }
    }
    const derivedHabitual: string[] = []
    for (const [primary, count] of artistCounts.entries()) {
      if (count >= 2) {
        const tokens = artistKeysByNorm.get(primary) ?? [primary]
        derivedHabitual.push(...tokens)
      }
    }
    if (derivedHabitual.length > 0) {
      history = {
        ...history,
        habitualArtistKeys: [
          ...new Set([...(history.habitualArtistKeys ?? []), ...derivedHabitual]),
        ],
      }
    }

    let profilePool = filterProfilePoolForSeedCoherence(rawProfilePool, seed, similarPool)
    if (similarPool.length === 0 && profilePool.length === 0) {
      throw new Error("No playable matches were found for this track")
    }
    const exposureMultipliers = (
      sessionManager as unknown as {
        getExposureMultipliers?: (c: readonly TrackCandidate[]) => Map<string, number>
      }
    ).getExposureMultipliers?.([...similarPool, ...profilePool])
    const strictPlanningOptions = createLiveBatchPlanningOptions(
      history.uris,
      seed.uri,
      [seed.uri],
      history.canonicalKeys,
      history,
      exposureMultipliers
    )
    const hardExclusions = [...new Set([seed.uri, ...history.uris])]
    const buildStrict = (currentSimilar: TrackCandidate[], currentProfile: TrackCandidate[]) =>
      filterOutPreviouslyPlayed(
        buildTrackBatch(
          seed,
          0,
          hardExclusions,
          currentSimilar,
          currentProfile,
          settings,
          settings.initialQueueSize,
          [...history.uris, ...currentProfile.map((candidate) => candidate.uri)],
          [],
          [],
          strictPlanningOptions
        ),
        seed.uri,
        history
      )

    let selected = buildStrict(similarPool, profilePool)
    if (selected.length < Math.min(15, settings.initialQueueSize) && history.uris.length > 0) {
      const deepSimilar = await fetchSimilarPool(seed, settings, { deepDiscovery: true })
      if (deepSimilar.length > 0) {
        similarPool = mergeCandidatesWithProvenance([...similarPool, ...deepSimilar])
        profilePool = filterProfilePoolForSeedCoherence(rawProfilePool, seed, similarPool)
        const expanded = buildStrict(similarPool, profilePool)
        if (expanded.length > selected.length) selected = expanded
      }
    }
    if (selected.length === 0) {
      const relaxedOptions = createLiveBatchPlanningOptions(
        history.uris,
        seed.uri,
        [seed.uri],
        history.canonicalKeys,
        history,
        exposureMultipliers
      )
      selected = buildTrackBatch(
        seed,
        0,
        [seed.uri],
        similarPool,
        profilePool,
        settings,
        settings.initialQueueSize,
        [...history.uris, ...profilePool.map((candidate) => candidate.uri)],
        [],
        [],
        relaxedOptions
      )
    }
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
  const previousPlayedUris =
    sessionManager.isActive() && sessionManager.getSeed()?.uri === prepared.seed.uri
      ? sessionManager.getPlayedUris()
      : []
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
  if (previousPlayedUris.length > 0) {
    sessionManager.restorePlayedUris(previousPlayedUris)
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
  const generation = options.buildOnly ? null : liveMixCoordinator.begin()
  const isSwitchingToDifferentSeed =
    !options.buildOnly &&
    Boolean(
      options.playSeed || (sessionManager.isActive() && sessionManager.getSeed()?.uri !== seedUri)
    )
  const existingSeed =
    !isSwitchingToDifferentSeed &&
    sessionManager.isActive() &&
    sessionManager.getSeed()?.uri === seedUri &&
    sessionManager.getSeed()?.trackName
      ? sessionManager.getSeed()
      : null
  if (isSwitchingToDifferentSeed) {
    disableAutoplayGuard()
    sessionManager.endSession()
    clearSimilarMixRecovery()
    invalidatePrefetch()
  }
  const [, seed] = await Promise.all([
    sessionManager.ensureTasteIdentity(),
    existingSeed ? Promise.resolve(existingSeed) : fetchSeedMetadata(seedUri),
    isSwitchingToDifferentSeed && generation != null
      ? queueMutationCoordinator
          .run(async () => {
            if (!liveMixCoordinator.isCurrent(generation)) return false
            return await clearUpcomingQueue()
          })
          .catch(() => false)
      : Promise.resolve(false),
  ])
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
    const usedNewMixTakeover = Boolean((options.replaceUpcoming && currentUri) || options.playSeed)
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
    if (!usedNewMixTakeover) {
      await detachFromPlaylistContext(seed.albumUri)
    }
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
  const currentUri = Spicetify.Player.data?.item?.uri
  if (!currentUri) {
    throw new Error("Play a song first, then enable Shuffle Similar")
  }

  // Enabling from the playbar builds a Similar Mix for the currently playing song itself
  // (rather than throwing away the seed to shuffle an entire surrounding playlist/album).
  // Refreshing an active session stays anchored to the original seed song clicked on.
  const activeSeedUri = sessionManager.isActive() ? sessionManager.getSeed()?.uri : null
  const activeContextUri = sessionManager.isActive() ? sessionManager.getContextUri() : null
  await startShuffleSimilar(activeSeedUri ?? currentUri, activeContextUri, {
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
  const isInterstitial =
    uri === "spotify:delimiter" ||
    uri.startsWith("spotify:ad:") ||
    uri.startsWith("spotify:interstitial:")
  if (!sessionManager.ownsQueueTrack(uri) && !isInterstitial) {
    const hasOwnedTracksAhead = getUpcomingQueueUris().some((queuedUri) =>
      sessionManager.ownsQueueTrack(queuedUri)
    )
    if (hasOwnedTracksAhead && isUserQueuedDetourTrack(uri)) {
      const item = Spicetify.Player.data?.item
      sessionManager.rememberPlayedTrack({
        uri,
        trackName: item?.name || item?.metadata?.title || undefined,
        artistUri: item?.artists?.[0]?.uri || item?.metadata?.artist_uri || undefined,
        artistName: item?.artists?.[0]?.name || item?.metadata?.artist_name || undefined,
      })
      const detourObservation = sessionManager.observeExternalQueuedTrack(uri)
      if (detourObservation.type === "early-skip") {
        invalidatePrefetch()
        await rerankUpcomingAfterFeedback().catch(() => false)
      }
      await refillQueueIfNeeded()
      void prefetchNextBatch()
      return "active"
    }

    sessionManager.transitionToTrack(uri)
    liveMixCoordinator.begin()
    disableAutoplayGuard()
    sessionManager.endSession()
    clearSimilarMixRecovery()
    invalidatePrefetch()
    await queueMutationCoordinator.run(() => clearUpcomingQueue()).catch(() => false)
    return "stopped"
  }

  const observation = sessionManager.transitionToTrack(uri)
  if (observation.type === "manual-context-exit") {
    liveMixCoordinator.begin()
    disableAutoplayGuard()
    sessionManager.endSession()
    clearSimilarMixRecovery()
    invalidatePrefetch()
    await queueMutationCoordinator.run(() => clearUpcomingQueue()).catch(() => false)
    return "stopped"
  }
  sessionManager.recordTrackPlayed(uri)
  persistActiveSession()
  if (observation.type === "early-skip") {
    invalidatePrefetch()
    await rerankUpcomingAfterFeedback().catch(() => false)
  }
  await refillQueueIfNeeded()
  void prefetchNextBatch()
  return "active"
}

// Public API that moved to focused modules; importers keep using ./shuffleEngine.
export { handlePlaybackFailure, teachSimilarMixPreference } from "./playbackRecovery"
export { refillQueueIfNeeded, rerankUpcomingAfterFeedback } from "./refill"
export { clearSimilarMixRecovery } from "./sessionState"
