export const SHUFFLE_SIMILAR_TEST_ID = "shuffle-similar-button"

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

  if (legacyButtonObserver) return

  const shuffleButton = findNativeShuffleButton()
  const parent = shuffleButton?.parentElement
  if (!parent) return

  legacyButtonObserver = new MutationObserver(removeLegacyButtonsFromMutations)
  legacyButtonObserver.observe(parent, { childList: true, subtree: true })
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
  currentButton: Pick<HTMLElement, "isConnected"> | null
): boolean => {
  if (currentButton && !currentButton.isConnected) return true

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

const isNativeShuffleLabel = (label: string): boolean => {
  const normalized = label.toLowerCase()
  if (!normalized.includes("shuffle")) return false
  if (normalized.includes("smart")) return false
  if (normalized.includes("similar")) return false
  if (normalized.includes("better")) return false
  return true
}

export const findNativeShuffleButton = (): HTMLButtonElement | null => {
  for (const selector of NATIVE_SHUFFLE_SELECTORS) {
    const element = document.querySelector(selector)
    if (element instanceof HTMLButtonElement && !isShuffleSimilarButton(element)) {
      return element
    }
  }

  const playPause = document.querySelector('button[data-testid="control-button-playpause"]')
  const controlGroup = playPause?.parentElement
  if (controlGroup) {
    const byTestId = controlGroup.querySelector('button[data-testid="control-button-shuffle"]')
    if (byTestId instanceof HTMLButtonElement && !isShuffleSimilarButton(byTestId)) {
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
    target.closest(`[data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]`)
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
