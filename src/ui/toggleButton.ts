import { disableAutoplayGuard, enableAutoplayGuard } from "../queue/autoplayGuard"
import {
  clearSimilarMixRecovery,
  reshuffleFromCurrentTrack,
  reshuffleOnToggleOff,
} from "../services/shuffleEngine"
import { sessionManager } from "../session/SessionManager"
import { debounce } from "../utils/debounce"
import { applyEnhanceIcon } from "./icons"
import { enforceNativeShuffleOff, updateNativeShuffleGuard } from "./nativeShuffleGuard"
import {
  findNativeShuffleButton,
  placeElementBeforeShuffle,
  playbarMutationsAffectControls,
  removeLegacyExtensionButtons,
  SHUFFLE_SIMILAR_TEST_ID,
  sanitizeClonedPlaybarButton,
  watchForLegacyExtensionButtons,
} from "./playbarControls"
import { registerShuffleSimilarUiSync, shuffleSimilarStatus } from "./shuffleSimilarUiState"
import {
  mapSimilarMixError,
  mountSimilarMixStatus,
  type SimilarMixPublicError,
  type SimilarMixStatusMount,
  type SimilarMixStatusSnapshot,
} from "./status"

const STYLE_ID = "shuffle-similar-button-styles"
const BUTTON_CLASS = "shuffle-similar-playbar-btn"
const TEST_ID = SHUFFLE_SIMILAR_TEST_ID

let buttonElement: HTMLButtonElement | null = null
let buttonTippy: { setContent: (content: string) => void } | null = null
let isBusy = false
let placementObserver: MutationObserver | null = null
let placementObserverRoot: HTMLElement | null = null
let statusObserver: MutationObserver | null = null
let statusObserverRoot: HTMLElement | null = null
let statusMount: SimilarMixStatusMount | null = null
let registered = false

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
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      padding: 0;
      border: none;
      background: transparent !important;
      border-radius: 50%;
      flex-shrink: 0;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
      color: rgba(var(--spice-rgb-text, 255, 255, 255), 0.72) !important;
      transition: color 160ms ease, opacity 160ms ease, transform 120ms ease;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}:hover {
      color: var(--spice-text, #ffffff) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-pressed="true"] {
      color: var(--spice-button-active, var(--spice-button, var(--accent-color, #1ed760))) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-pressed="true"]::after {
      content: "";
      position: absolute;
      bottom: 2px;
      left: 50%;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background-color: currentColor;
      transform: translateX(-50%);
      pointer-events: none;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-busy="true"] {
      cursor: progress;
      opacity: 0.72 !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}:focus-visible {
      outline: 2px solid var(--spice-text, #ffffff) !important;
      outline-offset: 2px !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}:active:not([aria-busy="true"]) {
      transform: scale(0.94);
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS} svg {
      width: 16px !important;
      height: 16px !important;
      fill: currentColor !important;
      color: inherit !important;
      filter: none !important;
      display: block !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS} svg path {
      fill: currentColor !important;
    }

    body > #similar-mix-status {
      position: fixed;
      left: 50%;
      bottom: 78px;
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transform: translate(-50%, 6px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
    }

    body > #similar-mix-status[data-state="building"],
    body > #similar-mix-status[data-state="refreshing"],
    body > #similar-mix-status[data-state="stopping"],
    body > #similar-mix-status[data-state="error"],
    body > #similar-mix-status[data-state="degraded"] {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, 0);
    }

    body > #similar-mix-status[data-state="on"] {
      visibility: visible;
      animation: similar-mix-confirm 2.4s ease forwards;
    }

    @keyframes similar-mix-confirm {
      0% { opacity: 0; transform: translate(-50%, 6px); }
      12%, 76% { opacity: 1; transform: translate(-50%, 0); }
      100% { opacity: 0; visibility: hidden; transform: translate(-50%, -2px); }
    }

    @media (prefers-reduced-motion: reduce) {
      button[data-testid="${TEST_ID}"].${BUTTON_CLASS},
      body > #similar-mix-status {
        transition: none;
      }

      button[data-testid="${TEST_ID}"].${BUTTON_CLASS}:active:not([aria-busy="true"]) {
        transform: none;
      }

      body > #similar-mix-status[data-state="on"] {
        animation: none;
        opacity: 0;
        visibility: visible;
        transform: translate(-50%, 0);
      }
    }
  `
  document.head.appendChild(style)
}

export type ToggleButtonPresentation = {
  readonly pressed: boolean
  readonly busy: boolean
  readonly label: string
}

export const getToggleButtonPresentation = (
  snapshot: SimilarMixStatusSnapshot,
  enabled: boolean
): ToggleButtonPresentation => {
  let label = "Turn on Similar Mix"

  if (snapshot.state === "building") label = "Building Similar Mix…"
  else if (snapshot.state === "refreshing") label = "Refreshing Similar Mix…"
  else if (snapshot.state === "stopping") label = "Turning off Similar Mix…"
  else if (enabled) label = "Turn off Similar Mix · Shift+click to refresh"
  else if (snapshot.state === "error") label = "Retry Similar Mix"

  return {
    pressed: enabled,
    busy: snapshot.copy.busy,
    label,
  }
}

const applyButtonIcon = () => {
  const svg = buttonElement?.querySelector("svg")
  if (!svg) return

  applyEnhanceIcon(svg)
  svg.setAttribute("aria-hidden", "true")
  svg.removeAttribute("aria-label")
}

const updateTooltip = (label: string) => {
  buttonElement?.setAttribute("aria-label", label)
  buttonElement?.setAttribute("title", label)
  buttonTippy?.setContent(label)
}

const OBSCURED_ACTIVE_CLASSES = new Set([
  "A6OB2PW88hienapJaToK",
  "wnuQy_DUIeaUfitOSBBL",
  "encore-internal-color-text-bright-accent",
])

const stripActivePresentation = (button: HTMLButtonElement) => {
  const elements = [button, ...Array.from(button.querySelectorAll<HTMLElement>("*"))]
  for (const element of elements) {
    for (const className of Array.from(element.classList)) {
      if (className.toLowerCase().includes("active") || OBSCURED_ACTIVE_CLASSES.has(className)) {
        element.classList.remove(className)
      }
    }
  }

  button.removeAttribute("data-active")

  const svg = button.querySelector("svg")
  svg?.style.removeProperty("filter")
  svg?.style.removeProperty("color")
}

const renderButton = (snapshot = shuffleSimilarStatus.getSnapshot()) => {
  if (!buttonElement) return

  const presentation = getToggleButtonPresentation(snapshot, sessionManager.isToggleEnabled())
  buttonElement.setAttribute("aria-pressed", presentation.pressed ? "true" : "false")
  buttonElement.setAttribute("aria-busy", presentation.busy ? "true" : "false")
  buttonElement.dataset.similarMixState = snapshot.state
  stripActivePresentation(buttonElement)
  applyButtonIcon()
  updateTooltip(presentation.label)
}

const mountLiveStatus = () => {
  if (!document.body) return
  statusMount = mountSimilarMixStatus(shuffleSimilarStatus, {
    document,
    target: document.body,
  })
}

const scheduleStatusWatch = () => {
  const root = document.body
  if (!root || (statusObserver && statusObserverRoot === root)) return

  statusObserver?.disconnect()
  statusObserverRoot = root
  statusObserver = new MutationObserver(() => {
    if (statusMount && document.contains(statusMount.element)) return
    mountLiveStatus()
  })
  statusObserver.observe(root, { childList: true })
}

const placeButton = (): boolean => {
  if (!buttonElement) return false
  return placeElementBeforeShuffle(buttonElement)
}

const createFallbackPlaybarButton = (): HTMLButtonElement => {
  const button = document.createElement("button")
  button.type = "button"
  button.tabIndex = 0
  button.setAttribute("data-encore-id", "buttonTertiary")
  button.className = "Button-buttonTertiary-small-iconOnly-useBrowserDefaultFocusStyle"

  const iconWrapper = document.createElement("span")
  iconWrapper.className = "e-91000-button__icon-wrapper"
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  iconWrapper.appendChild(svg)
  button.appendChild(iconWrapper)
  return button
}

const createShuffleSimilarButton = (
  shuffleReference: HTMLButtonElement | null
): HTMLButtonElement => {
  const button = shuffleReference
    ? sanitizeClonedPlaybarButton(shuffleReference.cloneNode(true) as HTMLButtonElement)
    : createFallbackPlaybarButton()

  button.setAttribute("data-testid", TEST_ID)
  button.setAttribute("aria-label", "Turn on Similar Mix")
  button.setAttribute("title", "Turn on Similar Mix")
  button.setAttribute("aria-pressed", "false")
  button.setAttribute("aria-busy", "false")
  button.classList.add(BUTTON_CLASS)

  stripActivePresentation(button)

  let svg = button.querySelector("svg")
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 16 16")
    svg.setAttribute("width", "16")
    svg.setAttribute("height", "16")
    button.appendChild(svg)
  }

  applyEnhanceIcon(svg)
  svg.setAttribute("aria-hidden", "true")
  svg.removeAttribute("aria-label")

  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    handleButtonClick(event)
  })

  return button
}

const syncButtonFromSession = () => {
  const enabled = sessionManager.isToggleEnabled()
  const state = shuffleSimilarStatus.getSnapshot().state

  if (!isBusy) {
    if (enabled && state !== "on" && state !== "degraded") {
      shuffleSimilarStatus.transitionTo("on")
    } else if (!enabled && state !== "off" && state !== "error") {
      shuffleSimilarStatus.transitionTo("off")
    }
  }

  mountLiveStatus()
  scheduleStatusWatch()
  renderButton()
}

const mountButton = (): boolean => {
  removeLegacyExtensionButtons()

  if (buttonElement && document.contains(buttonElement)) {
    syncButtonFromSession()
    return placeButton()
  }

  const shuffleButton = findNativeShuffleButton()
  const leftControls =
    document.querySelector<HTMLElement>('[data-testid="now-playing-bar"] .player-controls__left') ??
    document.querySelector<HTMLElement>(
      ".main-nowPlayingBar-nowPlayingBar .player-controls__left"
    ) ??
    document.querySelector<HTMLElement>(".player-controls__left")

  if (!shuffleButton && !leftControls) return false

  injectStyles()

  if (buttonElement && !document.contains(buttonElement)) {
    buttonElement = null
    buttonTippy = null
  }

  const orphan = document.querySelector(`[data-testid="${TEST_ID}"]`)
  if (orphan && orphan !== buttonElement) orphan.remove()

  buttonElement = createShuffleSimilarButton(shuffleButton)
  if (!placeElementBeforeShuffle(buttonElement)) {
    buttonElement = null
    return false
  }

  if (Spicetify.Tippy && Spicetify.TippyProps) {
    buttonTippy = Spicetify.Tippy(buttonElement, {
      ...Spicetify.TippyProps,
      content: getToggleButtonPresentation(
        shuffleSimilarStatus.getSnapshot(),
        sessionManager.isToggleEnabled()
      ).label,
    })
  }

  syncButtonFromSession()

  console.info("[Shuffle Similar] Playbar button mounted left of shuffle")
  return true
}

const ensureButtonInDom = () => {
  if (!buttonElement || !document.contains(buttonElement)) {
    buttonElement = null
    buttonTippy = null
    mountButton()
    return
  }

  placeButton()
  syncButtonFromSession()
}

const schedulePlacementWatch = () => {
  const shuffleButton = findNativeShuffleButton()
  const playbar =
    document.querySelector<HTMLElement>('[data-testid="now-playing-bar"]') ??
    document.querySelector<HTMLElement>(".main-nowPlayingBar-nowPlayingBar") ??
    document.querySelector<HTMLElement>(".player-controls__left")
  const root = playbar ?? shuffleButton?.parentElement ?? null
  if (!root) return
  if (placementObserver && placementObserverRoot === root) return

  placementObserver?.disconnect()
  placementObserverRoot = root

  const syncPlacement = debounce(() => {
    ensureButtonInDom()
    schedulePlacementWatch()
    updateNativeShuffleGuard()
  }, 200)

  placementObserver = new MutationObserver((records) => {
    if (playbarMutationsAffectControls(records, buttonElement)) syncPlacement()
  })
  placementObserver.observe(root, { childList: true, subtree: true })
}

const notifyPublicError = (error: unknown, remainsActive = false): SimilarMixPublicError => {
  const publicError = mapSimilarMixError(error)
  const message = remainsActive
    ? `Similar Mix is still on. ${publicError.message}`
    : `${publicError.title}. ${publicError.message}`
  Spicetify.showNotification(message, !remainsActive)
  return publicError
}

const enableShuffleSimilar = async () => {
  if (isBusy) return
  isBusy = true
  const transaction = shuffleSimilarStatus.beginTransition("building")

  try {
    if (!Spicetify.Player.data?.item?.uri) {
      const publicError = notifyPublicError("NO_ACTIVE_TRACK")
      transaction.fail(publicError)
      return
    }

    await reshuffleFromCurrentTrack()
    sessionManager.setToggleEnabled(true)
    enableAutoplayGuard()
    enforceNativeShuffleOff()
    updateNativeShuffleGuard()
    transaction.commit("on")
  } catch (error) {
    sessionManager.setToggleEnabled(false)
    disableAutoplayGuard()
    sessionManager.endSession()
    clearSimilarMixRecovery()
    updateNativeShuffleGuard()
    transaction.fail(notifyPublicError(error))
  } finally {
    isBusy = false
    renderButton()
  }
}

const reshuffleActiveSession = async () => {
  if (isBusy) return
  isBusy = true
  const transaction = shuffleSimilarStatus.beginTransition("refreshing")

  try {
    if (!Spicetify.Player.data?.item?.uri) {
      const publicError = notifyPublicError("NO_ACTIVE_TRACK", true)
      transaction.degrade(publicError)
      return
    }

    await reshuffleFromCurrentTrack()
    sessionManager.setToggleEnabled(true)
    enableAutoplayGuard()
    enforceNativeShuffleOff()
    updateNativeShuffleGuard()
    transaction.commit("on")
  } catch (error) {
    sessionManager.setToggleEnabled(true)
    enableAutoplayGuard()
    enforceNativeShuffleOff()
    updateNativeShuffleGuard()
    transaction.degrade(notifyPublicError(error, true))
  } finally {
    isBusy = false
    renderButton()
  }
}

const disableShuffleSimilar = async () => {
  if (isBusy) return
  isBusy = true
  sessionManager.setToggleEnabled(false)
  disableAutoplayGuard()
  sessionManager.endSession()
  clearSimilarMixRecovery()
  updateNativeShuffleGuard()
  const transaction = shuffleSimilarStatus.beginTransition("stopping")

  try {
    await reshuffleOnToggleOff()
    transaction.commit("off")
  } catch (error) {
    transaction.fail(notifyPublicError(error))
  } finally {
    isBusy = false
    renderButton()
  }
}

const handleButtonClick = (event: MouseEvent) => {
  if (!buttonElement || isBusy || shuffleSimilarStatus.getSnapshot().copy.busy) return

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

export const triggerToggleShuffleSimilar = () => {
  if (isBusy || shuffleSimilarStatus.getSnapshot().copy.busy) return
  if (sessionManager.isToggleEnabled()) {
    void disableShuffleSimilar()
  } else {
    void enableShuffleSimilar()
  }
}

export const triggerRefreshShuffleSimilar = () => {
  if (isBusy || shuffleSimilarStatus.getSnapshot().copy.busy) return
  if (sessionManager.isToggleEnabled()) {
    void reshuffleActiveSession()
  } else {
    void enableShuffleSimilar()
  }
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
    if (attemptMount() || attempts >= 120) {
      clearInterval(interval)
      if (attempts >= 120) {
        console.warn("[Shuffle Similar] Could not find shuffle button to mount playbar control")
      }
    }
  }, 500)
}

const syncUiFromPlayback = () => {
  if (sessionManager.isToggleEnabled()) {
    enforceNativeShuffleOff()
    enableAutoplayGuard()
  } else {
    disableAutoplayGuard()
  }
  updateNativeShuffleGuard()
  ensureButtonInDom()
  syncButtonFromSession()
}

export const registerToggleButton = () => {
  if (registered) {
    syncUiFromPlayback()
    return
  }
  removeLegacyExtensionButtons()
  watchForLegacyExtensionButtons()
  registerShuffleSimilarUiSync(syncUiFromPlayback)
  shuffleSimilarStatus.subscribe(renderButton)
  mountLiveStatus()
  scheduleStatusWatch()
  waitForShuffleButton()
  registered = true
}
