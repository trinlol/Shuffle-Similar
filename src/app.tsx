import { registerContextMenu } from "./ui/contextMenu"
import { registerToggleButton } from "./ui/toggleButton"
import {
  registerNativeShuffleGuard,
  enforceNativeShuffleOff,
  updateNativeShuffleGuard,
} from "./ui/nativeShuffleGuard"
import { removeLegacyExtensionButtons } from "./ui/playbarControls"
import {
  handlePlaybackFailure,
  handleSongChange,
  recoverSimilarMixSession,
} from "./services/shuffleEngine"
import { sessionManager } from "./session/SessionManager"
import { syncShuffleSimilarFromPlayback } from "./ui/shuffleSimilarUiState"
import { PlaybackFailureWatchdog } from "./feedback/playbackFailureWatchdog"

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

const PLAYBAR_INIT_DELAY_MS = 4000

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
  (uri) => { void handlePlaybackFailure(uri) }
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

const initializeExtension = () => {
  if (initialized) return
  initialized = true

  void sessionManager.initializeTasteIdentity()

  tryRegisterContextMenu()
  setTimeout(tryRegisterContextMenu, 2000)

  Spicetify.Player.addEventListener("songchange", () => {
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
      playbackFailureWatchdog.observeSongChange(uri, sessionManager.ownsQueueTrack(uri))
    })
  })
  Spicetify.Player.addEventListener("onprogress", () => {
    if (sessionManager.isActive()) {
      const progress = Spicetify.Player.getProgress()
      sessionManager.recordProgress(
        progress,
        Spicetify.Player.getDuration(),
        Spicetify.Player.getRepeat() === 2
      )
      const uri = Spicetify.Player.data?.item?.uri
      if (uri) {
        playbackFailureWatchdog.observeProgress(uri, progress)
        if (progress >= 1_000) sessionManager.confirmPlayback(uri)
      }
    }
  })

  setTimeout(initializePlaybarFeatures, PLAYBAR_INIT_DELAY_MS)
  setTimeout(() => {
    void recoverSimilarMixSession().then((recovered) => {
      if (recovered) {
        syncShuffleSimilarFromPlayback()
        console.info("[Shuffle Similar] Recovered the active Similar Mix queue")
      }
    })
  }, PLAYBAR_INIT_DELAY_MS + 250)

  console.info("[Shuffle Similar] Extension initialized")
}

const isSpicetifyReady = () =>
  Boolean(
    Spicetify.Platform &&
      Spicetify.Player &&
      Spicetify.URI &&
      Spicetify.ContextMenu?.Item &&
      Spicetify.Menu?.Item &&
      Spicetify.PopupModal
  )

const waitForSpicetify = () => {
  if (isSpicetifyReady()) {
    initializeExtension()
    return
  }

  setTimeout(waitForSpicetify, 200)
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
