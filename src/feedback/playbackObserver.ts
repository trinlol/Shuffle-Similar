import type { TastePlaybackOutcome } from "../profile/tasteProfile"
import type { TrackCandidate } from "../session/types"

const COMPLETION_RATIO = 0.8
const COMPLETION_REMAINING_MS = 15_000
const SUBSTANTIAL_RATIO = 0.6
const SUBSTANTIAL_TIME_MS = 90_000
const EARLY_SKIP_TIME_MS = 30_000
const EARLY_SKIP_RATIO = 0.35

export type PlaybackContext = Readonly<{
  sessionId?: string
  source?: string
  genres?: readonly string[]
}>

export type PlaybackSnapshot = Readonly<{
  candidate: TrackCandidate
  extensionOwned: boolean
  progressMs: number | null
  durationMs: number | null
  context: PlaybackContext
}>

export type PlaybackTarget = Readonly<{
  uri: string | null
  extensionOwned: boolean
}>

export type PlaybackTransition = Readonly<{
  cause: "songchange" | "play-failure"
  previous: PlaybackSnapshot | null
  current: PlaybackTarget | null
}>

export type PlaybackMetrics = Readonly<{
  progressMs: number
  durationMs: number
  progressRatio: number
}>

export type IgnoredPlaybackReason =
  | "invalid-clock"
  | "missing-previous"
  | "previous-not-extension-owned"
  | "duplicate-songchange"
  | "interstitial"
  | "missing-current"
  | "invalid-playback-metrics"
  | "ambiguous-playback"

type ObservationBase = Readonly<{
  occurredAt: number
  current: PlaybackTarget | null
  rerank: "none" | "immediate"
}>

export type IgnoredPlaybackObservation = ObservationBase &
  Readonly<{
    type: "ignored"
    reason: IgnoredPlaybackReason
    candidate?: TrackCandidate
    context?: PlaybackContext
    tasteOutcome: null
    rerank: "none"
  }>

export type ManualContextExitObservation = ObservationBase &
  Readonly<{
    type: "manual-context-exit"
    candidate: TrackCandidate
    context: PlaybackContext
    tasteOutcome: null
    rerank: "none"
  }>

export type PlayFailureObservation = ObservationBase &
  Readonly<{
    type: "play-failure"
    candidate: TrackCandidate
    context: PlaybackContext
    tasteOutcome: null
    rerank: "immediate"
  }>

type TeachingObservation<Kind extends TastePlaybackOutcome["type"]> = ObservationBase &
  Readonly<{
    type: Kind
    candidate: TrackCandidate
    context: PlaybackContext
    metrics: PlaybackMetrics
    tasteOutcome: TastePlaybackOutcome & { type: Kind }
    rerank: "none"
  }>

export type CompletionObservation = TeachingObservation<"completion">
export type SubstantialPlayObservation = TeachingObservation<"substantial-play">
export type EarlySkipObservation = TeachingObservation<"early-skip">

export type PlaybackObservation =
  | IgnoredPlaybackObservation
  | CompletionObservation
  | SubstantialPlayObservation
  | EarlySkipObservation
  | ManualContextExitObservation
  | PlayFailureObservation

export type PlaybackClock = () => number

const ignored = (
  reason: IgnoredPlaybackReason,
  transition: PlaybackTransition,
  occurredAt: number
): IgnoredPlaybackObservation => ({
  type: "ignored",
  reason,
  occurredAt,
  current: transition.current,
  candidate: transition.previous?.candidate,
  context: transition.previous?.context,
  tasteOutcome: null,
  rerank: "none",
})

const validMetrics = (snapshot: PlaybackSnapshot): PlaybackMetrics | null => {
  const { progressMs, durationMs } = snapshot
  if (
    typeof progressMs !== "number" ||
    !Number.isFinite(progressMs) ||
    progressMs < 0 ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null
  }
  return { progressMs, durationMs, progressRatio: progressMs / durationMs }
}

const isNeutralInterstitial = (uri: string | null | undefined): boolean =>
  uri === "spotify:delimiter" ||
  uri?.startsWith("spotify:ad:") === true ||
  uri?.startsWith("spotify:interstitial:") === true

const teachingObservation = <Kind extends TastePlaybackOutcome["type"]>(
  type: Kind,
  transition: PlaybackTransition & { previous: PlaybackSnapshot },
  metrics: PlaybackMetrics,
  occurredAt: number
): TeachingObservation<Kind> => ({
  type,
  candidate: transition.previous.candidate,
  context: transition.previous.context,
  current: transition.current,
  occurredAt,
  metrics,
  tasteOutcome: {
    type,
    candidate: transition.previous.candidate,
    genres: transition.previous.context.genres,
    occurredAt,
  },
  // Queue mutation during Spotify's songchange/Skip transition can invalidate
  // the track the player is resolving. The taste signal is persisted now and
  // naturally affects the next safe refill instead.
  rerank: "none",
})

/**
 * Classifies one completed playback transition. The function is state-free,
 * calls the injected clock exactly once, and never reads Spicetify globals.
 * Precedence deliberately favors completion, then substantial listening,
 * before considering an early skip so overlapping thresholds cannot create a
 * false negative.
 */
export const classifyPlaybackTransition = (
  transition: PlaybackTransition,
  clock: PlaybackClock
): PlaybackObservation => {
  let occurredAt: number
  try {
    occurredAt = clock()
  } catch {
    return ignored("invalid-clock", transition, 0)
  }
  if (!Number.isFinite(occurredAt) || occurredAt < 0) {
    return ignored("invalid-clock", transition, 0)
  }

  const previous = transition.previous
  if (!previous) return ignored("missing-previous", transition, occurredAt)
  if (!previous.extensionOwned) {
    return ignored("previous-not-extension-owned", transition, occurredAt)
  }

  if (
    transition.cause === "songchange" &&
    transition.current?.uri &&
    transition.current.uri === previous.candidate.uri
  ) {
    return ignored("duplicate-songchange", transition, occurredAt)
  }

  if (transition.cause === "songchange" && isNeutralInterstitial(transition.current?.uri)) {
    return ignored("interstitial", transition, occurredAt)
  }

  if (transition.current?.uri && !transition.current.extensionOwned) {
    return {
      type: "manual-context-exit",
      candidate: previous.candidate,
      context: previous.context,
      current: transition.current,
      occurredAt,
      tasteOutcome: null,
      rerank: "none",
    }
  }

  if (transition.cause === "play-failure") {
    return {
      type: "play-failure",
      candidate: previous.candidate,
      context: previous.context,
      current: transition.current,
      occurredAt,
      tasteOutcome: null,
      rerank: "immediate",
    }
  }

  const metrics = validMetrics(previous)
  if (!metrics) return ignored("invalid-playback-metrics", transition, occurredAt)

  const remainingMs = metrics.durationMs - metrics.progressMs
  if (
    metrics.progressRatio >= COMPLETION_RATIO ||
    (remainingMs >= 0 && remainingMs <= COMPLETION_REMAINING_MS)
  ) {
    return teachingObservation("completion", { ...transition, previous }, metrics, occurredAt)
  }

  if (!transition.current?.uri) return ignored("missing-current", transition, occurredAt)

  if (metrics.progressRatio >= SUBSTANTIAL_RATIO || metrics.progressMs >= SUBSTANTIAL_TIME_MS) {
    return teachingObservation("substantial-play", { ...transition, previous }, metrics, occurredAt)
  }

  if (metrics.progressMs < EARLY_SKIP_TIME_MS || metrics.progressRatio < EARLY_SKIP_RATIO) {
    return teachingObservation("early-skip", { ...transition, previous }, metrics, occurredAt)
  }

  return ignored("ambiguous-playback", transition, occurredAt)
}
