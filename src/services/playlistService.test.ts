import { afterEach, describe, expect, it, vi } from "vitest"
import { createSimilarPlaylist } from "./playlistService"

describe("createSimilarPlaylist", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("creates and fills a playlist through Spotify's platform APIs", async () => {
    const rootlistApi = {
      marker: "rootlist",
      createPlaylist: vi.fn(function (this: { marker?: string }) {
        if (this.marker !== "rootlist")
          throw new TypeError("Cannot read properties of undefined (reading '_events')")
        return Promise.resolve("spotify:playlist:new-playlist")
      }),
    }
    const playlistApi = {
      marker: "playlist",
      add: vi.fn(function (this: { marker?: string }) {
        if (this.marker !== "playlist")
          throw new TypeError("Cannot read properties of undefined (reading '_events')")
        return Promise.resolve()
      }),
    }
    vi.stubGlobal("Spicetify", {
      Platform: {
        RootlistAPI: rootlistApi,
        PlaylistAPI: playlistApi,
      },
      CosmosAsync: {
        post: vi.fn().mockResolvedValue(undefined),
      },
    })

    const result = await createSimilarPlaylist("Seed", "Artist", [
      "spotify:track:one",
      "spotify:track:two",
      "spotify:track:one",
    ])

    expect(rootlistApi.createPlaylist).toHaveBeenCalledWith("Similar to - Seed", {
      before: "start",
    })
    expect(playlistApi.add).toHaveBeenCalledWith(
      "spotify:playlist:new-playlist",
      ["spotify:track:one", "spotify:track:two"],
      { before: "start" }
    )
    expect(result).toEqual({
      uri: "spotify:playlist:new-playlist",
      trackCount: 2,
    })
  })
})
