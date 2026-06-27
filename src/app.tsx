import { registerContextMenu } from "./ui/contextMenu"
import { registerToggleButton } from "./ui/toggleButton"
import {
  registerNativeShuffleGuard,
  enforceNativeShuffleOff,
  updateNativeShuffleGuard,
} from "./ui/nativeShuffleGuard"
import { removeLegacyExtensionButtons } from "./ui/playbarControls"
import { handleSongChange } from "./services/shuffleEngine"
import { sessionManager } from "./session/SessionManager"

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

  tryRegisterContextMenu()
  setTimeout(tryRegisterContextMenu, 2000)

  Spicetify.Player.addEventListener("songchange", () => {
    if (sessionManager.isToggleEnabled()) {
      enforceNativeShuffleOff()
    }
    updateNativeShuffleGuard()
    void handleSongChange()
  })

  setTimeout(initializePlaybarFeatures, PLAYBAR_INIT_DELAY_MS)

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
