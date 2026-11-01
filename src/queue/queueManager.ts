import { fisherYatesShuffle } from "../algorithm/shuffle"
import { createQueueError } from "../diagnostics/failureReasons"
import { recordOperation } from "../diagnostics/operationLog"
import type { TrackCandidate } from "../session/types"
import {
  type QueueSnapshot,
  queuedUris,
  readInternalQueueSnapshot,
  readQueueSnapshot,
  waitForQueue,
} from "./queueState"

type PlaybackContext = {
  uri: string
  url: string
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every queue timing in one place. Waits on Spotify state go through
 * `waitForQueue`, which resolves on `queue_update` before these limits. */
export const QUEUE_TIMING = {
  /** Upper bound for a clear to show up in Spotify's local snapshot. */
  clearSettleMs: 2_000,
  /** Upper bound for a single PlayerAPI call to resolve. */
  operationTimeoutMs: 5_000,
  /** Re-read after a verified takeover to catch late context injection. */
  postVerifyGuardMs: 250,
  /** Delay before queueing after starting playback. */
  afterPlayDelayMs: 400,
  /** Upper bound for the queue to match a requested mix. */
  convergenceTimeoutMs: 1_000,
  /** Fallback poll interval while waiting for convergence. */
  convergencePollMs: 100,
  /** Poll interval while waiting for the player to reach the seed track. */
  seedTransitionPollMs: 100,
} as const

export class QueueOperationTimeoutError extends Error {
  readonly code = "SERVICE_UNAVAILABLE"
  readonly reason = "queue_timeout"

  constructor(operation: string) {
    super(`Spotify did not finish ${operation} in time`)
    this.name = "QueueOperationTimeoutError"
  }
}

export const runQueueOperationWithTimeout = async <T>(
  operation: () => Promise<T> | T,
  label: string,
  timeoutMs: number = QUEUE_TIMING.operationTimeoutMs
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

/** Upcoming URIs in play order, as Spotify shows them (duplicates kept). */
export const getRawUpcomingQueueUris = (): string[] =>
  readQueueSnapshot().entries.map((entry) => entry.uri)

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

/** Spotify resolves `clearQueue()` before its local queue state reflects the
 * clear. A multi-track `addToQueue` issued in that window copies the stale
 * snapshot and writes the old queued tracks back ahead of the new mix. */
const waitForQueueClearToSettle = async (): Promise<boolean> =>
  (
    await waitForQueue((snapshot) => queuedUris(snapshot).length === 0, {
      timeoutMs: QUEUE_TIMING.clearSettleMs,
    })
  ).met

const clearQueueSafe = async (): Promise<boolean> => {
  const startedAt = Date.now()
  const queuedBefore = queuedUris().length
  try {
    const clear = () =>
      runQueueOperationWithTimeout(
        () => Spicetify.Platform.PlayerAPI.clearQueue(),
        "the queue clear"
      )
    await clear()

    // Settling is advisory. Spotify accepted the clear, so a snapshot that
    // lags or never updates must not turn it into a failure; the add and the
    // convergence check that follow still verify the real outcome.
    if (await waitForQueueClearToSettle()) {
      recordOperation({
        op: "queue.clear",
        outcome: "ok",
        durationMs: Date.now() - startedAt,
        counts: { queuedBefore },
      })
      return true
    }
    console.warn(
      "[Shuffle Similar] Queue still showed manually queued tracks after clear; retrying once"
    )
    await clear()
    const settled = await waitForQueueClearToSettle()
    if (!settled) {
      console.warn(
        "[Shuffle Similar] Queue snapshot did not reflect the clear; continuing to verification"
      )
    }
    recordOperation({
      op: "queue.clear",
      outcome: settled ? "retry" : "timeout",
      durationMs: Date.now() - startedAt,
      counts: { queuedBefore, queuedAfter: queuedUris().length },
      reason: settled ? "queue_clear_retried" : "queue_clear_unsettled",
    })
    return true
  } catch (error) {
    const timedOut = error instanceof QueueOperationTimeoutError
    recordOperation({
      op: "queue.clear",
      outcome: timedOut ? "timeout" : "failed",
      durationMs: Date.now() - startedAt,
      reason: timedOut ? "queue_timeout" : "queue_clear_failed",
    })
    if (timedOut) throw error
    return false
  }
}

const addTracksSafe = async (uris: string[]) => {
  const items = uris.filter((uri) => uri.startsWith("spotify:track:")).map((uri) => ({ uri }))

  if (items.length === 0) return

  disableNativeShuffle()
  const startedAt = Date.now()
  try {
    await runQueueOperationWithTimeout(
      () => Spicetify.Platform.PlayerAPI.addToQueue(items),
      "the queue add"
    )
    recordOperation({
      op: "queue.add",
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      counts: { tracks: items.length },
    })
  } catch (error) {
    const timedOut = error instanceof QueueOperationTimeoutError
    recordOperation({
      op: "queue.add",
      outcome: timedOut ? "timeout" : "failed",
      durationMs: Date.now() - startedAt,
      counts: { tracks: items.length },
      reason: timedOut ? "queue_timeout" : "queue_replace_failed",
    })
    throw error
  }
}

export const replaceQueue = async (
  uris: string[],
  _options: { resetPrevTracks?: boolean } = {}
): Promise<void> => {
  const tracks = uris.filter((uri) => uri?.startsWith("spotify:track:"))
  if (tracks.length === 0) return

  if (!(await clearQueueSafe())) {
    throw createQueueError("Spotify could not clear the upcoming queue", "queue_clear_failed")
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

  await wait(QUEUE_TIMING.afterPlayDelayMs)
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

const isTrackUri = (uri: string) => uri.startsWith("spotify:track:")

const snapshotTrackUris = (snapshot: QueueSnapshot, dedupe: boolean): string[] => {
  const uris = snapshot.entries.map((entry) => entry.uri).filter(isTrackUri)
  return dedupe ? [...new Set(uris)] : uris
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
  const requestedUris = expected.filter(isTrackUri)
  const dedupe = !options.strict
  if (requestedUris.length === 0) {
    const actualUris = options.strict ? getRawUpcomingQueueUris() : getUpcomingQueueUris()
    return { requestedUris, actualUris, verified: actualUris.length === 0 }
  }

  const matches = options.strict
    ? (expectedUris: string[], observedUris: string[]) =>
        queueTakeoverSnapshotMatches(expectedUris, observedUris)
    : queuePrefixMatches
  const requestedSet = new Set(requestedUris)
  // A snapshot counts as stable once it has held for (stableReads - 1) poll
  // intervals, matching the old fixed-interval loop whichever check fires.
  const stableForMs = (Math.max(1, options.stableReads ?? 1) - 1) * QUEUE_TIMING.convergencePollMs
  let actualUris: string[] = []
  let stableKey = ""
  let stableSince = 0

  const converged = (snapshot: QueueSnapshot): boolean => {
    const publicUris = snapshotTrackUris(snapshot, dedupe)
    const privateUris = snapshotTrackUris(readInternalQueueSnapshot(), false)
    const comparable = publicUris.length > 0 ? publicUris : privateUris
    actualUris = comparable
    const publicMatches = publicUris.length === 0 || matches(requestedUris, publicUris)
    const privateSnapshotIsRelevant =
      publicUris.length < requestedUris.length && privateUris.some((uri) => requestedSet.has(uri))
    const privateMatches = !privateSnapshotIsRelevant || matches(requestedUris, privateUris)
    const ok = options.strict
      ? publicMatches && privateMatches && comparable.length > 0
      : matches(requestedUris, comparable)
    if (!ok) {
      stableKey = ""
      return false
    }
    const key = `${publicUris.join("\n")}\n--private--\n${privateUris.join("\n")}`
    if (key !== stableKey) {
      stableKey = key
      stableSince = Date.now()
    }
    return Date.now() - stableSince >= stableForMs
  }

  const startedAt = Date.now()
  const { met } = await waitForQueue(converged, {
    timeoutMs: QUEUE_TIMING.convergenceTimeoutMs,
    pollMs: QUEUE_TIMING.convergencePollMs,
  })
  recordOperation({
    op: "queue.verify",
    outcome: met ? "ok" : "failed",
    durationMs: Date.now() - startedAt,
    counts: {
      requested: requestedUris.length,
      observed: actualUris.length,
      strict: options.strict ? 1 : 0,
    },
    reason: met ? undefined : "queue_not_confirmed",
  })
  return { requestedUris, actualUris, verified: met }
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
    if (!(await clearQueueSafe()))
      throw createQueueError("Spotify could not clear the upcoming queue", "queue_clear_failed")
    const commit = await waitForQueueConvergence([])
    if (!commit.verified && previousUris.length > 0) {
      await addTracksSafe(previousUris)
    }
    return commit
  }

  // Use the documented PlayerAPI queue contract for live playback. Spotify's
  // private setQueue path is version-sensitive and accepts internal records
  // that can appear in the queue while still failing to play.
  if (!(await clearQueueSafe())) {
    throw createQueueError("Spotify could not replace the upcoming queue", "queue_replace_failed")
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
      throw createQueueError(
        "Spotify could not roll back an unconfirmed queue update",
        "queue_replace_failed"
      )
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
    if (!(await clearQueueSafe()))
      throw createQueueError("Spotify could not replace the upcoming queue", "queue_replace_failed")
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
      await wait(QUEUE_TIMING.postVerifyGuardMs)
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
    throw createQueueError(
      "Spotify could not roll back an unconfirmed fresh queue",
      "queue_replace_failed"
    )
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
    await wait(QUEUE_TIMING.seedTransitionPollMs)
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
