import { describe, expect, it, vi } from "vitest"
import {
  SIMILAR_MIX_STATUS_COPY,
  createSimilarMixStatus,
  mapSimilarMixError,
  mountSimilarMixStatus,
  unmountSimilarMixStatus,
  updateSimilarMixStatus,
  type SimilarMixStatus,
} from "./status"

const STATES: SimilarMixStatus[] = [
  "off",
  "building",
  "on",
  "refreshing",
  "stopping",
  "error",
  "degraded",
]

describe("Similar Mix status copy", () => {
  it("has concise centralized copy and behavior metadata for every state", () => {
    expect(Object.keys(SIMILAR_MIX_STATUS_COPY)).toEqual(STATES)

    for (const state of STATES) {
      const copy = SIMILAR_MIX_STATUS_COPY[state]
      expect(copy.label.length).toBeGreaterThan(0)
      expect(copy.label.length).toBeLessThanOrEqual(32)
      expect(copy.detail.length).toBeGreaterThan(0)
      expect(copy.detail.length).toBeLessThanOrEqual(72)
      expect(Object.isFrozen(copy)).toBe(true)
    }

    expect(SIMILAR_MIX_STATUS_COPY.building.busy).toBe(true)
    expect(SIMILAR_MIX_STATUS_COPY.refreshing.busy).toBe(true)
    expect(SIMILAR_MIX_STATUS_COPY.stopping.busy).toBe(true)
    expect(SIMILAR_MIX_STATUS_COPY.on.tone).toBe("positive")
    expect(SIMILAR_MIX_STATUS_COPY.error.tone).toBe("negative")
  })
})

describe("public Similar Mix errors", () => {
  it("maps known service hints to fixed, actionable public copy", () => {
    expect(mapSimilarMixError({ status: 429 })).toMatchObject({
      code: "rate_limited",
      retryable: true,
      recovery: "wait",
    })
    expect(mapSimilarMixError({ code: "NO_ACTIVE_TRACK" })).toMatchObject({
      code: "no_active_track",
      retryable: true,
      recovery: "choose_track",
    })
    expect(mapSimilarMixError({ statusCode: 503 })).toMatchObject({
      code: "service_unavailable",
      retryable: true,
      recovery: "retry",
    })
  })

  it("never exposes raw exception text or untrusted error fields", () => {
    const secret = "private-token-and-stack-details"
    const mapped = mapSimilarMixError(new Error(secret))
    const hostile = mapSimilarMixError({
      code: "UNRECOGNIZED_INTERNAL_FAILURE",
      title: secret,
      message: secret,
      stack: secret,
    })

    expect(mapped.code).toBe("unexpected")
    expect(hostile.code).toBe("unexpected")
    expect(JSON.stringify([mapped, hostile])).not.toContain(secret)
    expect(Object.isFrozen(mapped)).toBe(true)
  })

  it("survives hostile error objects with throwing getters", () => {
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, "code", {
      get: () => {
        throw new Error("do not leak me")
      },
    })

    expect(mapSimilarMixError(hostile).code).toBe("unexpected")
  })
})

describe("Similar Mix status controller", () => {
  it("publishes an immutable initial snapshot and emits current state on subscribe", () => {
    const controller = createSimilarMixStatus({ now: () => 1_000 })
    const listener = vi.fn()

    const unsubscribe = controller.subscribe(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({
      state: "off",
      revision: 0,
      updatedAt: 1_000,
      copy: SIMILAR_MIX_STATUS_COPY.off,
    })
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true)

    unsubscribe()
    unsubscribe()
  })

  it("notifies active subscribers once per meaningful transition", () => {
    let now = 10
    const controller = createSimilarMixStatus({ now: () => ++now })
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = controller.subscribe(first, { emitCurrent: false })
    controller.subscribe(second, { emitCurrent: false })

    controller.transitionTo("building")
    controller.transitionTo("building")
    unsubscribe()
    controller.transitionTo("on")

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({ state: "on", revision: 2 })
  })

  it("isolates faulty observers so healthy observers still receive updates", () => {
    const controller = createSimilarMixStatus()
    const healthy = vi.fn()
    controller.subscribe(() => {
      throw new Error("broken view")
    }, { emitCurrent: false })
    controller.subscribe(healthy, { emitCurrent: false })

    expect(() => controller.transitionTo("building")).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it("attaches sanitized errors only to error and degraded snapshots", () => {
    const secret = "sensitive request payload"
    const controller = createSimilarMixStatus()

    controller.transitionTo("error", new Error(secret))
    const failed = controller.getSnapshot()
    expect(failed.error?.code).toBe("unexpected")
    expect(JSON.stringify(failed)).not.toContain(secret)

    controller.transitionTo("on", new Error(secret))
    expect(controller.getSnapshot().error).toBeUndefined()
  })

  it("commits a transition transaction to its natural success state", () => {
    const controller = createSimilarMixStatus()
    const building = controller.beginTransition("building")

    expect(controller.getSnapshot().state).toBe("building")
    expect(building.commit()).toBe(true)
    expect(controller.getSnapshot().state).toBe("on")
    expect(building.commit()).toBe(false)

    const stopping = controller.beginTransition("stopping")
    expect(stopping.commit()).toBe(true)
    expect(controller.getSnapshot().state).toBe("off")
  })

  it("prevents stale async work from overwriting a newer transition", () => {
    const controller = createSimilarMixStatus()
    const first = controller.beginTransition("building")
    const second = controller.beginTransition("refreshing")

    expect(first.commit()).toBe(false)
    expect(first.fail({ status: 503 })).toBe(false)
    expect(second.commit()).toBe(true)
    expect(controller.getSnapshot().state).toBe("on")
  })

  it("supports sanitized failure and graceful degradation transactions", () => {
    const controller = createSimilarMixStatus()
    const failure = controller.beginTransition("building")
    expect(failure.fail({ status: 429 })).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      state: "error",
      error: { code: "rate_limited" },
    })

    const refresh = controller.beginTransition("refreshing")
    expect(refresh.degrade({ code: "NETWORK_ERROR" })).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      state: "degraded",
      error: { code: "offline" },
    })
  })
})

describe("Similar Mix status capsule", () => {
  it("is a safe no-op when the DOM is unavailable", () => {
    const controller = createSimilarMixStatus()

    expect(mountSimilarMixStatus(controller, { document: null })).toBeNull()
    expect(updateSimilarMixStatus(null)).toBe(false)
    expect(() => unmountSimilarMixStatus(null)).not.toThrow()
  })
})
