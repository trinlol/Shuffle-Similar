import type { SeedMetadata, TrackCandidate } from "../session/types"
import { sortByObscurity } from "../algorithm/filters"
import { candidateFromUri } from "./trackMetadata"
import { pickRandom } from "../algorithm/shuffle"
import { isWebApiTrackPlayable } from "../utils/playability"
import { getUriId } from "../utils/uri"
import { attachSourceProvenance, mergeCandidatesWithProvenance } from "./provenance"
import { runWithTimeout } from "./spotifyApiAdapter"

type AlbumTrack = {
  uri?: string
  playability?: { playable?: boolean }
}

const LIKED_TRACKS_PAGE_SIZE = 50
const LIKED_TRACKS_MAX = 200
export const PROFILE_SOURCE_TIMEOUT_MS = 4_000
const PROFILE_PLAYLIST_CONCURRENCY = 3

class SharedPlaylistRequestLimiter {
  private active = 0
  private readonly waiters: Array<() => void> = []

  private async acquire(): Promise<void> {
    if (this.active < PROFILE_PLAYLIST_CONCURRENCY) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  async run<T>(request: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await runWithTimeout(() => request(), PROFILE_SOURCE_TIMEOUT_MS)
    } finally {
      this.release()
    }
  }
}

const playlistRequestLimiter = new SharedPlaylistRequestLimiter()

const fetchLikedTracksFromWebApi = async (): Promise<TrackCandidate[]> => {
  const candidates: TrackCandidate[] = []
  let offset = 0

  while (offset < LIKED_TRACKS_MAX) {
    const res = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/me/tracks?limit=${LIKED_TRACKS_PAGE_SIZE}&offset=${offset}`
        ),
      PROFILE_SOURCE_TIMEOUT_MS
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
      candidates.push(
        attachSourceProvenance(
          {
            uri: track.uri,
            artistUri: track.artists?.[0]?.uri,
            artistName: track.artists?.[0]?.name,
            popularity: track.popularity,
          },
          "liked-tracks"
        )
      )
    }

    if (!res?.next) break
    offset += LIKED_TRACKS_PAGE_SIZE
  }

  return candidates
}

const fetchLikedTracksFromCollection = async (): Promise<TrackCandidate[]> => {
  const res = await runWithTimeout(
    () =>
      Spicetify.CosmosAsync.get(
        "sp://core-collection/unstable/@/list/tracks/all?responseFormat=protobufJson"
      ),
    PROFILE_SOURCE_TIMEOUT_MS
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
      }) =>
        attachSourceProvenance(
          {
            uri: track.trackMetadata?.link ?? "",
            artistUri: track.trackMetadata?.artistUri,
            artistName: track.trackMetadata?.artistName,
            popularity: track.trackMetadata?.popularity,
          },
          "liked-tracks-collection"
        )
    )
    .filter((candidate: TrackCandidate) => Boolean(candidate.uri))
}

const fetchLikedTracks = async (): Promise<TrackCandidate[]> => {
  try {
    return await fetchLikedTracksFromWebApi()
  } catch {
    console.info("[Shuffle Similar] Liked songs degraded (using local collection fallback)")
  }

  try {
    return await fetchLikedTracksFromCollection()
  } catch {
    console.warn("[Shuffle Similar] Liked songs unavailable from web and local collection")
    return []
  }
}

type PlaylistEntry = {
  uri: string
  name: string
}

export const fetchRecentlyPlayedTracks = async (): Promise<TrackCandidate[]> => {
  try {
    const response = await runWithTimeout(
      () => Spicetify.CosmosAsync.get(
        "https://api.spotify.com/v1/me/player/recently-played?limit=50"
      ),
      PROFILE_SOURCE_TIMEOUT_MS
    )
    return (response?.items ?? [])
      .map((item: any) => item?.track)
      .filter((track: any) => track?.uri && isWebApiTrackPlayable(track))
      .map((track: any) => attachSourceProvenance({
        uri: track.uri,
        artistUri: track.artists?.[0]?.uri,
        artistName: track.artists?.[0]?.name,
        popularity: track.popularity,
      }, "recently-played"))
      .slice(0, 50)
  } catch {
    return []
  }
}

type RootlistNode = { type?: string; uri?: string; name?: string; items?: RootlistNode[] }
type PlaylistContents = {
  items?: Array<{ uri: string; isPlayable?: boolean; metadata?: Record<string, string> }>
}
type TopTracksResponse = { items?: Array<{ uri?: string }> }

const fetchPlaylistEntries = async (): Promise<PlaylistEntry[]> => {
  const root = await runWithTimeout<{ items?: RootlistNode[] }>(
    () => Spicetify.Platform.RootlistAPI.getContents(),
    PROFILE_SOURCE_TIMEOUT_MS
  )
  const playlists: PlaylistEntry[] = []

  const walk = (items: RootlistNode[]) => {
    for (const item of items) {
      if (item.type === "playlist" && item.uri) {
        playlists.push({ uri: item.uri, name: item.name ?? item.uri })
      }
      if (item.items) walk(item.items)
    }
  }

  walk(root.items ?? [])
  return playlists
}

const fetchPlaylistTracks = async (playlistUri: string): Promise<TrackCandidate[]> => {
  const playlistId = getUriId(playlistUri)
  if (!playlistId) return []

  const res = await playlistRequestLimiter.run<PlaylistContents>(() =>
    Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
      limit: 100,
    })
  )

  return (res.items ?? [])
    .filter((item: { uri: string; isPlayable?: boolean }) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false)
    .map((item: { uri: string; metadata?: Record<string, string> }) =>
      candidateFromUri(item.uri, item.metadata, "profile-playlist")
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
      const res = await playlistRequestLimiter.run<PlaylistContents>(() =>
        Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
          limit,
          offset,
        })
      )

      const items = res?.items ?? []
      if (items.length === 0) break

      const tracks = items
        .filter((item: { uri: string; isPlayable?: boolean }) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false)
        .map((item: { uri: string; metadata?: Record<string, string> }) =>
          candidateFromUri(item.uri, item.metadata, "profile-playlist")
        )

      allTracks.push(...tracks)

      if (items.length < limit || allTracks.length >= 2000) {
        break
      }
      offset += limit
    }
  } catch {
    console.info("[Shuffle Similar] Playlist source degraded (returning partial tracks)")
  }

  return allTracks
}

export const fetchTopTracks = async (): Promise<string[]> => {
  const topTracks: string[] = []
  const results = await Promise.allSettled([
      runWithTimeout<TopTracksResponse>(
      () =>
        Spicetify.CosmosAsync.get(
          "https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term"
        ),
      PROFILE_SOURCE_TIMEOUT_MS
    ),
      runWithTimeout<TopTracksResponse>(
      () =>
        Spicetify.CosmosAsync.get(
          "https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term"
        ),
      PROFILE_SOURCE_TIMEOUT_MS
    ),
      runWithTimeout<TopTracksResponse>(
      () =>
        Spicetify.CosmosAsync.get(
          "https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=long_term"
        ),
      PROFILE_SOURCE_TIMEOUT_MS
    ),
  ])

  for (const result of results) {
    if (result.status !== "fulfilled") continue
    for (const item of result.value.items ?? []) {
      if (item?.uri) {
        topTracks.push(item.uri)
      }
    }
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
  const [likedResult, playlistResult, recentResult] = await Promise.allSettled([
    fetchLikedTracks(),
    fetchPlaylistEntries(),
    fetchRecentlyPlayedTracks(),
  ])

  const liked = likedResult.status === "fulfilled" ? likedResult.value : []
  const playlistEntries = playlistResult.status === "fulfilled" ? playlistResult.value : []
  const recent = recentResult.status === "fulfilled" ? recentResult.value : []

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

  return mergeCandidatesWithProvenance([...shuffledLiked, ...shuffledPlaylist, ...recent]).filter(
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
