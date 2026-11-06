import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSmartConfig } from "../storage/settings"
import { getSourceProvenance } from "./provenance"
import {
  capArtistFrequencyInSource,
  enrichPlaylistTracks,
  fetchPlaylistSimilarPool,
  fetchSimilarPool,
  getSpotifySourceDiagnostics,
  resetSpotifySourceState,
  searchTracks,
} from "./similarTracks"
import { resetArtistGenreCache } from "./trackMetadata"

const mustFind = <T>(items: readonly T[], predicate: (item: T) => boolean): T => {
  const found = items.find(predicate)
  if (found === undefined) throw new Error("expected a matching item")
  return found
}

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
  beforeEach(() => {
    resetSpotifySourceState()
    resetArtistGenreCache()
  })
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
      if (url.includes("/v1/tracks/"))
        return webTrack(url.split("/").pop()?.split("?")[0] ?? "metadata")
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
    expect(
      getSourceProvenance(mustFind(first, (track) => track.uri === "spotify:track:radio"))
    ).toContain("radio")
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

  it("never executes naked genre-less year searches when seed genres are empty", async () => {
    const searchQueries: string[] = []
    const genrelessSeed: SeedMetadata = {
      ...seed,
      uri: "spotify:track:new-single",
      trackId: "new-single",
      trackName: "Here You Come, There You Go",
      artistName: "Gracie Abrams",
      artistUri: "spotify:artist:gracie",
      releaseYear: 2026,
      genres: [],
    }
    const get = vi.fn(async (url: string) => {
      if (url.includes("/v1/search?")) {
        const q = new URL(url).searchParams.get("q") ?? ""
        searchQueries.push(q)
        return { tracks: { items: [webTrack("artist-hit")] } }
      }
      if (url.includes("/audio-features/"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("/recommendations?"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("/related-artists"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("inspiredby-mix")) return { mediaItems: [] }
      if (url.includes("/v1/artists/")) return { genres: ["indie pop"] }
      if (url.includes("/v1/tracks/")) return webTrack("artist-hit")
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_US" },
      URI: {
        fromString: (uri: string) => ({ id: uri.split(":").pop() }),
        radioURI: () => ({ toString: () => "spotify:station:new-single" }),
      },
      CosmosAsync: { get },
      Platform: { PlaylistAPI: { getContents: vi.fn().mockResolvedValue({ items: [] }) } },
      GraphQL: {
        Definitions: {},
        Request: vi.fn().mockResolvedValue({ data: {} }),
      },
    })

    const pool = await fetchSimilarPool(genrelessSeed, getSmartConfig(genrelessSeed))

    expect(pool.length).toBeGreaterThan(0)
    // Every search query must stay anchored to an artist or genre — never a naked year: range.
    expect(searchQueries.length).toBeGreaterThan(0)
    for (const q of searchQueries) {
      expect(q).not.toMatch(/^\s*year:\d{4}-\d{4}\s*$/)
      expect(q.toLowerCase()).toContain("gracie abrams")
    }
  })

  it("recovers related-artist top tracks and discovered-on playlists via desktop GraphQL when Web API related-artists is 403", async () => {
    const relatedDef = { name: "queryArtistRelated" }
    const overviewDef = { name: "queryArtistOverview" }
    const discoveredDef = { name: "queryArtistDiscoveredOn" }

    const get = vi.fn(async (url: string) => {
      if (url.includes("/related-artists"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("/recommendations?"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("/audio-features/"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("inspiredby-mix")) return { mediaItems: [] }
      if (url.includes("/v1/search?")) return { tracks: { items: [] } }
      if (url.includes("/v1/artists/")) return { genres: ["indie pop", "singer-songwriter"] }
      if (url.includes("/v1/tracks/")) return webTrack(url.split("/").pop()?.split("?")[0] ?? "t")
      throw new Error(`Unexpected URL: ${url}`)
    })

    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_US" },
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
                uri: "spotify:track:cooccurring-indie",
                isPlayable: true,
                metadata: {
                  title: "Ceilings",
                  artist_uri: "spotify:artist:lizzy",
                  artist_name: "Lizzy McAlpine",
                  album_uri: "spotify:album:five-seconds-flat",
                  album_name: "five seconds flat",
                },
              },
            ],
          }),
        },
      },
      GraphQL: {
        Definitions: {
          queryArtistRelated: relatedDef,
          queryArtistOverview: overviewDef,
          queryArtistDiscoveredOn: discoveredDef,
        },
        Request: vi.fn(async (definition: unknown) => {
          if (definition === relatedDef) {
            return {
              data: {
                artistUnion: {
                  relatedContent: {
                    relatedArtists: {
                      items: [
                        { uri: "spotify:artist:phoebe", profile: { name: "Phoebe Bridgers" } },
                      ],
                    },
                  },
                },
              },
            }
          }
          if (definition === overviewDef) {
            return {
              data: {
                artistUnion: {
                  profile: { name: "Phoebe Bridgers" },
                  discography: {
                    topTracks: {
                      items: [
                        {
                          track: {
                            uri: "spotify:track:phoebe-motion-sickness",
                            name: "Motion Sickness",
                            playability: { playable: true },
                            artists: {
                              items: [
                                {
                                  uri: "spotify:artist:phoebe",
                                  profile: { name: "Phoebe Bridgers" },
                                },
                              ],
                            },
                            albumOfTrack: {
                              uri: "spotify:album:stranger-in-the-alps",
                              name: "Stranger in the Alps",
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }
          }
          if (definition === discoveredDef) {
            return {
              data: {
                artistUnion: {
                  relatedContent: {
                    discoveredOnV2: {
                      items: [{ data: { uri: "spotify:playlist:sad-indie" } }],
                    },
                  },
                },
              },
            }
          }
          return { data: {} }
        }),
      },
    })

    const pool = await fetchSimilarPool(seed, getSmartConfig(seed))
    const uris = pool.map((track) => track.uri)

    expect(uris).toContain("spotify:track:phoebe-motion-sickness")
    expect(uris).toContain("spotify:track:cooccurring-indie")
    expect(
      getSourceProvenance(
        mustFind(pool, (track) => track.uri === "spotify:track:phoebe-motion-sickness")
      )
    ).toContain("related-artists")
    expect(
      getSourceProvenance(
        mustFind(pool, (track) => track.uri === "spotify:track:cooccurring-indie")
      )
    ).toContain("discovered-on")
  })

  it("caps per-artist dominance in sources to at most 2 tracks", () => {
    const candidates: TrackCandidate[] = [
      { uri: "spotify:track:1", artistUri: "spotify:artist:a" },
      { uri: "spotify:track:2", artistUri: "spotify:artist:a" },
      { uri: "spotify:track:3", artistUri: "spotify:artist:a" },
      { uri: "spotify:track:4", artistUri: "spotify:artist:b" },
      { uri: "spotify:track:5", artistUri: "spotify:artist:b" },
      { uri: "spotify:track:6", artistUri: "spotify:artist:b" },
      { uri: "spotify:track:7" }, // missing artist identity
    ]

    const capped = capArtistFrequencyInSource(candidates, 2)
    const artistACount = capped.filter((c) => c.artistUri === "spotify:artist:a").length
    const artistBCount = capped.filter((c) => c.artistUri === "spotify:artist:b").length
    expect(artistACount).toBe(2)
    expect(artistBCount).toBe(2)
    expect(capped.some((c) => c.uri === "spotify:track:7")).toBe(true)
  })

  it("expands discovery via 2-hop related artists in GraphQL", async () => {
    const relatedDef = { name: "queryArtistRelated" }
    const overviewDef = { name: "queryArtistOverview" }

    const get = vi.fn(async (url: string) => {
      if (url.includes("/related-artists"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("/recommendations?"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("/audio-features/"))
        throw Object.assign(new Error("Forbidden"), { status: 403 })
      if (url.includes("inspiredby-mix")) return { mediaItems: [] }
      if (url.includes("/v1/search?")) return { tracks: { items: [] } }
      if (url.includes("/v1/artists/")) return { genres: ["indie pop"] }
      if (url.includes("/v1/tracks/")) return webTrack(url.split("/").pop()?.split("?")[0] ?? "t")
      throw new Error(`Unexpected URL: ${url}`)
    })

    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_US" },
      URI: {
        fromString: (uri: string) => ({ id: uri.split(":").pop() }),
        radioURI: () => ({ toString: () => "spotify:station:seed" }),
      },
      CosmosAsync: { get },
      Platform: { PlaylistAPI: { getContents: vi.fn().mockResolvedValue({ items: [] }) } },
      GraphQL: {
        Definitions: {
          queryArtistRelated: relatedDef,
          queryArtistOverview: overviewDef,
        },
        Request: vi.fn(async (definition: unknown, variables: { uri?: string }) => {
          if (definition === relatedDef) {
            if (variables?.uri === seed.artistUri) {
              // Hop 1 returns artist A and artist B
              return {
                data: {
                  artistUnion: {
                    relatedContent: {
                      relatedArtists: {
                        items: [
                          { uri: "spotify:artist:hop1-a", profile: { name: "Hop 1 Artist A" } },
                          { uri: "spotify:artist:hop1-b", profile: { name: "Hop 1 Artist B" } },
                        ],
                      },
                    },
                  },
                },
              }
            }
            if (variables?.uri === "spotify:artist:hop1-a") {
              // Hop 2 from hop1-a returns a brand-new 2nd-hop artist
              return {
                data: {
                  artistUnion: {
                    relatedContent: {
                      relatedArtists: {
                        items: [
                          {
                            uri: "spotify:artist:hop2-deep",
                            profile: { name: "Hop 2 Deep Artist" },
                          },
                        ],
                      },
                    },
                  },
                },
              }
            }
            return { data: { artistUnion: { relatedContent: { relatedArtists: { items: [] } } } } }
          }
          if (definition === overviewDef) {
            const artistUri = variables?.uri ?? "unknown"
            const artistId = artistUri.split(":").pop() ?? "unknown"
            return {
              data: {
                artistUnion: {
                  profile: { name: `Artist ${artistId}` },
                  discography: {
                    topTracks: {
                      items: [
                        {
                          track: {
                            uri: `spotify:track:${artistId}-hit`,
                            name: `Song by ${artistId}`,
                            playability: { playable: true },
                            artists: {
                              items: [{ uri: artistUri, profile: { name: `Artist ${artistId}` } }],
                            },
                            albumOfTrack: {
                              uri: `spotify:album:${artistId}-album`,
                              name: `Album ${artistId}`,
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }
          }
          return { data: {} }
        }),
      },
    })

    const pool = await fetchSimilarPool(seed, getSmartConfig(seed))
    const uris = pool.map((t) => t.uri)

    expect(uris).toContain("spotify:track:hop1-a-hit")
    expect(uris).toContain("spotify:track:hop2-deep-hit")
  })
})
