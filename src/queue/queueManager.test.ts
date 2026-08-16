import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendTracksToQueue,
  getConfirmedQueueOwnership,
  playTrack,
  queuePrefixMatches,
  replaceUpcomingQueue,
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
})
