import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchSeedMetadata } from "./trackMetadata"
import { optionalSpotifyCapabilities } from "./spotifyApiAdapter"

describe("fetchSeedMetadata", () => {
  beforeEach(() => optionalSpotifyCapabilities.reset())

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

  it("capability-gates unavailable audio features after the first forbidden response", async () => {
    let featureCalls = 0
    const get = vi.fn(async (url: string) => {
      if (url.includes("/v1/tracks/")) {
        const id = url.match(/tracks\/([^?]+)/)?.[1] ?? "unknown"
        return {
          id,
          uri: `spotify:track:${id}`,
          name: `Track ${id}`,
          artists: [{ id: "artist", uri: "spotify:artist:artist", name: "Artist" }],
          album: { uri: "spotify:album:album", name: "Album", release_date: "2025" },
        }
      }
      if (url.includes("/v1/artists/")) return { genres: [] }
      if (url.includes("/v1/audio-features/")) {
        featureCalls += 1
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal("Spicetify", {
      Player: { data: { item: { uri: "", metadata: {} } } },
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: { get },
      GraphQL: {
        Definitions: { queryAlbumTracks: {} },
        Request: vi.fn().mockResolvedValue({ data: {} }),
      },
    })

    await fetchSeedMetadata("spotify:track:first")
    await fetchSeedMetadata("spotify:track:second")

    expect(featureCalls).toBe(1)
    expect(
      optionalSpotifyCapabilities
        .snapshot()
        .find((entry) => entry.capability === "audio-features")?.status
    ).toBe("unsupported")
  })
})
