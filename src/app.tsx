import { registerContextMenu } from "./ui/contextMenu"
import { registerSettingsMenu } from "./ui/settingsPage"
import { registerToggleButton } from "./ui/toggleButton"
import {
  registerNativeShuffleGuard,
  enforceNativeShuffleOff,
  updateNativeShuffleGuard,
} from "./ui/nativeShuffleGuard"
import { handleSongChange } from "./services/shuffleEngine"
import { sessionManager } from "./session/SessionManager"

const PLAYBAR_INIT_DELAY_MS = 4000

let initialized = false
let playbarInitialized = false

const initializePlaybarFeatures = () => {
  if (playbarInitialized) return
  playbarInitialized = true

  try {
    registerNativeShuffleGuard()
  } catch (error) {
    console.error("[Better Shuffle] Native shuffle guard failed", error)
  }

  try {
    registerToggleButton()
  } catch (error) {
    console.error("[Better Shuffle] Playbar button registration failed", error)
  }
}

const tryRegisterContextMenu = () => {
  try {
    registerContextMenu()
  } catch (error) {
    console.error("[Better Shuffle] Context menu registration failed", error)
  }
}

const tryRegisterSettingsMenu = () => {
  try {
    registerSettingsMenu()
  } catch (error) {
    console.error("[Better Shuffle] Settings menu registration failed", error)
  }
}

const initializeExtension = () => {
  if (initialized) return
  initialized = true

  tryRegisterContextMenu()
  tryRegisterSettingsMenu()
  setTimeout(tryRegisterContextMenu, 2000)
  setTimeout(tryRegisterSettingsMenu, 2000)

  Spicetify.Player.addEventListener("songchange", () => {
    enforceNativeShuffleOff()
    if (sessionManager.isToggleEnabled()) {
      updateNativeShuffleGuard()
    }
    void handleSongChange()
  })

  setTimeout(initializePlaybarFeatures, PLAYBAR_INIT_DELAY_MS)

  console.info("[Better Shuffle] Extension initialized")
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
  tryRegisterSettingsMenu()
})
waitForSpicetify()
