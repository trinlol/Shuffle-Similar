import { describe, expect, it } from "vitest"
import { QueueMutationCoordinator } from "./queueMutationCoordinator"

describe("QueueMutationCoordinator", () => {
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
})
