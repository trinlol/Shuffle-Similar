import { fisherYatesShuffle } from "../algorithm/shuffle"
import type { TrackCandidate } from "../session/types"

type PlaybackContext = {
  uri: string
  url: string
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const QUEUE_OPERATION_TIMEOUT_MS = 5_000

export class QueueOperationTimeoutError extends Error {
  readonly code = "SERVICE_UNAVAILABLE"

  constructor(operation: string) {
    super(`Spotify did not finish ${operation} in time`)
    this.name = "QueueOperationTimeoutError"
  }
}

export const runQueueOperationWithTimeout = async <T>(
  operation: () => Promise<T> | T,
  label: string,
  timeoutMs = QUEUE_OPERATION_TIMEOUT_MS
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueOperationTimeoutError(label)), Math.max(1, timeoutMs))
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const isPlaylistContext = (uri?: string | null): boolean => {
  if (!uri) return false
  try {
    const { Type } = Spicetify.URI
    const type = Spicetify.URI.fromString(uri).type
    return type === Type.PLAYLIST || type === Type.PLAYLIST_V2
  } catch {
    return false
  }
}

export const isArtistContext = (uri?: string | null): boolean => {
  if (!uri) return false
  try {
    const { Type } = Spicetify.URI
    const type = Spicetify.URI.fromString(uri).type
    return type === Type.ARTIST
  } catch {
    return false
  }
}

export const isAlbumContext = (uri?: string | null): boolean => {
  if (!uri) return false
  try {
    const { Type } = Spicetify.URI
    const type = Spicetify.URI.fromString(uri).type
    return type === Type.ALBUM
  } catch {
    return false
  }
}

export const isValidPlaybackContext = (uri?: string | null): uri is string => {
  if (!uri) return false
  try {
    const { Type } = Spicetify.URI
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

/** Shuffle Similar must not keep playlist or artist context or Spotify injects tracks */
export const resolveShuffleSimilarPlaybackContext = (
  contextUri?: string | null,
  albumUri?: string | null
): PlaybackContext | null => {
  if (
    contextUri &&
    !isPlaylistContext(contextUri) &&
    !isArtistContext(contextUri) &&
    isValidPlaybackContext(contextUri)
  ) {
    return { uri: contextUri, url: `context://${contextUri}` }
  }

  if (albumUri) {
    try {
      const { Type } = Spicetify.URI
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
  if (!isPlaylistContext(currentContextUri) && !isArtistContext(currentContextUri)) return

  const fallback = resolveShuffleSimilarPlaybackContext(null, albumUri)
  if (!fallback) return

  try {
    const sessionId = Spicetify.Platform.PlayerAPI.getState().sessionId
    await runQueueOperationWithTimeout(
      () =>
        Spicetify.Platform.PlayerAPI.updateContext(sessionId, {
          uri: fallback.uri,
          url: fallback.url,
        }),
      "the playback context update"
    )
  } catch (error) {
    console.warn("[Shuffle Similar] Could not switch away from playlist context", error)
  }
}

const readQueueUri = (track: any): string | null => {
  const uri = track?.uri ?? track?.contextTrack?.uri
  return typeof uri === "string" ? uri : null
}

export const getRawUpcomingQueueUris = (): string[] => {
  try {
    const publicTracks = (Spicetify.Queue?.nextTracks ?? [])
      .map(readQueueUri)
      .filter((uri: string | null): uri is string => Boolean(uri))
      .filter((uri: string) => uri !== "spotify:delimiter")
    if (publicTracks.length > 0) return publicTracks

    // Compatibility fallback for Spotify builds where the public queue has
    // not hydrated yet. Private internals are never the primary contract.
    const queue = Spicetify.Platform.PlayerAPI._queue?._queueState
    if (!queue) return []

    const nextUp = (queue.nextUp ?? []).map((track: { uri: string }) => track.uri)
    const queued = (queue.queued ?? []).map((track: { uri: string }) => track.uri)
    return [...nextUp, ...queued].filter((uri) => uri !== "spotify:delimiter")
  } catch {
    return []
  }
}

export const getUpcomingQueueUris = (): string[] => [...new Set(getRawUpcomingQueueUris())]

export const getUpcomingCount = (): number => getUpcomingQueueUris().length

const disableNativeShuffle = () => {
  try {
    if (Spicetify.Player.getShuffle?.()) {
      Spicetify.Player.setShuffle(false)
    }
  } catch {
    // ignore
  }
}

const clearQueueSafe = async (): Promise<boolean> => {
  try {
    await runQueueOperationWithTimeout(
      () => Spicetify.Platform.PlayerAPI.clearQueue(),
      "the queue clear"
    )
    return true
  } catch (error) {
    if (error instanceof QueueOperationTimeoutError) throw error
    return false
  }
}

const addTracksSafe = async (uris: string[]) => {
  const items = uris.filter((uri) => uri.startsWith("spotify:track:")).map((uri) => ({ uri }))

  if (items.length === 0) return

  disableNativeShuffle()
  await runQueueOperationWithTimeout(
    () => Spicetify.Platform.PlayerAPI.addToQueue(items),
    "the queue add"
  )
}

export const replaceQueue = async (
  uris: string[],
  _options: { resetPrevTracks?: boolean } = {}
): Promise<void> => {
  const tracks = uris.filter((uri) => uri?.startsWith("spotify:track:"))
  if (tracks.length === 0) return

  if (!(await clearQueueSafe())) {
    throw new Error("Spotify could not clear the upcoming queue")
  }
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

  await runQueueOperationWithTimeout(
    () => Spicetify.Platform.PlayerAPI.play(track, context, {}),
    "playback"
  )
}

export const queueTracksAfterPlayback = async (queueUris: string[]): Promise<void> => {
  const tracks = queueUris.filter((uri) => uri.startsWith("spotify:track:"))
  if (tracks.length === 0) return

  await wait(400)
  await addTracksSafe(tracks)
}

export type QueueCommit = {
  requestedUris: string[]
  actualUris: string[]
  verified: boolean
}

/** A verified snapshot may contain only the hydration quorum; ownership stays
 * anchored to the complete requested queue, never that partial observation. */
export const getConfirmedQueueOwnership = (commit: QueueCommit): string[] =>
  commit.verified ? [...commit.requestedUris] : []

const readPrivateUpcomingQueueUris = (): string[] => {
  try {
    const queueState = Spicetify.Platform.PlayerAPI._queue?._queueState
    const entries = queueState?.nextTracks ?? []
    return entries
      .map(readQueueUri)
      .filter(
        (uri: unknown): uri is string => typeof uri === "string" && uri.startsWith("spotify:track:")
      )
  } catch {
    return []
  }
}

export const queuePrefixMatches = (expected: string[], actual: string[], limit = 8): boolean => {
  if (expected.length === 0) return actual.length === 0
  const requiredPrefixLength = Math.min(expected.length, Math.max(1, limit))
  if (actual.length < requiredPrefixLength) return false
  for (let index = 0; index < requiredPrefixLength; index += 1) {
    if (actual[index] !== expected[index]) return false
  }
  return true
}

export const queueSnapshotMatchesRequested = (
  expected: string[],
  actual: string[],
  limit = 8
): boolean => {
  if (!queuePrefixMatches(expected, actual, limit)) return false
  if (actual.length > expected.length) return false
  return actual.every((uri, index) => expected[index] === uri)
}

/** Spotify may append context/autoplay tracks after a manually queued mix.
 * They are harmless once the complete requested mix is visible in order;
 * foreign entries before that boundary still invalidate the takeover. */
export const queueTakeoverSnapshotMatches = (
  expected: string[],
  actual: string[],
  limit = 8
): boolean => {
  if (!queuePrefixMatches(expected, actual, limit)) return false

  const observedRequestedCount = Math.min(expected.length, actual.length)
  for (let index = 0; index < observedRequestedCount; index += 1) {
    if (actual[index] !== expected[index]) return false
  }

  return true
}

const waitForQueueConvergence = async (
  expected: string[],
  options: { strict?: boolean; stableReads?: number } = {}
): Promise<QueueCommit> => {
  const requestedUris = expected.filter((uri) => uri.startsWith("spotify:track:"))
  let actualUris = options.strict ? getRawUpcomingQueueUris() : getUpcomingQueueUris()
  if (requestedUris.length === 0) {
    return { requestedUris, actualUris, verified: actualUris.length === 0 }
  }

  const matches = options.strict
    ? (expectedUris: string[], actualUris: string[]) =>
        queueTakeoverSnapshotMatches(expectedUris, actualUris)
    : queuePrefixMatches
  const requiredStableReads = Math.max(1, options.stableReads ?? 1)
  const requestedSet = new Set(requestedUris)
  let stableReads = 0
  let previousSnapshot = ""
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const publicUris = (options.strict ? getRawUpcomingQueueUris() : getUpcomingQueueUris()).filter(
      (uri) => uri.startsWith("spotify:track:")
    )
    const privateUris = readPrivateUpcomingQueueUris()
    const comparable = publicUris.length > 0 ? publicUris : privateUris
    actualUris = comparable
    const publicMatches = publicUris.length === 0 || matches(requestedUris, publicUris)
    const privateSnapshotIsRelevant =
      publicUris.length < requestedUris.length && privateUris.some((uri) => requestedSet.has(uri))
    const privateMatches = !privateSnapshotIsRelevant || matches(requestedUris, privateUris)
    const converged = options.strict
      ? publicMatches && privateMatches && comparable.length > 0
      : matches(requestedUris, comparable)
    if (converged) {
      const snapshot = `${publicUris.join("\n")}\n--private--\n${privateUris.join("\n")}`
      stableReads = snapshot === previousSnapshot ? stableReads + 1 : 1
      previousSnapshot = snapshot
      if (stableReads >= requiredStableReads) {
        return { requestedUris, actualUris: comparable, verified: true }
      }
    } else {
      stableReads = 0
      previousSnapshot = ""
    }
    await wait(100)
  }

  return { requestedUris, actualUris, verified: false }
}

export const replaceUpcomingQueue = async (
  currentUri: string | null,
  upcomingUris: string[]
): Promise<QueueCommit> => {
  const tracks = upcomingUris
    .filter((uri) => uri.startsWith("spotify:track:"))
    .filter((uri) => !currentUri || uri !== currentUri)

  const previousUris = getUpcomingQueueUris().filter((uri) => uri.startsWith("spotify:track:"))

  if (tracks.length === 0) {
    if (!(await clearQueueSafe())) throw new Error("Spotify could not clear the upcoming queue")
    const commit = await waitForQueueConvergence([])
    if (!commit.verified && previousUris.length > 0) {
      await addTracksSafe(previousUris)
    }
    return commit
  }

  // Use the documented PlayerAPI queue contract for live playback. The
  // private `_queue._client.setQueue` shape is version-sensitive and accepts
  // internal ContextTrack records that can appear in Spotify's queue while
  // still failing when the player tries to resolve them.
  if (!(await clearQueueSafe())) {
    throw new Error("Spotify could not replace the upcoming queue")
  }
  try {
    await addTracksSafe(tracks)
  } catch (error) {
    if (previousUris.length > 0) {
      await addTracksSafe(previousUris).catch(() => undefined)
    }
    throw error
  }

  const commit = await waitForQueueConvergence(tracks)
  if (!commit.verified) {
    if (!(await clearQueueSafe())) {
      throw new Error("Spotify could not roll back an unconfirmed queue update")
    }
    if (previousUris.length > 0) await addTracksSafe(previousUris)
  }
  return commit
}

/** Starts a fresh Similar Mix without allowing the previous playlist or
 * artist context to repopulate Spotify's queue after it has been cleared. */
export const replaceUpcomingQueueForNewMix = async (
  currentUri: string,
  upcomingUris: string[],
  albumUri?: string | null
): Promise<QueueCommit> => {
  const tracks = [...new Set(upcomingUris)]
    .filter((uri) => uri.startsWith("spotify:track:"))
    .filter((uri) => uri !== currentUri)
  const previousUris = getRawUpcomingQueueUris().filter((uri) => uri.startsWith("spotify:track:"))

  let lastCommit: QueueCommit = { requestedUris: tracks, actualUris: [], verified: false }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await detachFromPlaylistContext(albumUri)
    if (!(await clearQueueSafe())) throw new Error("Spotify could not replace the upcoming queue")
    try {
      await addTracksSafe(tracks)
    } catch (error) {
      await clearQueueSafe().catch(() => false)
      if (previousUris.length > 0) await addTracksSafe(previousUris).catch(() => undefined)
      throw error
    }
    lastCommit = await waitForQueueConvergence(tracks, {
      strict: true,
      stableReads: 2,
    })
    if (lastCommit.verified) {
      await wait(250)
      const guardedSnapshot = getRawUpcomingQueueUris().filter((uri) =>
        uri.startsWith("spotify:track:")
      )
      if (queueTakeoverSnapshotMatches(tracks, guardedSnapshot)) {
        return { ...lastCommit, actualUris: guardedSnapshot }
      }
      lastCommit = { ...lastCommit, actualUris: guardedSnapshot, verified: false }
    }
  }

  if (!(await clearQueueSafe())) {
    throw new Error("Spotify could not roll back an unconfirmed fresh queue")
  }
  if (previousUris.length > 0) await addTracksSafe(previousUris)
  return lastCommit
}

export const playSeedAndQueue = async (
  seedUri: string,
  queueUris: string[],
  playbackContext?: PlaybackContext | null
): Promise<QueueCommit> => {
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

  return await replaceUpcomingQueueForNewMix(seedUri, upcoming)
}

export const shuffleUpcomingInPlace = async (): Promise<boolean> => {
  const currentUri = Spicetify.Player.data?.item?.uri ?? null
  const upcoming = getUpcomingQueueUris().filter((uri) => uri.startsWith("spotify:track:"))
  if (upcoming.length === 0) return false

  const shuffled = fisherYatesShuffle(upcoming)
  await replaceUpcomingQueue(currentUri, shuffled)
  return true
}
