import { describe, expect, it } from "vitest"
import { createSimilarMixStatus } from "./status"
import { getToggleButtonPresentation } from "./toggleButton"

describe("Similar Mix toggle presentation", () => {
  it("keeps building truthful: busy but not pressed before queue success", () => {
    const status = createSimilarMixStatus()
    status.beginTransition("building")

    expect(getToggleButtonPresentation(status.getSnapshot(), false)).toEqual({
      pressed: false,
      busy: true,
      label: "Building Similar Mix…",
    })
  })

  it("describes the real active click and Shift+click interactions", () => {
    const status = createSimilarMixStatus({ initialState: "on" })

    expect(getToggleButtonPresentation(status.getSnapshot(), true)).toEqual({
      pressed: true,
      busy: false,
      label: "Turn off Similar Mix · Shift+click to refresh",
    })
  })

  it("keeps refresh active and stopping inactive while both are busy", () => {
    const status = createSimilarMixStatus({ initialState: "on" })
    status.beginTransition("refreshing")
    expect(getToggleButtonPresentation(status.getSnapshot(), true)).toMatchObject({
      pressed: true,
      busy: true,
      label: "Refreshing Similar Mix…",
    })

    status.beginTransition("stopping")
    expect(getToggleButtonPresentation(status.getSnapshot(), false)).toEqual({
      pressed: false,
      busy: true,
      label: "Turning off Similar Mix…",
    })
  })

  it("offers a retry after a failed start without claiming to be active", () => {
    const status = createSimilarMixStatus()
    status.transitionTo("error", { status: 503 })

    expect(getToggleButtonPresentation(status.getSnapshot(), false)).toEqual({
      pressed: false,
      busy: false,
      label: "Retry Similar Mix",
    })
  })
})
