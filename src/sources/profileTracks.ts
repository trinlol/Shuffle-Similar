import { fisherYatesShuffle, pickRandom } from "../algorithm/shuffle"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import { isWebApiTrackPlayable, type WebApiTrack } from "../utils/playability"
import { getUriId } from "../utils/uri"
import { attachSourceProvenance, mergeCandidatesWithProvenance } from "./provenance"
import { runWithTimeout } from "./spotifyApiAdapter"
import { candidateFromUri, enrichCandidateArtistGenres } from "./trackMetadata"

const parseYear = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const match = value.match(/\d{4}/)
    if (match) return Number(match[0])
  }
  return undefined
}

type AlbumTrack = {
  uri?: string
  playability?: { playable?: boolean }
}

const LIKED_TRACKS_PAGE_SIZE = 50
const LIKED_TRACKS_MAX = 200
export const PROFILE_SOURCE_TIMEOUT_MS = 4_000
const PROFILE_PLAYLIST_CONCURRENCY = 3

export type TopArtistsSnapshot = {
  artistUris: string[]
  artistNames: string[]
}

type CachedTopArtists = {
  snapshot: TopArtistsSnapshot
  expiresAt: number
  spicetifyRef: unknown
}

type CachedTopTracks = {
  tracks: string[]
  expiresAt: number
  spicetifyRef: unknown
}

let cachedTopArtists: CachedTopArtists | null = null
let cachedTopTracks: CachedTopTracks | null = null
let inFlightTopArtists: Promise<TopArtistsSnapshot> | null = null
let inFlightTopTracks: Promise<string[]> | null = null

export const resetProfileCaches = (): void => {
  cachedTopArtists = null
  cachedTopTracks = null
  inFlightTopArtists = null
  inFlightTopTracks = null
}

export const getCachedAffinityKeys = (): {
  habitualArtistKeys: string[]
  topTrackUris: string[]
} => {
  const currentSpicetify = (globalThis as unknown as { Spicetify?: unknown }).Spicetify
  const now = Date.now()
  const habitualArtistKeys: string[] = []
  if (
    cachedTopArtists &&
    cachedTopArtists.spicetifyRef === currentSpicetify &&
    cachedTopArtists.expiresAt > now
  ) {
    const keys = new Set<string>()
    for (const uri of cachedTopArtists.snapshot.artistUris) {
      if (uri) keys.add(uri.trim().toLowerCase())
    }
    for (const name of cachedTopArtists.snapshot.artistNames) {
      if (name) keys.add(`name:${name.trim().toLowerCase().replace(/\s+/g, " ")}`)
    }
    habitualArtistKeys.push(...keys)
  }
  const topTrackUris =
    cachedTopTracks &&
    cachedTopTracks.spicetifyRef === currentSpicetify &&
    cachedTopTracks.expiresAt > now
      ? [...cachedTopTracks.tracks]
      : []
  return { habitualArtistKeys, topTrackUris }
}

export const fetchTopArtists = async (): Promise<TopArtistsSnapshot> => {
  const currentSpicetify = (globalThis as unknown as { Spicetify?: unknown }).Spicetify
  const now = Date.now()
  if (
    cachedTopArtists &&
    cachedTopArtists.spicetifyRef === currentSpicetify &&
    cachedTopArtists.expiresAt > now &&
    (cachedTopArtists.snapshot.artistUris.length > 0 ||
      cachedTopArtists.snapshot.artistNames.length > 0)
  ) {
    return cachedTopArtists.snapshot
  }

  if (inFlightTopArtists) return await inFlightTopArtists

  const pending = (async (): Promise<TopArtistsSnapshot> => {
    try {
      const urls = [
        "https://api.spotify.com/v1/me/top/artists?limit=50&time_range=short_term",
        "https://api.spotify.com/v1/me/top/artists?limit=50&time_range=medium_term",
      ]
      const results = await Promise.allSettled(
        urls.map((url) =>
          runWithTimeout(() => Spicetify.CosmosAsync.get(url), PROFILE_SOURCE_TIMEOUT_MS)
        )
      )

      const uris = new Set<string>()
      const names = new Set<string>()

      for (const res of results) {
        if (res.status === "fulfilled" && res.value?.items && Array.isArray(res.value.items)) {
          for (const item of res.value.items) {
            const uri = item.uri ?? (item.id ? `spotify:artist:${item.id}` : undefined)
            if (uri && typeof uri === "string") uris.add(uri)
            if (item.name && typeof item.name === "string") names.add(item.name)
          }
        }
      }

      const snapshot: TopArtistsSnapshot = {
        artistUris: [...uris],
        artistNames: [...names],
      }

      if (snapshot.artistUris.length > 0 || snapshot.artistNames.length > 0) {
        cachedTopArtists = {
          snapshot,
          expiresAt: now + 5 * 60_000,
          spicetifyRef: currentSpicetify,
        }
      }

      return snapshot
    } catch {
      return { artistUris: [], artistNames: [] }
    }
  })()

  inFlightTopArtists = pending
  try {
    return await pending
  } finally {
    if (inFlightTopArtists === pending) inFlightTopArtists = null
  }
}

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

const extractLikedCandidates = (items: unknown[]): TrackCandidate[] => {
  const result: TrackCandidate[] = []
  for (const item of items) {
    const track = (item as { track?: unknown })?.track as {
      uri?: string
      name?: string
      popularity?: number
      is_playable?: boolean
      album?: { uri?: string; id?: string; name?: string; release_date?: string }
      artists?: Array<{ uri?: string; id?: string; name?: string }>
    } | null
    if (!track || !isWebApiTrackPlayable(track) || !track.uri) continue
    const primaryArtist = track.artists?.[0]
    result.push(
      attachSourceProvenance(
        {
          uri: track.uri,
          trackName: track.name,
          artistUri:
            primaryArtist?.uri ??
            (primaryArtist?.id ? `spotify:artist:${primaryArtist.id}` : undefined),
          artistName: primaryArtist?.name,
          albumUri:
            track.album?.uri ?? (track.album?.id ? `spotify:album:${track.album.id}` : undefined),
          albumName: track.album?.name,
          releaseYear: parseYear(track.album?.release_date),
          popularity: track.popularity,
        },
        "liked-tracks"
      )
    )
  }
  return result
}

const fetchLikedTracksFromWebApi = async (): Promise<TrackCandidate[]> => {
  const candidates: TrackCandidate[] = []

  const firstRes = await runWithTimeout(
    () =>
      Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/me/tracks?limit=${LIKED_TRACKS_PAGE_SIZE}&offset=0`
      ),
    PROFILE_SOURCE_TIMEOUT_MS
  )

  const firstItems = firstRes?.items ?? []
  if (firstItems.length === 0) return []
  candidates.push(...extractLikedCandidates(firstItems))

  if (!firstRes?.next) return candidates

  const total = typeof firstRes?.total === "number" ? firstRes.total : 0
  const subsequentOffsets: number[] = []

  if (total > LIKED_TRACKS_MAX) {
    const maxOffset = Math.min(total - LIKED_TRACKS_PAGE_SIZE, 800)
    const pagesNeeded = Math.floor(LIKED_TRACKS_MAX / LIKED_TRACKS_PAGE_SIZE) - 1
    const chosen = new Set<number>()
    for (let i = 0; i < pagesNeeded; i += 1) {
      if (maxOffset >= LIKED_TRACKS_PAGE_SIZE) {
        const range = maxOffset - LIKED_TRACKS_PAGE_SIZE
        const randomOffset = LIKED_TRACKS_PAGE_SIZE + Math.floor(Math.random() * (range + 1))
        chosen.add(randomOffset)
      } else {
        chosen.add((i + 1) * LIKED_TRACKS_PAGE_SIZE)
      }
    }
    subsequentOffsets.push(...chosen)
  } else {
    let offset = LIKED_TRACKS_PAGE_SIZE
    while (offset < LIKED_TRACKS_MAX) {
      subsequentOffsets.push(offset)
      offset += LIKED_TRACKS_PAGE_SIZE
    }
  }

  if (subsequentOffsets.length > 0) {
    const pageResponses = await Promise.all(
      subsequentOffsets.map((offset) =>
        runWithTimeout(
          () =>
            Spicetify.CosmosAsync.get(
              `https://api.spotify.com/v1/me/tracks?limit=${LIKED_TRACKS_PAGE_SIZE}&offset=${offset}`
            ),
          PROFILE_SOURCE_TIMEOUT_MS
        ).catch(() => null)
      )
    )
    for (const res of pageResponses) {
      const items = res?.items ?? []
      if (items.length === 0) continue
      candidates.push(...extractLikedCandidates(items))
      if (!res?.next && total <= LIKED_TRACKS_MAX) break
    }
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
          name?: string
          artistUri?: string
          artistName?: string
          albumUri?: string
          albumName?: string
          album?: { link?: string; name?: string; year?: number | string }
          popularity?: number
        }
      }) =>
        attachSourceProvenance(
          {
            uri: track.trackMetadata?.link ?? "",
            trackName: track.trackMetadata?.name,
            artistUri: track.trackMetadata?.artistUri,
            artistName: track.trackMetadata?.artistName,
            albumUri: track.trackMetadata?.album?.link ?? track.trackMetadata?.albumUri,
            albumName: track.trackMetadata?.album?.name ?? track.trackMetadata?.albumName,
            releaseYear: parseYear(track.trackMetadata?.album?.year),
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

/** Recently-played tracks carry title, album, artist, and popularity fields beyond WebApiTrack. */
type RecentTrackFields = {
  uri: string
  name?: string
  album?: { uri?: string; id?: string; name?: string; release_date?: string }
  artists?: Array<{ uri?: string; id?: string; name?: string }>
  popularity?: number
}

export const fetchRecentlyPlayedTracks = async (): Promise<TrackCandidate[]> => {
  try {
    const response = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/player/recently-played?limit=50"),
      PROFILE_SOURCE_TIMEOUT_MS
    )
    return (response?.items ?? [])
      .map((item: { track?: WebApiTrack & RecentTrackFields }) => item?.track)
      .filter(
        (
          track: (WebApiTrack & RecentTrackFields) | undefined
        ): track is WebApiTrack & RecentTrackFields =>
          Boolean(track?.uri) && isWebApiTrackPlayable(track)
      )
      .map((track: WebApiTrack & RecentTrackFields) => {
        const primaryArtist = track.artists?.[0]
        return attachSourceProvenance(
          {
            uri: track.uri,
            trackName: track.name,
            artistUri:
              primaryArtist?.uri ??
              (primaryArtist?.id ? `spotify:artist:${primaryArtist.id}` : undefined),
            artistName: primaryArtist?.name,
            albumUri:
              track.album?.uri ?? (track.album?.id ? `spotify:album:${track.album.id}` : undefined),
            albumName: track.album?.name,
            releaseYear: parseYear(track.album?.release_date),
            popularity: track.popularity,
          },
          "recently-played"
        )
      })
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
    .filter(
      (item: { uri: string; isPlayable?: boolean }) =>
        item.uri?.startsWith("spotify:track:") && item.isPlayable !== false
    )
    .map((item: { uri: string; metadata?: Record<string, string> }) =>
      attachSourceProvenance(
        candidateFromUri(item.uri, item.metadata, "profile-playlist"),
        `profile-playlist:${playlistId}`
      )
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
        .filter(
          (item: { uri: string; isPlayable?: boolean }) =>
            item.uri?.startsWith("spotify:track:") && item.isPlayable !== false
        )
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
  const currentSpicetify = (globalThis as unknown as { Spicetify?: unknown }).Spicetify
  const now = Date.now()
  if (
    cachedTopTracks &&
    cachedTopTracks.spicetifyRef === currentSpicetify &&
    cachedTopTracks.expiresAt > now &&
    cachedTopTracks.tracks.length > 0
  ) {
    return [...cachedTopTracks.tracks]
  }

  if (inFlightTopTracks) return [...(await inFlightTopTracks)]

  const pending = (async (): Promise<string[]> => {
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
    const unique = [...new Set(topTracks)]
    if (unique.length > 0) {
      cachedTopTracks = {
        tracks: unique,
        expiresAt: now + 5 * 60_000,
        spicetifyRef: currentSpicetify,
      }
    }
    return unique
  })()

  inFlightTopTracks = pending
  try {
    return [...(await pending)]
  } finally {
    if (inFlightTopTracks === pending) inFlightTopTracks = null
  }
}

const scorePlaylistName = (name: string, seed: SeedMetadata): number => {
  const lower = name.toLowerCase()
  let score = 0
  if (seed.artistName && lower.includes(seed.artistName.toLowerCase())) score += 3
  for (const genre of seed.genres) {
    const normalizedGenre = genre.toLowerCase().trim()
    if (!normalizedGenre) continue
    if (lower.includes(normalizedGenre)) {
      score += 2
      continue
    }
    for (const token of normalizedGenre.split(/[^a-z0-9]+/)) {
      if (token.length >= 3 && lower.includes(token)) {
        score += 1
        break
      }
    }
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
    .map((entry) => ({
      uri: entry.uri,
      score: scorePlaylistName(entry.name, seed),
      tieBreaker: Math.random(),
    }))
    .sort((a, b) => b.score - a.score || a.tieBreaker - b.tieBreaker)
    .slice(0, 8)
    .map((entry) => entry.uri)

  const playlistResults = await Promise.allSettled(
    sampledPlaylists.map((uri) => fetchPlaylistTracks(uri))
  )

  const playlistTracks: TrackCandidate[] = []
  for (const result of playlistResults) {
    if (result.status === "fulfilled") playlistTracks.push(...result.value)
  }

  const sampledLiked = fisherYatesShuffle(liked).slice(0, 160)
  const sampledPlaylistTracks = fisherYatesShuffle(playlistTracks).slice(0, 160)

  const merged = mergeCandidatesWithProvenance([...sampledLiked, ...sampledPlaylistTracks]).filter(
    (candidate) => candidate.uri !== seed.uri
  )

  const artistCounts = new Map<string, number>()
  const capped: TrackCandidate[] = []
  for (const candidate of merged) {
    const artistKey =
      candidate.artistUri?.trim().toLowerCase() ??
      (candidate.artistName ? `name:${candidate.artistName.trim().toLowerCase()}` : undefined)
    if (!artistKey) {
      capped.push(candidate)
      continue
    }
    const current = artistCounts.get(artistKey) ?? 0
    if (current < 2) {
      artistCounts.set(artistKey, current + 1)
      capped.push(candidate)
    }
  }

  return await enrichCandidateArtistGenres(capped, 20)
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
