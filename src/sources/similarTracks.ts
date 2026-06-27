import type { SeedMetadata, TrackCandidate } from "../session/types"
import type { SmartConfig } from "../storage/settings"
import { dedupeCandidates, excludeArtist } from "../algorithm/filters"
import { candidateFromUri, enrichCandidatesFromSearch } from "./trackMetadata"
import { getMarket } from "../utils/playability"
import { getUriId } from "../utils/uri"

const enrichAudioFeaturesAndMetadata = async (
  candidates: TrackCandidate[]
): Promise<TrackCandidate[]> => {
  if (candidates.length === 0) return candidates

  const ids = candidates.map((c) => getUriId(c.uri)).filter(Boolean)

  // 1. Fetch audio features in chunks of 100
  const featuresMap = new Map<string, { instrumentalness?: number }>()
  const featurePromises: Array<Promise<void>> = []
  const featureChunkSize = 100

  for (let i = 0; i < ids.length; i += featureChunkSize) {
    const chunkIds = ids.slice(i, i + featureChunkSize)
    featurePromises.push(
      (async () => {
        try {
          const res = await Spicetify.CosmosAsync.get(
            `https://api.spotify.com/v1/audio-features?ids=${chunkIds.join(",")}`
          )
          const audioFeatures = res?.audio_features ?? []
          for (const feat of audioFeatures) {
            if (feat?.id) {
              featuresMap.set(`spotify:track:${feat.id}`, {
                instrumentalness: feat.instrumentalness,
              })
            }
          }
        } catch (error) {
          console.warn("[Shuffle Similar] Failed to fetch audio features chunk", error)
        }
      })()
    )
  }

  // 2. Fetch track metadata in chunks of 50 to fill in missing albumName/popularity/trackName
  const metadataMap = new Map<string, { albumName?: string; trackName?: string; popularity?: number }>()
  const metadataPromises: Array<Promise<void>> = []
  const metadataChunkSize = 50

  const needsMetadata = candidates.filter((c) => !c.albumName || !c.trackName || c.popularity === undefined)
  const needsMetadataIds = needsMetadata.map((c) => getUriId(c.uri)).filter(Boolean)

  for (let i = 0; i < needsMetadataIds.length; i += metadataChunkSize) {
    const chunkIds = needsMetadataIds.slice(i, i + metadataChunkSize)
    metadataPromises.push(
      (async () => {
        try {
          const res = await Spicetify.CosmosAsync.get(
            `https://api.spotify.com/v1/tracks?ids=${chunkIds.join(",")}`
          )
          const tracks = res?.tracks ?? []
          for (const track of tracks) {
            if (track?.id) {
              metadataMap.set(`spotify:track:${track.id}`, {
                albumName: track.album?.name,
                trackName: track.name,
                popularity: track.popularity,
              })
            }
          }
        } catch (error) {
          console.warn("[Shuffle Similar] Failed to fetch track metadata chunk", error)
        }
      })()
    )
  }

  // Wait for all requests to finish
  await Promise.allSettled([...featurePromises, ...metadataPromises])

  // Merge the fetched data back to candidates
  return candidates.map((candidate) => {
    const feat = featuresMap.get(candidate.uri)
    const meta = metadataMap.get(candidate.uri)
    return {
      ...candidate,
      instrumentalness: feat?.instrumentalness ?? candidate.instrumentalness,
      albumName: meta?.albumName ?? candidate.albumName,
      trackName: meta?.trackName ?? candidate.trackName,
      popularity: meta?.popularity ?? candidate.popularity,
    }
  })
}

const filterInstrumentalsAndSoundtracks = (
  candidates: TrackCandidate[],
  isVocal: boolean,
  isSoundtrack: boolean
): TrackCandidate[] => {
  return candidates.filter((candidate) => {
    // 1. Vocal Tracks Protection:
    if (isVocal && candidate.instrumentalness !== undefined && candidate.instrumentalness > 0.5) {
      console.log(`[Shuffle Similar] Filtered out instrumental track: ${candidate.trackName} (instrumentalness: ${candidate.instrumentalness})`)
      return false
    }

    // 2. Soundtrack Leakage Protection:
    if (!isSoundtrack && candidate.albumName) {
      const isCandidateSoundtrack =
        /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(
          candidate.albumName
        )
      
      if (isCandidateSoundtrack) {
        // Exception: Disney/movie vocal pop songs (which have low instrumentalness < 0.2 and high popularity >= 60)
        const isDisneyOrVocalPopException =
          isVocal &&
          candidate.instrumentalness !== undefined &&
          candidate.instrumentalness < 0.2 &&
          candidate.popularity !== undefined &&
          candidate.popularity >= 60

        if (isDisneyOrVocalPopException) {
          console.log(`[Shuffle Similar] Kept vocal soundtrack exception: ${candidate.trackName} (popularity: ${candidate.popularity})`)
          return true
        }

        console.log(`[Shuffle Similar] Filtered out soundtrack leakage track: ${candidate.trackName} (album: ${candidate.albumName})`)
        return false
      }
    }

    return true
  })
}

const fetchPlaylistCandidates = async (playlistUri: string): Promise<TrackCandidate[]> => {
  try {
    const playlistId = getUriId(playlistUri)
    const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
      limit: 100,
    })

    return (res.items ?? [])
      .filter((item: { uri: string; isPlayable?: boolean }) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false)
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

const buildEraQuery = (seed: SeedMetadata, settings: SmartConfig): string | null => {
  if (seed.releaseYear == null) return null
  const start = Math.max(1900, seed.releaseYear - settings.eraWindow)
  const end = seed.releaseYear + settings.eraWindow
  return `year:${start}-${end}`
}

const fetchGenreEraCandidates = async (
  seed: SeedMetadata,
  settings: SmartConfig
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
  settings: SmartConfig
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
    console.warn("[Shuffle Similar] Failed to fetch audio features", error)
    return null
  }
}

const fetchRecommendations = async (
  seed: SeedMetadata,
  settings: SmartConfig,
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
    console.warn("[Shuffle Similar] v1/recommendations failed", error)
    return []
  }
}

export const fetchSimilarPool = async (
  seed: SeedMetadata,
  settings: SmartConfig
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

  // 1. Batch enrich candidates with audio features and track metadata
  candidates = await enrichAudioFeaturesAndMetadata(candidates)

  // 2. Filter out instrumentals/soundtracks based on AGENTS.md rules
  const isSeedSoundtrack =
    (seed.albumName &&
      /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(
        seed.albumName
      )) ||
    seed.genres.some((genre) =>
      /(soundtrack|score|orchestral|movie tunes|show tunes|broadway|musical)/i.test(genre)
    )
  const isSeedVocal = seed.instrumentalness === undefined || seed.instrumentalness < 0.2

  console.info(
    `[Shuffle Similar] Seed "${seed.trackName}" analysis: isSeedVocal = ${isSeedVocal}, isSeedSoundtrack = ${isSeedSoundtrack}`
  )

  candidates = filterInstrumentalsAndSoundtracks(candidates, isSeedVocal, isSeedSoundtrack)

  return candidates.filter((candidate) => candidate.uri !== seed.uri)
}

export const fetchPlaylistRecommendations = async (
  seeds: TrackCandidate[],
  settings: SmartConfig,
  limit = 50
): Promise<TrackCandidate[]> => {
  try {
    const seedTrackIds = seeds.map((s) => getUriId(s.uri)).filter(Boolean)
    if (seedTrackIds.length === 0) return []

    const market = getMarket()
    let url = `https://api.spotify.com/v1/recommendations?limit=${limit}&market=${market}&seed_tracks=${seedTrackIds.join(
      ","
    )}`

    if (settings.deprioritizePopular) {
      url += `&max_popularity=70`
    }

    const needsFeatures = settings.matchTempo || settings.matchEnergy || settings.matchValence
    if (needsFeatures) {
      // Use the first seed's features as a representative target
      const features = await fetchAudioFeatures(seedTrackIds[0])
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
    console.warn("[Shuffle Similar] Failed to fetch playlist recommendations", error)
    return []
  }
}

/**
 * Fetches a pool of similar tracks for a playlist using the full multi-strategy
 * approach (radio, inspired-by, genre/era, related artists, album peers, etc.).
 *
 * Samples several seed tracks spread across the playlist, runs fetchSimilarPool
 * for each, then merges and deduplicates the results.  Tracks that already exist
 * in the playlist are explicitly excluded.
 */
export const fetchPlaylistSimilarPool = async (
  playlistTracks: TrackCandidate[],
  settings: SmartConfig,
  seedCount = 3
): Promise<TrackCandidate[]> => {
  if (playlistTracks.length === 0) return []

  // Build the exclusion set from all playlist track URIs
  const playlistUriSet = new Set(playlistTracks.map((t) => t.uri))

  // Sample seed tracks spread across the playlist for diversity
  const seeds = sampleSpread(playlistTracks, Math.min(seedCount, playlistTracks.length))

  // Build SeedMetadata for each sampled track
  const seedMetadatas = await Promise.all(
    seeds.map((s) => buildSeedMetadataFromCandidate(s))
  )

  // Run the full multi-strategy fetch for each seed in parallel
  const poolResults = await Promise.allSettled(
    seedMetadatas.map((seed) => fetchSimilarPool(seed, settings))
  )

  // Also try the legacy recommendations endpoint as one more signal
  const recoResult = await Promise.allSettled([
    fetchPlaylistRecommendations(seeds, settings, settings.initialQueueSize * 2),
  ])

  // Merge all results
  const merged: TrackCandidate[] = []
  for (const result of poolResults) {
    if (result.status === "fulfilled") merged.push(...result.value)
  }
  for (const result of recoResult) {
    if (result.status === "fulfilled") merged.push(...result.value)
  }

  // Deduplicate and exclude tracks that are in the original playlist
  let deduped = dedupeCandidates(merged)
    .filter((c) => c.uri.startsWith("spotify:track:"))
    .filter((c) => !playlistUriSet.has(c.uri))

  // 1. Batch enrich playlist candidates with audio features and track metadata
  deduped = await enrichAudioFeaturesAndMetadata(deduped)

  // 2. Check if the playlist seeds are vocal and if any is a soundtrack
  const vocalCount = seedMetadatas.filter((s) => s.instrumentalness === undefined || s.instrumentalness < 0.2).length
  const isPlaylistVocal = vocalCount >= seedMetadatas.length / 2

  const isPlaylistSoundtrack = seedMetadatas.some((s) => {
    const isSoundtrackAlbum = s.albumName && /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(s.albumName)
    const isSoundtrackGenre = s.genres.some((g) => /(soundtrack|score|orchestral|movie tunes|show tunes|broadway|musical)/i.test(g))
    return isSoundtrackAlbum || isSoundtrackGenre
  })

  console.info(
    `[Shuffle Similar] Playlist analysis: isPlaylistVocal = ${isPlaylistVocal} (${vocalCount}/${seedMetadatas.length}), isPlaylistSoundtrack = ${isPlaylistSoundtrack}`
  )

  deduped = filterInstrumentalsAndSoundtracks(deduped, isPlaylistVocal, isPlaylistSoundtrack)

  console.info(
    `[Shuffle Similar] Playlist similar pool: ${deduped.length} candidates from ${seedMetadatas.length} seeds`
  )

  return deduped
}

/**
 * Samples `count` items spread evenly across an array for maximum diversity.
 */
const sampleSpread = <T>(items: T[], count: number): T[] => {
  if (count >= items.length) return [...items]
  const step = items.length / count
  const result: T[] = []
  for (let i = 0; i < count; i++) {
    const index = Math.min(Math.floor(i * step + Math.random() * step), items.length - 1)
    result.push(items[index])
  }
  return result
}

/**
 * Builds a SeedMetadata object from a TrackCandidate, fetching artist genres.
 */
const buildSeedMetadataFromCandidate = async (candidate: TrackCandidate): Promise<SeedMetadata> => {
  const trackId = getUriId(candidate.uri)
  const artistId = candidate.artistUri ? getUriId(candidate.artistUri) : ""

  let genres: string[] = []
  if (artistId) {
    try {
      const artist = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/artists/${artistId}`
      )
      genres = (artist?.genres ?? []).filter((g: string) => typeof g === "string")
    } catch {
      // Genres are optional, continue without them
    }
  }

  // Fetch track metadata and features for playlist seed tracks too
  let albumName = candidate.albumName
  let instrumentalness = candidate.instrumentalness
  try {
    if (!albumName) {
      const track = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/tracks/${trackId}?market=${getMarket()}`
      )
      albumName = track?.album?.name
    }
    const features = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/audio-features/${trackId}`
    )
    instrumentalness = features?.instrumentalness ?? undefined
  } catch {
    // ignore
  }

  return {
    uri: candidate.uri,
    trackId,
    trackName: "",
    artistName: candidate.artistName ?? "",
    artistUri: candidate.artistUri ?? "",
    albumUri: candidate.albumUri,
    albumName,
    releaseYear: candidate.releaseYear,
    genres,
    instrumentalness,
  }
}
