import { afterEach, describe, expect, it, vi } from "vitest"
import type { SeedMetadata } from "../session/types"
import {
  fetchAllPlaylistTracks,
  fetchProfilePool,
  fetchRecentlyPlayedTracks,
  fetchTopTracks,
  PROFILE_SOURCE_TIMEOUT_MS,
} from "./profileTracks"

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed",
  genres: ["indie"],
}

const platformItem = (id: string) => ({
  uri: `spotify:track:${id}`,
  isPlayable: true,
  metadata: {
    title: `Track ${id}`,
    artist_uri: `spotify:artist:${id}`,
    artist_name: `Artist ${id}`,
  },
})

describe("profile source fallbacks", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("preserves a healthy top-track window when its sibling request fails", async () => {
    const get = vi.fn(async (url: string) => {
      if (url.includes("short_term")) throw new Error("short-term unavailable")
      if (url.includes("medium_term")) {
        return {
          items: [{ uri: "spotify:track:healthy" }, { uri: "spotify:track:healthy" }],
        }
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal("Spicetify", { CosmosAsync: { get } })

    await expect(fetchTopTracks()).resolves.toEqual(["spotify:track:healthy"])
  })

  it("uses recently played tracks as a bounded profile signal", async () => {
    vi.stubGlobal("Spicetify", {
      CosmosAsync: {
        get: vi.fn().mockResolvedValue({
          items: [
            {
              track: {
                uri: "spotify:track:recent",
                is_playable: true,
                artists: [{ uri: "spotify:artist:recent", name: "Recent Artist" }],
              },
            },
          ],
        }),
      },
    })

    await expect(fetchRecentlyPlayedTracks()).resolves.toEqual([
      expect.objectContaining({
        uri: "spotify:track:recent",
        artistUri: "spotify:artist:recent",
      }),
    ])
  })

  it("returns liked tracks while unrelated platform APIs hang", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "info").mockImplementation(() => undefined)
    vi.stubGlobal("Spicetify", {
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: {
        get: vi.fn().mockResolvedValue({
          items: [
            {
              track: {
                uri: "spotify:track:liked",
                is_playable: true,
                artists: [{ uri: "spotify:artist:liked", name: "Liked Artist" }],
              },
            },
          ],
          next: null,
        }),
      },
      Platform: {
        RootlistAPI: { getContents: () => new Promise(() => undefined) },
        PlaylistAPI: { getContents: vi.fn() },
      },
    })

    const pending = fetchProfilePool(seed)
    await vi.advanceTimersByTimeAsync(PROFILE_SOURCE_TIMEOUT_MS + 1)

    await expect(pending).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: "spotify:track:liked" })])
    )
  })

  it("never exceeds shared playlist concurrency across concurrent playlist fetches", async () => {
    vi.useFakeTimers()
    let active = 0
    let peak = 0
    const playlistGet = vi.fn(async (uri: string) => {
      active += 1
      peak = Math.max(peak, active)
      if (uri.endsWith(":hanging")) return await new Promise(() => undefined)
      await Promise.resolve()
      active -= 1
      return { items: [platformItem(uri.split(":").pop() ?? "unknown")] }
    })
    vi.stubGlobal("Spicetify", {
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      Platform: { PlaylistAPI: { getContents: playlistGet } },
    })

    const pending = Promise.all(
      ["one", "hanging", "two", "three", "four"].map((id) =>
        fetchAllPlaylistTracks(`spotify:playlist:${id}`)
      )
    )
    await vi.advanceTimersByTimeAsync(PROFILE_SOURCE_TIMEOUT_MS + 1)
    const results = await pending

    const uris = results.flat().map((track) => track.uri)
    expect(uris).toEqual(
      expect.arrayContaining([
        "spotify:track:one",
        "spotify:track:two",
        "spotify:track:three",
        "spotify:track:four",
      ])
    )
    expect(uris).not.toContain("spotify:track:hanging")
    expect(peak).toBeLessThanOrEqual(3)
  })

  it("fetchProfilePool fetches only liked tracks (no recently-played, no playlist sampling)", async () => {
    const calls: string[] = []
    const rootlistSpy = vi.fn().mockResolvedValue({ items: [] })
    const get = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes("/me/tracks")) {
        return {
          items: [{ track: { uri: "spotify:track:liked", popularity: 30, is_playable: true } }],
          next: null,
        }
      }
      if (url.includes("recently-played")) {
        return { items: [{ track: { uri: "spotify:track:recent", is_playable: true } }] }
      }
      return {}
    })
    vi.stubGlobal("Spicetify", {
      CosmosAsync: { get },
      Platform: { RootlistAPI: { getContents: rootlistSpy } },
    })

    const pool = await fetchProfilePool(seed)

    expect(pool.map((c) => c.uri)).toContain("spotify:track:liked")
    expect(pool.map((c) => c.uri)).not.toContain("spotify:track:recent")
    expect(calls.some((url) => url.includes("recently-played"))).toBe(false)
    expect(calls.every((url) => url.includes("/me/tracks"))).toBe(true)
    expect(rootlistSpy).not.toHaveBeenCalled()
  })

  it("returns completed pages when a later fetchAllPlaylistTracks page hangs", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "info").mockImplementation(() => undefined)
    const playlistGet = vi.fn(async (_uri: string, options: { offset?: number }) => {
      if ((options.offset ?? 0) >= 100) return await new Promise(() => undefined)
      return { items: Array.from({ length: 100 }, (_, index) => platformItem(String(index))) }
    })
    vi.stubGlobal("Spicetify", {
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      Platform: { PlaylistAPI: { getContents: playlistGet } },
    })

    const pending = fetchAllPlaylistTracks("spotify:playlist:context")
    await vi.advanceTimersByTimeAsync(PROFILE_SOURCE_TIMEOUT_MS + 1)

    await expect(pending).resolves.toHaveLength(100)
    expect(playlistGet).toHaveBeenCalledTimes(2)
  })
})
