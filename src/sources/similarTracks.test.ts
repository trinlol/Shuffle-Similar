import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSmartConfig } from "../storage/settings"
import { getSourceProvenance } from "./provenance"
import {
  enrichPlaylistTracks,
  fetchPlaylistRecommendations,
  fetchPlaylistSimilarPool,
  fetchSimilarPool,
  filterInstrumentalsAndSoundtracksPublic,
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
      getSourceProvenance(first.find((track) => track.uri === "spotify:track:radio")!)
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
})

describe("instrumental-seed rule", () => {
  beforeEach(() => resetSpotifySourceState())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps instrumental candidates and drops vocal ones for an instrumental seed", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates: TrackCandidate[] = [
      { uri: "spotify:track:inst", instrumentalness: 0.8, albumName: "Some Score" },
      { uri: "spotify:track:vocal", instrumentalness: 0.05, albumName: "Pop Album" },
    ]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered.map((c) => c.uri)).toEqual(["spotify:track:inst"])
  })

  it("uses the genre/album heuristic for candidates without feature data", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates: TrackCandidate[] = [
      { uri: "spotify:track:score-album", albumName: "Dune (Original Motion Picture Soundtrack)" },
      { uri: "spotify:track:classical", genres: ["classical", "orchestral"] },
      { uri: "spotify:track:pop", albumName: "Pop Hits 2026" },
    ]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered.map((c) => c.uri)).toEqual([
      "spotify:track:score-album",
      "spotify:track:classical",
    ])
  })

  it("allows soundtrack albums when the seed is an instrumental score", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates: TrackCandidate[] = [
      {
        uri: "spotify:track:score",
        instrumentalness: 0.9,
        albumName: "Blade Runner 2049 (Original Score)",
      },
    ]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered).toHaveLength(1)
  })

  it("does not trigger for neutral seeds (0.2 ≤ instrumentalness < 0.9)", () => {
    const neutralSeed: SeedMetadata = { ...seed, instrumentalness: 0.5 }
    const candidates: TrackCandidate[] = [{ uri: "spotify:track:whatever", instrumentalness: 0.1 }]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, neutralSeed)
    expect(filtered).toHaveLength(1)
  })

  it("adds min_instrumentalness to recommendations URL for instrumental seeds", async () => {
    const urls: string[] = []
    const get = vi.fn(async (url: string) => {
      if (url.includes("/v1/recommendations")) {
        urls.push(url)
        return { tracks: [] }
      }
      return {}
    })
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: { get },
    })
    const scoreSeed: SeedMetadata = { ...seed, instrumentalness: 0.95 }
    await fetchSimilarPool(scoreSeed, getSmartConfig(scoreSeed))
    expect(urls.some((url) => url.includes("min_instrumentalness=0.5"))).toBe(true)
  })

  it("veto: vocal-indicator album names are rejected by the heuristic", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates: TrackCandidate[] = [
      // "score" matches, but "hits" + vocal framing must veto it
      { uri: "spotify:track:high-score", albumName: "High Score Vocal Hits" },
      // "piano" matches, but "sing"/"sung" framing must veto it
      { uri: "spotify:track:piano-man", albumName: "Piano Man Sing-Along" },
      // instrumental term + no vocal indicators → kept
      { uri: "spotify:track:clean-score", albumName: "Quiet Score" },
    ]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered.map((c) => c.uri)).toEqual(["spotify:track:clean-score"])
  })

  it("applies the instrumental rule to playlist pools only on a seed majority", async () => {
    const majorityInstrumental = async (instrumentalUris: Set<string>) => {
      const playlist: TrackCandidate[] = Array.from({ length: 3 }, (_, index) => ({
        uri: `spotify:track:pl-${index}`,
        artistUri: `spotify:artist:pl-${index}`,
        albumUri: `spotify:album:pl-${index}`,
        trackName: `Playlist Track ${index}`,
        artistName: `Playlist Artist ${index}`,
        albumName: "Regular Album",
        popularity: 40,
        releaseYear: 2024,
        instrumentalness: instrumentalUris.has(`spotify:track:pl-${index}`) ? 0.95 : 0.1,
      }))
      return fetchPlaylistSimilarPool(playlist, getSmartConfig(seed), 3)
    }

    // buildSeedMetadataFromCandidate re-fetches features for the playlist
    // seeds themselves, so the features mock must follow the current scenario.
    let instrumentalSeeds = new Set<string>()
    const get = vi.fn(async (url: string) => {
      if (url.includes("/v1/audio-features/")) {
        const id = url.split("/").pop()
        // Playlist seeds per scenario are instrumental; everything the
        // discovery pool returns is vocal, so the majority case must filter
        // all of it out of the playlist pool.
        return { instrumentalness: instrumentalSeeds.has(`spotify:track:${id}`) ? 0.95 : 0.05 }
      }
      if (url.includes("/v1/recommendations")) {
        const seedId = url.split("seed_tracks=")[1]?.split("&")[0] ?? "x"
        return {
          tracks: [0, 1].map((index) => webTrack(`rec-${seedId}-${index}`)),
        }
      }
      if (url.includes("/related-artists")) return { artists: [] }
      if (url.includes("/v1/search?")) return { tracks: { items: [] } }
      if (url.includes("inspiredby-mix")) return { mediaItems: [] }
      if (url.includes("/v1/artists/")) return { genres: ["indie pop"] }
      if (url.includes("/v1/tracks/")) {
        const id = url.split("/").pop()?.split("?")[0]
        return webTrack(id ?? "")
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
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
          fetchTracksForRadioStation: { name: "radio" },
          queryAlbumTracks: { name: "album" },
        },
        Request: vi.fn(async () => ({
          data: { albumUnion: { tracksV2: { items: [] } } },
        })),
      },
    })

    // 2 of 3 seeds instrumental → majority → vocal candidates are filtered out.
    instrumentalSeeds = new Set(["spotify:track:pl-0", "spotify:track:pl-1"])
    const withMajority = await majorityInstrumental(instrumentalSeeds)
    // The discovery pool returns only vocal candidates (0.05), so a majority
    // instrumental seed set must filter them all out of the playlist pool.
    expect(withMajority).toHaveLength(0)

    // Scenario 1 cached the playlist seeds' audio features; a stale pl-1
    // "instrumental" feature would leak into this scenario and flip the vote.
    resetSpotifySourceState()

    // 1 of 3 instrumental → no majority → vocal candidates survive.
    instrumentalSeeds = new Set(["spotify:track:pl-0"])
    const withoutMajority = await majorityInstrumental(instrumentalSeeds)
    expect(withoutMajority.length).toBeGreaterThan(0)
  })

  it("aligns the playlist recommendations URL param with the seed majority", async () => {
    const urls: string[] = []
    const get = vi.fn(async (url: string) => {
      if (url.includes("/v1/recommendations")) {
        urls.push(url)
        return { tracks: [] }
      }
      return {}
    })
    vi.stubGlobal("Spicetify", {
      Locale: { getLocale: () => "en_GB" },
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: { get },
    })

    const makeSeeds = (instrumentalCount: number): TrackCandidate[] =>
      Array.from({ length: 3 }, (_, index) => ({
        uri: `spotify:track:seed-${index}`,
        instrumentalness: index < instrumentalCount ? 0.95 : 0.1,
      }))

    await fetchPlaylistRecommendations(makeSeeds(2), getSmartConfig(seed), 10)
    expect(urls.some((url) => url.includes("min_instrumentalness=0.5"))).toBe(true)

    urls.length = 0
    await fetchPlaylistRecommendations(makeSeeds(1), getSmartConfig(seed), 10)
    expect(urls.some((url) => url.includes("min_instrumentalness=0.5"))).toBe(false)
  })
})
