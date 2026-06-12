import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BetterShuffleSettings,
} from "../storage/settings"

const SETTINGS_STYLE_ID = "better-shuffle-settings-styles"

const settingsStyles = `
.better-shuffle-settings-root .popup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
}
.better-shuffle-settings-root .popup-row label {
  color: var(--spice-text);
  flex: 1;
}
.better-shuffle-settings-root .popup-row input[type="number"] {
  width: 72px;
  color: var(--spice-text);
  background: rgba(var(--spice-rgb-shadow), 0.7);
  border: 0;
  border-radius: 4px;
  padding: 6px 8px;
}
.better-shuffle-settings-root .popup-row input[type="checkbox"] {
  width: 18px;
  height: 18px;
}
.better-shuffle-settings-root .popup-title {
  color: var(--spice-text);
  margin: 0 0 8px;
}
.better-shuffle-settings-root .popup-help {
  color: rgba(var(--spice-rgb-text), 0.7);
  font-size: 12px;
  margin: 0 0 16px;
}
.better-shuffle-settings-root .popup-reset {
  margin-top: 12px;
  color: var(--spice-text);
  background: rgba(var(--spice-rgb-shadow), 0.7);
  border: 0;
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
}
`

const injectSettingsStyles = () => {
  if (document.getElementById(SETTINGS_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = SETTINGS_STYLE_ID
  style.textContent = settingsStyles
  document.head.appendChild(style)
}

const fieldId = (label: string) =>
  `better-shuffle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`

const createNumberField = (
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (next: number) => void
) => {
  const row = document.createElement("div")
  row.className = "popup-row"

  const id = fieldId(label)
  const labelEl = document.createElement("label")
  labelEl.htmlFor = id
  labelEl.textContent = label

  const input = document.createElement("input")
  input.id = id
  input.type = "number"
  input.min = String(min)
  input.max = String(max)
  input.value = String(value)
  input.setAttribute("aria-label", label)
  input.addEventListener("change", () => {
    const parsed = Number(input.value)
    if (!Number.isFinite(parsed)) return
    onChange(Math.min(max, Math.max(min, parsed)))
  })

  row.append(labelEl, input)
  return { row, input }
}

const createCheckboxField = (
  label: string,
  checked: boolean,
  onChange: (next: boolean) => void
) => {
  const row = document.createElement("div")
  row.className = "popup-row"

  const id = fieldId(label)
  const labelEl = document.createElement("label")
  labelEl.htmlFor = id
  labelEl.textContent = label

  const input = document.createElement("input")
  input.id = id
  input.type = "checkbox"
  input.checked = checked
  input.setAttribute("aria-label", label)
  input.addEventListener("change", () => onChange(input.checked))

  row.append(labelEl, input)
  return { row, input }
}

const buildSettingsDom = (): HTMLElement => {
  injectSettingsStyles()

  let settings = loadSettings()
  const root = document.createElement("div")
  root.className = "better-shuffle-settings-root"

  const title = document.createElement("h3")
  title.className = "popup-title"
  title.textContent = "Better Shuffle Settings"

  const help = document.createElement("p")
  help.className = "popup-help"
  help.textContent =
    "Starts with genre/era-similar tracks, then gradually blends in your library and playlists."

  const inputs: {
    eraWindow: HTMLInputElement
    artistSpacing: HTMLInputElement
    refillThreshold: HTMLInputElement
    initialQueueSize: HTMLInputElement
    historyPenaltyWindow: HTMLInputElement
    deprioritizePopular: HTMLInputElement
    excludeSeedArtistEarly: HTMLInputElement
    matchTempo: HTMLInputElement
    matchEnergy: HTMLInputElement
    matchValence: HTMLInputElement
  } = {} as never

  const applyToInputs = (next: BetterShuffleSettings) => {
    settings = next
    inputs.eraWindow.value = String(next.eraWindow)
    inputs.artistSpacing.value = String(next.artistSpacing)
    inputs.refillThreshold.value = String(next.refillThreshold)
    inputs.initialQueueSize.value = String(next.initialQueueSize)
    inputs.historyPenaltyWindow.value = String(next.historyPenaltyWindow)
    inputs.deprioritizePopular.checked = next.deprioritizePopular
    inputs.excludeSeedArtistEarly.checked = next.excludeSeedArtistEarly
    inputs.matchTempo.checked = next.matchTempo
    inputs.matchEnergy.checked = next.matchEnergy
    inputs.matchValence.checked = next.matchValence
  }

  const persist = (patch: Partial<BetterShuffleSettings>) => {
    const next = { ...settings, ...patch }
    saveSettings(next)
    applyToInputs(next)
  }

  const eraField = createNumberField(
    "Era window (± years)",
    settings.eraWindow,
    1,
    10,
    (eraWindow) => persist({ eraWindow })
  )
  inputs.eraWindow = eraField.input

  const artistField = createNumberField(
    "Artist spacing",
    settings.artistSpacing,
    1,
    8,
    (artistSpacing) => persist({ artistSpacing })
  )
  inputs.artistSpacing = artistField.input

  const refillField = createNumberField(
    "Refill when queue has ≤",
    settings.refillThreshold,
    1,
    10,
    (refillThreshold) => persist({ refillThreshold })
  )
  inputs.refillThreshold = refillField.input

  const batchField = createNumberField(
    "Tracks per batch",
    settings.initialQueueSize,
    10,
    50,
    (initialQueueSize) => persist({ initialQueueSize })
  )
  inputs.initialQueueSize = batchField.input

  const historyField = createNumberField(
    "History penalty window",
    settings.historyPenaltyWindow,
    50,
    500,
    (historyPenaltyWindow) => persist({ historyPenaltyWindow })
  )
  inputs.historyPenaltyWindow = historyField.input

  const popularField = createCheckboxField(
    "Prefer less-played library tracks",
    settings.deprioritizePopular,
    (deprioritizePopular) => persist({ deprioritizePopular })
  )
  inputs.deprioritizePopular = popularField.input

  const excludeField = createCheckboxField(
    "Exclude seed artist early",
    settings.excludeSeedArtistEarly,
    (excludeSeedArtistEarly) => persist({ excludeSeedArtistEarly })
  )
  inputs.excludeSeedArtistEarly = excludeField.input

  const tempoField = createCheckboxField(
    "Match seed tempo (BPM)",
    settings.matchTempo,
    (matchTempo) => persist({ matchTempo })
  )
  inputs.matchTempo = tempoField.input

  const energyField = createCheckboxField(
    "Match seed energy",
    settings.matchEnergy,
    (matchEnergy) => persist({ matchEnergy })
  )
  inputs.matchEnergy = energyField.input

  const valenceField = createCheckboxField(
    "Match seed mood (valence)",
    settings.matchValence,
    (matchValence) => persist({ matchValence })
  )
  inputs.matchValence = valenceField.input

  const resetButton = document.createElement("button")
  resetButton.type = "button"
  resetButton.className = "popup-reset"
  resetButton.textContent = "Reset defaults"
  resetButton.addEventListener("click", () => {
    persist({
      ...DEFAULT_SETTINGS,
      blendPhases: [...DEFAULT_SETTINGS.blendPhases],
    })
  })

  root.append(
    title,
    help,
    eraField.row,
    artistField.row,
    refillField.row,
    batchField.row,
    historyField.row,
    popularField.row,
    excludeField.row,
    tempoField.row,
    energyField.row,
    valenceField.row,
    resetButton
  )

  return root
}

export const openSettingsPage = () => {
  try {
    Spicetify.PopupModal.hide()
  } catch {
    // No modal open yet
  }

  setTimeout(() => {
    Spicetify.PopupModal.display({
      title: "Better Shuffle",
      content: buildSettingsDom(),
      isLarge: true,
    })
  }, 100)
}

let settingsMenuRegistered = false

export const registerSettingsMenu = () => {
  if (settingsMenuRegistered) return

  if (!Spicetify.Menu?.Item || !Spicetify.Menu?.SubMenu) {
    throw new Error("Spicetify.Menu is not available")
  }

  const settingsItem = new Spicetify.Menu.Item(
    "Settings",
    false,
    () => openSettingsPage(),
    "edit"
  )

  new Spicetify.Menu.SubMenu("Better Shuffle", [settingsItem]).register()

  settingsMenuRegistered = true
  console.info("[Better Shuffle] Profile menu registered")
}
