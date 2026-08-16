import { describe, expect, it, vi } from "vitest"
import type { TrackCandidate } from "../session/types"
import {
  classifyPlaybackTransition,
  type PlaybackSnapshot,
  type PlaybackTransition,
} from "./playbackObserver"

const NOW = Date.UTC(2026, 7, 3)
const track = (id: string): TrackCandidate => ({
  uri: `spotify:track:${id}`,
  artistUri: `spotify:artist:${id}`,
  tempo: 120,
  energy: 0.7,
  valence: 0.6,
})

const previous = (overrides: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  candidate: track("previous"),
  extensionOwned: true,
  progressMs: 20_000,
  durationMs: 200_000,
  context: {
    sessionId: "session-1",
    source: "similar",
    genres: ["indie pop"],
  },
  ...overrides,
})

const transition = (overrides: Partial<PlaybackTransition> = {}): PlaybackTransition => ({
  cause: "songchange",
  previous: previous(),
  current: { uri: "spotify:track:current", extensionOwned: true },
  ...overrides,
})

const now = () => NOW

describe("playback transition classifier", () => {
  it("ignores duplicate songchange events for the same URI", () => {
    const observation = classifyPlaybackTransition(
      transition({ current: { uri: "spotify:track:previous", extensionOwned: true } }),
      now
    )

    expect(observation).toMatchObject({
      type: "ignored",
      reason: "duplicate-songchange",
      tasteOutcome: null,
      rerank: "none",
    })
  })

  it("never learns from a previous track the extension did not own", () => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ extensionOwned: false, progressMs: 5_000 }) }),
      now
    )

    expect(observation).toMatchObject({
      type: "ignored",
      reason: "previous-not-extension-owned",
      tasteOutcome: null,
    })
  })

  it.each([
    { progressMs: 160_000, durationMs: 200_000, label: "at least 80 percent" },
    { progressMs: 186_000, durationMs: 200_000, label: "within 15 seconds of the end" },
    {
      progressMs: 6_000,
      durationMs: 20_000,
      label: "near a short track end even when the skip ratio also matches",
    },
  ])("classifies natural completion $label", ({ progressMs, durationMs }) => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ progressMs, durationMs }) }),
      now
    )

    expect(observation.type).toBe("completion")
    expect(observation.tasteOutcome?.type).toBe("completion")
    expect(observation.rerank).toBe("none")
  })

  it.each([
    { progressMs: 120_000, durationMs: 200_000, label: "at least 60 percent" },
    {
      progressMs: 90_000,
      durationMs: 600_000,
      label: "at least 90 seconds despite a low ratio",
    },
  ])("classifies a substantial play $label", ({ progressMs, durationMs }) => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ progressMs, durationMs }) }),
      now
    )

    expect(observation.type).toBe("substantial-play")
    expect(observation.tasteOutcome?.type).toBe("substantial-play")
    expect(observation.rerank).toBe("none")
  })

  it.each([
    { progressMs: 29_999, durationMs: 200_000, label: "under 30 seconds" },
    { progressMs: 45_000, durationMs: 200_000, label: "under 35 percent" },
  ])("classifies an early skip $label", ({ progressMs, durationMs }) => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ progressMs, durationMs }) }),
      now
    )

    expect(observation.type).toBe("early-skip")
    expect(observation.tasteOutcome?.type).toBe("early-skip")
    expect(observation.rerank).toBe("none")
  })

  it("treats a switch to a non-owned track as a manual context exit, never a skip", () => {
    const observation = classifyPlaybackTransition(
      transition({
        previous: previous({ progressMs: 3_000 }),
        current: { uri: "spotify:track:user-choice", extensionOwned: false },
      }),
      now
    )

    expect(observation).toMatchObject({
      type: "manual-context-exit",
      tasteOutcome: null,
      rerank: "none",
    })
  })

  it.each(["spotify:ad:break-1", "spotify:interstitial:promo", "spotify:delimiter"])(
    "keeps the mix alive across neutral Spotify interstitial %s",
    (uri) => {
      const observation = classifyPlaybackTransition(
        transition({
          previous: previous({ progressMs: 3_000 }),
          current: { uri, extensionOwned: false },
        }),
        now
      )

      expect(observation).toMatchObject({
        type: "ignored",
        reason: "interstitial",
        tasteOutcome: null,
        rerank: "none",
      })
    }
  )

  it("still exits for a user-selected episode", () => {
    const observation = classifyPlaybackTransition(
      transition({ current: { uri: "spotify:episode:user-choice", extensionOwned: false } }),
      now
    )
    expect(observation.type).toBe("manual-context-exit")
  })

  it.each([
    { progressMs: Number.NaN, durationMs: 200_000 },
    { progressMs: -1, durationMs: 200_000 },
    { progressMs: 2_000, durationMs: 0 },
    { progressMs: 2_000, durationMs: Number.POSITIVE_INFINITY },
  ])("does not make negative feedback from invalid metrics %#", ({ progressMs, durationMs }) => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ progressMs, durationMs }) }),
      now
    )

    expect(observation).toMatchObject({
      type: "ignored",
      reason: "invalid-playback-metrics",
      tasteOutcome: null,
      rerank: "none",
    })
  })

  it("classifies an explicit play failure without poisoning taste and requests replacement", () => {
    const observation = classifyPlaybackTransition(
      transition({
        cause: "play-failure",
        previous: previous({ progressMs: 0 }),
        current: null,
      }),
      now
    )

    expect(observation).toMatchObject({
      type: "play-failure",
      tasteOutcome: null,
      rerank: "immediate",
    })
  })

  it("leaves the ambiguous middle band neutral", () => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ progressMs: 70_000, durationMs: 180_000 }) }),
      now
    )

    expect(observation).toMatchObject({
      type: "ignored",
      reason: "ambiguous-playback",
      tasteOutcome: null,
    })
  })

  it("requires a next track before interpreting an unfinished playback as a skip", () => {
    const observation = classifyPlaybackTransition(
      transition({ previous: previous({ progressMs: 4_000 }), current: null }),
      now
    )

    expect(observation).toMatchObject({
      type: "ignored",
      reason: "missing-current",
      tasteOutcome: null,
    })
  })

  it("returns candidate, context, metrics, timestamp, and a ready-to-persist taste outcome", () => {
    const clock = vi.fn(() => NOW)
    const input = transition({
      previous: previous({ progressMs: 20_000, durationMs: 200_000 }),
    })
    const original = structuredClone(input)
    const observation = classifyPlaybackTransition(input, clock)

    expect(observation).toMatchObject({
      type: "early-skip",
      candidate: { uri: "spotify:track:previous" },
      context: { sessionId: "session-1", source: "similar", genres: ["indie pop"] },
      occurredAt: NOW,
      metrics: { progressMs: 20_000, durationMs: 200_000, progressRatio: 0.1 },
      tasteOutcome: {
        type: "early-skip",
        candidate: { uri: "spotify:track:previous" },
        genres: ["indie pop"],
        occurredAt: NOW,
      },
      rerank: "none",
    })
    expect(clock).toHaveBeenCalledTimes(1)
    expect(input).toEqual(original)
  })

  it("ignores a transition when the injected clock is invalid", () => {
    const observation = classifyPlaybackTransition(transition(), () => Number.NaN)
    expect(observation).toMatchObject({
      type: "ignored",
      reason: "invalid-clock",
      occurredAt: 0,
      tasteOutcome: null,
    })
  })
})
