import { describe, expect, it } from "vitest"
import {
  isNativeShuffleLabel,
  playbarMutationsAffectControls,
  removeLegacyButtonsFromMutations,
  sanitizeClonedPlaybarButton,
} from "./playbarControls"

class FakeButton {
  disabled = true
  tabIndex = -1
  type = "submit"
  private readonly attributes = new Map<string, string>([
    ["id", "native-shuffle"],
    ["data-testid", "control-button-shuffle"],
    ["data-active", "true"],
    ["data-context-menu-open", "true"],
    ["aria-checked", "true"],
    ["aria-describedby", "native-tooltip"],
    ["aria-expanded", "true"],
    ["disabled", ""],
    ["style", "color: green"],
    ["title", "Enable shuffle"],
  ])

  getAttributeNames = () => [...this.attributes.keys()]
  removeAttribute = (name: string) => this.attributes.delete(name)
  hasAttribute = (name: string) => this.attributes.has(name)
  querySelectorAll = () => []
}

describe("cloned playbar button sanitation", () => {
  it("removes inherited identity, state, relationship, and inline presentation", () => {
    const button = new FakeButton()

    sanitizeClonedPlaybarButton(button as unknown as HTMLButtonElement)

    expect(button.getAttributeNames()).toEqual([])
    expect(button.disabled).toBe(false)
    expect(button.tabIndex).toBe(0)
    expect(button.type).toBe("button")
  })

  it("does no document-wide work for unrelated playbar mutations", () => {
    const addedNodes = { length: 0, item: () => null } as unknown as NodeList
    expect(removeLegacyButtonsFromMutations([{ addedNodes }])).toBe(0)
  })

  it("ignores playbar mutations unless a shuffle control or timeline banner was disconnected or changed", () => {
    const nodes = { length: 0, item: () => null } as unknown as NodeList
    const records = [{ addedNodes: nodes, removedNodes: nodes }]

    expect(playbarMutationsAffectControls(records, { isConnected: true })).toBe(false)
    expect(playbarMutationsAffectControls(records, { isConnected: false })).toBe(true)
    expect(
      playbarMutationsAffectControls(records, { isConnected: true }, { isConnected: false })
    ).toBe(true)
  })
})

describe("native shuffle label matching", () => {
  it("recognises Spotify's shuffle button when the playlist name contains Similar", () => {
    expect(isNativeShuffleLabel("Enable Shuffle for Similar to - July")).toBe(true)
    expect(isNativeShuffleLabel("Disable Shuffle for Better Days")).toBe(true)
    expect(isNativeShuffleLabel("Enable Shuffle")).toBe(true)
  })

  it("still rejects extension and smart-shuffle buttons and unrelated controls", () => {
    expect(isNativeShuffleLabel("Shuffle Similar")).toBe(false)
    expect(isNativeShuffleLabel("Better Shuffle")).toBe(false)
    expect(isNativeShuffleLabel("Shuffle+ Queue Tracks")).toBe(false)
    expect(isNativeShuffleLabel("Enable Smart Shuffle for Similar to - July")).toBe(false)
    expect(isNativeShuffleLabel("Add to playlist")).toBe(false)
  })
})
