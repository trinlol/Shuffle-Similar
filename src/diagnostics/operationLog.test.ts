import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { replaceUpcomingQueue, replaceUpcomingQueueForNewMix } from "../queue/queueManager"
import { createFakeSpotify } from "../test/fakeSpotify"
import {
  buildDiagnosticsReport,
  clearOperations,
  getOperations,
  recordOperation,
  registerDiagnosticsState,
} from "./operationLog"

describe("operation log", () => {
  beforeEach(() => {
    clearOperations()
    registerDiagnosticsState(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("keeps only the newest 50 records", () => {
    for (let index = 0; index < 60; index += 1) {
      recordOperation({ op: "queue.add", outcome: "ok", counts: { index } })
    }

    const operations = getOperations()
    expect(operations).toHaveLength(50)
    expect(operations[0].counts).toEqual({ index: 10 })
    expect(operations[49].counts).toEqual({ index: 59 })
  })

  it("drops reason text that is not a short code", () => {
    recordOperation({ op: "queue.verify", outcome: "failed", reason: "queue_not_confirmed" })
    recordOperation({ op: "queue.verify", outcome: "failed", reason: "spotify:track:abc leaked" })

    expect(getOperations().map((record) => record.reason)).toEqual([
      "queue_not_confirmed",
      undefined,
    ])
  })

  it("report is valid JSON with the documented keys", () => {
    vi.stubGlobal("Spicetify", { Config: { version: "2.46.4" } })
    registerDiagnosticsState(() => ({ toggleEnabled: true, sessionActive: false }))
    recordOperation({ op: "mix.start", outcome: "ok", durationMs: 12 })

    const report = JSON.parse(buildDiagnosticsReport())

    expect(Object.keys(report)).toEqual([
      "extensionVersion",
      "spicetifyVersion",
      "spotifyVersion",
      "generatedAt",
      "toggleEnabled",
      "sessionActive",
      "operations",
    ])
    expect(report.spicetifyVersion).toBe("2.46.4")
    expect(report.toggleEnabled).toBe(true)
    expect(report.sessionActive).toBe(false)
    expect(report.operations).toHaveLength(1)
  })

  it('a mix takeover and track change on a lagging Spotify leave no "spotify:track:" or "spotify:user:" text in the report', async () => {
    vi.useFakeTimers()
    const current = "spotify:track:current"
    const fake = createFakeSpotify({
      playing: current,
      queued: ["spotify:track:old"],
      contextTail: ["spotify:track:ctx", "spotify:user:someone:collection"],
    })
    fake.install()

    const takeover = replaceUpcomingQueueForNewMix(current, ["spotify:track:a", "spotify:track:b"])
    await vi.advanceTimersByTimeAsync(10_000)
    await takeover
    fake.nextTrack()
    const replace = replaceUpcomingQueue(fake.playing(), ["spotify:track:c"])
    await vi.advanceTimersByTimeAsync(10_000)
    await replace

    const ops = getOperations().map((record) => record.op)
    expect(ops).toEqual(expect.arrayContaining(["queue.clear", "queue.add", "queue.verify"]))
    const report = buildDiagnosticsReport()
    expect(report).not.toContain("spotify:track:")
    expect(report).not.toContain("spotify:user:")
  })
})
