import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SeedMetadata } from "../session/types"

/**
 * Behavioural coverage for the queue orchestrator.
 *
 * `shuffleEngine` coordinates the session, the queue, and Spotify. Its network
 * and pool-building collaborators are mocked so the assertions target the
 * orchestration rules that regressed historically: ownership accounting after a
 * refill, the refill threshold, session teardown on a manual context exit, and
 * neutral recovery from an unplayable owned track.
 */

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed",
  genres: [],
}

const candidate = (id: string) => ({
  uri: `spotify:track:${id}`,
  artistUri: `spotify:artist:${id}`,
})

/** Pool the mocked planner draws from; each test sets the batch it wants. */
let plannedBatch: ReturnType<typeof candidate>[] = []

const appendToQueue = vi.fn(async (_tracks: { uri: string }[]) => undefined)
const replaceUpcoming = vi.fn(async (_current: string | null | undefined, uris: string[]) => ({
  requestedUris: uris,
  actualUris: uris,
  verified: true,
}))
let upcomingQueueUris: string[] = []

vi.mock("../algorithm/progressiveBlend", () => ({
  buildTrackBatch: () => plannedBatch,
  buildSinglePoolBatch: () => plannedBatch,
  buildPlaylistBatch: () => plannedBatch,
}))

vi.mock("../sources/similarTracks", () => ({
  fetchSimilarPool: async () => plannedBatch,
  fetchPlaylistSimilarPool: async () => plannedBatch,
  enrichPlaylistTracks: async (tracks: unknown[]) => tracks,
}))

vi.mock("../sources/profileTracks", () => ({
  fetchProfilePool: async () => [],
  fetchAllPlaylistTracks: async () => [],
  fetchTopTracks: async () => [],
}))

vi.mock("../sources/artistTracks", () => ({
  fetchArtistDiscographyTracks: async () => [],
  fetchAlbumTracks: async () => [],
}))

vi.mock("../sources/trackMetadata", () => ({
  fetchSeedMetadata: async (uri: string) => ({ ...seed, uri, trackId: uri.split(":").pop() }),
}))

// Playability is a network concern; treat every planned URI as playable.
vi.mock("../utils/playability", () => ({
  filterPlayableUris: async (uris: string[]) => uris,
  verifyQueuePlayability: async (uris: string[]) => ({ playableUris: uris, rejectedUris: [] }),
}))

vi.mock("../queue/queueManager", () => ({
  appendTracksToQueue: (tracks: { uri: string }[]) => appendToQueue(tracks),
  replaceUpcomingQueue: (current: string | null | undefined, uris: string[]) =>
    replaceUpcoming(current, uris),
  replaceUpcomingQueueForNewMix: (current: string | null | undefined, uris: string[]) =>
    replaceUpcoming(current, uris),
  getConfirmedQueueOwnership: (commit: { actualUris?: string[]; verified?: boolean }) =>
    commit?.verified ? (commit.actualUris ?? []) : [],
  getUpcomingCount: () => upcomingQueueUris.length,
  getUpcomingQueueUris: () => [...upcomingQueueUris],
  detachFromPlaylistContext: async () => undefined,
  playSeedAndQueue: async () => ({ requestedUris: [], actualUris: [], verified: true }),
  resolveShuffleSimilarPlaybackContext: async () => null,
  shuffleUpcomingInPlace: async () => true,
  isPlaylistContext: () => false,
  isArtistContext: () => false,
  isAlbumContext: () => false,
  queuePrefixMatches: () => true,
}))

import { sessionManager } from "../session/SessionManager"
import { handlePlaybackFailure, handleSongChange, refillQueueIfNeeded } from "./shuffleEngine"

const localStorage = new Map<string, string>()
const playerNext = vi.fn()
const showNotification = vi.fn()

/** Points Spicetify.Player at `uri` with the given playback progress. */
const setNowPlaying = (uri: string | null, progressMs = 0) => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    Player: {
      data: uri ? { item: { uri }, isPaused: false, isBuffering: false } : undefined,
      getProgress: () => progressMs,
      getDuration: () => 200_000,
      getShuffle: () => false,
      setShuffle: () => undefined,
      next: playerNext,
    },
    LocalStorage: {
      get: (key: string) => localStorage.get(key) ?? null,
      set: (key: string, value: string) => localStorage.set(key, value),
      remove: (key: string) => localStorage.delete(key),
      clear: () => localStorage.clear(),
    },
    showNotification,
  }
}

beforeEach(() => {
  plannedBatch = []
  upcomingQueueUris = []
  localStorage.clear()
  appendToQueue.mockClear()
  replaceUpcoming.mockClear()
  playerNext.mockClear()
  showNotification.mockClear()
  setNowPlaying(seed.uri)
})

afterEach(() => {
  sessionManager.endSession()
  sessionManager.setToggleEnabled(false)
  vi.unstubAllGlobals()
})

describe("refillQueueIfNeeded", () => {
  it("does nothing while the owned queue still meets the refill threshold", async () => {
    const owned = ["one", "two", "three", "four"].map((id) => candidate(id))
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates(owned)
    sessionManager.setQueuedUris(owned.map((track) => track.uri))
    upcomingQueueUris = owned.map((track) => track.uri)
    plannedBatch = [candidate("fresh")]

    await refillQueueIfNeeded()

    expect(appendToQueue).not.toHaveBeenCalled()
  })

  it("appends a fresh batch once the owned queue falls below the threshold", async () => {
    const remaining = candidate("last")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([remaining])
    sessionManager.setQueuedUris([remaining.uri])
    upcomingQueueUris = [remaining.uri]
    plannedBatch = [candidate("fresh-a"), candidate("fresh-b")]

    await refillQueueIfNeeded()

    expect(appendToQueue).toHaveBeenCalledTimes(1)
    expect(appendToQueue.mock.calls[0][0].map((track) => track.uri)).toEqual([
      "spotify:track:fresh-a",
      "spotify:track:fresh-b",
    ])
  })

  it("keeps the previously owned tracks when adopting the appended batch", async () => {
    const remaining = candidate("last")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([remaining])
    sessionManager.setQueuedUris([remaining.uri])
    upcomingQueueUris = [remaining.uri]
    plannedBatch = [candidate("fresh-a")]

    await refillQueueIfNeeded()

    // Ownership must extend the existing prefix, never replace it, or the
    // in-flight track stops being recognised as ours.
    expect(sessionManager.getQueuedUris()).toEqual([remaining.uri, "spotify:track:fresh-a"])
    expect(sessionManager.ownsQueueTrack(remaining.uri)).toBe(true)
    expect(sessionManager.ownsQueueTrack("spotify:track:fresh-a")).toBe(true)
  })

  it("never adopts a Spotify context track appended after the owned batch", async () => {
    const remaining = candidate("last")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([remaining])
    sessionManager.setQueuedUris([remaining.uri])
    upcomingQueueUris = [remaining.uri, "spotify:track:spotify-autoplay"]
    plannedBatch = [candidate("fresh-a")]

    await refillQueueIfNeeded()

    expect(sessionManager.ownsQueueTrack("spotify:track:spotify-autoplay")).toBe(false)
  })

  it("stays inert when no session is active", async () => {
    plannedBatch = [candidate("fresh")]

    await refillQueueIfNeeded()

    expect(appendToQueue).not.toHaveBeenCalled()
  })
})

describe("handleSongChange", () => {
  it("ignores playback while Similar Mix is off", async () => {
    setNowPlaying("spotify:track:unrelated")

    expect(await handleSongChange()).toBe("ignored")
  })

  it("advances the session when playback moves to an owned track", async () => {
    const [first, second] = [candidate("first"), candidate("second")]
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([first, second])
    sessionManager.setQueuedUris([first.uri, second.uri])
    upcomingQueueUris = [first.uri, second.uri]
    plannedBatch = [candidate("fresh")]
    setNowPlaying(first.uri)

    expect(await handleSongChange()).toBe("active")
    expect(sessionManager.getPosition()).toBe(1)
    expect(sessionManager.isActive()).toBe(true)
  })

  it("ends the session and clears recovery when the listener leaves the mix", async () => {
    const owned = candidate("owned")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([owned])
    sessionManager.setQueuedUris([owned.uri])
    setNowPlaying("spotify:track:foreign")

    expect(await handleSongChange()).toBe("stopped")
    expect(sessionManager.isActive()).toBe(false)
    expect(localStorage.get("shuffleSimilar:activeSession:v1")).toBeUndefined()
  })
})

describe("handlePlaybackFailure", () => {
  it("skips past an owned unplayable track without recording a dislike", async () => {
    const [failing, next] = [candidate("failing"), candidate("next")]
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([failing, next])
    sessionManager.setQueuedUris([failing.uri, next.uri])
    upcomingQueueUris = [next.uri]
    plannedBatch = [candidate("fresh")]
    setNowPlaying(failing.uri)

    expect(await handlePlaybackFailure(failing.uri)).toBe(true)
    expect(playerNext).toHaveBeenCalledTimes(1)
    expect(sessionManager.isQuarantined(failing.uri)).toBe(true)
    // An operational failure must never be read as taste feedback.
    expect(sessionManager.getSkipFeedback()).toEqual([])
  })

  it("leaves tracks it does not own alone", async () => {
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.setQueuedUris([candidate("owned").uri])
    setNowPlaying("spotify:track:foreign")

    expect(await handlePlaybackFailure("spotify:track:foreign")).toBe(false)
    expect(playerNext).not.toHaveBeenCalled()
  })

  it("reports failure instead of advancing when no owned replacement exists", async () => {
    const failing = candidate("failing")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([failing])
    sessionManager.setQueuedUris([failing.uri])
    upcomingQueueUris = []
    plannedBatch = []
    setNowPlaying(failing.uri)

    expect(await handlePlaybackFailure(failing.uri)).toBe(false)
    expect(playerNext).not.toHaveBeenCalled()
    expect(showNotification).toHaveBeenCalledWith(
      "Similar Mix could not recover this unavailable track",
      true
    )
  })
})
