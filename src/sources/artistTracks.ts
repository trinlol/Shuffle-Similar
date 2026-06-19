import type { TrackCandidate } from "../session/types"
import { getMarket } from "../utils/playability"
import { getUriId } from "../utils/uri"

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
    const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
      uri: albumUri,
      offset: 0,
      limit: 100,
    })

    const album = data?.albumUnion
    const items = (album?.tracksV2 ?? album?.tracks ?? []).items ?? []
    const releaseYear = parseYear(album?.date?.isoString ?? album?.date?.year)

    return items
      .map((item: any) => {
        const track = item?.track
        if (!track?.uri) return null
        return {
          uri: track.uri,
          artistUri: track.artists?.items?.[0]?.uri,
          artistName: track.artists?.items?.[0]?.profile?.name,
          albumUri,
          popularity: track.popularity ?? album?.popularity ?? 50,
          releaseYear,
        }
      })
      .filter((candidate: any): candidate is TrackCandidate => Boolean(candidate))
  } catch (error) {
    console.warn("[Shuffle Similar] Failed to fetch album tracks", error)
    return []
  }
}

export const fetchArtistDiscographyTracks = async (artistUri: string): Promise<TrackCandidate[]> => {
  const artistId = getUriId(artistUri)
  if (!artistId) return []

  try {
    const market = getMarket()
    // Fetch albums and singles
    const res = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=50&market=${market}`
    )

    const albums = res?.items ?? []
    if (albums.length === 0) return []

    const albumIds = albums.map((item: any) => item.id).filter(Boolean)
    const candidates: TrackCandidate[] = []

    // Fetch album tracks in chunks of 20
    const chunkSize = 20
    for (let i = 0; i < albumIds.length; i += chunkSize) {
      const chunk = albumIds.slice(i, i + chunkSize)
      const chunkRes = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/albums?ids=${chunk.join(",")}&market=${market}`
      )

      const fullAlbums = chunkRes?.albums ?? []
      for (const album of fullAlbums) {
        if (!album) continue
        const releaseYear = parseYear(album.release_date)
        const tracks = album.tracks?.items ?? []
        for (const track of tracks) {
          if (!track?.uri) continue
          candidates.push({
            uri: track.uri,
            artistUri: `spotify:artist:${artistId}`,
            artistName: track.artists?.[0]?.name ?? album.artists?.[0]?.name,
            albumUri: album.uri,
            popularity: album.popularity ?? 50,
            releaseYear,
          })
        }
      }
    }

    // Deduplicate by track URI
    const seen = new Set<string>()
    return candidates.filter((c) => {
      if (seen.has(c.uri)) return false
      seen.add(c.uri)
      return true
    })
  } catch (error) {
    console.warn("[Shuffle Similar] Failed to fetch artist discography tracks", error)
    return []
  }
}
