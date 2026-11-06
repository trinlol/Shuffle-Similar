import { describe, expect, it } from "vitest"
import { createSimilarMixStatus } from "./status"
import { getTimelineBannerPresentation, getToggleButtonPresentation } from "./toggleButton"

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

describe("Similar Mix timeline banner presentation", () => {
  it("stays hidden when no Similar Mix session is active", () => {
    expect(
      getTimelineBannerPresentation({
        sessionActive: false,
        seed: { trackName: "July", artistName: "Noah Cyrus" },
        playedCount: 3,
      })
    ).toMatchObject({
      visible: false,
      seedTitle: "",
      fullText: "",
      playedCount: 0,
      buttonDisabled: true,
    })
  })

  it("shows the original seed song and played track count when Similar Mix is active", () => {
    expect(
      getTimelineBannerPresentation({
        sessionActive: true,
        seed: { trackName: "July", artistName: "Noah Cyrus" },
        playedCount: 6,
      })
    ).toEqual({
      visible: true,
      prefixText: "Playing similar songs based on ",
      seedTitle: "July",
      fullText: "Playing similar songs based on July",
      tooltip: 'Playing similar songs based on "July" by Noah Cyrus',
      playedCount: 6,
      buttonLabel: "Save playlist",
      buttonTooltip: "Save playlist with all 6 songs played from this queue",
      buttonBusy: false,
      buttonDisabled: false,
      buttonState: "idle",
    })
  })

  it("reflects saving and saved states on the timeline playlist button", () => {
    const saving = getTimelineBannerPresentation({
      sessionActive: true,
      seed: { trackName: "July", artistName: "Noah Cyrus" },
      playedCount: 4,
      saveState: "saving",
    })
    expect(saving).toMatchObject({
      buttonLabel: "Saving…",
      buttonBusy: true,
      buttonDisabled: true,
      buttonState: "saving",
    })

    const saved = getTimelineBannerPresentation({
      sessionActive: true,
      seed: { trackName: "July", artistName: "Noah Cyrus" },
      playedCount: 4,
      saveState: "saved",
    })
    expect(saved).toMatchObject({
      buttonLabel: "Saved!",
      buttonTooltip: 'Saved "Similar to - July" with 4 played songs.',
      buttonBusy: false,
      buttonDisabled: false,
      buttonState: "saved",
    })
  })
})
