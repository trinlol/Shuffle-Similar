/**
 * Bridges the queue/session services to playback-surface side effects.
 *
 * `shuffleEngine` needs to force Spotify's native shuffle off at a few points,
 * but that behaviour lives in the DOM-bound UI layer. Importing it directly made
 * a service depend on `ui/`, which pulled `document` and the whole playbar
 * module graph into every `shuffleEngine` unit test.
 *
 * The UI registers its implementation during startup; until then, and in tests,
 * the effect is a no-op. This mirrors `ui/shuffleSimilarUiState`, which already
 * uses a registration slot to break the same kind of cycle.
 */
type PlaybackEffect = () => void

let nativeShuffleSuppressor: PlaybackEffect | null = null

export const registerNativeShuffleSuppressor = (effect: PlaybackEffect) => {
  nativeShuffleSuppressor = effect

  return () => {
    if (nativeShuffleSuppressor === effect) nativeShuffleSuppressor = null
  }
}

/** Best-effort: a failing UI effect must never abort a queue transaction. */
export const suppressNativeShuffle = () => {
  try {
    nativeShuffleSuppressor?.()
  } catch (error) {
    console.error("[Shuffle Similar] Native shuffle suppression failed", error)
  }
}
