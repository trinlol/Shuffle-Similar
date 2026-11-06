import { disableAutoplayGuard, enableAutoplayGuard } from "../queue/autoplayGuard"
import { getSessionPlayedTrackUris, savePlayedSessionPlaylist } from "../services/playlistService"
import {
  clearSimilarMixRecovery,
  reshuffleFromCurrentTrack,
  reshuffleOnToggleOff,
} from "../services/shuffleEngine"
import { sessionManager } from "../session/SessionManager"
import type { SeedMetadata } from "../session/types"
import { debounce } from "../utils/debounce"
import {
  COPY,
  savedPlayedPlaylistMessage,
  savePlayedPlaylistTooltip,
  timelineSeedLabel,
  timelineSeedTooltip,
} from "./copy"
import { applyCheckIcon, applyEnhanceIcon, applyPlaylistAddIcon } from "./icons"
import { enforceNativeShuffleOff, updateNativeShuffleGuard } from "./nativeShuffleGuard"
import {
  findNativeShuffleButton,
  findTimelineContainer,
  placeElementBeforeShuffle,
  placeElementBesideTimeline,
  playbarMutationsAffectControls,
  removeLegacyExtensionButtons,
  SAVE_PLAYED_PLAYLIST_TEST_ID,
  SHUFFLE_SIMILAR_TEST_ID,
  SIMILAR_MIX_TIMELINE_TEST_ID,
  sanitizeClonedPlaybarButton,
  watchForLegacyExtensionButtons,
} from "./playbarControls"
import { registerShuffleSimilarUiSync, shuffleSimilarStatus } from "./shuffleSimilarUiState"
import {
  formatPublicErrorDetail,
  mapSimilarMixError,
  mountSimilarMixStatus,
  type SimilarMixPublicError,
  type SimilarMixStatusMount,
  type SimilarMixStatusSnapshot,
} from "./status"

const STYLE_ID = "shuffle-similar-button-styles"
const BUTTON_CLASS = "shuffle-similar-playbar-btn"
const TEST_ID = SHUFFLE_SIMILAR_TEST_ID
const TIMELINE_ID = SIMILAR_MIX_TIMELINE_TEST_ID

export type SavePlayedPlaylistState = "idle" | "saving" | "saved"

let buttonElement: HTMLButtonElement | null = null
let buttonTippy: { setContent: (content: string) => void; destroy?: () => void } | null = null
let timelineElement: HTMLDivElement | null = null
let timelinePrefixSpan: HTMLSpanElement | null = null
let timelineSeedStrong: HTMLElement | null = null
let timelineTextContainer: HTMLSpanElement | null = null
let savePlayedButton: HTMLButtonElement | null = null
let savePlayedIcon: SVGSVGElement | null = null
let savePlayedLabelSpan: HTMLSpanElement | null = null
let savePlayedState: SavePlayedPlaylistState = "idle"
let savePlayedResetTimer: ReturnType<typeof setTimeout> | null = null
let isBusy = false
let placementObserver: MutationObserver | null = null
let placementObserverRoot: WeakRef<HTMLElement> | null = null
let placementSyncCancel: (() => void) | null = null
let statusObserver: MutationObserver | null = null
let statusObserverRoot: WeakRef<HTMLElement> | null = null
let statusMount: SimilarMixStatusMount | null = null
let registered = false

const destroyButtonTippy = () => {
  if (!buttonTippy) return
  try {
    buttonTippy.destroy?.()
  } catch {
    // Ignore Tippy teardown errors on detached DOM nodes.
  }
  buttonTippy = null
}

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
      min-width: 32px;
      min-height: 32px;
      padding: 0;
      border-radius: 50%;
      opacity: 1 !important;
      visibility: visible !important;
      color: rgba(var(--spice-rgb-text, 255, 255, 255), 0.7) !important;
      transition: color 160ms ease, opacity 160ms ease, transform 120ms ease;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-pressed="true"] {
      color: var(--spice-button, #1ed760) !important;
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
      filter: none !important;
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
    body > #similar-mix-status[data-state="stopping"] {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, 0);
    }

    /* Errors are also surfaced as a Spotify notification, so the capsule must
       not stay pinned over the UI. Distinct names restart the timer when the
       state changes between error and degraded. */
    body > #similar-mix-status[data-state="error"] {
      visibility: visible;
      animation: similar-mix-alert-error 6s ease forwards;
    }

    body > #similar-mix-status[data-state="degraded"] {
      visibility: visible;
      animation: similar-mix-alert-degraded 6s ease forwards;
    }

    @keyframes similar-mix-alert-error {
      0% { opacity: 0; transform: translate(-50%, 6px); }
      5%, 88% { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
      100% { opacity: 0; visibility: hidden; transform: translate(-50%, -2px); }
    }

    @keyframes similar-mix-alert-degraded {
      0% { opacity: 0; transform: translate(-50%, 6px); }
      5%, 88% { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
      100% { opacity: 0; visibility: hidden; transform: translate(-50%, -2px); }
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

      body > #similar-mix-status[data-state="error"],
      body > #similar-mix-status[data-state="degraded"] {
        animation-timing-function: step-end;
      }

      #${TIMELINE_ID} .similar-mix-timeline__save-btn {
        transition: none;
      }
    }

    .main-nowPlayingBar-center:has(#${TIMELINE_ID}[data-active="true"]),
    [data-testid="player-controls"]:has(#${TIMELINE_ID}[data-active="true"]),
    .player-controls__buttons:has(#${TIMELINE_ID}[data-active="true"]) {
      overflow: visible !important;
    }

    .player-controls__left:has(#${TIMELINE_ID}[data-active="true"]) {
      min-width: 0 !important;
      overflow: visible !important;
      align-items: center;
    }

    #${TIMELINE_ID} {
      display: none;
      align-items: center;
      gap: 8px;
      margin-right: 6px;
      padding: 3px 4px 3px 10px;
      border-radius: 999px;
      border: 1px solid rgba(var(--spice-rgb-text, 255, 255, 255), 0.14);
      background: rgba(var(--spice-rgb-text, 255, 255, 255), 0.06);
      max-width: min(380px, 28vw);
      min-width: 0;
      flex-shrink: 0;
      font-size: 11px;
      line-height: 1.15;
      color: var(--spice-subtext, #b3b3b3);
      box-sizing: border-box;
    }

    #${TIMELINE_ID}[data-active="true"] {
      display: inline-flex;
    }

    #${TIMELINE_ID} .similar-mix-timeline__text {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      max-width: 220px;
      overflow: hidden;
      line-height: 1.15;
      color: var(--spice-subtext, #b3b3b3);
    }

    #${TIMELINE_ID} .similar-mix-timeline__prefix {
      font-size: 9.5px;
      color: var(--spice-subtext, #b3b3b3);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #${TIMELINE_ID} .similar-mix-timeline__seed {
      font-size: 11px;
      color: var(--spice-text, #ffffff);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #${TIMELINE_ID} .similar-mix-timeline__save-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid rgba(var(--spice-rgb-button, 30, 215, 96), 0.36);
      background: rgba(var(--spice-rgb-button, 30, 215, 96), 0.14);
      color: var(--afterglow-accent, var(--spice-button, #1ed760));
      font-size: 11px;
      font-weight: 600;
      line-height: 1.1;
      cursor: pointer;
      white-space: nowrap;
      transition:
        background-color 150ms ease,
        border-color 150ms ease,
        color 150ms ease,
        transform 120ms ease,
        opacity 150ms ease;
    }

    #${TIMELINE_ID} .similar-mix-timeline__save-btn:hover:not(:disabled) {
      background: rgba(var(--spice-rgb-button, 30, 215, 96), 0.24);
      border-color: var(--afterglow-accent, var(--spice-button, #1ed760));
      color: var(--spice-text, #ffffff);
    }

    #${TIMELINE_ID} .similar-mix-timeline__save-btn:active:not(:disabled) {
      transform: scale(0.96);
    }

    #${TIMELINE_ID} .similar-mix-timeline__save-btn:disabled,
    #${TIMELINE_ID} .similar-mix-timeline__save-btn[aria-busy="true"] {
      cursor: progress;
      opacity: 0.68;
    }

    #${TIMELINE_ID} .similar-mix-timeline__save-btn svg {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
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
  let label: string = COPY.toggleOn

  if (snapshot.state === "building") label = COPY.toggleBuilding
  else if (snapshot.state === "refreshing") label = COPY.toggleRefreshing
  else if (snapshot.state === "stopping") label = COPY.toggleStopping
  else if (enabled) label = `${COPY.toggleOff} · ${COPY.toggleRefreshHint}`
  else if (snapshot.state === "error") label = COPY.toggleRetry

  return {
    pressed: enabled,
    busy: snapshot.copy.busy,
    label,
  }
}

export type TimelineBannerPresentation = {
  readonly visible: boolean
  readonly prefixText: string
  readonly seedTitle: string
  readonly fullText: string
  readonly tooltip: string
  readonly playedCount: number
  readonly buttonLabel: string
  readonly buttonTooltip: string
  readonly buttonBusy: boolean
  readonly buttonDisabled: boolean
  readonly buttonState: SavePlayedPlaylistState
}

export const getTimelineBannerPresentation = (options: {
  readonly sessionActive: boolean
  readonly seed: Pick<SeedMetadata, "trackName" | "artistName"> | null | undefined
  readonly playedCount: number
  readonly saveState?: SavePlayedPlaylistState
}): TimelineBannerPresentation => {
  const seedTitle = options.seed?.trackName?.trim() ?? ""
  const visible = Boolean(options.sessionActive && seedTitle.length > 0)
  const playedCount = visible ? Math.max(1, Math.floor(options.playedCount)) : 0
  const saveState = options.saveState ?? "idle"

  const buttonLabel =
    saveState === "saving"
      ? COPY.savingPlayedButton
      : saveState === "saved"
        ? COPY.savedPlayedButton
        : COPY.savePlayedButton

  const buttonTooltip =
    saveState === "saving"
      ? COPY.savingPlaylist
      : saveState === "saved"
        ? savedPlayedPlaylistMessage(seedTitle || "Mix", playedCount)
        : savePlayedPlaylistTooltip(playedCount)

  return {
    visible,
    prefixText: visible ? `${COPY.timelinePrefix} ` : "",
    seedTitle: visible ? seedTitle : "",
    fullText: visible ? timelineSeedLabel(seedTitle) : "",
    tooltip: visible ? timelineSeedTooltip(seedTitle, options.seed?.artistName) : "",
    playedCount,
    buttonLabel,
    buttonTooltip,
    buttonBusy: saveState === "saving",
    buttonDisabled: !visible || saveState === "saving" || playedCount === 0,
    buttonState: saveState,
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

const renderTimelineBanner = () => {
  if (!sessionManager.isActive() && (savePlayedState !== "idle" || savePlayedResetTimer !== null)) {
    if (savePlayedResetTimer) {
      clearTimeout(savePlayedResetTimer)
      savePlayedResetTimer = null
    }
    savePlayedState = "idle"
  }
  if (!timelineElement) return

  const presentation = getTimelineBannerPresentation({
    sessionActive: sessionManager.isActive(),
    seed: sessionManager.getSeed(),
    playedCount: getSessionPlayedTrackUris().length,
    saveState: savePlayedState,
  })

  timelineElement.dataset.active = presentation.visible ? "true" : "false"
  timelineElement.hidden = !presentation.visible

  if (timelinePrefixSpan && timelinePrefixSpan.textContent !== presentation.prefixText) {
    timelinePrefixSpan.textContent = presentation.prefixText
  }
  if (timelineSeedStrong && timelineSeedStrong.textContent !== presentation.seedTitle) {
    timelineSeedStrong.textContent = presentation.seedTitle
  }
  if (timelineTextContainer) {
    timelineTextContainer.setAttribute("title", presentation.tooltip)
    timelineTextContainer.setAttribute("aria-label", presentation.fullText)
  }

  if (savePlayedButton) {
    savePlayedButton.disabled = presentation.buttonDisabled
    savePlayedButton.setAttribute("aria-busy", presentation.buttonBusy ? "true" : "false")
    savePlayedButton.setAttribute("aria-label", presentation.buttonTooltip)
    savePlayedButton.setAttribute("title", presentation.buttonTooltip)
    savePlayedButton.dataset.saveState = presentation.buttonState
  }

  if (savePlayedLabelSpan && savePlayedLabelSpan.textContent !== presentation.buttonLabel) {
    savePlayedLabelSpan.textContent = presentation.buttonLabel
  }

  if (savePlayedIcon) {
    if (presentation.buttonState === "saved") {
      applyCheckIcon(savePlayedIcon)
    } else {
      applyPlaylistAddIcon(savePlayedIcon)
    }
  }
}

const handleSavePlayedPlaylistClick = async () => {
  if (savePlayedState === "saving" || !sessionManager.isActive()) return
  if (savePlayedResetTimer) {
    clearTimeout(savePlayedResetTimer)
    savePlayedResetTimer = null
  }

  savePlayedState = "saving"
  renderTimelineBanner()

  try {
    const saved = await savePlayedSessionPlaylist()
    savePlayedState = "saved"
    renderTimelineBanner()
    Spicetify.showNotification(savedPlayedPlaylistMessage(saved.seedTrackName, saved.trackCount))
    savePlayedResetTimer = setTimeout(() => {
      savePlayedResetTimer = null
      savePlayedState = "idle"
      renderTimelineBanner()
    }, 2_200)
  } catch (error) {
    console.error("[Shuffle Similar] Failed to save played songs playlist", error)
    savePlayedState = "idle"
    renderTimelineBanner()
    const reason = error instanceof Error && error.message.trim() ? error.message.trim() : ""
    Spicetify.showNotification(reason || COPY.savePlaylistFailed, true)
  }
}

const createTimelineBanner = (): HTMLDivElement => {
  const container = document.createElement("div")
  container.id = TIMELINE_ID
  container.className = "similar-mix-timeline"
  container.setAttribute("data-testid", SIMILAR_MIX_TIMELINE_TEST_ID)
  container.dataset.active = "false"
  container.hidden = true

  const textContainer = document.createElement("span")
  textContainer.className = "similar-mix-timeline__text"
  textContainer.setAttribute("data-testid", "similar-mix-timeline-text")

  const prefixSpan = document.createElement("span")
  prefixSpan.className = "similar-mix-timeline__prefix"

  const seedStrong = document.createElement("strong")
  seedStrong.className = "similar-mix-timeline__seed"

  textContainer.append(prefixSpan, seedStrong)

  const button = document.createElement("button")
  button.type = "button"
  button.className = "similar-mix-timeline__save-btn"
  button.setAttribute("data-testid", SAVE_PLAYED_PLAYLIST_TEST_ID)
  button.setAttribute("aria-label", COPY.menuSavePlaylist)
  button.setAttribute("title", COPY.menuSavePlaylist)

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("aria-hidden", "true")
  applyPlaylistAddIcon(svg)

  const labelSpan = document.createElement("span")
  labelSpan.className = "similar-mix-timeline__save-label"
  labelSpan.textContent = COPY.savePlayedButton

  button.append(svg, labelSpan)
  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    void handleSavePlayedPlaylistClick()
  })

  container.append(textContainer, button)

  timelineTextContainer = textContainer
  timelinePrefixSpan = prefixSpan
  timelineSeedStrong = seedStrong
  savePlayedButton = button
  savePlayedIcon = svg
  savePlayedLabelSpan = labelSpan

  return container
}

const ensureTimelineInDom = (): boolean => {
  if (timelineElement && document.contains(timelineElement)) {
    const placed = placeElementBesideTimeline(timelineElement)
    renderTimelineBanner()
    return placed
  }

  const timelineContainer = findTimelineContainer()
  if (!timelineContainer) return false

  injectStyles()

  if (!timelineElement || timelineElement.ownerDocument !== document) {
    timelineElement = createTimelineBanner()
  }

  const orphan = document.querySelector(`[data-testid="${SIMILAR_MIX_TIMELINE_TEST_ID}"]`)
  if (orphan && orphan !== timelineElement) orphan.remove()

  const placed = placeElementBesideTimeline(timelineElement)
  renderTimelineBanner()
  return placed
}

const renderButton = (snapshot = shuffleSimilarStatus.getSnapshot()) => {
  if (buttonElement) {
    const presentation = getToggleButtonPresentation(snapshot, sessionManager.isToggleEnabled())
    buttonElement.setAttribute("aria-pressed", presentation.pressed ? "true" : "false")
    buttonElement.setAttribute("aria-busy", presentation.busy ? "true" : "false")
    buttonElement.dataset.similarMixState = snapshot.state
    stripActivePresentation(buttonElement)
    applyButtonIcon()
    updateTooltip(presentation.label)
  }
  ensureTimelineInDom()
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
  if (!root || (statusObserver && statusObserverRoot?.deref() === root)) return

  statusObserver?.disconnect()
  statusObserverRoot = new WeakRef(root)
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

const createShuffleSimilarButton = (shuffleReference: HTMLButtonElement): HTMLButtonElement => {
  const button = sanitizeClonedPlaybarButton(shuffleReference.cloneNode(true) as HTMLButtonElement)

  button.setAttribute("data-testid", TEST_ID)
  button.setAttribute("aria-label", COPY.toggleOn)
  button.setAttribute("title", COPY.toggleOn)
  button.setAttribute("aria-pressed", "false")
  button.setAttribute("aria-busy", "false")
  button.classList.add(BUTTON_CLASS)

  stripActivePresentation(button)

  const svg = button.querySelector("svg")
  if (svg) {
    applyEnhanceIcon(svg)
    svg.setAttribute("aria-hidden", "true")
    svg.removeAttribute("aria-label")
  }

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
    const placed = placeButton()
    syncButtonFromSession()
    return placed
  }

  const shuffleButton = findNativeShuffleButton()
  if (!shuffleButton) return false

  injectStyles()

  if (buttonElement && !document.contains(buttonElement)) {
    destroyButtonTippy()
    buttonElement = null
  }

  const orphan = document.querySelector(`[data-testid="${TEST_ID}"]`)
  if (orphan && orphan !== buttonElement) orphan.remove()

  buttonElement = createShuffleSimilarButton(shuffleButton)
  shuffleButton.before(buttonElement)

  destroyButtonTippy()
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
    destroyButtonTippy()
    buttonElement = null
    mountButton()
    return
  }

  placeButton()
  syncButtonFromSession()
}

const schedulePlacementWatch = () => {
  const shuffleButton = findNativeShuffleButton()
  const parent = shuffleButton?.parentElement
  if (!parent) return

  const playbar =
    document.querySelector<HTMLElement>('[data-testid="now-playing-bar"]') ??
    document.querySelector<HTMLElement>(".main-nowPlayingBar-nowPlayingBar")
  const root = playbar ?? parent
  if (placementObserver && placementObserverRoot?.deref() === root) return

  placementSyncCancel?.()
  placementObserver?.disconnect()
  placementObserverRoot = new WeakRef(root)

  const syncPlacement = debounce(() => {
    ensureButtonInDom()
    ensureTimelineInDom()
    schedulePlacementWatch()
    watchForLegacyExtensionButtons()
    updateNativeShuffleGuard()
  }, 50)
  placementSyncCancel = syncPlacement.cancel

  placementObserver = new MutationObserver((records) => {
    if (playbarMutationsAffectControls(records, buttonElement, timelineElement)) syncPlacement()
  })
  placementObserver.observe(root, { childList: true, subtree: true })
}

const notifyPublicError = (error: unknown, remainsActive = false): SimilarMixPublicError => {
  const publicError = mapSimilarMixError(error)
  const detail = formatPublicErrorDetail(publicError)
  const message = remainsActive
    ? `Similar Mix is still on. ${detail}`
    : `${publicError.title}. ${detail}`
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

const waitForShuffleButton = () => {
  const attemptMount = () => {
    if (!mountButton()) return false
    schedulePlacementWatch()
    return true
  }

  if (attemptMount()) return

  let attempts = 0
  let mountObserver: MutationObserver | null = null
  const stopWaiting = () => {
    clearInterval(interval)
    mountObserver?.disconnect()
    mountObserver = null
  }
  const interval = setInterval(() => {
    attempts += 1
    if (attemptMount() || attempts >= 120) {
      stopWaiting()
      if (attempts >= 120) {
        console.warn("[Shuffle Similar] Could not find shuffle button to mount playbar control")
      }
    }
  }, 150)

  if (document.body) {
    let frameQueued = false
    mountObserver = new MutationObserver(() => {
      if (frameQueued) return
      frameQueued = true
      requestAnimationFrame(() => {
        frameQueued = false
        if (!mountObserver || !findNativeShuffleButton()) return
        if (attemptMount()) stopWaiting()
      })
    })
    mountObserver.observe(document.body, { childList: true, subtree: true })
  }
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
