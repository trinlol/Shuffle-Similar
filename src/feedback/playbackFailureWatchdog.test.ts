import { afterEach, describe, expect, it, vi } from "vitest"
import { PlaybackFailureWatchdog } from "./playbackFailureWatchdog"

afterEach(() => {
  vi.useRealTimers()
})

describe("PlaybackFailureWatchdog", () => {
  it("requires two zero-progress observations before reporting failure", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const watchdog = new PlaybackFailureWatchdog(
      () => ({
        uri: "spotify:track:failed",
        progressMs: 0,
        durationMs: 180_000,
        isPaused: false,
        isBuffering: false,
      }),
      onFailure,
      { armDelayMs: 8_000, confirmationDelayMs: 2_000 }
    )

    watchdog.observeSongChange("spotify:track:failed", true)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(onFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it("fails closed while paused or buffering", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    let paused = true
    const watchdog = new PlaybackFailureWatchdog(
      () => ({
        uri: "spotify:track:owned",
        progressMs: 0,
        durationMs: 180_000,
        isPaused: paused,
        isBuffering: !paused,
      }),
      onFailure,
      { armDelayMs: 1_000, confirmationDelayMs: 500 }
    )

    watchdog.observeSongChange("spotify:track:owned", true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onFailure).not.toHaveBeenCalled()
    paused = false
    watchdog.observeProgress("spotify:track:owned", 1_500)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("does not arm for foreign or non-track playback", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const watchdog = new PlaybackFailureWatchdog(
      () => ({ uri: "spotify:ad:break", progressMs: 0, durationMs: 0 }),
      onFailure,
      { armDelayMs: 100, confirmationDelayMs: 100 }
    )

    watchdog.observeSongChange("spotify:track:foreign", false)
    watchdog.observeSongChange("spotify:ad:break", true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("cancels when playback changes URI before inspection", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const watchdog = new PlaybackFailureWatchdog(
      () => ({ uri: "spotify:track:new", progressMs: 0, durationMs: 180_000 }),
      onFailure,
      { armDelayMs: 100, confirmationDelayMs: 100 }
    )
    watchdog.observeSongChange("spotify:track:old", true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("cancels when the player has no loaded duration", async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    const watchdog = new PlaybackFailureWatchdog(
      () => ({ uri: "spotify:track:owned", progressMs: 0, durationMs: 0 }),
      onFailure,
      { armDelayMs: 100, confirmationDelayMs: 100 }
    )
    watchdog.observeSongChange("spotify:track:owned", true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onFailure).not.toHaveBeenCalled()
  })
})
