import { describe, expect, it, vi } from "vitest"
import { SourcePipeline } from "./sourcePipeline"

describe("SourcePipeline", () => {
  it("keeps healthy source results when another source fails", async () => {
    const pipeline = new SourcePipeline({ timeoutMs: 100, maxConcurrency: 2 })

    const result = await pipeline.run([
      { id: "radio", run: async () => ["a", "b"] },
      { id: "search", run: async () => { throw new Error("403") } },
    ])

    expect(result.values).toEqual([
      { sourceId: "radio", value: ["a", "b"] },
    ])
    expect(result.diagnostics.map(({ sourceId, status }) => ({ sourceId, status }))).toEqual([
      { sourceId: "radio", status: "ok" },
      { sourceId: "search", status: "error" },
    ])
    expect(result.degraded).toBe(true)
  })

  it("never exceeds its remote request concurrency budget", async () => {
    const pipeline = new SourcePipeline({ timeoutMs: 500, maxConcurrency: 2 })
    let active = 0
    let peak = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })

    const pending = pipeline.run(
      Array.from({ length: 5 }, (_, index) => ({
        id: `source-${index}`,
        run: async () => {
          active += 1
          peak = Math.max(peak, active)
          await gate
          active -= 1
          return [index]
        },
      }))
    )

    await Promise.resolve()
    expect(peak).toBe(2)
    release?.()
    await pending
    expect(peak).toBe(2)
  })

  it("shares the concurrency budget across overlapping pipeline runs", async () => {
    const pipeline = new SourcePipeline({ timeoutMs: 500, maxConcurrency: 2 })
    let active = 0
    let peak = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const task = (id: string) => ({
      id,
      run: async () => {
        active += 1
        peak = Math.max(peak, active)
        await gate
        active -= 1
        return [id]
      },
    })

    const first = pipeline.run([task("a"), task("b")])
    const second = pipeline.run([task("c"), task("d")])
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(2)
    release?.()
    await Promise.all([first, second])
    expect(peak).toBe(2)
  })

  it("times out unhealthy sources and temporarily opens their circuit", async () => {
    let now = 1_000
    let calls = 0
    const pipeline = new SourcePipeline({
      timeoutMs: 5,
      maxConcurrency: 1,
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => now,
    })
    const task = {
      id: "legacy-recommendations",
      run: async () => {
        calls += 1
        return await new Promise<string[]>(() => undefined)
      },
    }

    const timedOut = await pipeline.run([task])
    expect(timedOut.diagnostics[0].status).toBe("timeout")

    const circuitOpen = await pipeline.run([task])
    expect(circuitOpen.diagnostics[0].status).toBe("circuit-open")
    expect(calls).toBe(1)

    now += 1_001
    const recovered = await pipeline.run([{
      ...task,
      run: async () => {
        calls += 1
        return ["recovered"]
      },
    }])
    expect(recovered.diagnostics[0].status).toBe("ok")
    expect(calls).toBe(2)
  })

  it("bounds remembered circuit health for dynamically named adapters", async () => {
    const pipeline = new SourcePipeline({
      timeoutMs: 50,
      maxConcurrency: 1,
      failureThreshold: 1,
      maxHealthEntries: 2,
    })

    for (const id of ["first", "second", "third"]) {
      await pipeline.run([{ id, run: async () => { throw new Error("unavailable") } }])
    }

    expect(pipeline.healthEntryCount).toBe(2)
  })

  it("returns a foreground snapshot at quorum while tracking late work", async () => {
    const pipeline = new SourcePipeline({ timeoutMs: 500, maxConcurrency: 2 })
    let releaseSlow: (() => void) | undefined
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const lateValues: Array<{ sourceId: string; value: string[] }> = []

    const foreground = await pipeline.run([
      { id: "fast", run: async () => ["a", "b"] },
      { id: "slow", run: async () => { await slowGate; return ["c"] } },
    ], {
      quorum: (values) => values.some(({ sourceId }) => sourceId === "fast"),
      onLateValue: (value) => lateValues.push(value),
    })

    expect(foreground.values).toEqual([{ sourceId: "fast", value: ["a", "b"] }])
    expect(lateValues).toEqual([])
    releaseSlow?.()
    await vi.waitFor(() => expect(lateValues).toHaveLength(1))
    expect(lateValues).toEqual([{ sourceId: "slow", value: ["c"] }])
  })

  it("returns at the foreground deadline and cancels queued source launches", async () => {
    vi.useFakeTimers()
    const pipeline = new SourcePipeline({ timeoutMs: 5_000, maxConcurrency: 1 })
    let releaseSlow: (() => void) | undefined
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const queuedRun = vi.fn(async () => ["queued"])
    const lateValues: Array<{ sourceId: string; value: string[] }> = []

    const pending = pipeline.run([
      { id: "slow", run: async () => { await slowGate; return ["late"] } },
      { id: "queued", run: queuedRun },
    ], {
      foregroundDeadlineMs: 100,
      onLateValue: (value) => lateValues.push(value),
    })

    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toMatchObject({ values: [] })
    expect(queuedRun).not.toHaveBeenCalled()
    releaseSlow?.()
    await vi.waitFor(() => expect(lateValues).toEqual([{ sourceId: "slow", value: ["late"] }]))
    vi.useRealTimers()
  })
})
