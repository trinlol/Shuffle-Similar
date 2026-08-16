import { describe, expect, it, vi } from "vitest"
import {
  NATIVE_SHUFFLE_BLOCKED_TITLE,
  applyNativeShuffleBlockedState,
} from "./nativeShuffleGuard"

class FakeButton {
  disabled = false
  tabIndex = -1
  private readonly attributes = new Map<string, string>([
    ["tabindex", "-1"],
    ["title", "Native shuffle"],
  ])

  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  getAttribute = (name: string) => this.attributes.get(name) ?? null
  setAttribute = (name: string, value: string) => {
    this.attributes.set(name, value)
    if (name === "tabindex") this.tabIndex = Number(value)
  }
  removeAttribute = (name: string) => {
    this.attributes.delete(name)
    if (name === "tabindex") this.tabIndex = 0
  }
}

describe("native shuffle guard accessibility", () => {
  it("stays focusable and explanatory while blocked, then restores native attributes", () => {
    const button = new FakeButton()
    const element = button as unknown as HTMLButtonElement

    applyNativeShuffleBlockedState(element, true)
    expect(button.disabled).toBe(false)
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute("aria-disabled")).toBe("true")
    expect(button.getAttribute("title")).toBe(NATIVE_SHUFFLE_BLOCKED_TITLE)

    applyNativeShuffleBlockedState(element, false)
    expect(button.disabled).toBe(false)
    expect(button.tabIndex).toBe(-1)
    expect(button.getAttribute("aria-disabled")).toBeNull()
    expect(button.getAttribute("title")).toBe("Native shuffle")
  })

  it("captures original attributes only once across repeated blocked updates", () => {
    const button = new FakeButton()
    const element = button as unknown as HTMLButtonElement

    applyNativeShuffleBlockedState(element, true)
    applyNativeShuffleBlockedState(element, true)
    applyNativeShuffleBlockedState(element, false)

    expect(button.getAttribute("title")).toBe("Native shuffle")
    expect(button.addEventListener).toHaveBeenCalledTimes(1)
    expect(button.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
