import { buildTrackBatch, getBlendWeights } from "../algorithm/progressiveBlend"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata } from "../session/types"
import { fetchProfilePool } from "../sources/profileTracks"
import { fetchSimilarPool } from "../sources/similarTracks"
import { fetchSeedMetadata } from "../sources/trackMetadata"
import { loadSettings } from "../storage/settings"
import { detectForeignInjection, enableAutoplayGuard, syncKnownQueue } from "../queue/autoplayGuard"
import {
  appendTracksToQueue,
  getUpcomingCount,
  getUpcomingQueueUris,
  detachFromPlaylistContext,
  playSeedAndQueue,
  replaceUpcomingQueue,
  resolveBetterShufflePlaybackContext,
  shuffleUpcomingInPlace,
} from "../queue/queueManager"
import { filterPlayableUris } from "../utils/playability"
import { enforceNativeShuffleOff } from "../ui/nativeShuffleGuard"

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

const buildPlayableBatch = async (seed: SeedMetadata, forceRefreshPools: boolean) => {
  const { similar, profile, settings } = await ensurePools(seed, forceRefreshPools)

  if (similar.length === 0 && profile.length === 0) {
    throw new Error("Could not find tracks for Better Shuffle. Try another song.")
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
  const { similarWeight, profileWeight } = getBlendWeights(position, settings.blendPhases)
  const mode =
    similarWeight >= profileWeight
      ? `similar (${similarCount} sources)`
      : "your library"
  return `Better Shuffle: ${queueSize} queued · ${mode}`
}

export const startBetterShuffle = async (
  seedUri: string,
  contextUri?: string | null,
  options: StartOptions = {}
) => {
  const seed = await fetchSeedMetadata(seedUri)
  sessionManager.startSession(seed)
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
    const playbackContext = resolveBetterShufflePlaybackContext(contextUri, seed.albumUri)
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
  await startBetterShuffle(seedUri, contextUri, {
    forceRefreshPools: true,
    playSeed: true,
    replaceUpcoming: false,
  })
}

export const reshuffleFromCurrentTrack = async () => {
  const uri = Spicetify.Player.data?.item?.uri
  if (!uri) {
    throw new Error("Play a song first, then enable Better Shuffle")
  }

  const playerContextUri = Spicetify.Player.data?.context?.uri ?? null
  await startBetterShuffle(uri, playerContextUri, {
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
    console.error("[Better Shuffle] refill failed", error)
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
