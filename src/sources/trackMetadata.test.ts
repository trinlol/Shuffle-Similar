import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchSeedMetadata } from "./trackMetadata"

describe("fetchSeedMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves an off-player track name through search when direct metadata fails", async () => {
    const get = vi.fn(async (url: string) => {
      if (url.includes("/v1/tracks/")) throw new Error("track lookup failed")
      if (url.includes("/v1/search?")) {
        return {
          tracks: {
            items: [
              {
                id: "seed-id",
                uri: "spotify:track:seed-id",
                name: "The Actual Song",
                popularity: 42,
                artists: [{ id: "artist-id", uri: "spotify:artist:artist-id", name: "Artist" }],
                album: { uri: "spotify:album:album-id", name: "Album", release_date: "2024-01-01" },
              },
            ],
          },
        }
      }
      if (url.includes("/v1/artists/")) return { genres: ["indie"] }
      if (url.includes("/v1/audio-features/")) return {}
      throw new Error(`Unexpected URL: ${url}`)
    })

    vi.stubGlobal("Spicetify", {
      Player: { data: { item: { uri: "spotify:track:different-id", metadata: {} } } },
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: { get },
      GraphQL: {
        Definitions: { queryAlbumTracks: {} },
        Request: vi.fn().mockResolvedValue({ data: {} }),
      },
    })

    const seed = await fetchSeedMetadata("spotify:track:seed-id")

    expect(seed.trackName).toBe("The Actual Song")
    expect(seed.artistName).toBe("Artist")
  })
})
