import type { TrackCandidate } from "../session/types"
import { fisherYatesShuffle } from "../algorithm/shuffle"

type QueueTrack = {
  contextTrack: {
    uri: string
    uid: string
    metadata: {
      is_queued: string
    }
  }
  removed: unknown[]
  blocked: unknown[]
  provider: string
}

type PlaybackContext = {
  uri: string
  url: string
}

const { Type } = Spicetify.URI

const formatQueueTrack = (uri: string): QueueTrack => ({
  contextTrack: {
    uri,
    uid: "",
    metadata: {
      is_queued: "false",
    },
  },
  removed: [],
  blocked: [],
  provider: "context",
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const isPlaylistContext = (uri?: string | null): boolean => {
  if (!uri) return false
  try {
    const type = Spicetify.URI.fromString(uri).type
    return type === Type.PLAYLIST || type === Type.PLAYLIST_V2
  } catch {
    return false
  }
}

export const isValidPlaybackContext = (uri?: string | null): uri is string => {
  if (!uri) return false
  try {
    const type = Spicetify.URI.fromString(uri).type
    return (
      type === Type.PLAYLIST ||
      type === Type.PLAYLIST_V2 ||
      type === Type.ALBUM ||
      type === Type.ARTIST
    )
  } catch {
    return false
  }
}

export const resolvePlaybackContext = (
  contextUri?: string | null,
  albumUri?: string | null
): PlaybackContext | null => {
  if (isValidPlaybackContext(contextUri)) {
    return { uri: contextUri, url: `context://${contextUri}` }
  }
  if (isValidPlaybackContext(albumUri)) {
    return { uri: albumUri, url: `context://${albumUri}` }
  }
  return null
}

/** Better Shuffle must not keep playlist context or Spotify injects playlist tracks */
export const resolveBetterShufflePlaybackContext = (
  contextUri?: string | null,
  albumUri?: string | null
): PlaybackContext | null => {
  if (contextUri && !isPlaylistContext(contextUri) && isValidPlaybackContext(contextUri)) {
    return { uri: contextUri, url: `context://${contextUri}` }
  }

  if (albumUri) {
    try {
      const type = Spicetify.URI.fromString(albumUri).type
      if (type === Type.ALBUM) {
        return { uri: albumUri, url: `context://${albumUri}` }
      }
    } catch {
      // ignore
    }
  }

  return null
}

export const detachFromPlaylistContext = async (albumUri?: string | null) => {
  const currentContextUri = Spicetify.Player.data?.context?.uri
  if (!isPlaylistContext(currentContextUri)) return

  const fallback = resolveBetterShufflePlaybackContext(null, albumUri)
  if (!fallback) return

  try {
    const sessionId = Spicetify.Platform.PlayerAPI.getState().sessionId
    await Spicetify.Platform.PlayerAPI.updateContext(sessionId, {
      uri: fallback.uri,
      url: fallback.url,
    })
  } catch (error) {
    console.warn("[Better Shuffle] Could not switch away from playlist context", error)
  }
}

export const getUpcomingQueueUris = (): string[] => {
  try {
    const queue = Spicetify.Platform.PlayerAPI._queue?._queueState
    if (!queue) return []

    const nextUp = (queue.nextUp ?? []).map((track: { uri: string }) => track.uri)
    const queued = (queue.queued ?? []).map((track: { uri: string }) => track.uri)
    return [...new Set([...nextUp, ...queued])].filter((uri) => uri !== "spotify:delimiter")
  } catch {
    return []
  }
}

export const getUpcomingCount = (): number => getUpcomingQueueUris().length

const getQueueClient = () => {
  try {
    const playerQueue = Spicetify.Platform.PlayerAPI._queue
    if (!playerQueue?._client?.setQueue) return null
    return {
      client: playerQueue._client,
      prevTracks: playerQueue._queue?.prevTracks ?? [],
      queueRevision: Spicetify.Queue?.queueRevision ?? playerQueue._queue?.queueRevision,
    }
  } catch {
    return null
  }
}

const disableNativeShuffle = () => {
  try {
    if (Spicetify.Player.getShuffle?.()) {
      Spicetify.Player.setShuffle(false)
    }
  } catch {
    // ignore
  }
}

const clearQueueSafe = async () => {
  try {
    await Spicetify.Platform.PlayerAPI.clearQueue()
  } catch {
    // ignore
  }
}

const addTracksSafe = async (uris: string[]) => {
  const items = uris
    .filter((uri) => uri.startsWith("spotify:track:"))
    .map((uri) => ({ uri }))

  if (items.length === 0) return

  disableNativeShuffle()
  await Spicetify.Platform.PlayerAPI.addToQueue(items)
}

const setQueueSafe = async (uris: string[], resetPrevTracks = false): Promise<boolean> => {
  const tracks = uris.filter((uri) => uri?.startsWith("spotify:track:"))
  if (tracks.length === 0) return false

  const withDelimiter = [...tracks, "spotify:delimiter"]
  disableNativeShuffle()

  const queueClient = getQueueClient()
  if (!queueClient) return false

  try {
    queueClient.client.setQueue({
      nextTracks: withDelimiter.map(formatQueueTrack),
      prevTracks: resetPrevTracks ? [] : queueClient.prevTracks,
      queueRevision: Spicetify.Queue?.queueRevision ?? queueClient.queueRevision,
    })
    return true
  } catch (error) {
    console.warn("[Better Shuffle] setQueue failed", error)
    return false
  }
}

export const replaceQueue = async (
  uris: string[],
  options: { resetPrevTracks?: boolean } = {}
): Promise<void> => {
  const tracks = uris.filter((uri) => uri?.startsWith("spotify:track:"))
  if (tracks.length === 0) return

  const usedSetQueue = await setQueueSafe(tracks, options.resetPrevTracks ?? false)
  if (usedSetQueue) return

  await clearQueueSafe()
  await addTracksSafe(tracks)
}

export const appendTracksToQueue = async (candidates: TrackCandidate[]): Promise<void> => {
  const uris = candidates
    .map((candidate) => candidate.uri)
    .filter((uri) => uri.startsWith("spotify:track:"))

  await addTracksSafe(uris)
}

export const playTrack = async (
  seedUri: string,
  playbackContext?: PlaybackContext | null
): Promise<void> => {
  if (!seedUri.startsWith("spotify:track:")) {
    throw new Error("Invalid track URI")
  }

  const track = { uri: seedUri }
  const context = playbackContext ?? {}

  await Spicetify.Platform.PlayerAPI.play(track, context, {})
}

export const queueTracksAfterPlayback = async (queueUris: string[]): Promise<void> => {
  const tracks = queueUris.filter((uri) => uri.startsWith("spotify:track:"))
  if (tracks.length === 0) return

  await wait(400)
  await addTracksSafe(tracks)
}

export const replaceUpcomingQueue = async (currentUri: string | null, upcomingUris: string[]): Promise<void> => {
  await clearQueueSafe()

  const tracks = upcomingUris
    .filter((uri) => uri.startsWith("spotify:track:"))
    .filter((uri) => !currentUri || uri !== currentUri)

  if (tracks.length === 0) return

  const usedSetQueue = await setQueueSafe(tracks, false)
  if (usedSetQueue) return

  await addTracksSafe(tracks)
}

export const playSeedAndQueue = async (
  seedUri: string,
  queueUris: string[],
  playbackContext?: PlaybackContext | null
): Promise<void> => {
  const upcoming = queueUris.filter((uri) => uri !== seedUri && uri.startsWith("spotify:track:"))

  // Always play the seed — this is the context-menu path where the user
  // explicitly chose a song to start from.
  await playTrack(seedUri, playbackContext)

  // Wait for the player to transition to the seed track.
  // This ensures that Spotify's playback initialization is complete
  // before we replace the upcoming queue, preventing the queue from being wiped out.
  let attempts = 0
  while (Spicetify.Player.data?.item?.uri !== seedUri && attempts < 15) {
    await wait(100)
    attempts++
  }

  await replaceUpcomingQueue(seedUri, upcoming)
}


export const shuffleUpcomingInPlace = async (): Promise<boolean> => {
  const currentUri = Spicetify.Player.data?.item?.uri ?? null
  const upcoming = getUpcomingQueueUris().filter((uri) => uri.startsWith("spotify:track:"))
  if (upcoming.length === 0) return false

  const shuffled = fisherYatesShuffle(upcoming)
  await replaceUpcomingQueue(currentUri, shuffled)
  return true
}

