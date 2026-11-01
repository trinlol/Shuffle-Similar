import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeSpotify } from "./fakeSpotify"

const uris = (...ids: string[]) => ids.map((id) => `spotify:track:${id}`)

describe("fake Spotify", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("clearQueue resolves before state changes", async () => {
    const fake = createFakeSpotify({ queued: uris("old-a", "old-b") })
    fake.install()

    await Spicetify.Platform.PlayerAPI.clearQueue()
    expect(fake.queued()).toEqual(uris("old-a", "old-b"))

    await vi.advanceTimersByTimeAsync(150)
    expect(fake.queued()).toEqual([])
  })

  it("addToQueue during the lag window re-adds stale queued tracks", async () => {
    const fake = createFakeSpotify({ queued: uris("old-a", "old-b") })
    fake.install()

    await Spicetify.Platform.PlayerAPI.clearQueue()
    await Spicetify.Platform.PlayerAPI.addToQueue(uris("new-a").map((uri) => ({ uri })))
    await vi.advanceTimersByTimeAsync(500)

    expect(fake.queued()).toEqual(uris("old-a", "old-b", "new-a"))
  })

  it("nextTrack lists the new current track at index 0 for headLagMs only", async () => {
    const fake = createFakeSpotify({ playing: "spotify:track:now", queued: uris("next", "later") })
    fake.install()

    fake.nextTrack()
    expect(fake.playing()).toBe("spotify:track:next")
    expect(fake.upcoming()[0]).toBe("spotify:track:next")

    await vi.advanceTimersByTimeAsync(80)
    expect(fake.upcoming()).toEqual(uris("later"))
  })

  it("queue_update fires once per operation after applyDelayMs, with public queue already updated", async () => {
    const fake = createFakeSpotify({ queued: uris("old") })
    fake.install()
    const seen: number[] = []
    Spicetify.Platform.PlayerAPI._events.addListener("queue_update", () => {
      seen.push(Spicetify.Queue.nextTracks.length)
    })

    await Spicetify.Platform.PlayerAPI.clearQueue()
    await vi.advanceTimersByTimeAsync(149)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([0])
  })

  it("dropWhileStale ignores a clear issued inside the lag window", async () => {
    const fake = createFakeSpotify({ queued: uris("old"), dropWhileStale: true })
    fake.install()

    await Spicetify.Platform.PlayerAPI.addToQueue(uris("new").map((uri) => ({ uri })))
    await Spicetify.Platform.PlayerAPI.clearQueue()
    await vi.advanceTimersByTimeAsync(500)

    expect(fake.queued()).toEqual(uris("old", "new"))
    expect(fake.operations.map((entry) => entry.op)).toEqual(["add", "clear"])
  })
})
