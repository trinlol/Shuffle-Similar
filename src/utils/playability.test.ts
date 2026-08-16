import { afterEach, describe, expect, it, vi } from "vitest"
import {
  resetQueuePlayabilityCache,
  verifyQueuePlayability,
} from "./playability"

afterEach(() => {
  resetQueuePlayabilityCache()
  vi.unstubAllGlobals()
})

describe("verifyQueuePlayability", () => {
  it("removes explicit unavailable and local candidates before they reach Spotify's queue", async () => {
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      CosmosAsync: {
        get: vi.fn(async (url: string) => {
          if (url.includes("unavailable")) return { uri: "spotify:track:unavailable", is_playable: false }
          if (url.includes("local")) return { uri: "spotify:track:local", is_playable: true, is_local: true }
          return { uri: "spotify:track:good", is_playable: true }
        }),
      },
    })

    const result = await verifyQueuePlayability([
      "spotify:track:good",
      "spotify:track:unavailable",
      "spotify:track:local",
    ])

    expect(result.playableUris).toEqual(["spotify:track:good"])
    expect(result.rejectedUris).toEqual([
      "spotify:track:unavailable",
      "spotify:track:local",
    ])
    expect(result.degraded).toBe(false)
  })

  it("keeps syntactically valid tracks when Spotify's optional validation endpoint is unavailable", async () => {
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      CosmosAsync: { get: vi.fn(async () => { throw new Error("restricted") }) },
    })

    const result = await verifyQueuePlayability(["spotify:track:one", "spotify:track:two"])

    expect(result.playableUris).toEqual(["spotify:track:one", "spotify:track:two"])
    expect(result.rejectedUris).toEqual([])
    expect(result.uncheckedUris).toEqual(["spotify:track:one", "spotify:track:two"])
    expect(result.degraded).toBe(true)
  })

  it("keeps verified playable tracks ahead of transiently unchecked tracks", async () => {
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      CosmosAsync: {
        get: vi.fn(async (url: string) => {
          const id = url.split("/").pop()?.split("?")[0]
          if (id === "unchecked") throw new Error("temporary validation failure")
          return { uri: `spotify:track:${id}`, is_playable: true }
        }),
      },
    })

    const result = await verifyQueuePlayability([
      "spotify:track:unchecked",
      "spotify:track:verified-one",
      "spotify:track:verified-two",
    ])

    expect(result.playableUris).toEqual([
      "spotify:track:verified-one",
      "spotify:track:verified-two",
      "spotify:track:unchecked",
    ])
    expect(result.checkedUris).toEqual([
      "spotify:track:verified-one",
      "spotify:track:verified-two",
    ])
    expect(result.uncheckedUris).toEqual(["spotify:track:unchecked"])
    expect(result.degraded).toBe(true)
  })

  it("bounds validation work to the queue head so startup remains responsive", async () => {
    const get = vi.fn(async (url: string) => ({
      uri: `spotify:track:${url.split("/").pop()?.split("?")[0]}`,
      is_playable: true,
    }))
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      CosmosAsync: { get },
    })

    const uris = Array.from({ length: 20 }, (_, index) => `spotify:track:${index}`)
    const result = await verifyQueuePlayability(uris)

    expect(result.playableUris).toEqual(uris)
    expect(get).toHaveBeenCalledTimes(12)
    expect(result.uncheckedUris).toEqual(uris.slice(12))
  })
})
