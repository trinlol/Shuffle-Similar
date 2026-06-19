import { sessionManager } from "../session/SessionManager"
import {
  findNativeShuffleButton,
  isNativeShuffleTarget,
  NATIVE_SHUFFLE_SELECTORS,
} from "./playbarControls"

let hookedButton: HTMLButtonElement | null = null
let shuffleClickBlocker: ((event: Event) => void) | null = null

const injectStyles = () => {
  if (document.getElementById("shuffle-similar-native-guard-styles")) return

  const style = document.createElement("style")
  style.id = "shuffle-similar-native-guard-styles"
  style.textContent = `
    ${NATIVE_SHUFFLE_SELECTORS.join(", ")}[data-shuffle-similar-blocked="true"] {
      opacity: 0.28 !important;
      cursor: not-allowed !important;
      pointer-events: none !important;
      filter: grayscale(1);
    }
  `
  document.head.appendChild(style)
}

export const enforceNativeShuffleOff = () => {
  if (!sessionManager.isToggleEnabled()) return

  try {
    if (Spicetify.Player.getShuffle?.()) {
      Spicetify.Player.setShuffle(false)
    }
  } catch {
    // ignore
  }
}

const getShuffleClickBlocker = () => {
  if (!shuffleClickBlocker) {
    shuffleClickBlocker = (event: Event) => {
      if (!sessionManager.isToggleEnabled()) return
      if (!isNativeShuffleTarget(event.target)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      enforceNativeShuffleOff()
      Spicetify.showNotification("Turn off Shuffle Similar to use Spotify shuffle", true)
    }
  }

  return shuffleClickBlocker
}

const blockShuffleClicks = (button: HTMLButtonElement) => {
  button.addEventListener("click", getShuffleClickBlocker(), true)
}

const unblockShuffleClicks = (button: HTMLButtonElement) => {
  if (!shuffleClickBlocker) return
  button.removeEventListener("click", shuffleClickBlocker, true)
}

const applyBlockedState = (button: HTMLButtonElement, blocked: boolean) => {
  if (blocked) {
    button.setAttribute("data-shuffle-similar-blocked", "true")
    button.setAttribute("aria-disabled", "true")
    button.disabled = true
    button.tabIndex = -1
    blockShuffleClicks(button)
    return
  }

  button.removeAttribute("data-shuffle-similar-blocked")
  button.removeAttribute("aria-disabled")
  button.disabled = false
  button.tabIndex = 0
  unblockShuffleClicks(button)
}

export const updateNativeShuffleGuard = () => {
  const blocked = sessionManager.isToggleEnabled()
  enforceNativeShuffleOff()

  const button = findNativeShuffleButton()
  if (!button) return

  if (hookedButton && hookedButton !== button) {
    applyBlockedState(hookedButton, false)
  }

  hookedButton = button
  applyBlockedState(button, blocked)
}

export const registerNativeShuffleGuard = () => {
  injectStyles()
  updateNativeShuffleGuard()
}
