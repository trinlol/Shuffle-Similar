import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchArtistDiscographyTracks } from "./artistTracks"
import { getSourceProvenance } from "./provenance"

describe("artist track retrieval", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uses bounded per-album GraphQL requests, never the removed several-albums endpoint", async () => {
    const get = vi.fn(async (url: string) => {
      if (url.includes("/artists/artist-id/albums?")) {
        return {
          items: [
            { id: "album-good", uri: "spotify:album:album-good" },
            { id: "album-broken", uri: "spotify:album:album-broken" },
          ],
        }
      }
      throw new Error(`Unexpected Web API request: ${url}`)
    })
    const request = vi.fn(async (_definition: unknown, variables: { uri: string }) => {
      if (variables.uri.endsWith("album-broken")) throw new Error("album unavailable")
      return {
        data: {
          albumUnion: {
            name: "Healthy Album",
            uri: variables.uri,
            date: { year: 2024 },
            tracksV2: {
              items: [
                {
                  track: {
                    uri: "spotify:track:healthy",
                    playability: { playable: true },
                    artists: {
                      items: [
                        { uri: "spotify:artist:artist-id", profile: { name: "Artist" } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      }
    })
    vi.stubGlobal("Spicetify", {
      URI: { fromString: (uri: string) => ({ id: uri.split(":").pop() }) },
      CosmosAsync: { get },
      GraphQL: { Definitions: { queryAlbumTracks: {} }, Request: request },
      Platform: { History: { location: { pathname: "/" } } },
    })

    const tracks = await fetchArtistDiscographyTracks("spotify:artist:artist-id")

    expect(tracks.map((track) => track.uri)).toEqual(["spotify:track:healthy"])
    expect(get.mock.calls.some(([url]) => String(url).includes("/v1/albums?ids="))).toBe(false)
    expect(getSourceProvenance(tracks[0])).toEqual([
      "album-graphql",
      "artist-discography",
    ])
  })
})
