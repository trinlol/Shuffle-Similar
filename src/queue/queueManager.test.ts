import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendTracksToQueue,
  getConfirmedQueueOwnership,
  playTrack,
  queuePrefixMatches,
  queueSnapshotMatchesRequested,
  replaceUpcomingQueue,
  replaceUpcomingQueueForNewMix,
  replaceQueue,
} from "./queueManager"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const stubNeverSettlingPlayer = () => {
  const never = () => new Promise<never>(() => undefined)
  vi.stubGlobal("Spicetify", {
    Player: { getShuffle: () => false },
    Platform: {
      PlayerAPI: {
        clearQueue: never,
        addToQueue: never,
        play: never,
      },
    },
  })
}

const expectTimedOut = async (promise: Promise<unknown>) => {
  const assertion = expect(promise).rejects.toMatchObject({
    name: "QueueOperationTimeoutError",
    code: "SERVICE_UNAVAILABLE",
  })
  await vi.advanceTimersByTimeAsync(5_001)
  await assertion
}

describe("queuePrefixMatches", () => {
  it("requires the full short queue or an eight-track quorum for a long queue", () => {
    expect(queuePrefixMatches(["a", "b", "c"], ["a", "b"])).toBe(false)
    expect(queuePrefixMatches(["a", "b", "c"], ["a", "b", "c"])).toBe(true)
    const expected = Array.from({ length: 50 }, (_, index) => `track-${index}`)
    expect(queuePrefixMatches(expected, expected.slice(0, 1))).toBe(false)
    expect(queuePrefixMatches(expected, expected.slice(0, 8))).toBe(true)
  })

  it("rejects stale or empty queue snapshots", () => {
    expect(queuePrefixMatches(["a", "b"], ["x", "b"])).toBe(false)
    expect(queuePrefixMatches(["a"], [])).toBe(false)
  })

  it("requires an empty actual queue when clearing", () => {
    expect(queuePrefixMatches([], [])).toBe(true)
    expect(queuePrefixMatches([], ["a"])).toBe(false)
  })

  it("rejects a stale tail after an otherwise valid requested prefix", () => {
    expect(
      queueSnapshotMatchesRequested(
        ["spotify:track:new-one", "spotify:track:new-two"],
        ["spotify:track:new-one", "spotify:track:new-two", "spotify:track:old"]
      )
    ).toBe(false)
    expect(
      queueSnapshotMatchesRequested(
        ["spotify:track:new-one", "spotify:track:new-two"],
        ["spotify:track:new-one", "spotify:track:new-two"]
      )
    ).toBe(true)
  })

  it("rejects reordered or duplicated entries beyond the hydration quorum", () => {
    const expected = Array.from({ length: 10 }, (_, index) => `spotify:track:${index}`)
    expect(queueSnapshotMatchesRequested(expected, [...expected.slice(0, 8), expected[9]])).toBe(false)
    expect(queueSnapshotMatchesRequested(expected, [...expected.slice(0, 8), expected[7]])).toBe(false)
    expect(queueSnapshotMatchesRequested(expected, expected.slice(0, 9))).toBe(true)
  })

  it("keeps all requested tracks owned after a partial hydration quorum", () => {
    const requestedUris = Array.from({ length: 50 }, (_, index) => `spotify:track:${index}`)
    expect(getConfirmedQueueOwnership({
      requestedUris,
      actualUris: requestedUris.slice(0, 8),
      verified: true,
    })).toEqual(requestedUris)
  })

  it("times out a stuck queue clear", async () => {
    vi.useFakeTimers()
    stubNeverSettlingPlayer()
    await expectTimedOut(replaceQueue(["spotify:track:a"]))
  })

  it("times out a stuck queue add", async () => {
    vi.useFakeTimers()
    stubNeverSettlingPlayer()
    await expectTimedOut(appendTracksToQueue([{ uri: "spotify:track:a" }]))
  })

  it("times out stuck playback", async () => {
    vi.useFakeTimers()
    stubNeverSettlingPlayer()
    await expectTimedOut(playTrack("spotify:track:a"))
  })

  it("uses the public queue contract instead of fabricated private queue entries", async () => {
    const nextTracks: Array<{ uri: string }> = []
    const addToQueue = vi.fn(async (items: Array<{ uri: string }>) => {
      nextTracks.push(...items)
    })
    const setQueue = vi.fn(() => undefined)

    vi.stubGlobal("Spicetify", {
      Queue: { nextTracks, queueRevision: "revision-1" },
      Player: { getShuffle: () => false },
      Platform: {
        PlayerAPI: {
          clearQueue: vi.fn(async () => {
            nextTracks.splice(0)
          }),
          addToQueue,
          _queue: {
            _client: { setQueue },
            _queue: { prevTracks: [], queueRevision: "revision-1" },
          },
        },
      },
    })

    const commit = await replaceUpcomingQueue(null, ["spotify:track:one", "spotify:track:two"])

    expect(commit.verified).toBe(true)
    expect(addToQueue).toHaveBeenCalledWith([
      { uri: "spotify:track:one" },
      { uri: "spotify:track:two" },
    ])
    expect(setQueue).not.toHaveBeenCalled()
  })

  it("detaches the previous playback context before clearing and installing a new mix", async () => {
    const operations: string[] = []
    const nextTracks: Array<{ uri: string }> = [{ uri: "spotify:track:old" }]
    const playerData = {
      item: { uri: "spotify:track:current" },
      context: { uri: "spotify:playlist:previous" },
    }

    vi.stubGlobal("Spicetify", {
      Queue: { nextTracks },
      Player: { data: playerData, getShuffle: () => false },
      URI: {
        Type: { PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2", ALBUM: "album", ARTIST: "artist" },
        fromString: (uri: string) => ({ type: uri.split(":")[1] }),
      },
      Platform: {
        PlayerAPI: {
          getState: () => ({ sessionId: "session-1" }),
          updateContext: vi.fn(async (_sessionId: string, context: { uri: string }) => {
            operations.push("detach-context")
            playerData.context.uri = context.uri
          }),
          clearQueue: vi.fn(async () => {
            operations.push("clear-queue")
            nextTracks.splice(0)
          }),
          addToQueue: vi.fn(async (items: Array<{ uri: string }>) => {
            operations.push("add-new-mix")
            nextTracks.push(...items)
          }),
        },
      },
    })

    const commit = await replaceUpcomingQueueForNewMix(
      "spotify:track:current",
      ["spotify:track:new-one", "spotify:track:new-two"],
      "spotify:album:current"
    )

    expect(commit.verified).toBe(true)
    expect(operations).toEqual(["detach-context", "clear-queue", "add-new-mix"])
    expect(nextTracks).toEqual([
      { uri: "spotify:track:new-one" },
      { uri: "spotify:track:new-two" },
    ])
  })

  it("retries a fresh takeover once when Spotify reinjects an old queue track", async () => {
    const nextTracks: Array<{ uri: string }> = [{ uri: "spotify:track:old" }]
    let installAttempt = 0
    const clearQueue = vi.fn(async () => nextTracks.splice(0))
    const addToQueue = vi.fn(async (items: Array<{ uri: string }>) => {
      installAttempt += 1
      nextTracks.push(...items)
      if (installAttempt === 1) nextTracks.push({ uri: "spotify:track:old" })
    })

    vi.stubGlobal("Spicetify", {
      Queue: { nextTracks },
      Player: {
        data: { item: { uri: "spotify:track:current" }, context: { uri: "spotify:album:current" } },
        getShuffle: () => false,
      },
      URI: {
        Type: { PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2", ALBUM: "album", ARTIST: "artist" },
        fromString: (uri: string) => ({ type: uri.split(":")[1] }),
      },
      Platform: { PlayerAPI: { clearQueue, addToQueue } },
    })

    const commit = await replaceUpcomingQueueForNewMix(
      "spotify:track:current",
      ["spotify:track:new-one", "spotify:track:new-two"],
      "spotify:album:current"
    )

    expect(commit.verified).toBe(true)
    expect(clearQueue).toHaveBeenCalledTimes(2)
    expect(addToQueue).toHaveBeenCalledTimes(2)
    expect(nextTracks).toEqual([
      { uri: "spotify:track:new-one" },
      { uri: "spotify:track:new-two" },
    ])
  })

  it("rejects a hydrated public prefix while the private queue still has an old tail", async () => {
    const nextTracks: Array<{ uri: string }> = [{ uri: "spotify:track:old" }]
    const privateTracks: Array<{ uri: string }> = [{ uri: "spotify:track:old" }]
    let installAttempt = 0
    const clearQueue = vi.fn(async () => {
      nextTracks.splice(0)
      privateTracks.splice(0)
    })
    const addToQueue = vi.fn(async (items: Array<{ uri: string }>) => {
      installAttempt += 1
      nextTracks.push(...items)
      privateTracks.push(...items)
      if (installAttempt === 1) privateTracks.push({ uri: "spotify:track:old" })
    })

    vi.stubGlobal("Spicetify", {
      Queue: { nextTracks },
      Player: {
        data: { item: { uri: "spotify:track:current" }, context: { uri: "spotify:album:current" } },
        getShuffle: () => false,
      },
      URI: {
        Type: { PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2", ALBUM: "album", ARTIST: "artist" },
        fromString: (uri: string) => ({ type: uri.split(":")[1] }),
      },
      Platform: {
        PlayerAPI: {
          clearQueue,
          addToQueue,
          _queue: { _queueState: { nextTracks: privateTracks } },
        },
      },
    })

    const commit = await replaceUpcomingQueueForNewMix(
      "spotify:track:current",
      ["spotify:track:new-one", "spotify:track:new-two"],
      "spotify:album:current"
    )

    expect(commit.verified).toBe(true)
    expect(clearQueue).toHaveBeenCalledTimes(2)
    expect(privateTracks).toEqual(nextTracks)
  })

  it("restores the previous queue when a fresh install fails after clearing", async () => {
    const nextTracks: Array<{ uri: string }> = [{ uri: "spotify:track:old" }]
    const clearQueue = vi.fn(async () => nextTracks.splice(0))
    const addToQueue = vi.fn(async (items: Array<{ uri: string }>) => {
      if (items.some(({ uri }) => uri === "spotify:track:new")) throw new Error("install failed")
      nextTracks.push(...items)
    })

    vi.stubGlobal("Spicetify", {
      Queue: { nextTracks },
      Player: {
        data: { item: { uri: "spotify:track:current" }, context: { uri: "spotify:album:current" } },
        getShuffle: () => false,
      },
      URI: {
        Type: { PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2", ALBUM: "album", ARTIST: "artist" },
        fromString: (uri: string) => ({ type: uri.split(":")[1] }),
      },
      Platform: { PlayerAPI: { clearQueue, addToQueue } },
    })

    await expect(replaceUpcomingQueueForNewMix(
      "spotify:track:current",
      ["spotify:track:new"],
      "spotify:album:current"
    )).rejects.toThrow("install failed")
    expect(nextTracks).toEqual([{ uri: "spotify:track:old" }])
    expect(clearQueue).toHaveBeenCalledTimes(2)
  })
})
