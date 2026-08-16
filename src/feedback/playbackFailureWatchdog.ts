export type PlaybackWatchdogSnapshot = {
  uri: string | null
  progressMs: number
  durationMs: number
  isPaused?: boolean
  isBuffering?: boolean
}

export type PlaybackFailureWatchdogOptions = {
  armDelayMs?: number
  confirmationDelayMs?: number
}

const MIN_CONFIRMED_PROGRESS_MS = 1_000
type InspectionPhase = "arming" | "confirming"

/** Conservative fallback for Spicetify, which exposes no playback-error event.
 * It fails closed whenever playback is paused, buffering, foreign, or already
 * producing credible progress. */
export class PlaybackFailureWatchdog {
  private armedUri: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly armDelayMs: number
  private readonly confirmationDelayMs: number

  constructor(
    private readonly readSnapshot: () => PlaybackWatchdogSnapshot,
    private readonly onFailure: (uri: string) => void | Promise<void>,
    options: PlaybackFailureWatchdogOptions = {}
  ) {
    this.armDelayMs = Math.max(100, options.armDelayMs ?? 8_000)
    this.confirmationDelayMs = Math.max(100, options.confirmationDelayMs ?? 2_000)
  }

  observeSongChange(uri: string, extensionOwned: boolean): void {
    this.cancel()
    if (!extensionOwned || !uri.startsWith("spotify:track:")) return
    this.armedUri = uri
    this.schedule(this.armDelayMs, "arming")
  }

  observeProgress(uri: string, progressMs: number): void {
    if (uri !== this.armedUri) return
    if (progressMs >= MIN_CONFIRMED_PROGRESS_MS) {
      this.cancel()
    } else if (!this.timer) {
      this.schedule(this.armDelayMs, "arming")
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.armedUri = null
  }

  private schedule(delayMs: number, phase: InspectionPhase): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.inspect(phase), delayMs)
  }

  private inspect(phase: InspectionPhase): void {
    this.timer = null
    const uri = this.armedUri
    if (!uri) return
    const snapshot = this.readSnapshot()
    if (snapshot.uri !== uri || snapshot.durationMs <= 0) {
      this.cancel()
      return
    }
    if (snapshot.progressMs >= MIN_CONFIRMED_PROGRESS_MS) {
      this.cancel()
      return
    }
    if (snapshot.isPaused || snapshot.isBuffering) {
      return
    }
    if (phase === "arming") {
      this.schedule(this.confirmationDelayMs, "confirming")
      return
    }
    this.cancel()
    void this.onFailure(uri)
  }
}
