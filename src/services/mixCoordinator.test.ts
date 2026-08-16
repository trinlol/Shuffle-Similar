import { describe, expect, it } from "vitest"
import { LatestMixCoordinator, StaleMixBuildError } from "./mixCoordinator"

describe("LatestMixCoordinator", () => {
  it("rejects an older build before it can mutate the queue", async () => {
    const coordinator = new LatestMixCoordinator()
    const older = coordinator.begin()
    const newest = coordinator.begin()
    let olderCommitted = false

    await expect(coordinator.commit(older, async () => {
      olderCommitted = true
    })).rejects.toBeInstanceOf(StaleMixBuildError)
    await expect(coordinator.commit(newest, async () => "committed")).resolves.toBe("committed")
    expect(olderCommitted).toBe(false)
  })

  it("serializes commits without tearing down one that already began", async () => {
    const coordinator = new LatestMixCoordinator()
    const events: string[] = []
    const firstToken = coordinator.begin()
    let releaseFirst: () => void = () => undefined
    let markFirstStarted: () => void = () => undefined
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })

    const first = coordinator.commit(firstToken, async () => {
      events.push("first:start")
      markFirstStarted()
      await holdFirst
      events.push("first:end")
    })

    await firstStarted
    const secondToken = coordinator.begin()
    const second = coordinator.commit(secondToken, async () => {
      events.push("second:start")
      events.push("second:end")
    })
    releaseFirst()

    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })

  it("keeps the completed mix valid if a newer serialized commit fails", async () => {
    const coordinator = new LatestMixCoordinator()
    let committedState = "original"
    const firstToken = coordinator.begin()
    let markFirstStarted: () => void = () => undefined
    let releaseFirst: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = coordinator.commit(firstToken, async () => {
      markFirstStarted()
      await holdFirst
      committedState = "first"
    })

    await firstStarted
    const secondToken = coordinator.begin()
    const second = coordinator.commit(secondToken, async () => {
      throw new Error("newer preparation failed")
    })
    releaseFirst()

    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow("newer preparation failed")
    expect(committedState).toBe("first")
  })

  it("releases the commit lane after a failure", async () => {
    const coordinator = new LatestMixCoordinator()
    const failedToken = coordinator.begin()
    await expect(coordinator.commit(failedToken, async () => {
      throw new Error("queue failure")
    })).rejects.toThrow("queue failure")

    const recoveredToken = coordinator.begin()
    await expect(coordinator.commit(recoveredToken, async () => "recovered")).resolves.toBe("recovered")
  })
})
