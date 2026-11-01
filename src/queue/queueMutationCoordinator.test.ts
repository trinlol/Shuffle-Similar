import { afterEach, describe, expect, it, vi } from "vitest"
import { createFakeSpotify } from "../test/fakeSpotify"
import { replaceUpcomingQueue } from "./queueManager"
import { QueueMutationCoordinator } from "./queueMutationCoordinator"

describe("QueueMutationCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("serializes queue mutations and continues after a rejected operation", async () => {
    const coordinator = new QueueMutationCoordinator()
    const operations: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = coordinator.run(async () => {
      operations.push("first:start")
      await gate
      operations.push("first:end")
      throw new Error("failed")
    })
    const second = coordinator.run(async () => {
      operations.push("second")
      return 2
    })

    await Promise.resolve()
    expect(operations).toEqual(["first:start"])
    release?.()
    await expect(first).rejects.toThrow("failed")
    await expect(second).resolves.toBe(2)
    expect(operations).toEqual(["first:start", "first:end", "second"])
  })

  it("concurrent replaceUpcomingQueue calls never interleave", async () => {
    vi.useFakeTimers()
    const current = "spotify:track:current"
    const fake = createFakeSpotify({ playing: current, queued: ["spotify:track:old"] })
    fake.install()
    const coordinator = new QueueMutationCoordinator()

    const first = coordinator.run(() => replaceUpcomingQueue(current, ["spotify:track:a"]))
    const second = coordinator.run(() => replaceUpcomingQueue(current, ["spotify:track:b"]))
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([first, second])

    expect(fake.operations.map((entry) => entry.op)).toEqual(["clear", "add", "clear", "add"])
    expect(fake.queued()).toEqual(["spotify:track:b"])
  })
})
