import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SeedMetadata, TrackCandidate } from "../session/types"

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
let plannedBatch: TrackCandidate[] = []

const appendToQueue = vi.fn(async (_tracks: { uri: string }[]) => undefined)
const clearUpcoming = vi.fn(async () => {
  upcomingQueueUris = []
  return true
})
const replaceUpcoming = vi.fn(async (_current: string | null | undefined, uris: string[]) => ({
  requestedUris: uris,
  actualUris: uris,
  verified: true,
}))
const playSeedAndQueueMock = vi.fn(async (_seedUri: string, uris: string[]) => {
  upcomingQueueUris = [...uris]
  return {
    requestedUris: uris,
    actualUris: uris,
    verified: true,
  }
})
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
  fetchRecentlyPlayedTracks: async () => [],
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
  clearUpcomingQueue: () => clearUpcoming(),
  replaceUpcomingQueue: (current: string | null | undefined, uris: string[]) =>
    replaceUpcoming(current, uris),
  replaceUpcomingQueueForNewMix: (current: string | null | undefined, uris: string[]) =>
    replaceUpcoming(current, uris),
  getConfirmedQueueOwnership: (commit: { actualUris?: string[]; verified?: boolean }) =>
    commit?.verified ? (commit.actualUris ?? []) : [],
  getUpcomingCount: () => upcomingQueueUris.length,
  getUpcomingQueueUris: () => [...upcomingQueueUris],
  detachFromPlaylistContext: async () => undefined,
  playSeedAndQueue: (seedUri: string, uris: string[]) => playSeedAndQueueMock(seedUri, uris),
  resolveShuffleSimilarPlaybackContext: async () => null,
  shuffleUpcomingInPlace: async () => true,
  isPlaylistContext: () => false,
  isArtistContext: () => false,
  isAlbumContext: () => false,
  queuePrefixMatches: () => true,
}))

import { clearOperations, getOperations } from "../diagnostics/operationLog"
import { disableAutoplayGuard, enableAutoplayGuard, syncKnownQueue } from "../queue/autoplayGuard"
import { sessionManager } from "../session/SessionManager"
import { queueMutationCoordinator } from "./sessionState"
import {
  buildFromContextMenu,
  handlePlaybackFailure,
  handleSongChange,
  refillQueueIfNeeded,
  reshuffleFromCurrentTrack,
  startFromContextMenu,
} from "./shuffleEngine"

const localStorage = new Map<string, string>()
const playerNext = vi.fn()
const showNotification = vi.fn()

/** Points Spicetify.Player at `uri` with the given playback progress. */
const setNowPlaying = (
  uri: string | null,
  progressMs = 0,
  options: { provider?: string; contextUri?: string | null } = {}
) => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    Player: {
      data: uri
        ? {
            item: {
              uri,
              ...(options.provider
                ? {
                    provider: options.provider,
                    metadata: {
                      provider: options.provider,
                      is_queued: String(options.provider === "queue"),
                    },
                  }
                : {}),
            },
            ...(options.contextUri ? { context: { uri: options.contextUri } } : {}),
            isPaused: false,
            isBuffering: false,
          }
        : undefined,
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
  clearUpcoming.mockClear()
  replaceUpcoming.mockClear()
  playSeedAndQueueMock.mockClear()
  playerNext.mockClear()
  showNotification.mockClear()
  clearOperations()
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

  it("ends the session, clears recovery, and scraps the upcoming queue when the listener clicks a song not in the mix", async () => {
    const owned = candidate("owned")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([owned])
    sessionManager.setQueuedUris([owned.uri])
    upcomingQueueUris = [owned.uri]
    setNowPlaying("spotify:track:foreign")

    expect(await handleSongChange()).toBe("stopped")
    expect(sessionManager.isActive()).toBe(false)
    expect(clearUpcoming).toHaveBeenCalledTimes(1)
    expect(upcomingQueueUris).toEqual([])
    expect(localStorage.get("shuffleSimilar:activeSession:v1")).toBeUndefined()
  })

  it("scraps the upcoming queue even if the listener clicks a foreign song right after a detour track", async () => {
    const [ownedOne, ownedTwo] = [candidate("owned-1"), candidate("owned-2")]
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([ownedOne, ownedTwo])
    sessionManager.setQueuedUris([ownedOne.uri, ownedTwo.uri])
    upcomingQueueUris = [ownedOne.uri, ownedTwo.uri]

    // First, play an "Add to queue" detour track (kept in queue).
    setNowPlaying("spotify:track:detour-queued", 0, { provider: "queue" })
    expect(await handleSongChange()).toBe("active")
    expect(clearUpcoming).not.toHaveBeenCalled()

    // Next, click directly on a completely different song not in the queue (not provider="queue").
    setNowPlaying("spotify:track:clicked-outside-song", 0, { provider: "context" })
    expect(await handleSongChange()).toBe("stopped")
    expect(sessionManager.isActive()).toBe(false)
    expect(clearUpcoming).toHaveBeenCalledTimes(1)
    expect(upcomingQueueUris).toEqual([])
  })

  it("clears the previous session and queue when starting Play Similar Shuffle on a different song", async () => {
    const [oldOne, oldTwo] = [candidate("old-1"), candidate("old-2")]
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([oldOne, oldTwo])
    sessionManager.setQueuedUris([oldOne.uri, oldTwo.uri])
    upcomingQueueUris = [oldOne.uri, oldTwo.uri]

    setNowPlaying("spotify:track:new-seed")
    const runtime = (globalThis as unknown as { Spicetify: Record<string, unknown> }).Spicetify
    runtime.Platform = {
      PlayerAPI: {
        clearQueue: async () => undefined,
        addToQueue: async () => undefined,
        play: async () => undefined,
      },
    }
    const [newOne, newTwo] = [candidate("new-1"), candidate("new-2")]
    plannedBatch = [newOne, newTwo]

    await startFromContextMenu("spotify:track:new-seed")

    expect(clearUpcoming).toHaveBeenCalledTimes(1)
    expect(playSeedAndQueueMock).toHaveBeenCalledWith("spotify:track:new-seed", [
      newOne.uri,
      newTwo.uri,
    ])
    expect(sessionManager.isActive()).toBe(true)
    expect(sessionManager.getSeed()?.uri).toBe("spotify:track:new-seed")
    expect(sessionManager.getQueuedUris()).toEqual([newOne.uri, newTwo.uri])
  })

  it("allows a manually queued detour track without ending or hijacking the original seed mix", async () => {
    const gracieSeed: SeedMetadata = {
      uri: "spotify:track:gracie-here-you-come",
      trackId: "gracie-here-you-come",
      trackName: "Here You Come, There You Go",
      artistName: "Gracie Abrams",
      artistUri: "spotify:artist:gracie",
      genres: ["indie pop", "singer-songwriter"],
    }
    const [gracieNextOne, gracieNextTwo] = [
      candidate("gracie-similar-1"),
      candidate("gracie-similar-2"),
    ]
    sessionManager.startSession(gracieSeed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([gracieNextOne, gracieNextTwo])
    sessionManager.setQueuedUris([gracieNextOne.uri, gracieNextTwo.uri])
    upcomingQueueUris = [gracieNextOne.uri, gracieNextTwo.uri]
    plannedBatch = [candidate("gracie-refill-1"), candidate("gracie-refill-2")]

    // Listener clicked "Add to queue" on Pardyalone while listening to Gracie Abrams.
    const detourUri = "spotify:track:pardyalone-tattoos"
    setNowPlaying(detourUri, 0, { provider: "queue" })

    expect(await handleSongChange()).toBe("active")
    expect(sessionManager.isActive()).toBe(true)
    expect(sessionManager.getSeed()?.uri).toBe(gracieSeed.uri)
    expect(sessionManager.ownsQueueTrack(detourUri)).toBe(false)
    expect(sessionManager.getRecentPositiveAnchors().map((track) => track.uri)).not.toContain(
      detourUri
    )

    // After the detour song finishes, playback returns to the owned Gracie Abrams mix.
    sessionManager.recordProgress(190_000, 200_000)
    setNowPlaying(gracieNextOne.uri, 0, { provider: "queue" })
    upcomingQueueUris = [gracieNextTwo.uri]

    expect(await handleSongChange()).toBe("active")
    expect(sessionManager.getSeed()?.uri).toBe(gracieSeed.uri)
    expect(sessionManager.getPlayedUris()).toContain(gracieNextOne.uri)
    expect(sessionManager.getPlayedUris()).not.toContain(detourUri)
    expect(sessionManager.getRecentPositiveAnchors().map((track) => track.uri)).not.toContain(
      detourUri
    )
  })

  it("anchors playbar enablement to the clicked track even inside a playlist context and refreshes from the original seed", async () => {
    setNowPlaying("spotify:track:gracie-seed", 0, {
      contextUri: "spotify:playlist:big-mixed-playlist",
    })
    const runtime = (globalThis as unknown as { Spicetify: Record<string, unknown> }).Spicetify
    runtime.Platform = {
      PlayerAPI: {
        clearQueue: async () => undefined,
        addToQueue: async () => undefined,
        play: async () => undefined,
      },
    }
    plannedBatch = [candidate("gracie-a"), candidate("gracie-b")]

    await reshuffleFromCurrentTrack()

    expect(sessionManager.isActive()).toBe(true)
    expect(sessionManager.isPlaylistSession()).toBe(false)
    expect(sessionManager.getSeed()?.uri).toBe("spotify:track:gracie-seed")

    // Later in the session (or during a detour track), refreshing keeps the original seed.
    setNowPlaying("spotify:track:gracie-a", 45_000, {
      contextUri: "spotify:album:detached-album",
    })
    const refreshedRuntime = (globalThis as unknown as { Spicetify: Record<string, unknown> })
      .Spicetify
    refreshedRuntime.Platform = runtime.Platform
    plannedBatch = [candidate("gracie-c"), candidate("gracie-d")]

    await reshuffleFromCurrentTrack()

    expect(sessionManager.getSeed()?.uri).toBe("spotify:track:gracie-seed")
    expect(sessionManager.isPlaylistSession()).toBe(false)
  })

  it("never puts any previously played songs into a newly started queue across sessions, skips, or alternate deluxe URIs", async () => {
    // 1. User plays songs normally while Similar Mix is OFF:
    sessionManager.rememberPlayedTrack({
      uri: "spotify:track:passive-off-1",
      trackName: "Risk",
      artistUri: "spotify:artist:gracie",
      artistName: "Gracie Abrams",
    })

    // 2. Start Queue #1 and play/skip through 35 tracks (exceeding the old 25-track slice):
    const queueOnePlayed = Array.from({ length: 35 }, (_, i) => ({
      uri: `spotify:track:q1-played-${i}`,
      trackName: `Played Song ${i}`,
      artistUri: `spotify:artist:q1-artist-${i}`,
      artistName: `Played Artist ${i}`,
    }))
    const unplayedInQ1 = candidate("q1-never-reached")

    setNowPlaying("spotify:track:seed-one")
    const runtime = (globalThis as unknown as { Spicetify: Record<string, unknown> }).Spicetify
    runtime.Platform = {
      PlayerAPI: {
        clearQueue: async () => undefined,
        addToQueue: async () => undefined,
        play: async () => undefined,
      },
    }
    plannedBatch = [...queueOnePlayed, unplayedInQ1]
    await startFromContextMenu("spotify:track:seed-one")

    // Advance through all 35 tracks in Queue #1 (even quick <1s skips without confirmPlayback!):
    for (let i = 0; i < queueOnePlayed.length; i += 1) {
      upcomingQueueUris = [...queueOnePlayed.slice(i + 1).map((t) => t.uri), unplayedInQ1.uri]
      setNowPlaying(queueOnePlayed[i].uri, 300)
      ;(
        globalThis as unknown as {
          Spicetify: Record<string, unknown>
        }
      ).Spicetify.Platform = runtime.Platform
      await handleSongChange()
    }

    // End Queue #1 completely (e.g. user clicked a brand-new song outside the mix):
    sessionManager.endSession()
    expect(sessionManager.isActive()).toBe(false)

    // 3. Also simulate desktop Spotify previousItems & Queue.prevTracks holding another played song:
    setNowPlaying("spotify:track:seed-two")
    const nextRuntime = (
      globalThis as unknown as {
        Spicetify: {
          Player: { data: Record<string, unknown> }
          Queue?: unknown
          Platform?: unknown
        }
      }
    ).Spicetify
    nextRuntime.Platform = runtime.Platform
    nextRuntime.Player.data.previousItems = [
      {
        uri: "spotify:track:desktop-prev-1",
        name: "Blowing Smoke",
        artists: [{ uri: "spotify:artist:gracie", name: "Gracie Abrams" }],
      },
    ]
    nextRuntime.Queue = {
      prevTracks: [
        {
          contextTrack: {
            uri: "spotify:track:queue-prev-1",
            metadata: {
              title: "Tough Love",
              artist_uri: "spotify:artist:gracie",
              artist_name: "Gracie Abrams",
            },
          },
        },
      ],
    }

    // 4. Start brand-new Queue #2 where the pool contains ALL 35 played tracks from Queue #1,
    // Queue #1's seed, passive/desktop/queue previous tracks, alternate Deluxe/Remaster URIs of
    // played songs, and ONLY 6 genuinely unplayed songs (below the old <10 backfill threshold!):
    const freshSix = Array.from({ length: 6 }, (_, i) => ({
      uri: `spotify:track:brand-new-${i}`,
      trackName: `Brand New ${i}`,
      artistUri: `spotify:artist:new-${i}`,
      artistName: `New Artist ${i}`,
    }))
    plannedBatch = [
      { uri: "spotify:track:seed-one", artistUri: "spotify:artist:seed" },
      { uri: "spotify:track:passive-off-1", artistUri: "spotify:artist:gracie" },
      {
        uri: "spotify:track:risk-deluxe-reissue",
        trackName: "Risk (Deluxe)",
        artistUri: "spotify:artist:gracie",
        artistName: "Gracie Abrams",
      },
      {
        uri: "spotify:track:blowing-smoke-remaster",
        trackName: "Blowing Smoke - Single Version",
        artistName: "Gracie Abrams",
      },
      {
        uri: "spotify:track:tough-love-deluxe",
        trackName: "Tough Love (Deluxe Edition)",
        artistUri: "spotify:artist:gracie",
      },
      ...queueOnePlayed,
      ...freshSix,
    ]

    const built = await buildFromContextMenu("spotify:track:seed-two")

    // Strictly ONLY the 6 unplayed tracks are queued — zero previously played tracks or alternate URIs!
    expect(built.queueUris).toEqual(freshSix.map((track) => track.uri))
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

describe("operation log", () => {
  const ops = () =>
    getOperations().map(({ op, outcome, reason, counts }) => ({ op, outcome, reason, counts }))

  it("records a refill append with its track count", async () => {
    const remaining = candidate("last")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([remaining])
    sessionManager.setQueuedUris([remaining.uri])
    upcomingQueueUris = [remaining.uri]
    plannedBatch = [candidate("fresh-a"), candidate("fresh-b")]

    await refillQueueIfNeeded()

    expect(ops()).toContainEqual(
      expect.objectContaining({ op: "refill.append", outcome: "ok", counts: { tracks: 2 } })
    )
  })

  it("records a recovered playback failure", async () => {
    const [failing, next] = [candidate("failing"), candidate("next")]
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([failing, next])
    sessionManager.setQueuedUris([failing.uri, next.uri])
    upcomingQueueUris = [next.uri]
    setNowPlaying(failing.uri)

    await handlePlaybackFailure(failing.uri)

    expect(ops()).toContainEqual(
      expect.objectContaining({ op: "recovery.play_failure", outcome: "ok" })
    )
  })

  it("records a playback failure with no owned replacement", async () => {
    const failing = candidate("failing")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([failing])
    sessionManager.setQueuedUris([failing.uri])
    setNowPlaying(failing.uri)

    await handlePlaybackFailure(failing.uri)

    expect(ops()).toContainEqual(
      expect.objectContaining({
        op: "recovery.play_failure",
        outcome: "failed",
        reason: "recovery_no_replacement",
      })
    )
  })

  it("records a mix start that Spotify does not confirm", async () => {
    setNowPlaying(seed.uri)
    const runtime = (globalThis as unknown as { Spicetify: Record<string, unknown> }).Spicetify
    runtime.Platform = {
      PlayerAPI: {
        clearQueue: async () => undefined,
        addToQueue: async () => undefined,
        play: async () => undefined,
      },
    }
    plannedBatch = [candidate("mix-a"), candidate("mix-b")]
    replaceUpcoming.mockImplementationOnce(async (_current, uris) => ({
      requestedUris: uris,
      actualUris: [],
      verified: false,
    }))

    await expect(reshuffleFromCurrentTrack()).rejects.toMatchObject({
      reason: "queue_not_confirmed",
    })

    expect(ops()).toContainEqual(
      expect.objectContaining({ op: "mix.start", outcome: "failed", reason: "queue_not_confirmed" })
    )
  })
})

describe("foreign-track cleanup", () => {
  afterEach(() => {
    disableAutoplayGuard()
  })

  it("does not overwrite a newer mix that took the queue while the cleanup was waiting", async () => {
    const owned = candidate("owned")
    sessionManager.startSession(seed)
    sessionManager.setToggleEnabled(true)
    sessionManager.registerCandidates([owned])
    sessionManager.setQueuedUris([owned.uri])
    enableAutoplayGuard()
    syncKnownQueue([owned.uri])
    upcomingQueueUris = ["spotify:track:foreign", owned.uri]

    // Another queue mutation (e.g. a refresh starting a new mix) holds the lane.
    let release: (() => void) | undefined
    const busy = queueMutationCoordinator.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const refill = refillQueueIfNeeded()
    await Promise.resolve()
    // The newer mix commits and supersedes the session the refill read.
    sessionManager.invalidatePendingMutations()
    release?.()
    await busy
    await refill

    expect(replaceUpcoming).not.toHaveBeenCalled()
  })
})
