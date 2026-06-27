import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getMarket, isWebApiTrackPlayable } from "../utils/playability"
import { getUriId } from "../utils/uri"

const parseYear = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const match = value.match(/\d{4}/)
    if (match) return Number(match[0])
  }
  return undefined
}

export const candidateFromUri = (uri: string, metadata?: Record<string, string>): TrackCandidate => ({
  uri,
  artistUri: metadata?.artist_uri ?? metadata?.["artist_uri:1"],
  artistName: metadata?.artist_name ?? metadata?.["artist_name:1"],
  albumUri: metadata?.album_uri,
  albumName: metadata?.album_title ?? metadata?.album_name,
  trackName: metadata?.title ?? metadata?.name ?? metadata?.track_name,
  popularity: metadata?.popularity ? Number(metadata.popularity) : undefined,
  releaseYear: metadata?.release_year ? Number(metadata.release_year) : undefined,
})

const fetchArtistGenres = async (artistId: string): Promise<string[]> => {
  if (!artistId) return []
  try {
    const artist = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/artists/${artistId}`
    )
    return (artist?.genres ?? []).filter((genre: string) => typeof genre === "string")
  } catch {
    return []
  }
}

export const getSeedMetadataFromPlayer = (uri: string): SeedMetadata => {
  const currentUri = Spicetify.Player.data?.item?.uri
  const metadata =
    currentUri === uri ? (Spicetify.Player.data?.item?.metadata ?? {}) : ({} as Record<string, string>)
  const trackId = getUriId(uri)

  return {
    uri,
    trackId,
    trackName: metadata.title ?? "",
    artistName: metadata.artist_name ?? metadata["artist_name:1"] ?? "",
    artistUri: metadata.artist_uri ?? metadata["artist_uri:1"] ?? "",
    albumUri: metadata.album_uri,
    albumName: metadata.album_title ?? metadata.album_name,
    releaseYear: parseYear(metadata.release_year ?? metadata.album_year),
    genres: [],
  }
}

export const fetchSeedMetadata = async (uri: string): Promise<SeedMetadata> => {
  const base = getSeedMetadataFromPlayer(uri)

  try {
    const track = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/tracks/${base.trackId}?market=${getMarket()}`
    )
    const artist = track?.artists?.[0]
    const artistId = artist?.id ?? getUriId(artist?.uri ?? "")
    const genres = artistId ? await fetchArtistGenres(artistId) : []
    const features = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/audio-features/${base.trackId}`
    ).catch(() => null)

    return enrichSeedMetadata({
      uri,
      trackId: base.trackId,
      trackName: track?.name ?? base.trackName,
      artistName: artist?.name ?? base.artistName,
      artistUri: artist?.uri ?? base.artistUri,
      albumUri: track?.album?.uri ?? base.albumUri,
      albumName: track?.album?.name ?? base.albumName,
      releaseYear: parseYear(track?.album?.release_date) ?? base.releaseYear,
      genres,
      instrumentalness: features?.instrumentalness ?? undefined,
    })
  } catch {
    return enrichSeedMetadata(base)
  }
}

export const enrichSeedMetadata = async (seed: SeedMetadata): Promise<SeedMetadata> => {
  if (!seed.albumUri) return seed

  try {
    const { queryAlbumTracks } = Spicetify.GraphQL.Definitions
    const { data, errors } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
      uri: seed.albumUri,
      offset: 0,
      limit: 1,
    })

    if (errors?.length) return seed

    const album = data?.albumUnion
    const releaseYear = parseYear(album?.date?.isoString ?? album?.date?.year)
    const albumName = album?.name
    return {
      ...seed,
      albumName: albumName ?? seed.albumName,
      releaseYear: releaseYear ?? seed.releaseYear,
    }
  } catch {
    return seed
  }
}

export const enrichCandidatesFromSearch = (items: Array<Record<string, unknown>>): TrackCandidate[] => {
  const candidates: TrackCandidate[] = []

  for (const item of items) {
    const track = item as {
      uri?: string
      id?: string
      name?: string
      popularity?: number
      is_playable?: boolean
      album?: { release_date?: string; uri?: string; id?: string; name?: string }
      artists?: Array<{ id?: string; name?: string; uri?: string }>
    }
    const uri = track.uri ?? (track.id ? `spotify:track:${track.id}` : "")
    if (!uri || !isWebApiTrackPlayable(track)) continue
    const artist = track.artists?.[0]
    candidates.push({
      uri,
      artistUri: artist?.uri ?? (artist?.id ? `spotify:artist:${artist.id}` : undefined),
      artistName: artist?.name,
      albumUri: track.album?.uri ?? (track.album?.id ? `spotify:album:${track.album.id}` : undefined),
      albumName: track.album?.name,
      trackName: track.name,
      popularity: track.popularity,
      releaseYear: parseYear(track.album?.release_date),
    })
  }

  return candidates
}
