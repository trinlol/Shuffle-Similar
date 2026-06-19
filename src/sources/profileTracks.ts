import type { SeedMetadata, TrackCandidate } from "../session/types"
import { dedupeCandidates, sortByObscurity } from "../algorithm/filters"
import { candidateFromUri } from "./trackMetadata"
import { pickRandom } from "../algorithm/shuffle"
import { isWebApiTrackPlayable } from "../utils/playability"
import { getUriId } from "../utils/uri"

type AlbumTrack = {
  uri?: string
  playability?: { playable?: boolean }
}

const LIKED_TRACKS_PAGE_SIZE = 50
const LIKED_TRACKS_MAX = 200

const fetchLikedTracksFromWebApi = async (): Promise<TrackCandidate[]> => {
  const candidates: TrackCandidate[] = []
  let offset = 0

  while (offset < LIKED_TRACKS_MAX) {
    const res = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/me/tracks?limit=${LIKED_TRACKS_PAGE_SIZE}&offset=${offset}`
    )

    const items = res?.items ?? []
    if (items.length === 0) break

    for (const item of items) {
      const track = item?.track as {
        uri?: string
        popularity?: number
        is_playable?: boolean
        artists?: Array<{ uri?: string; name?: string }>
      } | null
      if (!track || !isWebApiTrackPlayable(track) || !track.uri) continue
      candidates.push({
        uri: track.uri,
        artistUri: track.artists?.[0]?.uri,
        artistName: track.artists?.[0]?.name,
        popularity: track.popularity,
      })
    }

    if (!res?.next) break
    offset += LIKED_TRACKS_PAGE_SIZE
  }

  return candidates
}

const fetchLikedTracksFromCollection = async (): Promise<TrackCandidate[]> => {
  const res = await Spicetify.CosmosAsync.get(
    "sp://core-collection/unstable/@/list/tracks/all?responseFormat=protobufJson"
  )

  return (res.item ?? [])
    .filter((track: { trackMetadata?: { playable?: boolean } }) => track.trackMetadata?.playable)
    .map(
      (track: {
        trackMetadata?: {
          link?: string
          artistUri?: string
          artistName?: string
          popularity?: number
        }
      }) => ({
        uri: track.trackMetadata?.link ?? "",
        artistUri: track.trackMetadata?.artistUri,
        artistName: track.trackMetadata?.artistName,
        popularity: track.trackMetadata?.popularity,
      })
    )
    .filter((candidate: TrackCandidate) => Boolean(candidate.uri))
}

const fetchLikedTracks = async (): Promise<TrackCandidate[]> => {
  try {
    return await fetchLikedTracksFromWebApi()
  } catch (webApiError) {
    console.warn("[Shuffle Similar] Web API liked songs failed, trying collection API", webApiError)
  }

  try {
    return await fetchLikedTracksFromCollection()
  } catch (collectionError) {
    console.warn("[Shuffle Similar] Collection API liked songs failed", collectionError)
    return []
  }
}

type PlaylistEntry = {
  uri: string
  name: string
}

const fetchPlaylistEntries = async (): Promise<PlaylistEntry[]> => {
  const root = await Spicetify.Platform.RootlistAPI.getContents()
  const playlists: PlaylistEntry[] = []

  const walk = (items: Array<{ type?: string; uri?: string; name?: string; items?: unknown[] }>) => {
    for (const item of items) {
      if (item.type === "playlist" && item.uri) {
        playlists.push({ uri: item.uri, name: item.name ?? item.uri })
      }
      if (item.items) walk(item.items as Array<{ type?: string; uri?: string; name?: string; items?: unknown[] }>)
    }
  }

  walk(root.items ?? [])
  return playlists
}

const fetchPlaylistTracks = async (playlistUri: string): Promise<TrackCandidate[]> => {
  const playlistId = getUriId(playlistUri)
  if (!playlistId) return []

  const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
    limit: 100,
  })

  return (res.items ?? [])
    .filter((item: { uri: string; isPlayable?: boolean }) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false)
    .map((item: { uri: string; metadata?: Record<string, string> }) =>
      candidateFromUri(item.uri, item.metadata)
    )
}

export const fetchAllPlaylistTracks = async (playlistUri: string): Promise<TrackCandidate[]> => {
  const playlistId = getUriId(playlistUri)
  if (!playlistId) return []

  const allTracks: TrackCandidate[] = []
  let offset = 0
  const limit = 100

  try {
    while (true) {
      const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
        limit,
        offset,
      })

      const items = res?.items ?? []
      if (items.length === 0) break

      const tracks = items
        .filter((item: { uri: string; isPlayable?: boolean }) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false)
        .map((item: { uri: string; metadata?: Record<string, string> }) =>
          candidateFromUri(item.uri, item.metadata)
        )

      allTracks.push(...tracks)

      if (items.length < limit || allTracks.length >= 2000) {
        break
      }
      offset += limit
    }
  } catch (error) {
    console.warn("[Shuffle Similar] Failed to fetch all playlist tracks", error)
  }

  return allTracks
}

export const fetchTopTracks = async (): Promise<string[]> => {
  const topTracks: string[] = []
  try {
    const [shortTermRes, mediumTermRes] = await Promise.all([
      Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term"),
      Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term"),
    ])

    const shortTermItems = shortTermRes?.items ?? []
    const mediumTermItems = mediumTermRes?.items ?? []

    for (const item of [...shortTermItems, ...mediumTermItems]) {
      if (item?.uri) {
        topTracks.push(item.uri)
      }
    }
  } catch (error) {
    console.warn("[Shuffle Similar] Failed to fetch top tracks", error)
  }
  return [...new Set(topTracks)]
}


const scorePlaylistName = (name: string, seed: SeedMetadata): number => {
  const lower = name.toLowerCase()
  let score = 0
  if (seed.artistName && lower.includes(seed.artistName.toLowerCase())) score += 2
  for (const genre of seed.genres) {
    if (lower.includes(genre.toLowerCase())) score += 1
  }
  return score
}

export const fetchProfilePool = async (seed: SeedMetadata): Promise<TrackCandidate[]> => {
  const [likedResult, playlistResult] = await Promise.allSettled([
    fetchLikedTracks(),
    fetchPlaylistEntries(),
  ])

  const liked = likedResult.status === "fulfilled" ? likedResult.value : []
  const playlistEntries = playlistResult.status === "fulfilled" ? playlistResult.value : []

  const sampledPlaylists = playlistEntries
    .map((entry) => ({ uri: entry.uri, score: scorePlaylistName(entry.name, seed) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((entry) => entry.uri)

  const playlistResults = await Promise.allSettled(
    sampledPlaylists.map((uri) => fetchPlaylistTracks(uri))
  )

  const playlistTracks: TrackCandidate[] = []
  for (const result of playlistResults) {
    if (result.status === "fulfilled") playlistTracks.push(...result.value)
  }

  const shuffledLiked = sortByObscurity(liked).slice(0, 120)
  const shuffledPlaylist = sortByObscurity(playlistTracks).slice(0, 120)

  return dedupeCandidates([...shuffledLiked, ...shuffledPlaylist]).filter(
    (candidate) => candidate.uri !== seed.uri
  )
}

export const pickSeedFromCollection = async (uris: string[]): Promise<string | null> => {
  if (uris.length === 0) return null

  const firstUri = uris[0]
  const uriObj = Spicetify.URI.fromString(firstUri)
  const { Type } = Spicetify.URI

  if (uriObj.type === Type.TRACK) {
    return firstUri
  }

  switch (uriObj.type) {
    case Type.PLAYLIST:
    case Type.PLAYLIST_V2: {
      const tracks = await fetchPlaylistTracks(firstUri)
      const pick = pickRandom(tracks)
      if (!pick?.uri) {
        throw new Error("No playable tracks found in this playlist.")
      }
      return pick.uri
    }
    case Type.ALBUM: {
      const { queryAlbumTracks } = Spicetify.GraphQL.Definitions
      const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
        uri: firstUri,
        offset: 0,
        limit: 100,
      })
      const items = (data?.albumUnion?.tracksV2 ?? data?.albumUnion?.tracks ?? []).items ?? []
      const playable: AlbumTrack[] = items
        .map((item: { track?: AlbumTrack }) => item.track)
        .filter((track: AlbumTrack | undefined): track is AlbumTrack =>
          Boolean(track?.playability?.playable && track.uri)
        )
      const pick = pickRandom(playable)
      if (!pick?.uri) {
        throw new Error("No playable tracks found in this album.")
      }
      return pick.uri
    }
    case Type.ARTIST: {
      const { queryArtistOverview } = Spicetify.GraphQL.Definitions
      const { data } = await Spicetify.GraphQL.Request(queryArtistOverview, {
        uri: firstUri,
        locale: Spicetify.Locale.getLocale(),
        includePrerelease: false,
      })
      const topTracks = data?.artistUnion?.discography?.topTracks?.items ?? []
      const playable: AlbumTrack[] = topTracks
        .map((item: { track?: AlbumTrack }) => item.track)
        .filter((track: AlbumTrack | undefined): track is AlbumTrack => Boolean(track?.uri))
      const pick = pickRandom(playable)
      if (!pick?.uri) {
        throw new Error("No playable tracks found for this artist.")
      }
      return pick.uri
    }
    default:
      return firstUri
  }
}
