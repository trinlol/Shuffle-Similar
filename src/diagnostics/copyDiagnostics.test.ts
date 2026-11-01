import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { copyDiagnostics } from "./copyDiagnostics"

const showNotification = vi.fn()

const stubSpicetify = (extra: Record<string, unknown> = {}) =>
  vi.stubGlobal("Spicetify", { showNotification, Config: { version: "2.46.4" }, ...extra })

describe("copyDiagnostics", () => {
  beforeEach(() => {
    showNotification.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns true and notifies on success", async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    stubSpicetify()
    vi.stubGlobal("navigator", { clipboard: { writeText } })

    expect(await copyDiagnostics()).toBe(true)
    expect(JSON.parse(writeText.mock.calls[0][0]).spicetifyVersion).toBe("2.46.4")
    expect(showNotification).toHaveBeenCalledWith("Diagnostics copied")
  })

  it("returns false and notifies when the clipboard rejects", async () => {
    stubSpicetify()
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    })

    expect(await copyDiagnostics()).toBe(false)
    expect(showNotification).toHaveBeenCalledWith("Could not copy diagnostics", true)
  })

  it("falls back to ClipboardAPI when navigator.clipboard is missing", async () => {
    const copy = vi.fn(async (_text: string) => undefined)
    stubSpicetify({ Platform: { ClipboardAPI: { copy } } })
    vi.stubGlobal("navigator", {})

    expect(await copyDiagnostics()).toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith("Diagnostics copied")
  })
})
