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
})
