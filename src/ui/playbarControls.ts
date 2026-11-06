export const SHUFFLE_SIMILAR_TEST_ID = "shuffle-similar-button"
export const SIMILAR_MIX_TIMELINE_TEST_ID = "similar-mix-timeline"
export const SAVE_PLAYED_PLAYLIST_TEST_ID = "similar-mix-save-played-button"

export const LEGACY_EXTENSION_TEST_IDS = [
  "better-shuffle-button",
  "similar-shuffle-button",
] as const

const LEGACY_EXTENSION_LABELS = ["Better Shuffle", "Similar Shuffle"] as const

const CLONED_CONTROL_ATTRIBUTES = new Set([
  "disabled",
  "form",
  "formaction",
  "formmethod",
  "id",
  "name",
  "style",
  "tabindex",
  "title",
  "value",
])

export const sanitizeClonedPlaybarButton = (button: HTMLButtonElement): HTMLButtonElement => {
  for (const attribute of button.getAttributeNames()) {
    if (
      attribute.startsWith("aria-") ||
      attribute.startsWith("data-") ||
      CLONED_CONTROL_ATTRIBUTES.has(attribute)
    ) {
      button.removeAttribute(attribute)
    }
  }

  for (const descendant of Array.from(button.querySelectorAll("[id]"))) {
    descendant.removeAttribute("id")
  }

  button.disabled = false
  button.type = "button"
  button.tabIndex = 0
  return button
}

const isLegacyExtensionButton = (button: HTMLButtonElement): boolean => {
  const testId = button.getAttribute("data-testid")
  if (testId && (LEGACY_EXTENSION_TEST_IDS as readonly string[]).includes(testId)) {
    return true
  }

  const label = button.getAttribute("aria-label") ?? ""
  return (LEGACY_EXTENSION_LABELS as readonly string[]).includes(label)
}

export const removeLegacyExtensionButtons = (): number => {
  let removed = 0

  for (const testId of LEGACY_EXTENSION_TEST_IDS) {
    const element = document.querySelector(`[data-testid="${testId}"]`)
    if (element) {
      element.remove()
      removed += 1
    }
  }

  const playbar =
    document.querySelector('[data-testid="now-playing-bar"]') ??
    document.querySelector(".main-nowPlayingBar-nowPlayingBar")

  if (playbar) {
    const buttons = playbar.querySelectorAll("button")
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index)
      if (!(button instanceof HTMLButtonElement)) continue
      if (isLegacyExtensionButton(button)) {
        button.remove()
        removed += 1
      }
    }
  }

  if (removed > 0) {
    console.warn(
      `[Shuffle Similar] Removed ${removed} legacy playbar button(s). Delete better-shuffle.js and similar-shuffle.js from your Extensions folder.`
    )
  }

  return removed
}

let legacyButtonObserver: MutationObserver | null = null
let legacyButtonObserverRoot: WeakRef<HTMLElement> | null = null

const removeLegacyButtonsInNode = (node: Node): number => {
  if (!(node instanceof Element)) return 0

  let removed = 0
  if (node instanceof HTMLButtonElement && isLegacyExtensionButton(node)) {
    node.remove()
    removed += 1
  }

  const buttons = node.querySelectorAll("button")
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons.item(index)
    if (!(button instanceof HTMLButtonElement) || !isLegacyExtensionButton(button)) continue
    button.remove()
    removed += 1
  }
  return removed
}

/** Inspect only nodes introduced by a mutation instead of rescanning Spotify's
 * entire playbar for every React update. */
export const removeLegacyButtonsFromMutations = (
  records: readonly Pick<MutationRecord, "addedNodes">[]
): number => {
  let removed = 0
  for (const record of records) {
    for (let index = 0; index < record.addedNodes.length; index += 1) {
      const node = record.addedNodes.item(index)
      if (node) removed += removeLegacyButtonsInNode(node)
    }
  }

  if (removed > 0) {
    console.warn(
      `[Shuffle Similar] Removed ${removed} legacy playbar button(s). Delete better-shuffle.js and similar-shuffle.js from your Extensions folder.`
    )
  }
  return removed
}

export const watchForLegacyExtensionButtons = () => {
  removeLegacyExtensionButtons()

  const shuffleButton = findNativeShuffleButton()
  const parent = shuffleButton?.parentElement ?? null
  const currentRoot = legacyButtonObserverRoot?.deref() ?? null

  if (!parent) {
    if (legacyButtonObserver && !currentRoot?.isConnected) {
      legacyButtonObserver.disconnect()
      legacyButtonObserver = null
      legacyButtonObserverRoot = null
    }
    return
  }

  if (legacyButtonObserver && currentRoot === parent) return

  legacyButtonObserver?.disconnect()
  legacyButtonObserver = new MutationObserver(removeLegacyButtonsFromMutations)
  legacyButtonObserver.observe(parent, { childList: true, subtree: true })
  legacyButtonObserverRoot = new WeakRef(parent)
}

export const NATIVE_SHUFFLE_SELECTORS = [
  `button[data-testid="control-button-shuffle"]:not([data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]):not([data-testid="better-shuffle-button"]):not([data-testid="similar-shuffle-button"])`,
  `.main-shuffleButton-button:not([data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]):not([data-testid="better-shuffle-button"]):not([data-testid="similar-shuffle-button"])`,
]

const PLAYBAR_CONTROL_MUTATION_SELECTOR = [
  `[data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]`,
  ...NATIVE_SHUFFLE_SELECTORS,
].join(", ")

const nodeContainsPlaybarControl = (node: Node): boolean =>
  node instanceof Element &&
  (node.matches(PLAYBAR_CONTROL_MUTATION_SELECTOR) ||
    Boolean(node.querySelector(PLAYBAR_CONTROL_MUTATION_SELECTOR)))

/** Cheaply rejects the frequent playbar mutations that cannot affect either
 * shuffle control, avoiding timer churn and follow-up DOM reads. */
export const playbarMutationsAffectControls = (
  records: readonly Pick<MutationRecord, "addedNodes" | "removedNodes">[],
  currentButton: Pick<HTMLElement, "isConnected"> | null,
  currentTimeline?: Pick<HTMLElement, "isConnected"> | null
): boolean => {
  if (currentButton && !currentButton.isConnected) return true
  if (currentTimeline && !currentTimeline.isConnected) return true

  for (const record of records) {
    for (const nodes of [record.addedNodes, record.removedNodes]) {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes.item(index)
        if (node && nodeContainsPlaybarControl(node)) return true
      }
    }
  }
  return false
}

export const isShuffleSimilarButton = (element: Element | null): boolean =>
  element instanceof HTMLButtonElement &&
  element.getAttribute("data-testid") === SHUFFLE_SIMILAR_TEST_ID

export const isSavePlayedPlaylistButton = (element: Element | null): boolean =>
  element instanceof HTMLButtonElement &&
  element.getAttribute("data-testid") === SAVE_PLAYED_PLAYLIST_TEST_ID

export const isNativeShuffleLabel = (label: string): boolean => {
  // Spotify appends " for <context name>" (e.g. "Enable Shuffle for Similar to - July").
  // Judge only the action: a playlist named "Similar…" or "Better…" must not hide the button.
  const normalized = label.toLowerCase().split(" for ")[0]
  if (!normalized.includes("shuffle")) return false
  if (normalized.includes("shuffle+")) return false
  if (normalized.includes("smart")) return false
  if (normalized.includes("similar")) return false
  if (normalized.includes("better")) return false
  return true
}

const isLeftControlsShuffleCandidate = (button: HTMLButtonElement): boolean => {
  if (
    isShuffleSimilarButton(button) ||
    isSavePlayedPlaylistButton(button) ||
    isLegacyExtensionButton(button)
  ) {
    return false
  }
  const testId = button.getAttribute("data-testid") ?? ""
  if (testId === "control-button-shuffle") return true
  if (testId.startsWith("control-button-")) return false

  const normalized = (button.getAttribute("aria-label") ?? "").toLowerCase().split(" for ")[0]
  if (!normalized.includes("shuffle")) return false
  if (normalized.includes("shuffle+")) return false
  if (normalized.includes("similar")) return false
  if (normalized.includes("better")) return false
  return true
}

export const findNativeShuffleButton = (): HTMLButtonElement | null => {
  for (const selector of NATIVE_SHUFFLE_SELECTORS) {
    const element = document.querySelector(selector)
    if (
      element instanceof HTMLButtonElement &&
      !isShuffleSimilarButton(element) &&
      !isSavePlayedPlaylistButton(element)
    ) {
      return element
    }
  }

  const skipBack = document.querySelector('button[data-testid="control-button-skip-back"]')
  const leftControls =
    document.querySelector(".player-controls__left") ?? skipBack?.parentElement ?? null
  if (leftControls) {
    const buttons = leftControls.querySelectorAll("button")
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index)
      if (button instanceof HTMLButtonElement && isLeftControlsShuffleCandidate(button)) {
        return button
      }
    }
  }

  const playPause = document.querySelector('button[data-testid="control-button-playpause"]')
  const controlGroup = playPause?.parentElement
  if (controlGroup) {
    const byTestId = controlGroup.querySelector('button[data-testid="control-button-shuffle"]')
    if (
      byTestId instanceof HTMLButtonElement &&
      !isShuffleSimilarButton(byTestId) &&
      !isSavePlayedPlaylistButton(byTestId)
    ) {
      return byTestId
    }
  }

  const playbar =
    document.querySelector('[data-testid="now-playing-bar"]') ??
    document.querySelector(".main-nowPlayingBar-nowPlayingBar")

  if (playbar) {
    const buttons = playbar.querySelectorAll("button")
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index)
      if (!(button instanceof HTMLButtonElement)) continue
      if (isShuffleSimilarButton(button)) continue
      if (isSavePlayedPlaylistButton(button)) continue
      if (isLegacyExtensionButton(button)) continue

      const label = button.getAttribute("aria-label") ?? ""
      if (isNativeShuffleLabel(label)) {
        return button
      }
    }
  }

  return null
}

export const isNativeShuffleTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false
  if (
    isShuffleSimilarButton(target) ||
    isSavePlayedPlaylistButton(target) ||
    target.closest(`[data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]`) ||
    target.closest(`[data-testid="${SAVE_PLAYED_PLAYLIST_TEST_ID}"]`)
  ) {
    return false
  }

  const shuffle = findNativeShuffleButton()
  if (shuffle && (target === shuffle || shuffle.contains(target))) return true

  return Boolean(target.closest(NATIVE_SHUFFLE_SELECTORS.join(", ")))
}

export const placeElementBeforeShuffle = (element: HTMLElement): boolean => {
  const shuffleButton = findNativeShuffleButton()
  if (!shuffleButton) return false
  if (element === shuffleButton) return true

  if (element.nextElementSibling !== shuffleButton) {
    shuffleButton.before(element)
  }

  return true
}

export const findTimelineContainer = (doc: Document = document): HTMLElement | null => {
  const playbar =
    doc.querySelector<HTMLElement>('[data-testid="now-playing-bar"]') ??
    doc.querySelector<HTMLElement>(".main-nowPlayingBar-nowPlayingBar") ??
    doc.querySelector<HTMLElement>(".Root__now-playing-bar")
  const root: ParentNode = playbar ?? doc

  const leftControls =
    root.querySelector<HTMLElement>(".player-controls__left") ??
    root.querySelector<HTMLElement>('button[data-testid="control-button-skip-back"]')?.parentElement
  if (leftControls) return leftControls

  const shuffleButton = findNativeShuffleButton()
  if (shuffleButton?.parentElement) return shuffleButton.parentElement

  const direct = root.querySelector<HTMLElement>(".playback-bar")
  if (direct) return direct

  const childAnchor =
    root.querySelector<HTMLElement>('[data-testid="playback-duration"]') ??
    root.querySelector<HTMLElement>(".playback-bar__progress-time-remaining") ??
    root.querySelector<HTMLElement>('[data-testid="playback-progressbar"]') ??
    root.querySelector<HTMLElement>('[data-testid="playback-position"]') ??
    root.querySelector<HTMLElement>(".playback-bar__progress-time-elapsed")

  return childAnchor?.parentElement ?? null
}

export const placeElementBesideTimeline = (
  element: HTMLElement,
  doc: Document = document
): boolean => {
  const shuffleButton = doc === document ? findNativeShuffleButton() : null
  const shuffleSimilarButton = doc.querySelector<HTMLElement>(
    `button[data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]`
  )
  const leftAnchor =
    shuffleSimilarButton &&
    (!shuffleButton || shuffleSimilarButton.parentElement === shuffleButton.parentElement)
      ? shuffleSimilarButton
      : shuffleButton

  if (leftAnchor && leftAnchor !== element) {
    if (element.nextElementSibling !== leftAnchor) {
      leftAnchor.before(element)
    }
    return true
  }

  const container = findTimelineContainer(doc)
  if (!container) return false

  if (
    container.classList.contains("player-controls__left") ||
    container.querySelector('button[data-testid="control-button-skip-back"]')
  ) {
    if (container.firstElementChild !== element) {
      container.prepend(element)
    }
    return true
  }

  const durationAnchor =
    container.querySelector<HTMLElement>('[data-testid="playback-duration"]') ??
    container.querySelector<HTMLElement>(".playback-bar__progress-time-remaining")

  if (durationAnchor) {
    if (durationAnchor.nextElementSibling !== element) {
      durationAnchor.after(element)
    }
    return true
  }

  if (element.parentElement !== container || container.lastElementChild !== element) {
    container.appendChild(element)
  }
  return true
}
