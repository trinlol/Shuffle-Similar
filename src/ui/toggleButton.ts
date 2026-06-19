import { sessionManager } from "../session/SessionManager"
import { enableAutoplayGuard, disableAutoplayGuard } from "../queue/autoplayGuard"
import { reshuffleFromCurrentTrack, reshuffleOnToggleOff } from "../services/shuffleEngine"
import { registerShuffleSimilarUiSync } from "./shuffleSimilarUiState"
import { enforceNativeShuffleOff, updateNativeShuffleGuard } from "./nativeShuffleGuard"
import {
  SHUFFLE_SIMILAR_TEST_ID,
  findNativeShuffleButton,
  placeElementBeforeShuffle,
  removeLegacyExtensionButtons,
  watchForLegacyExtensionButtons,
} from "./playbarControls"
import { applyEnhanceIcon, applyRefreshIcon } from "./icons"
import { debounce } from "../utils/debounce"

const STYLE_ID = "shuffle-similar-button-styles"
const BUTTON_CLASS = "shuffle-similar-playbar-btn"
const CLICK_ANIMATION_CLASS = "shuffle-similar-click"
const TEST_ID = SHUFFLE_SIMILAR_TEST_ID
const DEFAULT_ICON = "enhance" as const

let buttonElement: HTMLButtonElement | null = null
let buttonTippy: { setContent: (content: string) => void } | null = null
let isBusy = false
let placementObserver: MutationObserver | null = null

const injectStyles = () => {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
    button[data-testid="${TEST_ID}"].${BUTTON_CLASS} {
      position: relative;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      opacity: 1 !important;
      visibility: visible !important;
      transition: color 0.25s ease;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="false"] {
      color: rgba(var(--spice-rgb-text), 0.7) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="false"] svg {
      filter: none !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="true"] {
      color: var(--spice-button) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="true"] svg {
      filter: drop-shadow(0 0 6px rgba(var(--spice-rgb-selected-row), 0.85));
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}.${CLICK_ANIMATION_CLASS} {
      animation: shuffle-similar-pulse 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}.${CLICK_ANIMATION_CLASS}::after {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid var(--spice-button);
      opacity: 0;
      animation: shuffle-similar-ring 0.65s ease-out forwards;
      pointer-events: none;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[data-hover-refresh="true"] svg {
      animation: shuffle-similar-spin 0.6s ease-out 1;
    }

    @keyframes shuffle-similar-pulse {
      0% { transform: scale(1); }
      35% { transform: scale(1.18); }
      100% { transform: scale(1); }
    }

    @keyframes shuffle-similar-ring {
      0% {
        opacity: 0.85;
        transform: scale(0.75);
      }
      100% {
        opacity: 0;
        transform: scale(1.75);
      }
    }

    @keyframes shuffle-similar-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `
  document.head.appendChild(style)
}

const applyButtonIcon = (icon: "default" | "reload") => {
  const svg = buttonElement?.querySelector("svg")
  if (!svg) return

  if (icon === "reload") {
    applyRefreshIcon(svg)
    return
  }

  applyEnhanceIcon(svg)
}

const updateTooltip = (label: string) => {
  buttonElement?.setAttribute("aria-label", label)
  buttonElement?.setAttribute("title", label)
  buttonTippy?.setContent(label)
}

const refreshTooltip = () => {
  if (!sessionManager.isToggleEnabled()) {
    updateTooltip("Shuffle Similar")
    return
  }

  updateTooltip("Turn off Shuffle Similar · Shift+click to reshuffle")
}

const handleMouseEnter = () => {
  if (!buttonElement || !sessionManager.isToggleEnabled()) return
  buttonElement.setAttribute("data-hover-refresh", "true")
  applyButtonIcon("reload")
}

const handleMouseLeave = () => {
  if (!buttonElement) return
  buttonElement.removeAttribute("data-hover-refresh")
  applyButtonIcon("default")
}

const playClickAnimation = () => {
  if (!buttonElement) return

  buttonElement.classList.remove(CLICK_ANIMATION_CLASS)
  void buttonElement.offsetWidth
  buttonElement.classList.add(CLICK_ANIMATION_CLASS)

  const handleAnimationEnd = () => {
    buttonElement?.classList.remove(CLICK_ANIMATION_CLASS)
    buttonElement?.removeEventListener("animationend", handleAnimationEnd)
  }
  buttonElement.addEventListener("animationend", handleAnimationEnd)
}

const stripActivePresentation = (button: HTMLButtonElement) => {
  for (const className of Array.from(button.classList)) {
    if (className.toLowerCase().includes("active")) {
      button.classList.remove(className)
    }
  }

  button.removeAttribute("data-active")

  const svg = button.querySelector("svg")
  svg?.style.removeProperty("filter")
  svg?.style.removeProperty("color")
}

const setButtonActive = (active: boolean) => {
  if (!buttonElement) return
  buttonElement.setAttribute("aria-checked", active ? "true" : "false")
  buttonElement.classList.toggle("active", active)

  if (!active) {
    stripActivePresentation(buttonElement)
  }
}

const placeButton = (): boolean => {
  if (!buttonElement) return false
  return placeElementBeforeShuffle(buttonElement)
}

const createShuffleSimilarButton = (shuffleReference: HTMLButtonElement): HTMLButtonElement => {
  const button = shuffleReference.cloneNode(true) as HTMLButtonElement

  button.setAttribute("data-testid", TEST_ID)
  button.setAttribute("aria-label", "Shuffle Similar")
  button.setAttribute("aria-checked", "false")
  button.classList.add(BUTTON_CLASS)
  button.removeAttribute("disabled")
  button.removeAttribute("data-shuffle-similar-blocked")
  button.removeAttribute("aria-disabled")
  button.tabIndex = 0

  stripActivePresentation(button)

  const svg = button.querySelector("svg")
  if (svg) {
    applyEnhanceIcon(svg)
  }

  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    handleButtonClick(event)
  })
  button.addEventListener("mouseenter", handleMouseEnter)
  button.addEventListener("mouseleave", handleMouseLeave)

  return button
}

const mountButton = (): boolean => {
  removeLegacyExtensionButtons()

  if (buttonElement && document.contains(buttonElement)) {
    syncButtonFromSession()
    return placeButton()
  }

  const shuffleButton = findNativeShuffleButton()
  if (!shuffleButton) return false

  injectStyles()

  if (buttonElement && !document.contains(buttonElement)) {
    buttonElement = null
  }

  buttonElement = createShuffleSimilarButton(shuffleButton)
  shuffleButton.before(buttonElement)

  if (Spicetify.Tippy && Spicetify.TippyProps) {
    buttonTippy = Spicetify.Tippy(buttonElement, {
      ...Spicetify.TippyProps,
      content: "Shuffle Similar",
    })
  }

  syncButtonFromSession()

  console.info("[Shuffle Similar] Playbar button mounted left of shuffle")
  return true
}

const ensureButtonInDom = () => {
  if (!buttonElement || !document.contains(buttonElement)) {
    buttonElement = null
    mountButton()
    return
  }

  placeButton()
  syncButtonFromSession()
}

const schedulePlacementWatch = () => {
  if (placementObserver) return

  const shuffleButton = findNativeShuffleButton()
  const parent = shuffleButton?.parentElement
  if (!parent) return

  const syncPlacement = debounce(() => {
    ensureButtonInDom()
    if (sessionManager.isToggleEnabled()) {
      updateNativeShuffleGuard()
    }
  }, 750)

  placementObserver = new MutationObserver(syncPlacement)
  placementObserver.observe(parent, { childList: true })
}

const syncButtonFromSession = () => {
  const enabled = sessionManager.isToggleEnabled()
  setButtonActive(enabled)
  if (!enabled) {
    buttonElement?.removeAttribute("data-hover-refresh")
    applyButtonIcon("default")
  }
  refreshTooltip()
}

const handleButtonClick = (event: MouseEvent) => {
  if (!buttonElement || isBusy) return

  if (!sessionManager.isToggleEnabled()) {
    void enableShuffleSimilar()
    return
  }

  if (event.shiftKey) {
    void reshuffleActiveSession()
    return
  }

  void disableShuffleSimilar()
}

const waitForShuffleButton = () => {
  const attemptMount = () => {
    if (!mountButton()) return false
    schedulePlacementWatch()
    return true
  }

  if (attemptMount()) return

  let attempts = 0
  const interval = setInterval(() => {
    attempts += 1
    if (attemptMount() || attempts >= 60) {
      clearInterval(interval)
      if (attempts >= 60) {
        console.warn("[Shuffle Similar] Could not find shuffle button to mount playbar control")
      }
    }
  }, 2000)
}

const enableShuffleSimilar = async () => {
  if (isBusy) return
  isBusy = true
  playClickAnimation()

  try {
    sessionManager.setToggleEnabled(true)
    enforceNativeShuffleOff()
    enableAutoplayGuard()
    updateNativeShuffleGuard()
    setButtonActive(true)
    refreshTooltip()
    Spicetify.showNotification("Building Shuffle Similar queue...")
    await reshuffleFromCurrentTrack()
  } catch (error) {
    console.error("[Shuffle Similar]", error)
    setButtonActive(false)
    sessionManager.setToggleEnabled(false)
    disableAutoplayGuard()
    sessionManager.endSession()
    updateNativeShuffleGuard()
    refreshTooltip()
    Spicetify.showNotification(
      error instanceof Error ? error.message : "Shuffle Similar failed",
      true
    )
  } finally {
    isBusy = false
  }
}

const reshuffleActiveSession = async () => {
  if (isBusy) return
  isBusy = true
  playClickAnimation()

  try {
    Spicetify.showNotification("Reshuffling queue...")
    await reshuffleFromCurrentTrack()
    refreshTooltip()
  } catch (error) {
    console.error("[Shuffle Similar]", error)
    Spicetify.showNotification(
      error instanceof Error ? error.message : "Reshuffle failed",
      true
    )
  } finally {
    isBusy = false
  }
}

const disableShuffleSimilar = async () => {
  if (isBusy) return
  isBusy = true
  playClickAnimation()

  try {
    sessionManager.setToggleEnabled(false)
    disableAutoplayGuard()
    sessionManager.endSession()
    setButtonActive(false)
    buttonElement?.removeAttribute("data-hover-refresh")
    applyButtonIcon("default")
    updateNativeShuffleGuard()
    refreshTooltip()
    await reshuffleOnToggleOff()
    Spicetify.showNotification("Shuffle Similar disabled")
  } catch (error) {
    console.error("[Shuffle Similar]", error)
    sessionManager.setToggleEnabled(false)
    disableAutoplayGuard()
    sessionManager.endSession()
    setButtonActive(false)
    updateNativeShuffleGuard()
    refreshTooltip()
    Spicetify.showNotification(
      error instanceof Error ? error.message : "Shuffle Similar failed",
      true
    )
  } finally {
    isBusy = false
  }
}

const syncUiFromPlayback = () => {
  sessionManager.setToggleEnabled(true)
  enforceNativeShuffleOff()
  enableAutoplayGuard()
  updateNativeShuffleGuard()
  ensureButtonInDom()
  syncButtonFromSession()
}

export const registerToggleButton = () => {
  removeLegacyExtensionButtons()
  watchForLegacyExtensionButtons()
  registerShuffleSimilarUiSync(syncUiFromPlayback)
  waitForShuffleButton()
}
