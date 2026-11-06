import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getUpcomingQueueUris: vi.fn<() => string[]>(),
  isActive: vi.fn<() => boolean>(),
  getQueuedUris: vi.fn<() => string[]>(),
  ownsQueueTrack: vi.fn<(uri: string) => boolean>(),
}))

vi.mock("./queueManager", () => ({
  getUpcomingQueueUris: mocks.getUpcomingQueueUris,
}))

vi.mock("../session/SessionManager", () => ({
  sessionManager: {
    isActive: mocks.isActive,
    getQueuedUris: mocks.getQueuedUris,
    ownsQueueTrack: mocks.ownsQueueTrack,
  },
}))

import {
  detectForeignInjection,
  disableAutoplayGuard,
  enableAutoplayGuard,
  isUserQueuedDetourTrack,
  syncKnownQueue,
} from "./autoplayGuard"

describe("autoplay guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disableAutoplayGuard()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("ignores Spotify context tracks appended after the complete owned queue", () => {
    const owned = ["spotify:track:mix-one", "spotify:track:mix-two"]
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue([...owned, "spotify:track:spotify-context"])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual([])
  })

  it("reports a foreign track inserted before the owned queue completes", () => {
    const owned = ["spotify:track:mix-one", "spotify:track:mix-two"]
    const foreign = "spotify:track:foreign"
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue([owned[0], foreign, owned[1]])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual([foreign])
  })

  it("does not accept a foreign queue when no owned tracks remain", () => {
    const foreign = "spotify:track:foreign"
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue([])
    mocks.ownsQueueTrack.mockReturnValue(false)
    mocks.getUpcomingQueueUris.mockReturnValue([foreign])
    enableAutoplayGuard()
    // Establish a non-empty prior snapshot, matching an exhausted active session.
    syncKnownQueue(["spotify:track:already-played"])
    expect(detectForeignInjection()).toEqual([foreign])
  })
  it("ignores the just-started track still listed at the head of a lagging queue snapshot", () => {
    const owned = ["spotify:track:mix-two", "spotify:track:mix-three"]
    const justStarted = "spotify:track:mix-one"
    vi.stubGlobal("Spicetify", { Player: { data: { item: { uri: justStarted } } } })
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    // The started track counts as owned (already played) but is not upcoming.
    mocks.ownsQueueTrack.mockImplementation((uri) => [...owned, justStarted].includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue([justStarted, ...owned, "spotify:track:context"])
    enableAutoplayGuard()
    syncKnownQueue([justStarted, ...owned])

    expect(detectForeignInjection()).toEqual([])
  })

  it("still reports a foreign head track that is not the one playing", () => {
    const owned = ["spotify:track:mix-two"]
    vi.stubGlobal("Spicetify", { Player: { data: { item: { uri: "spotify:track:mix-one" } } } })
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue(["spotify:track:foreign", ...owned])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual(["spotify:track:foreign"])
  })

  it("drops only one copy of the playing track from the head", () => {
    const playing = "spotify:track:p"
    const owned = ["spotify:track:a", playing]
    vi.stubGlobal("Spicetify", { Player: { data: { item: { uri: playing } } } })
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    // Stale head, then the owned mix (which legitimately queues the same track again), then context.
    mocks.getUpcomingQueueUris.mockReturnValue([playing, ...owned, "spotify:track:ctx"])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual([])
  })

  it("does not treat an owned track that Spotify dropped as foreign injection", () => {
    // Spotify silently dropped mix-two (e.g. unavailable); the context tail follows the mix.
    const owned = ["spotify:track:mix-one", "spotify:track:mix-two", "spotify:track:mix-three"]
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue([
      "spotify:track:mix-one",
      "spotify:track:mix-three",
      "spotify:track:context-a",
      "spotify:track:context-b",
    ])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual([])
  })

  it("still reports a foreign track placed between owned tracks after a drop", () => {
    const owned = ["spotify:track:mix-one", "spotify:track:mix-two", "spotify:track:mix-three"]
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue([
      "spotify:track:mix-one",
      "spotify:track:foreign",
      "spotify:track:mix-three",
      "spotify:track:context-a",
    ])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual(["spotify:track:foreign"])
  })

  it("preserves a manually user-queued detour track placed ahead of owned mix tracks while still catching context injections", () => {
    const owned = ["spotify:track:mix-one", "spotify:track:mix-two"]
    const userQueued = "spotify:track:pardyalone-detour"
    const rogueContext = "spotify:track:autoplay-intruder"

    vi.stubGlobal("Spicetify", {
      Queue: {
        nextTracks: [
          { uri: userQueued, provider: "queue" },
          { uri: owned[0], provider: "queue" },
          { uri: owned[1], provider: "queue" },
        ],
      },
      Player: { data: { item: { uri: "spotify:track:gracie-seed" } } },
    })
    mocks.isActive.mockReturnValue(true)
    mocks.getQueuedUris.mockReturnValue(owned)
    mocks.ownsQueueTrack.mockImplementation((uri) => owned.includes(uri))
    mocks.getUpcomingQueueUris.mockReturnValue([userQueued, ...owned])
    enableAutoplayGuard()
    syncKnownQueue(owned)

    expect(detectForeignInjection()).toEqual([])

    // If a non-queue context track also slips in before the owned queue finishes, only that intruder is flagged.
    vi.stubGlobal("Spicetify", {
      Queue: {
        nextTracks: [
          { uri: userQueued, provider: "queue" },
          { uri: rogueContext, provider: "context" },
          { uri: owned[0], provider: "queue" },
          { uri: owned[1], provider: "queue" },
        ],
      },
      Player: { data: { item: { uri: "spotify:track:gracie-seed" } } },
    })
    mocks.getUpcomingQueueUris.mockReturnValue([userQueued, rogueContext, ...owned])

    expect(detectForeignInjection()).toEqual([rogueContext])
  })

  it("unsubscribes replaced _events emitters and caps observed user-queued detour URIs", () => {
    const firstEmitter = { addListener: vi.fn(), removeListener: vi.fn() }
    const secondEmitter = { addListener: vi.fn(), removeListener: vi.fn() }

    vi.stubGlobal("Spicetify", {
      Platform: { PlayerAPI: { _events: firstEmitter } },
      Queue: { nextTracks: [] },
    })
    enableAutoplayGuard()
    expect(firstEmitter.addListener).toHaveBeenCalledTimes(1)

    vi.stubGlobal("Spicetify", {
      Platform: { PlayerAPI: { _events: secondEmitter } },
      Queue: { nextTracks: [] },
    })
    enableAutoplayGuard()
    expect(firstEmitter.removeListener).toHaveBeenCalledTimes(1)
    expect(secondEmitter.addListener).toHaveBeenCalledTimes(1)

    mocks.isActive.mockReturnValue(true)
    mocks.ownsQueueTrack.mockReturnValue(false)
    const manualQueue = Array.from({ length: 150 }, (_, index) => ({
      uri: `spotify:track:manual-${index}`,
      provider: "queue",
    }))
    vi.stubGlobal("Spicetify", {
      Platform: { PlayerAPI: { _events: secondEmitter } },
      Queue: { nextTracks: manualQueue },
      Player: { data: { item: { uri: "spotify:track:seed" } } },
    })
    const onQueueUpdate = secondEmitter.addListener.mock.calls[0][1] as () => void
    onQueueUpdate()

    // Clear live queue so lookup relies strictly on bounded observedUserQueuedUris
    vi.stubGlobal("Spicetify", {
      Platform: { PlayerAPI: { _events: secondEmitter } },
      Queue: { nextTracks: [] },
      Player: { data: { item: { uri: "spotify:track:seed" } } },
    })
    expect(isUserQueuedDetourTrack("spotify:track:manual-0")).toBe(false)
    expect(isUserQueuedDetourTrack("spotify:track:manual-149")).toBe(true)

    disableAutoplayGuard()
    expect(secondEmitter.removeListener).toHaveBeenCalledTimes(1)
  })
})
