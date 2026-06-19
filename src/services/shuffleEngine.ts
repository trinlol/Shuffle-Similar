import { buildTrackBatch, getBlendWeights, buildSinglePoolBatch } from "../algorithm/progressiveBlend"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { fetchProfilePool, fetchAllPlaylistTracks, fetchTopTracks } from "../sources/profileTracks"
import { fetchSimilarPool, fetchPlaylistRecommendations, fetchPlaylistSimilarPool } from "../sources/similarTracks"
import { fetchSeedMetadata } from "../sources/trackMetadata"
import { loadSettings, loadPlayHistory } from "../storage/settings"
import { detectForeignInjection, enableAutoplayGuard, syncKnownQueue } from "../queue/autoplayGuard"
import {
  appendTracksToQueue,
  getUpcomingCount,
  getUpcomingQueueUris,
  detachFromPlaylistContext,
  playSeedAndQueue,
  replaceUpcomingQueue,
  resolveShuffleSimilarPlaybackContext,
  shuffleUpcomingInPlace,
  isPlaylistContext,
  isArtistContext,
  isAlbumContext,
} from "../queue/queueManager"
import { filterPlayableUris } from "../utils/playability"
import { enforceNativeShuffleOff } from "../ui/nativeShuffleGuard"
import { fisherYatesShuffle } from "../algorithm/shuffle"
import { getUriId } from "../utils/uri"
import { fetchArtistDiscographyTracks, fetchAlbumTracks } from "../sources/artistTracks"

type StartOptions = {
  forceRefreshPools?: boolean
  playSeed?: boolean
  replaceUpcoming?: boolean
}

const ensurePools = async (seed: SeedMetadata, forceRefresh = false) => {
  const settings = loadSettings()
  let similar = forceRefresh ? [] : sessionManager.getSimilarPool()
  let profile = forceRefresh ? [] : sessionManager.getProfilePool()

  if (similar.length === 0) {
    similar = await fetchSimilarPool(seed, settings)
  }
  if (profile.length === 0) {
    profile = await fetchProfilePool(seed)
  }

  sessionManager.setPools(similar, profile)
  return { similar, profile, settings }
}

const buildPlaylistPlayableBatch = async () => {
  const playlistTracks = sessionManager.getPlaylistTracks()
  if (playlistTracks.length === 0) {
    throw new Error("Playlist has no tracks.")
  }

  const settings = loadSettings()
  const mode = settings.playlistShuffleMode
  const playedUris = sessionManager.getPlayedUris()
  const queuedUris = sessionManager.getQueuedUris()
  const upcomingQueueUris = getUpcomingQueueUris()
  const excludeUris = [...new Set([...playedUris, ...queuedUris, ...upcomingQueueUris])]

  let batch: TrackCandidate[] = []

  if (mode === "strict") {
    batch = buildSinglePoolBatch(
      sessionManager.getSeed(),
      playlistTracks,
      excludeUris,
      settings,
      settings.initialQueueSize
    )
  } else if (mode === "similar") {
    // Use the full multi-strategy approach: radio, inspired-by, genre/era,
    // related artists, album peers — not just the deprecated /v1/recommendations
    const similarPool = await fetchPlaylistSimilarPool(playlistTracks, settings, 3)

    batch = buildSinglePoolBatch(
      sessionManager.getSeed(),
      similarPool,
      excludeUris,
      settings,
      settings.initialQueueSize
    )

    // If the full strategy still came up short, try with more seeds
    if (batch.length < settings.initialQueueSize / 2 && playlistTracks.length > 3) {
      const extraPool = await fetchPlaylistSimilarPool(playlistTracks, settings, 5)
      const extraExclude = [...excludeUris, ...batch.map((t) => t.uri)]
      const extra = buildSinglePoolBatch(
        sessionManager.getSeed(),
        extraPool,
        extraExclude,
        settings,
        settings.initialQueueSize - batch.length
      )
      batch.push(...extra)
    }
  } else {
    // blend mode: mix playlist tracks with similar tracks
    const similarPool = await fetchPlaylistSimilarPool(playlistTracks, settings, 3)

    batch = buildTrackBatch(
      sessionManager.getSeed()!,
      sessionManager.getPosition(),
      excludeUris,
      similarPool,
      playlistTracks,
      settings,
      settings.initialQueueSize
    )
  }

  // Last-resort fallback: only use playlist tracks if nothing else worked,
  // and warn the user that we couldn't find similar tracks
  if (batch.length === 0) {
    if (mode === "similar") {
      console.warn("[Shuffle Similar] No similar tracks found, falling back to playlist tracks")
      Spicetify.showNotification("Could not find similar tracks — shuffling playlist instead", true)
    }
    batch = buildSinglePoolBatch(
      sessionManager.getSeed(),
      playlistTracks,
      excludeUris,
      settings,
      settings.initialQueueSize
    )
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found. Adjust your playlist or settings.")
  }

  const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri))
  const queueUris = playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri)

  return { playableQueueUris: queueUris, settings, similarCount: playlistTracks.length, profileCount: 0 }
}

const buildArtistPlayableBatch = async () => {
  const artistTracks = sessionManager.getArtistTracks()
  if (artistTracks.length === 0) {
    throw new Error("Artist has no tracks.")
  }

  const settings = loadSettings()
  const mode = settings.artistShuffleMode
  const seed = sessionManager.getSeed()!
  const playedUris = sessionManager.getPlayedUris()
  const queuedUris = sessionManager.getQueuedUris()
  const upcomingQueueUris = getUpcomingQueueUris()
  const excludeUris = [...new Set([...playedUris, ...queuedUris, ...upcomingQueueUris])]

  let batch: TrackCandidate[] = []

  if (mode === "strict") {
    batch = buildSinglePoolBatch(
      seed,
      artistTracks,
      excludeUris,
      settings,
      settings.initialQueueSize
    )
  } else {
    const similarTracks = await fetchSimilarPool(seed, settings)

    if (mode === "similar") {
      batch = buildSinglePoolBatch(
        seed,
        similarTracks,
        excludeUris,
        settings,
        settings.initialQueueSize
      )
    } else {
      // blend
      batch = buildTrackBatch(
        seed,
        sessionManager.getPosition(),
        excludeUris,
        similarTracks,
        artistTracks,
        settings,
        settings.initialQueueSize
      )
    }
  }

  // Graceful fallback if batch is empty
  if (batch.length === 0) {
    batch = buildSinglePoolBatch(
      seed,
      artistTracks,
      excludeUris,
      settings,
      settings.initialQueueSize
    )
  }

  if (batch.length === 0) {
    throw new Error("No suitable tracks found. Adjust your settings.")
  }

  const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri))
  const queueUris = playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri)

  return { playableQueueUris: queueUris, settings, similarCount: artistTracks.length, profileCount: 0 }
}

const buildPlayableBatch = async (seed: SeedMetadata, forceRefreshPools: boolean) => {
  if (sessionManager.isPlaylistSession()) {
    return await buildPlaylistPlayableBatch()
  }
  if (sessionManager.isArtistSession()) {
    return await buildArtistPlayableBatch()
  }

  const { similar, profile, settings } = await ensurePools(seed, forceRefreshPools)

  if (similar.length === 0 && profile.length === 0) {
    throw new Error("Could not find tracks for Shuffle Similar. Try another song.")
  }

  const excludeUris = [
    ...new Set([
      ...sessionManager.getPlayedUris(),
      ...sessionManager.getQueuedUris(),
      ...getUpcomingQueueUris(),
    ]),
  ]

  const batch = buildTrackBatch(
    seed,
    sessionManager.getPosition(),
    excludeUris,
    similar,
    profile,
    settings,
    settings.initialQueueSize
  )

  if (batch.length === 0) {
    throw new Error("No suitable tracks found. Try again or adjust settings.")
  }

  const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri))
  const queueUris =
    playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri)

  if (queueUris.length === 0) {
    throw new Error("Could not build a shuffle queue. Try another song.")
  }

  return { playableQueueUris: queueUris, settings, similarCount: similar.length, profileCount: profile.length }
}

const formatSuccessMessage = (
  queueSize: number,
  position: number,
  settings: ReturnType<typeof loadSettings>,
  similarCount: number
) => {
  if (sessionManager.isPlaylistSession()) {
    const mode = settings.playlistShuffleMode
    const desc =
      mode === "strict" ? "playlist tracks" : mode === "blend" ? "playlist blend" : "similar to playlist"
    return `Shuffle Similar: ${queueSize} queued · ${desc}`
  }
  if (sessionManager.isArtistSession()) {
    const mode = settings.artistShuffleMode
    const desc =
      mode === "strict" ? "artist discography" : mode === "blend" ? "artist blend" : "similar to artist"
    return `Shuffle Similar: ${queueSize} queued · ${desc}`
  }
  const { similarWeight, profileWeight } = getBlendWeights(position, settings)
  const mode =
    similarWeight >= profileWeight
      ? `similar (${similarCount} sources)`
      : "your library"
  return `Shuffle Similar: ${queueSize} queued · ${mode}`
}

export const startShuffleSimilar = async (
  seedUri: string,
  contextUri?: string | null,
  options: StartOptions = {}
) => {
  const seed = await fetchSeedMetadata(seedUri)
  if (contextUri && isPlaylistContext(contextUri)) {
    const playlistTracks = await fetchAllPlaylistTracks(contextUri)
    const topTracks = await fetchTopTracks()
    sessionManager.startPlaylistSession(seed, contextUri, playlistTracks, topTracks)
  } else if (contextUri && isAlbumContext(contextUri)) {
    const albumTracks = await fetchAlbumTracks(contextUri)
    sessionManager.startPlaylistSession(seed, contextUri, albumTracks, [])
  } else if (contextUri && isArtistContext(contextUri)) {
    const artistTracks = await fetchArtistDiscographyTracks(contextUri)
    sessionManager.startArtistSession(seed, contextUri, artistTracks)
  } else {
    sessionManager.startSession(seed)
  }
  enableAutoplayGuard()
  enforceNativeShuffleOff()

  const { playableQueueUris, settings, similarCount } = await buildPlayableBatch(
    seed,
    options.forceRefreshPools ?? true
  )

  const currentUri = Spicetify.Player.data?.item?.uri

  if (options.replaceUpcoming && currentUri) {
    // Toggle-enable path: keep the currently playing track untouched,
    // only replace the upcoming queue.  Exclude both the current track
    // and the seed (which is the current track) from the queue.
    const upcoming = playableQueueUris.filter(
      (uri) => uri !== currentUri && uri !== seed.uri
    )
    sessionManager.setQueuedUris(upcoming)
    syncKnownQueue(upcoming)
    await replaceUpcomingQueue(currentUri, upcoming)
  } else if (options.playSeed) {
    // Context-menu path: always play the seed track first, then queue
    // the rest.  Ensure the seed is never duplicated in the queue.
    const upcoming = playableQueueUris.filter((uri) => uri !== seed.uri)
    sessionManager.setQueuedUris(upcoming)
    syncKnownQueue(upcoming)
    const playbackContext = resolveShuffleSimilarPlaybackContext(contextUri, seed.albumUri)
    await playSeedAndQueue(seed.uri, upcoming, playbackContext)
  } else {
    // Fallback: replace upcoming without touching playback
    const upcoming = playableQueueUris.filter(
      (uri) => uri !== currentUri && uri !== seed.uri
    )
    sessionManager.setQueuedUris(upcoming)
    syncKnownQueue(upcoming)
    await replaceUpcomingQueue(currentUri ?? seed.uri, upcoming)
  }

  await detachFromPlaylistContext(seed.albumUri)

  sessionManager.setToggleEnabled(true)

  Spicetify.showNotification(
    formatSuccessMessage(playableQueueUris.length, sessionManager.getPosition(), settings, similarCount)
  )
}

export const startFromContextMenu = async (seedUri: string, contextUri?: string | null) => {
  await startShuffleSimilar(seedUri, contextUri, {
    forceRefreshPools: true,
    playSeed: true,
    replaceUpcoming: false,
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
  const shuffled = await shuffleUpcomingInPlace()
  if (!shuffled) return
  Spicetify.showNotification("Queue reshuffled")
}

export const refillQueueIfNeeded = async () => {
  if (!sessionManager.isActive() || sessionManager.isRefilling()) return

  const settings = loadSettings()
  const upcoming = getUpcomingCount()
  if (upcoming >= settings.refillThreshold) return

  const seed = sessionManager.getSeed()
  if (!seed) return

  sessionManager.setRefilling(true)
  try {
    const foreign = detectForeignInjection()
    if (foreign.length > 0) {
      const cleaned = getUpcomingQueueUris().filter((uri) => sessionManager.ownsQueueTrack(uri))
      const current = Spicetify.Player.data?.item?.uri
      await replaceUpcomingQueue(current, cleaned)
    }

    const { playableQueueUris } = await buildPlayableBatch(seed, false)
    const alreadyQueued = new Set(getUpcomingQueueUris())
    const batchUris = playableQueueUris
      .filter((uri) => !alreadyQueued.has(uri))
      .slice(0, settings.initialQueueSize)
    if (batchUris.length === 0) return

    await appendTracksToQueue(batchUris.map((uri) => ({ uri })))
    const merged = [...getUpcomingQueueUris(), ...batchUris]
    sessionManager.setQueuedUris(merged)
    syncKnownQueue(merged)
  } catch (error) {
    console.error("[Shuffle Similar] refill failed", error)
  } finally {
    sessionManager.setRefilling(false)
  }
}

export const handleSongChange = async () => {
  const uri = Spicetify.Player.data?.item?.uri
  if (!uri) return

  if (!sessionManager.isToggleEnabled() || !sessionManager.isActive()) return

  enforceNativeShuffleOff()
  sessionManager.recordTrackPlayed(uri)
  await refillQueueIfNeeded()
}
