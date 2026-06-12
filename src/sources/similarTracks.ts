import type { SeedMetadata, TrackCandidate } from "../session/types"
import type { BetterShuffleSettings } from "../storage/settings"
import { dedupeCandidates, excludeArtist } from "../algorithm/filters"
import { candidateFromUri, enrichCandidatesFromSearch } from "./trackMetadata"
import { getMarket } from "../utils/playability"
import { getUriId } from "../utils/uri"

const fetchPlaylistCandidates = async (playlistUri: string): Promise<TrackCandidate[]> => {
  try {
    const playlistId = getUriId(playlistUri)
    const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
      limit: 100,
    })

    return (res.items ?? [])
      .filter((item: { isPlayable?: boolean }) => item.isPlayable)
      .map((item: { uri: string; metadata?: Record<string, string> }) =>
        candidateFromUri(item.uri, item.metadata)
      )
  } catch {
    return []
  }
}

const fetchInspiredByMix = async (seedUri: string): Promise<TrackCandidate[]> => {
  try {
    const response = await Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/inspiredby-mix/v2/seed_to_playlist/${seedUri}?response-format=json`
    )

    const playlistUri = response?.mediaItems?.[0]?.uri
    if (!playlistUri) return []
    return fetchPlaylistCandidates(playlistUri)
  } catch {
    return []
  }
}

const fetchRadioStationCandidates = async (seedUri: string): Promise<TrackCandidate[]> => {
  try {
    const radioUri = (Spicetify.URI as typeof Spicetify.URI & {
      radioURI: (args: string) => Spicetify.URI
    }).radioURI(seedUri)
    const { fetchTracksForRadioStation } = Spicetify.GraphQL.Definitions
    const { data, errors } = await Spicetify.GraphQL.Request(fetchTracksForRadioStation, {
      uri: radioUri.toString(),
      limit: 50,
    })

    if (errors?.length) return []

    const tracks = data?.radioStation?.tracks?.items ?? data?.mediaItems ?? []
    const candidates: TrackCandidate[] = []
    for (const item of tracks) {
      const entry = item as {
        track?: {
          uri?: string
          artists?: { items?: Array<{ uri?: string; profile?: { name?: string } }> }
        }
        uri?: string
      }
      const track = entry.track ?? entry
      const uri = track.uri
      if (!uri) continue
      const artist = "artists" in track ? track.artists?.items?.[0] : undefined
      candidates.push({
        uri,
        artistUri: artist?.uri,
        artistName: artist?.profile?.name,
      })
    }
    return candidates
  } catch {
    return []
  }
}

const searchTracks = async (query: string, limit = 50): Promise<TrackCandidate[]> => {
  const market = getMarket()
  const offset = Math.floor(Math.random() * 150)
  const response = await Spicetify.CosmosAsync.get(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&offset=${offset}&market=${market}`
  )
  return enrichCandidatesFromSearch(response?.tracks?.items ?? [])
}

const buildEraQuery = (seed: SeedMetadata, settings: BetterShuffleSettings): string | null => {
  if (seed.releaseYear == null) return null
  const start = Math.max(1900, seed.releaseYear - settings.eraWindow)
  const end = seed.releaseYear + settings.eraWindow
  return `year:${start}-${end}`
}

const fetchGenreEraCandidates = async (
  seed: SeedMetadata,
  settings: BetterShuffleSettings
): Promise<TrackCandidate[]> => {
  const eraQuery = buildEraQuery(seed, settings)
  const genre = seed.genres[0]
  if (!genre && !eraQuery) return []

  const parts: string[] = []
  if (genre) parts.push(`genre:"${genre}"`)
  if (eraQuery) parts.push(eraQuery)
  if (parts.length === 0) return []

  return searchTracks(parts.join(" "))
}

const fetchEraOnlyCandidates = async (
  seed: SeedMetadata,
  settings: BetterShuffleSettings
): Promise<TrackCandidate[]> => {
  const eraQuery = buildEraQuery(seed, settings)
  if (!eraQuery) return []
  return searchTracks(eraQuery)
}

const fetchRelatedArtistCandidates = async (seed: SeedMetadata): Promise<TrackCandidate[]> => {
  const artistId = getUriId(seed.artistUri)
  if (!artistId) return []

  try {
    const related = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/artists/${artistId}/related-artists`
    )
    const artists = (related?.artists ?? []).slice(0, 6) as Array<{ name?: string }>
    const results = await Promise.allSettled(
      artists
        .filter((artist) => artist.name && artist.name !== seed.artistName)
        .map((artist) => searchTracks(`artist:"${artist.name}"`, 20))
    )

    const merged: TrackCandidate[] = []
    for (const result of results) {
      if (result.status === "fulfilled") merged.push(...result.value)
    }
    return merged
  } catch {
    return []
  }
}

const fetchAlbumPeerCandidates = async (seed: SeedMetadata): Promise<TrackCandidate[]> => {
  if (!seed.albumUri) return []

  try {
    const { queryAlbumTracks } = Spicetify.GraphQL.Definitions
    const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
      uri: seed.albumUri,
      offset: 0,
      limit: 50,
    })

    const items = (data?.albumUnion?.tracksV2 ?? data?.albumUnion?.tracks ?? []).items ?? []
    const albumTracks: TrackCandidate[] = []
    for (const item of items) {
      const track = (item as { track?: {
        uri?: string
        playability?: { playable?: boolean }
        artists?: { items?: Array<{ uri?: string; profile?: { name?: string } }> }
        popularity?: number
      } }).track
      if (!track?.playability?.playable || !track.uri || track.uri === seed.uri) continue
      albumTracks.push({
        uri: track.uri,
        artistUri: track.artists?.items?.[0]?.uri,
        artistName: track.artists?.items?.[0]?.profile?.name,
        albumUri: seed.albumUri,
        popularity: track.popularity,
      })
    }
    return albumTracks
  } catch {
    return []
  }
}

const fetchAudioFeatures = async (trackId: string): Promise<{ tempo?: number; energy?: number; valence?: number } | null> => {
  try {
    const response = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/audio-features/${trackId}`
    )
    return {
      tempo: response?.tempo,
      energy: response?.energy,
      valence: response?.valence,
    }
  } catch (error) {
    console.warn("[Better Shuffle] Failed to fetch audio features", error)
    return null
  }
}

const fetchRecommendations = async (
  seed: SeedMetadata,
  settings: BetterShuffleSettings,
  limit = 50
): Promise<TrackCandidate[]> => {
  try {
    const trackId = seed.trackId
    const artistId = getUriId(seed.artistUri)
    if (!trackId) return []

    const market = getMarket()
    let url = `https://api.spotify.com/v1/recommendations?limit=${limit}&market=${market}&seed_tracks=${trackId}`
    if (artistId) {
      url += `&seed_artists=${artistId}`
    }
    if (settings.deprioritizePopular) {
      url += `&max_popularity=70`
    }

    const needsFeatures = settings.matchTempo || settings.matchEnergy || settings.matchValence
    if (needsFeatures) {
      const features = await fetchAudioFeatures(trackId)
      if (features) {
        if (settings.matchTempo && features.tempo != null) {
          url += `&target_tempo=${features.tempo}`
        }
        if (settings.matchEnergy && features.energy != null) {
          url += `&target_energy=${features.energy}`
        }
        if (settings.matchValence && features.valence != null) {
          url += `&target_valence=${features.valence}`
        }
      }
    }

    const response = await Spicetify.CosmosAsync.get(url)
    return enrichCandidatesFromSearch(response?.tracks ?? [])
  } catch (error) {
    console.warn("[Better Shuffle] v1/recommendations failed", error)
    return []
  }
}

export const fetchSimilarPool = async (
  seed: SeedMetadata,
  settings: BetterShuffleSettings
): Promise<TrackCandidate[]> => {
  const results = await Promise.allSettled([
    fetchRecommendations(seed, settings, 50),
    fetchInspiredByMix(seed.uri),
    fetchRadioStationCandidates(seed.uri),
    fetchGenreEraCandidates(seed, settings),
    fetchEraOnlyCandidates(seed, settings),
    fetchRelatedArtistCandidates(seed),
    fetchAlbumPeerCandidates(seed),
  ])

  const merged: TrackCandidate[] = []
  for (const result of results) {
    if (result.status === "fulfilled") merged.push(...result.value)
  }

  let candidates = dedupeCandidates(merged)
    .filter((candidate) => candidate.uri !== seed.uri)
    .filter((candidate) => candidate.uri.startsWith("spotify:track:"))

  candidates = excludeArtist(candidates, seed.artistUri, seed.artistName)

  if (candidates.length < 10 && seed.artistName) {
    const fallback = await searchTracks(`year:${seed.releaseYear ?? 2010}`, 50)
    candidates = dedupeCandidates([
      ...candidates,
      ...excludeArtist(fallback, seed.artistUri, seed.artistName),
    ])
  }

  return candidates.filter((candidate) => candidate.uri !== seed.uri)
}
