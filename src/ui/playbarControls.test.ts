import { describe, expect, it } from "vitest"
import {
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

  it("ignores playbar mutations unless a shuffle control was disconnected or changed", () => {
    const nodes = { length: 0, item: () => null } as unknown as NodeList
    const records = [{ addedNodes: nodes, removedNodes: nodes }]

    expect(playbarMutationsAffectControls(records, { isConnected: true })).toBe(false)
    expect(playbarMutationsAffectControls(records, { isConnected: false })).toBe(true)
  })
})
