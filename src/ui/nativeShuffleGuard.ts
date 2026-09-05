import { sessionManager } from "../session/SessionManager"
import {
  findNativeShuffleButton,
  isNativeShuffleTarget,
  NATIVE_SHUFFLE_SELECTORS,
} from "./playbarControls"

let hookedButton: HTMLButtonElement | null = null
let shuffleClickBlocker: ((event: Event) => void) | null = null

export const NATIVE_SHUFFLE_BLOCKED_TITLE = "Turn off Similar Mix to use Spotify shuffle"

type NativeButtonAttributes = {
  readonly disabled: boolean
  readonly tabIndex: string | null
  readonly ariaDisabled: string | null
  readonly ariaDescription: string | null
  readonly title: string | null
}

const originalButtonAttributes = new WeakMap<HTMLButtonElement, NativeButtonAttributes>()
const blockedButtons = new WeakSet<HTMLButtonElement>()
const BLOCKED_NATIVE_SHUFFLE_SELECTORS = NATIVE_SHUFFLE_SELECTORS.map(
  (selector) => `${selector}[data-shuffle-similar-blocked="true"]`
).join(", ")
const FOCUSED_BLOCKED_NATIVE_SHUFFLE_SELECTORS = NATIVE_SHUFFLE_SELECTORS.map(
  (selector) => `${selector}[data-shuffle-similar-blocked="true"]:focus-visible`
).join(", ")

const injectStyles = () => {
  if (document.getElementById("shuffle-similar-native-guard-styles")) return

  const style = document.createElement("style")
  style.id = "shuffle-similar-native-guard-styles"
  style.textContent = `
    ${BLOCKED_NATIVE_SHUFFLE_SELECTORS} {
      opacity: 0.55 !important;
      cursor: not-allowed !important;
    }

    ${FOCUSED_BLOCKED_NATIVE_SHUFFLE_SELECTORS} {
      outline: 2px solid var(--spice-text, #ffffff) !important;
      outline-offset: 2px !important;
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
      Spicetify.showNotification(NATIVE_SHUFFLE_BLOCKED_TITLE)
    }
  }

  return shuffleClickBlocker
}

const blockShuffleClicks = (button: HTMLButtonElement) => {
  if (blockedButtons.has(button)) return
  button.addEventListener("click", getShuffleClickBlocker(), true)
  blockedButtons.add(button)
}

const unblockShuffleClicks = (button: HTMLButtonElement) => {
  if (!shuffleClickBlocker || !blockedButtons.has(button)) return
  button.removeEventListener("click", shuffleClickBlocker, true)
  blockedButtons.delete(button)
}

const restoreAttribute = (button: HTMLButtonElement, name: string, value: string | null) => {
  if (value === null) {
    button.removeAttribute(name)
  } else {
    button.setAttribute(name, value)
  }
}

export const applyNativeShuffleBlockedState = (button: HTMLButtonElement, blocked: boolean) => {
  if (blocked) {
    if (!originalButtonAttributes.has(button)) {
      originalButtonAttributes.set(button, {
        disabled: button.disabled,
        tabIndex: button.getAttribute("tabindex"),
        ariaDisabled: button.getAttribute("aria-disabled"),
        ariaDescription: button.getAttribute("aria-description"),
        title: button.getAttribute("title"),
      })
    }

    button.setAttribute("data-shuffle-similar-blocked", "true")
    button.setAttribute("aria-disabled", "true")
    button.setAttribute("aria-description", NATIVE_SHUFFLE_BLOCKED_TITLE)
    button.setAttribute("title", NATIVE_SHUFFLE_BLOCKED_TITLE)
    button.removeAttribute("disabled")
    button.disabled = false
    button.tabIndex = 0
    blockShuffleClicks(button)
    return
  }

  const original = originalButtonAttributes.get(button)
  button.removeAttribute("data-shuffle-similar-blocked")
  unblockShuffleClicks(button)
  if (!original) return

  restoreAttribute(button, "tabindex", original.tabIndex)
  restoreAttribute(button, "aria-disabled", original.ariaDisabled)
  restoreAttribute(button, "aria-description", original.ariaDescription)
  restoreAttribute(button, "title", original.title)
  button.disabled = original.disabled
  originalButtonAttributes.delete(button)
}

export const updateNativeShuffleGuard = () => {
  const blocked = sessionManager.isToggleEnabled()
  enforceNativeShuffleOff()

  const button = findNativeShuffleButton()
  if (!button) {
    if (hookedButton) applyNativeShuffleBlockedState(hookedButton, false)
    hookedButton = null
    return
  }

  if (hookedButton && hookedButton !== button) {
    applyNativeShuffleBlockedState(hookedButton, false)
  }

  hookedButton = button
  applyNativeShuffleBlockedState(button, blocked)
}

export const registerNativeShuffleGuard = () => {
  injectStyles()
  updateNativeShuffleGuard()
}
