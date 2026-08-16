import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSmartConfig } from "../storage/settings"
import { getSourceProvenance } from "./provenance"
import {
  enrichPlaylistTracks,
  fetchPlaylistSimilarPool,
  fetchSimilarPool,
  getSpotifySourceDiagnostics,
  resetSpotifySourceState,
  searchTracks,
} from "./similarTracks"

const seed: SeedMetadata = {
  uri: "spotify:track:seed",
  trackId: "seed",
  trackName: "Seed",
  artistName: "Seed Artist",
  artistUri: "spotify:artist:seed-artist",
  albumUri: "spotify:album:seed-album",
  releaseYear: 2024,
  genres: ["indie pop"],
}

const webTrack = (id: string) => ({
  id,
  uri: `spotify:track:${id}`,
  name: `Track ${id}`,
  popularity: 40,
  is_playable: true,
  artists: [{ id: `artist-${id}`, uri: `spotify:artist:artist-${id}`, name: `Artist ${id}` }],
  album: {
    id: `album-${id}`,
    uri: `spotify:album:album-${id}`,
    name: `Album ${id}`,
    release_date: "2024-01-01",
  },
})

describe("restricted Spotify source compatibility", () => {
  beforeEach(() => resetSpotifySourceState())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps every Search request at Spotify's maximum of 10", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const get = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset") ?? 0)
      return {
        tracks: { items: Array.from({ length: 10 }, (_, index) => webTrack(`${offset + index}`)) },
      }
    })
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      CosmosAsync: { get },
    })

    const tracks = await searchTracks("genre:indie", 35, "test-search")

    expect(tracks).toHaveLength(35)
    expect(get).toHaveBeenCalledTimes(4)
    for (const [url] of get.mock.calls) {
      expect(new URL(String(url)).searchParams.get("limit")).toBe("10")
    }
    expect(getSourceProvenance(tracks[0])).toEqual(["test-search"])
  })

  it("enriches through bounded single-item endpoints without removed batch requests", async () => {
    const urls: string[] = []
    const get = vi.fn(async (url: string) => {
      urls.push(url)
      const id = url.split("/").pop()?.split("?")[0] ?? "unknown"
      if (url.includes("/audio-features/")) {
        return { id, tempo: 123, energy: 0.7, valence: 0.6, danceability: 0.5 }
      }
      if (url.includes("/tracks/")) return webTrack(id)
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: { get },
    })
    const input: TrackCandidate[] = Array.from({ length: 3 }, (_, index) => ({
      uri: `spotify:track:${index}`,
    }))

    const enriched = await enrichPlaylistTracks(input)

    expect(enriched.every((track) => track.tempo === 123 && track.trackName)).toBe(true)
    expect(urls.some((url) => url.includes("audio-features?ids="))).toBe(false)
    expect(urls.some((url) => url.includes("/tracks?ids="))).toBe(false)
    expect(urls.filter((url) => url.includes("/audio-features/")).length).toBeLessThanOrEqual(12)
    expect(urls.filter((url) => url.includes("/tracks/")).length).toBeLessThanOrEqual(12)
  })

  it("keeps healthy internal and Search fallbacks when optional Web API capabilities are forbidden", async () => {
    const optionalCalls = { recommendations: 0, related: 0, features: 0 }
    let searchIndex = 0
    const get = vi.fn(async (url: string) => {
      if (url.includes("/audio-features/")) {
        optionalCalls.features += 1
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      }
      if (url.includes("/recommendations?")) {
        optionalCalls.recommendations += 1
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      }
      if (url.includes("/related-artists")) {
        optionalCalls.related += 1
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      }
      if (url.includes("/v1/search?")) {
        searchIndex += 1
        return { tracks: { items: [webTrack(`search-${searchIndex}`)] } }
      }
      if (url.includes("inspiredby-mix")) {
        return { mediaItems: [{ uri: "spotify:playlist:inspired" }] }
      }
      if (url.includes("/v1/tracks/")) return webTrack(url.split("/").pop()?.split("?")[0] ?? "metadata")
      throw new Error(`Unexpected URL: ${url}`)
    })
    const radioDefinition = { name: "radio" }
    const albumDefinition = { name: "album" }
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      URI: {
        fromString: (uri: string) => ({ id: uri.split(":").pop() }),
        radioURI: () => ({ toString: () => "spotify:station:seed" }),
      },
      CosmosAsync: { get },
      Platform: {
        PlaylistAPI: {
          getContents: vi.fn().mockResolvedValue({
            items: [
              {
                uri: "spotify:track:inspired",
                isPlayable: true,
                metadata: {
                  title: "Inspired",
                  artist_uri: "spotify:artist:inspired",
                  album_uri: "spotify:album:inspired",
                  album_name: "Inspired Album",
                  popularity: "50",
                  release_year: "2024",
                },
              },
            ],
          }),
        },
      },
      GraphQL: {
        Definitions: {
          fetchTracksForRadioStation: radioDefinition,
          queryAlbumTracks: albumDefinition,
        },
        Request: vi.fn(async (definition: unknown) => {
          if (definition === radioDefinition) {
            return {
              data: {
                radioStation: {
                  tracks: {
                    items: [
                      {
                        track: {
                          uri: "spotify:track:radio",
                          artists: {
                            items: [
                              { uri: "spotify:artist:radio", profile: { name: "Radio Artist" } },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            }
          }
          return { data: { albumUnion: { tracksV2: { items: [] } } } }
        }),
      },
    })

    const first = await fetchSimilarPool(seed, getSmartConfig(seed))
    const second = await fetchSimilarPool(seed, getSmartConfig(seed))

    expect(first.map((track) => track.uri)).toEqual(
      expect.arrayContaining(["spotify:track:inspired", "spotify:track:radio"])
    )
    expect(second.length).toBeGreaterThan(0)
    expect(optionalCalls).toEqual({ recommendations: 1, related: 1, features: 1 })
    expect(getSourceProvenance(first.find((track) => track.uri === "spotify:track:radio")!)).toContain(
      "radio"
    )
    expect(
      getSpotifySourceDiagnostics().capabilities.map(({ capability, status }) => ({
        capability,
        status,
      }))
    ).toEqual(
      expect.arrayContaining([
        { capability: "recommendations", status: "unsupported" },
        { capability: "related-artists", status: "unsupported" },
        { capability: "audio-features", status: "unsupported" },
      ])
    )
  })

  it("globally bounds playlist fan-out enrichment requests and concurrency", async () => {
    let activeEnrichment = 0
    let peakEnrichment = 0
    let audioRequests = 0
    let metadataRequests = 0
    let radioRequest = 0
    const withMeasuredEnrichment = async <T>(value: T): Promise<T> => {
      activeEnrichment += 1
      peakEnrichment = Math.max(peakEnrichment, activeEnrichment)
      await new Promise((resolve) => setTimeout(resolve, 1))
      activeEnrichment -= 1
      return value
    }
    const get = vi.fn(async (url: string) => {
      const id = url.split("/").pop()?.split("?")[0] ?? "unknown"
      if (url.includes("/audio-features/")) {
        audioRequests += 1
        return withMeasuredEnrichment({
          id,
          tempo: 120,
          energy: 0.7,
          valence: 0.6,
          danceability: 0.5,
          acousticness: 0.2,
          instrumentalness: 0.05,
        })
      }
      if (url.includes("/v1/tracks/")) {
        metadataRequests += 1
        return withMeasuredEnrichment(webTrack(id))
      }
      if (url.includes("/recommendations?")) return { tracks: [] }
      if (url.includes("/related-artists")) return { artists: [] }
      if (url.includes("/v1/search?")) return { tracks: { items: [] } }
      if (url.includes("inspiredby-mix")) return { mediaItems: [] }
      if (url.includes("/v1/artists/")) return { genres: ["indie pop"] }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const radioDefinition = { name: "radio" }
    const albumDefinition = { name: "album" }
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      URI: {
        fromString: (uri: string) => ({ id: uri.split(":").pop() }),
        radioURI: () => ({ toString: () => "spotify:station:seed" }),
      },
      CosmosAsync: { get },
      Platform: { PlaylistAPI: { getContents: vi.fn().mockResolvedValue({ items: [] }) } },
      GraphQL: {
        Definitions: {
          fetchTracksForRadioStation: radioDefinition,
          queryAlbumTracks: albumDefinition,
        },
        Request: vi.fn(async (definition: unknown) => {
          if (definition !== radioDefinition) {
            return { data: { albumUnion: { tracksV2: { items: [] } } } }
          }
          radioRequest += 1
          return {
            data: {
              radioStation: {
                tracks: {
                  items: Array.from({ length: 10 }, (_, index) => ({
                    track: {
                      uri: `spotify:track:radio-${radioRequest}-${index}`,
                      artists: {
                        items: [
                          {
                            uri: `spotify:artist:radio-${radioRequest}-${index}`,
                            profile: { name: `Radio ${radioRequest}-${index}` },
                          },
                        ],
                      },
                    },
                  })),
                },
              },
            },
          }
        }),
      },
    })
    const playlist = Array.from({ length: 5 }, (_, index) => ({
      uri: `spotify:track:playlist-${index}`,
    }))

    const result = await fetchPlaylistSimilarPool(playlist, getSmartConfig(seed), 5)

    expect(result.length).toBeGreaterThan(0)
    expect(audioRequests).toBeLessThanOrEqual(17)
    expect(metadataRequests).toBeLessThanOrEqual(17)
    expect(peakEnrichment).toBeLessThanOrEqual(3)
  })
})
