import { buildDiagnosticsReport, registerDiagnosticsState } from "./diagnostics/operationLog"
import { PlaybackFailureWatchdog } from "./feedback/playbackFailureWatchdog"
import { registerNativeShuffleSuppressor } from "./services/playbackEffects"
import {
  handlePlaybackFailure,
  handleSongChange,
  recoverSimilarMixSession,
} from "./services/shuffleEngine"
import { sessionManager } from "./session/SessionManager"
import type { TrackCandidate } from "./session/types"
import { registerContextMenu } from "./ui/contextMenu"
import {
  enforceNativeShuffleOff,
  registerNativeShuffleGuard,
  updateNativeShuffleGuard,
} from "./ui/nativeShuffleGuard"
import { removeLegacyExtensionButtons } from "./ui/playbarControls"
import { syncShuffleSimilarFromPlayback } from "./ui/shuffleSimilarUiState"
import { registerToggleButton } from "./ui/toggleButton"

const GLOBAL_LOAD_KEY = "__shuffleSimilarExtensionLoaded__"
const globalScope = globalThis as typeof globalThis & { [GLOBAL_LOAD_KEY]?: boolean }

if (globalScope[GLOBAL_LOAD_KEY]) {
  console.warn(
    "[Shuffle Similar] Extension already loaded — remove duplicate entries from spicetify config extensions and delete old better-shuffle.js / similar-shuffle.js files"
  )
} else {
  globalScope[GLOBAL_LOAD_KEY] = true
  bootExtension()
}

function bootExtension() {
  removeLegacyExtensionButtons()

  // Lets the service layer suppress native shuffle without importing the DOM-bound UI.
  registerNativeShuffleSuppressor(enforceNativeShuffleOff)

  registerDiagnosticsState(() => ({
    toggleEnabled: sessionManager.isToggleEnabled(),
    sessionActive: sessionManager.isActive(),
  }))
  // Console access for bug reports: copy(__shuffleSimilarDiagnostics())
  ;(globalThis as { __shuffleSimilarDiagnostics?: () => string }).__shuffleSimilarDiagnostics =
    buildDiagnosticsReport

  const RECOVERY_RETRY_DELAY_MS = 350

  let initialized = false
  let playbarInitialized = false
  const playbackFailureWatchdog = new PlaybackFailureWatchdog(
    () => ({
      uri: Spicetify.Player.data?.item?.uri ?? null,
      progressMs: Spicetify.Player.getProgress(),
      durationMs: Spicetify.Player.getDuration(),
      isPaused: Boolean(Spicetify.Player.data?.isPaused),
      isBuffering: Boolean(Spicetify.Player.data?.isBuffering),
    }),
    (uri) => {
      void handlePlaybackFailure(uri)
    }
  )

  const initializePlaybarFeatures = () => {
    if (playbarInitialized) return
    playbarInitialized = true

    try {
      registerNativeShuffleGuard()
    } catch (error) {
      console.error("[Shuffle Similar] Native shuffle guard failed", error)
    }

    try {
      registerToggleButton()
    } catch (error) {
      console.error("[Shuffle Similar] Playbar button registration failed", error)
    }
  }

  const tryRegisterContextMenu = () => {
    try {
      registerContextMenu()
    } catch (error) {
      console.error("[Shuffle Similar] Context menu registration failed", error)
    }
  }

  const getCurrentPlayerTrackInfo = ():
    | (Pick<TrackCandidate, "uri"> &
        Partial<Pick<TrackCandidate, "trackName" | "artistUri" | "artistName">>)
    | null => {
    const item = Spicetify.Player.data?.item
    const uri = item?.uri
    if (!uri?.startsWith("spotify:track:")) return null
    return {
      uri,
      trackName: item.name || item.metadata?.title || undefined,
      artistUri: item.artists?.[0]?.uri || item.metadata?.artist_uri || undefined,
      artistName: item.artists?.[0]?.name || item.metadata?.artist_name || undefined,
    }
  }

  const initializeExtension = () => {
    if (initialized) return
    initialized = true

    void sessionManager.initializeTasteIdentity()

    tryRegisterContextMenu()
    setTimeout(tryRegisterContextMenu, 2000)

    let lastObservedPlayerTrack = getCurrentPlayerTrackInfo()
    let lastRememberedProgressUri: string | null = null

    Spicetify.Player.addEventListener("songchange", () => {
      if (lastObservedPlayerTrack && lastObservedPlayerTrack.uri !== lastRememberedProgressUri) {
        sessionManager.rememberPlayedTrack(lastObservedPlayerTrack)
        lastRememberedProgressUri = lastObservedPlayerTrack.uri
      }
      lastObservedPlayerTrack = getCurrentPlayerTrackInfo()
      if (lastObservedPlayerTrack?.uri !== lastRememberedProgressUri) {
        lastRememberedProgressUri = null
      }
      if (sessionManager.isToggleEnabled()) {
        enforceNativeShuffleOff()
      }
      updateNativeShuffleGuard()
      const uri = Spicetify.Player.data?.item?.uri ?? ""
      void handleSongChange().then((result) => {
        if ((Spicetify.Player.data?.item?.uri ?? "") !== uri) return
        if (result === "stopped") {
          playbackFailureWatchdog.cancel()
          updateNativeShuffleGuard()
          syncShuffleSimilarFromPlayback()
          return
        }
        syncShuffleSimilarFromPlayback()
        playbackFailureWatchdog.observeSongChange(uri, sessionManager.ownsQueueTrack(uri))
      })
    })
    Spicetify.Player.addEventListener("onprogress", () => {
      const progress = Spicetify.Player.getProgress()
      const currentTrack = getCurrentPlayerTrackInfo()
      if (currentTrack) {
        lastObservedPlayerTrack = currentTrack
        if (progress >= 1_000 && currentTrack.uri !== lastRememberedProgressUri) {
          lastRememberedProgressUri = currentTrack.uri
          sessionManager.rememberPlayedTrack(currentTrack)
        }
      }
      if (sessionManager.isActive()) {
        sessionManager.recordProgress(
          progress,
          Spicetify.Player.getDuration(),
          Spicetify.Player.getRepeat() === 2
        )
        const uri = currentTrack?.uri ?? Spicetify.Player.data?.item?.uri
        if (uri) {
          playbackFailureWatchdog.observeProgress(uri, progress)
          if (progress >= 1_000) sessionManager.confirmPlayback(uri)
        }
      }
    })

    initializePlaybarFeatures()

    const attemptSessionRecovery = (allowRetry: boolean) => {
      void recoverSimilarMixSession().then((recovered) => {
        if (recovered) {
          syncShuffleSimilarFromPlayback()
          console.info("[Shuffle Similar] Recovered the active Similar Mix queue")
        } else if (allowRetry) {
          setTimeout(() => attemptSessionRecovery(false), RECOVERY_RETRY_DELAY_MS)
        }
      })
    }
    attemptSessionRecovery(true)

    console.info("[Shuffle Similar] Extension initialized")
  }

  const isSpicetifyReady = () =>
    Boolean(Spicetify.Platform && Spicetify.Player && Spicetify.URI && Spicetify.ContextMenu?.Item)

  const waitForSpicetify = () => {
    if (isSpicetifyReady()) {
      initializeExtension()
      return
    }

    setTimeout(waitForSpicetify, 50)
  }

  const spicetifyEvents = (
    Spicetify as {
      Events?: {
        platformLoaded?: { addListener?: (fn: () => void) => void }
        webpackLoaded?: { addListener?: (fn: () => void) => void }
      }
    }
  ).Events
  spicetifyEvents?.platformLoaded?.addListener?.(waitForSpicetify)
  spicetifyEvents?.webpackLoaded?.addListener?.(() => {
    tryRegisterContextMenu()
  })
  waitForSpicetify()
}
