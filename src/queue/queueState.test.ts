import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeSpotify } from "../test/fakeSpotify"
import {
  queuedUris,
  readInternalQueueSnapshot,
  readQueueSnapshot,
  waitForQueue,
} from "./queueState"

const uris = (...ids: string[]) => ids.map((id) => `spotify:track:${id}`)
const queueEmpty = (snapshot: ReturnType<typeof readQueueSnapshot>) =>
  queuedUris(snapshot).length === 0

describe("queueState", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("resolves immediately when the predicate already holds", async () => {
    createFakeSpotify({ contextTail: uris("ctx") }).install()

    const result = await waitForQueue(queueEmpty, { timeoutMs: 1_000 })

    expect(result.met).toBe(true)
    expect(result.snapshot.entries.map((entry) => entry.uri)).toEqual(uris("ctx"))
  })

  it("resolves on queue_update without polling", async () => {
    const fake = createFakeSpotify({ queued: uris("old"), applyDelayMs: 150 })
    fake.install()
    await Spicetify.Platform.PlayerAPI.clearQueue()

    let result: { met: boolean } | null = null
    void waitForQueue(queueEmpty, { timeoutMs: 5_000, pollMs: 10_000 }).then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(149)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(result).toEqual(expect.objectContaining({ met: true }))
  })

  it("falls back to polling when no queue_update event is emitted", async () => {
    const fake = createFakeSpotify({ queued: uris("old"), emitQueueUpdate: false })
    fake.install()
    await Spicetify.Platform.PlayerAPI.clearQueue()

    const pending = waitForQueue(queueEmpty, { timeoutMs: 5_000, pollMs: 25 })
    await vi.advanceTimersByTimeAsync(175)

    await expect(pending).resolves.toEqual(expect.objectContaining({ met: true }))
  })

  it("returns met:false at timeoutMs and removes its listener", async () => {
    const fake = createFakeSpotify({ queued: uris("stuck") })
    fake.install()

    const pending = waitForQueue(queueEmpty, { timeoutMs: 2_000 })
    expect(fake.listenerCount("queue_update")).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(pending).resolves.toEqual(expect.objectContaining({ met: false }))
    expect(fake.listenerCount("queue_update")).toBe(0)
  })

  it('readQueueSnapshot returns source "none" and does not throw when Spicetify.Queue and _queue are missing', () => {
    vi.stubGlobal("Spicetify", { Platform: { PlayerAPI: {} } })
    expect(readQueueSnapshot()).toEqual({ entries: [], revision: null, source: "none" })

    vi.stubGlobal("Spicetify", undefined)
    expect(readQueueSnapshot()).toEqual({ entries: [], revision: null, source: "none" })
  })

  it("internal fallback lists queued tracks before nextUp, without delimiters", () => {
    vi.stubGlobal("Spicetify", {
      Queue: { nextTracks: [] },
      Platform: {
        PlayerAPI: {
          _queue: {
            _queueState: {
              queued: [{ contextTrack: { uri: "spotify:track:q" }, provider: "queue" }],
              nextUp: [
                { contextTrack: { uri: "spotify:delimiter" }, provider: "context" },
                { contextTrack: { uri: "spotify:track:n" }, provider: "context" },
              ],
            },
          },
        },
      },
    })

    const snapshot = readQueueSnapshot()

    expect(snapshot.source).toBe("internal")
    expect(snapshot.entries).toEqual([
      { uri: "spotify:track:q", provider: "queue" },
      { uri: "spotify:track:n", provider: "context" },
    ])
    expect(queuedUris(snapshot)).toEqual(["spotify:track:q"])
  })

  it("readInternalQueueSnapshot reads Spotify's internal state even when the public queue is hydrated", () => {
    createFakeSpotify({ queued: uris("q"), contextTail: uris("ctx") }).install()

    const internal = readInternalQueueSnapshot()

    expect(internal.source).toBe("internal")
    expect(internal.entries.map((entry) => entry.uri)).toEqual(uris("q", "ctx"))
    expect(readQueueSnapshot().source).toBe("public")
  })
})
