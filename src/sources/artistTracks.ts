import type { TrackCandidate } from "../session/types"
import { getMarket } from "../utils/playability"
import { getUriId } from "../utils/uri"
import { attachSourceProvenance, mergeCandidatesWithProvenance } from "./provenance"
import { runWithTimeout } from "./spotifyApiAdapter"

const SOURCE_TIMEOUT_MS = 6_000
const MAX_DISCOGRAPHY_ALBUMS = 12
const ALBUM_CONCURRENCY = 3

const parseYear = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const match = value.match(/\d{4}/)
    if (match) return Number(match[0])
  }
  return undefined
}

export const fetchAlbumTracks = async (albumUri: string): Promise<TrackCandidate[]> => {
  try {
    const { queryAlbumTracks } = Spicetify.GraphQL.Definitions
    const { data } = await runWithTimeout(
      () =>
        Spicetify.GraphQL.Request(queryAlbumTracks, {
          uri: albumUri,
          offset: 0,
          limit: 100,
        }),
      SOURCE_TIMEOUT_MS
    )

    const album = data?.albumUnion
    const items = (album?.tracksV2 ?? album?.tracks ?? []).items ?? []
    const releaseYear = parseYear(album?.date?.isoString ?? album?.date?.year)

    return items
      .map((item: any) => {
        const track = item?.track
        if (!track?.uri || track.playability?.playable === false) return null
        return attachSourceProvenance(
          {
            uri: track.uri,
            artistUri: track.artists?.items?.[0]?.uri,
            artistName: track.artists?.items?.[0]?.profile?.name,
            albumUri,
            albumName: album?.name,
            popularity: track.popularity ?? album?.popularity,
            releaseYear,
          },
          "album-graphql"
        )
      })
      .filter((candidate: any): candidate is TrackCandidate => Boolean(candidate))
  } catch {
    return []
  }
}

const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (item: Input) => Promise<Output>
): Promise<Output[]> => {
  const results = new Array<Output>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index])
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export const fetchArtistDiscographyTracks = async (artistUri: string): Promise<TrackCandidate[]> => {
  const artistId = getUriId(artistUri)
  if (!artistId) return []

  try {
    const market = getMarket()
    const res = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=50&market=${market}`
        ),
      SOURCE_TIMEOUT_MS
    )

    const albums = (res?.items ?? []) as Array<{ id?: string; uri?: string }>
    if (albums.length === 0) return []

    const albumUris = [...new Set(
      albums
        .map((album) => album.uri ?? (album.id ? `spotify:album:${album.id}` : ""))
        .filter(Boolean)
    )].slice(0, MAX_DISCOGRAPHY_ALBUMS)
    const albumTracks = await mapWithConcurrency(
      albumUris,
      ALBUM_CONCURRENCY,
      (albumUri) => fetchAlbumTracks(albumUri)
    )
    return mergeCandidatesWithProvenance(albumTracks.flat()).map((candidate) =>
      attachSourceProvenance(candidate, "artist-discography")
    )
  } catch {
    return []
  }
}
