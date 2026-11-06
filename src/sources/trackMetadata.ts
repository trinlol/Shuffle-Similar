import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getMarket, isWebApiTrackPlayable } from "../utils/playability"
import { getUriId } from "../utils/uri"
import { attachSourceProvenance } from "./provenance"
import { BoundedCache, optionalSpotifyCapabilities, runWithTimeout } from "./spotifyApiAdapter"

const SOURCE_TIMEOUT_MS = 6_000
const ARTIST_GENRE_CONCURRENCY = 4
const artistGenreCache = new BoundedCache<string, string[]>(1024)
const inFlightArtistGenres = new Map<string, Promise<string[]>>()
let artistGenresEndpointBlocked = false

export const resetArtistGenreCache = (): void => {
  artistGenreCache.clear()
  inFlightArtistGenres.clear()
  artistGenresEndpointBlocked = false
}

export const getArtistGenreCacheSize = (): number => artistGenreCache.size

const isBlockedStatus = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const record = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const code = record.status ?? record.statusCode ?? record.response?.status
  return code === 403 || code === 404 || code === 405 || code === 410
}

const parseYear = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const match = value.match(/\d{4}/)
    if (match) return Number(match[0])
  }
  return undefined
}

export const candidateFromUri = (
  uri: string,
  metadata?: Record<string, string>,
  sourceId = "platform"
): TrackCandidate =>
  attachSourceProvenance(
    {
      uri,
      artistUri: metadata?.artist_uri ?? metadata?.["artist_uri:1"],
      artistName: metadata?.artist_name ?? metadata?.["artist_name:1"],
      albumUri: metadata?.album_uri,
      albumName: metadata?.album_title ?? metadata?.album_name,
      trackName: metadata?.title ?? metadata?.name ?? metadata?.track_name,
      popularity: metadata?.popularity ? Number(metadata.popularity) : undefined,
      releaseYear: metadata?.release_year ? Number(metadata.release_year) : undefined,
    },
    sourceId
  )

export const fetchArtistGenres = async (artistId: string): Promise<string[]> => {
  if (!artistId) return []
  const cached = artistGenreCache.get(artistId)
  if (cached) return cached
  if (artistGenresEndpointBlocked) return []

  const pending = inFlightArtistGenres.get(artistId)
  if (pending) return await pending

  const request = (async (): Promise<string[]> => {
    try {
      const artist = await runWithTimeout(
        () => Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/artists/${artistId}`),
        SOURCE_TIMEOUT_MS
      )
      const genres = (artist?.genres ?? []).filter((genre: string) => typeof genre === "string")
      artistGenreCache.set(artistId, genres)
      return genres
    } catch (error) {
      if (isBlockedStatus(error)) {
        artistGenresEndpointBlocked = true
      }
      return []
    } finally {
      inFlightArtistGenres.delete(artistId)
    }
  })()

  inFlightArtistGenres.set(artistId, request)
  return await request
}

export const enrichCandidateArtistGenres = async (
  candidates: readonly TrackCandidate[],
  maxUncachedArtists = 18
): Promise<TrackCandidate[]> => {
  if (candidates.length === 0) return []

  if (!artistGenresEndpointBlocked && maxUncachedArtists > 0) {
    const uncachedArtistIds: string[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      if (candidate.genres?.length) continue
      const artistId = candidate.artistUri ? getUriId(candidate.artistUri) : ""
      if (!artistId || seen.has(artistId) || artistGenreCache.has(artistId)) continue
      seen.add(artistId)
      uncachedArtistIds.push(artistId)
      if (uncachedArtistIds.length >= maxUncachedArtists) break
    }

    if (uncachedArtistIds.length > 0) {
      const probeArtist = async (artistId: string): Promise<boolean> => {
        try {
          const artist = await runWithTimeout(
            () => Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/artists/${artistId}`),
            SOURCE_TIMEOUT_MS
          )
          const genres = (artist?.genres ?? []).filter((genre: string) => typeof genre === "string")
          artistGenreCache.set(artistId, genres)
          return true
        } catch {
          return false
        }
      }

      const firstOk = await probeArtist(uncachedArtistIds[0])
      if (!firstOk) {
        artistGenresEndpointBlocked = true
      } else if (uncachedArtistIds.length > 1) {
        const rest = uncachedArtistIds.slice(1)
        let nextIndex = 0
        const worker = async (): Promise<void> => {
          while (nextIndex < rest.length) {
            const index = nextIndex
            nextIndex += 1
            await probeArtist(rest[index])
          }
        }
        const workers = Math.min(ARTIST_GENRE_CONCURRENCY, rest.length)
        await Promise.all(Array.from({ length: workers }, () => worker()))
      }
    }
  }

  return candidates.map((candidate) => {
    if (candidate.genres?.length) return candidate
    const artistId = candidate.artistUri ? getUriId(candidate.artistUri) : ""
    const cached = artistId ? artistGenreCache.get(artistId) : undefined
    if (!cached?.length) return candidate
    return {
      ...candidate,
      genres: cached,
    }
  })
}

const fetchTrackDetails = async (trackId: string) => {
  try {
    return await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/tracks/${trackId}?market=${getMarket()}`
        ),
      SOURCE_TIMEOUT_MS
    )
  } catch {
    const query = encodeURIComponent(`spotify:track:${trackId}`)
    const response = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/search?q=${query}&type=track&limit=10&market=${getMarket()}`
        ),
      SOURCE_TIMEOUT_MS
    ).catch(() => null)
    const tracks = response?.tracks?.items ?? []
    return (
      tracks.find(
        (track: { id?: string; uri?: string }) =>
          track?.id === trackId || track?.uri === `spotify:track:${trackId}`
      ) ?? null
    )
  }
}

export const getSeedMetadataFromPlayer = (uri: string): SeedMetadata => {
  const currentUri = Spicetify.Player.data?.item?.uri
  const metadata =
    currentUri === uri
      ? (Spicetify.Player.data?.item?.metadata ?? {})
      : ({} as Record<string, string>)
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
    const baseArtistId = base.artistUri ? getUriId(base.artistUri) : ""
    const [track, featureResult, preloadedGenres] = await Promise.all([
      fetchTrackDetails(base.trackId),
      optionalSpotifyCapabilities.run("audio-features", () =>
        Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/audio-features/${base.trackId}`)
      ),
      baseArtistId ? fetchArtistGenres(baseArtistId) : Promise.resolve<string[] | null>(null),
    ])
    if (!track) return enrichSeedMetadata(base)
    const artist = track?.artists?.[0]
    const artistId = artist?.id ?? getUriId(artist?.uri ?? "")
    const genres =
      preloadedGenres !== null && (!artistId || artistId === baseArtistId)
        ? preloadedGenres
        : artistId
          ? await fetchArtistGenres(artistId)
          : []
    const features = featureResult.status === "ok" ? featureResult.value : null

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
      popularity: track?.popularity,
      tempo: features?.tempo,
      energy: features?.energy,
      valence: features?.valence,
      danceability: features?.danceability,
      acousticness: features?.acousticness,
    })
  } catch {
    return enrichSeedMetadata(base)
  }
}

export const enrichSeedMetadata = async (seed: SeedMetadata): Promise<SeedMetadata> => {
  if (!seed.albumUri) return seed
  if (seed.albumName && seed.releaseYear != null) return seed

  try {
    const { queryAlbumTracks } = Spicetify.GraphQL.Definitions
    const { data, errors } = await runWithTimeout(
      () =>
        Spicetify.GraphQL.Request(queryAlbumTracks, {
          uri: seed.albumUri,
          offset: 0,
          limit: 1,
        }),
      SOURCE_TIMEOUT_MS
    )

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

export const enrichCandidatesFromSearch = (
  items: Array<Record<string, unknown>>,
  sourceId = "search"
): TrackCandidate[] => {
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
    candidates.push(
      attachSourceProvenance(
        {
          uri,
          artistUri: artist?.uri ?? (artist?.id ? `spotify:artist:${artist.id}` : undefined),
          artistName: artist?.name,
          albumUri:
            track.album?.uri ?? (track.album?.id ? `spotify:album:${track.album.id}` : undefined),
          albumName: track.album?.name,
          trackName: track.name,
          popularity: track.popularity,
          releaseYear: parseYear(track.album?.release_date),
        },
        sourceId
      )
    )
  }

  return candidates
}
