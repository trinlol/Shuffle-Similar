import { describe, expect, it, vi } from "vitest"
import { BoundedCache, OptionalSpotifyCapabilityGate, runWithTimeout } from "./spotifyApiAdapter"

describe("BoundedCache", () => {
  it("evicts the least recently used entry and refreshes reads", () => {
    const cache = new BoundedCache<string, number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)

    expect(cache.has("a")).toBe(true)
    expect(cache.has("b")).toBe(false)
    expect(cache.get("c")).toBe(3)
    expect(cache.size).toBe(2)
  })
})

describe("OptionalSpotifyCapabilityGate", () => {
  it("marks a forbidden optional endpoint unsupported and never probes it again", async () => {
    const gate = new OptionalSpotifyCapabilityGate({ timeoutMs: 50 })
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 })
    })

    expect((await gate.run("recommendations", operation)).status).toBe("unsupported")
    expect((await gate.run("recommendations", operation)).status).toBe("unsupported")
    expect(operation).toHaveBeenCalledTimes(1)
    expect(gate.snapshot().find((item) => item.capability === "recommendations")).toMatchObject({
      status: "unsupported",
      consecutiveFailures: 1,
    })
  })

  it("opens a temporary circuit after repeated timeouts and retries after cooldown", async () => {
    let now = 1_000
    const gate = new OptionalSpotifyCapabilityGate({
      timeoutMs: 2,
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => now,
    })
    const hanging = vi.fn(async () => await new Promise<string>(() => undefined))

    expect((await gate.run("audio-features", hanging)).status).toBe("timeout")
    expect((await gate.run("audio-features", hanging)).status).toBe("circuit-open")
    expect(hanging).toHaveBeenCalledTimes(1)

    now += 1_001
    const recovered = await gate.run("audio-features", async () => "available")
    expect(recovered).toEqual({ status: "ok", value: "available" })
    expect(gate.snapshot().find((item) => item.capability === "audio-features")).toMatchObject({
      status: "available",
      consecutiveFailures: 0,
    })
  })

  it("immediately cools down quota-limited capabilities", async () => {
    let now = 2_000
    const gate = new OptionalSpotifyCapabilityGate({
      timeoutMs: 50,
      cooldownMs: 5_000,
      now: () => now,
    })
    const limited = vi.fn(async () => {
      throw { response: { status: 429 } }
    })

    expect((await gate.run("related-artists", limited)).status).toBe("quota-limited")
    expect((await gate.run("related-artists", limited)).status).toBe("circuit-open")
    expect(limited).toHaveBeenCalledTimes(1)
    now += 5_001
    expect((await gate.run("related-artists", async () => [])).status).toBe("ok")
  })

  it("aborts and rejects a timed-out injected request", async () => {
    let signal: AbortSignal | undefined
    await expect(
      runWithTimeout((received) => {
        signal = received
        return new Promise(() => undefined)
      }, 2)
    ).rejects.toMatchObject({ name: "SourceTimeoutError" })
    expect(signal?.aborted).toBe(true)
  })
})
