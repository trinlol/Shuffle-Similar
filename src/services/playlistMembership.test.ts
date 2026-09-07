import { beforeAll, describe, expect, it } from "vitest"
import { buildPlaylistMembershipSet } from "./playlistMembership"

beforeAll(() => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    // getUriId resolves playlist ids through Spicetify.URI.
    URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
    Platform: {
      RootlistAPI: {
        getContents: async () => ({
          items: [
            { type: "playlist", uri: "spotify:playlist:a", name: "Chill" },
            { type: "playlist", uri: "spotify:playlist:b", name: "Rock" },
            {
              type: "folder",
              items: [{ type: "playlist", uri: "spotify:playlist:c", name: "Nested" }],
            },
          ],
        }),
      },
      PlaylistAPI: {
        getContents: async (uri: string) => ({
          items:
            uri === "spotify:playlist:a"
              ? [{ uri: "spotify:track:in-a" }]
              : uri === "spotify:playlist:b"
                ? [{ uri: "spotify:track:in-b" }, { uri: "spotify:track:in-a" }]
                : [{ uri: "spotify:track:in-c" }],
        }),
      },
    },
  }
})

describe("playlist membership set", () => {
  it("unions track URIs across all playlists, including nested folders", async () => {
    const set = await buildPlaylistMembershipSet()
    expect(set.has("spotify:track:in-a")).toBe(true)
    expect(set.has("spotify:track:in-b")).toBe(true)
    expect(set.has("spotify:track:in-c")).toBe(true)
    expect(set.has("spotify:track:unrelated")).toBe(false)
    expect(set.size).toBe(3)
  })

  it("yields an empty set when playlist enumeration is unavailable", async () => {
    ;(
      globalThis as unknown as {
        Spicetify: { Platform: { RootlistAPI: { getContents: () => Promise<never> } } }
      }
    ).Spicetify.Platform.RootlistAPI = {
      getContents: () => Promise.reject(new Error("unavailable")),
    }

    const set = await buildPlaylistMembershipSet()
    expect(set.size).toBe(0)
  })
})
