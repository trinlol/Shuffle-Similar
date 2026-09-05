import { excludeArtist } from "../algorithm/filters"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import type { SmartConfig } from "../storage/settings"
import { getMarket } from "../utils/playability"
import { getUriId } from "../utils/uri"
import { attachSourceProvenance, mergeCandidatesWithProvenance } from "./provenance"
import { SourcePipeline } from "./sourcePipeline"
import { BoundedCache, optionalSpotifyCapabilities, runWithTimeout } from "./spotifyApiAdapter"
import { candidateFromUri, enrichCandidatesFromSearch } from "./trackMetadata"

type CachedFeatures = Pick<
  TrackCandidate,
  "instrumentalness" | "tempo" | "energy" | "valence" | "danceability" | "acousticness"
>
type CachedMetadata = Pick<
  TrackCandidate,
  "albumUri" | "albumName" | "trackName" | "popularity" | "releaseYear"
>
const SOURCE_TIMEOUT_MS = 6_000
const MAX_ENRICHMENT_REQUESTS = 12
const ENRICHMENT_CONCURRENCY = 3
const featureCache = new BoundedCache<string, CachedFeatures>(512)
const metadataCache = new BoundedCache<string, CachedMetadata>(512)
const discoveryPipeline = new SourcePipeline({
  timeoutMs: 8_000,
  maxConcurrency: 4,
  failureThreshold: 2,
  cooldownMs: 90_000,
})

const DISCOVERY_QUORUM_CANDIDATES = 75
const DISCOVERY_CACHE_TTL_MS = 2 * 60_000
const HIGH_AFFINITY_SOURCES = new Set(["recommendations", "inspired-by", "radio"])
const BREADTH_SOURCES = new Set(["genre-era-search", "era-search", "related-artists"])
const lateDiscoveryCache = new BoundedCache<
  string,
  { expiresAt: number; candidates: TrackCandidate[] }
>(12)
const discoveryGenerations = new BoundedCache<string, number>(12)

const rememberLateDiscovery = (seedUri: string, sourceId: string, candidates: TrackCandidate[]) => {
  if (candidates.length === 0) return
  const current = lateDiscoveryCache.get(seedUri)?.candidates ?? []
  lateDiscoveryCache.set(seedUri, {
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    candidates: mergeCandidatesWithProvenance([
      ...current,
      ...candidates.map((candidate) => attachSourceProvenance(candidate, sourceId)),
    ]).slice(0, 200),
  })
}

const takeLateDiscovery = (seedUri: string): TrackCandidate[] => {
  const entry = lateDiscoveryCache.take(seedUri)
  if (!entry || entry.expiresAt <= Date.now()) return []
  return entry.candidates
}

const hasDiscoveryQuorum = (
  values: ReadonlyArray<{ sourceId: string; value: TrackCandidate[] }>
): boolean => {
  const successful = values.filter(({ value }) => value.length > 0)
  if (successful.length < 3) return false
  if (!successful.some(({ sourceId }) => HIGH_AFFINITY_SOURCES.has(sourceId))) return false
  if (!successful.some(({ sourceId }) => BREADTH_SOURCES.has(sourceId))) return false
  const uniqueUris = new Set(
    successful.flatMap(({ value }) => value.map((candidate) => candidate.uri))
  )
  return uniqueUris.size >= DISCOVERY_QUORUM_CANDIDATES
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

export const resetSpotifySourceState = (): void => {
  featureCache.clear()
  metadataCache.clear()
  optionalSpotifyCapabilities.reset()
  discoveryPipeline.reset()
}

export const getSpotifySourceDiagnostics = () => ({
  capabilities: optionalSpotifyCapabilities.snapshot(),
  caches: {
    audioFeatures: featureCache.size,
    metadata: metadataCache.size,
  },
})

const enrichAudioFeaturesAndMetadata = async (
  candidates: TrackCandidate[]
): Promise<TrackCandidate[]> => {
  if (candidates.length === 0) return candidates

  const featuresMap = new Map<string, CachedFeatures>()
  for (const candidate of candidates) {
    const cached = featureCache.get(candidate.uri)
    if (cached) featuresMap.set(candidate.uri, cached)
  }
  const uncachedFeatureCandidates = candidates
    .filter((candidate) => !featureCache.has(candidate.uri) && Boolean(getUriId(candidate.uri)))
    .filter(
      (candidate, index, all) => all.findIndex((entry) => entry.uri === candidate.uri) === index
    )
    .slice(0, MAX_ENRICHMENT_REQUESTS)

  const fetchFeatures = async (candidate: TrackCandidate): Promise<boolean> => {
    const id = getUriId(candidate.uri)
    const result = await optionalSpotifyCapabilities.run("audio-features", () =>
      Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/audio-features/${id}`)
    )
    if (result.status !== "ok") return false
    const response = result.value
    const cached: CachedFeatures = {
      instrumentalness: response?.instrumentalness,
      tempo: response?.tempo,
      energy: response?.energy,
      valence: response?.valence,
      danceability: response?.danceability,
      acousticness: response?.acousticness,
    }
    featureCache.set(candidate.uri, cached)
    featuresMap.set(candidate.uri, cached)
    return true
  }

  if (uncachedFeatureCandidates.length > 0) {
    const available = await fetchFeatures(uncachedFeatureCandidates[0])
    if (available) {
      await mapWithConcurrency(
        uncachedFeatureCandidates.slice(1),
        ENRICHMENT_CONCURRENCY,
        fetchFeatures
      )
    }
  }

  const metadataMap = new Map<string, CachedMetadata>()
  for (const candidate of candidates) {
    const cached = metadataCache.get(candidate.uri)
    if (cached) metadataMap.set(candidate.uri, cached)
  }
  const needsMetadata = candidates.filter(
    (c) =>
      !metadataCache.has(c.uri) &&
      (!c.albumName ||
        !c.trackName ||
        c.popularity === undefined ||
        !c.albumUri ||
        c.releaseYear === undefined)
  )
  const boundedMetadata = needsMetadata
    .filter(
      (candidate, index, all) => all.findIndex((entry) => entry.uri === candidate.uri) === index
    )
    .slice(0, MAX_ENRICHMENT_REQUESTS)
  await mapWithConcurrency(boundedMetadata, ENRICHMENT_CONCURRENCY, async (candidate) => {
    const id = getUriId(candidate.uri)
    if (!id) return
    try {
      const track = await runWithTimeout(
        () =>
          Spicetify.CosmosAsync.get(
            `https://api.spotify.com/v1/tracks/${id}?market=${getMarket()}`
          ),
        SOURCE_TIMEOUT_MS
      )
      const cached: CachedMetadata = {
        albumUri: track?.album?.uri,
        albumName: track?.album?.name,
        trackName: track?.name,
        popularity: track?.popularity,
        releaseYear: Number.parseInt(track?.album?.release_date?.slice(0, 4), 10) || undefined,
      }
      metadataMap.set(candidate.uri, cached)
      metadataCache.set(candidate.uri, cached)
    } catch {
      // Metadata enrichment is optional; preserve the source candidate as-is.
    }
  })

  return candidates.map((candidate) => {
    const feat = featuresMap.get(candidate.uri)
    const meta = metadataMap.get(candidate.uri)
    return {
      ...candidate,
      instrumentalness: feat?.instrumentalness ?? candidate.instrumentalness,
      tempo: feat?.tempo ?? candidate.tempo,
      energy: feat?.energy ?? candidate.energy,
      valence: feat?.valence ?? candidate.valence,
      danceability: feat?.danceability ?? candidate.danceability,
      acousticness: feat?.acousticness ?? candidate.acousticness,
      albumName: meta?.albumName ?? candidate.albumName,
      albumUri: meta?.albumUri ?? candidate.albumUri,
      trackName: meta?.trackName ?? candidate.trackName,
      popularity: meta?.popularity ?? candidate.popularity,
      releaseYear: meta?.releaseYear ?? candidate.releaseYear,
    }
  })
}

export const enrichPlaylistTracks = async (tracks: TrackCandidate[]): Promise<TrackCandidate[]> =>
  enrichAudioFeaturesAndMetadata(tracks)

const filterInstrumentalsAndSoundtracks = (
  candidates: TrackCandidate[],
  isVocal: boolean,
  isSoundtrack: boolean
): TrackCandidate[] => {
  return candidates.filter((candidate) => {
    // 1. Vocal Tracks Protection:
    if (isVocal && candidate.instrumentalness !== undefined && candidate.instrumentalness > 0.5) {
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
          return true
        }

        return false
      }
    }

    return true
  })
}

const fetchPlaylistCandidates = async (
  playlistUri: string,
  sourceId: string
): Promise<TrackCandidate[]> => {
  try {
    const playlistId = getUriId(playlistUri)
    const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
      limit: 100,
    })

    return (res.items ?? [])
      .filter(
        (item: { uri: string; isPlayable?: boolean }) =>
          item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false
      )
      .map((item: { uri: string; metadata?: Record<string, string> }) =>
        candidateFromUri(item.uri, item.metadata, sourceId)
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
    return fetchPlaylistCandidates(playlistUri, "inspired-by")
  } catch {
    return []
  }
}

const fetchRadioStationCandidates = async (seedUri: string): Promise<TrackCandidate[]> => {
  try {
    const radioUri = (
      Spicetify.URI as typeof Spicetify.URI & {
        radioURI: (args: string) => Spicetify.URI
      }
    ).radioURI(seedUri)
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
      candidates.push(
        attachSourceProvenance(
          {
            uri,
            artistUri: artist?.uri,
            artistName: artist?.profile?.name,
          },
          "radio"
        )
      )
    }
    return candidates
  } catch {
    return []
  }
}

export const searchTracks = async (
  query: string,
  limit = 50,
  sourceId = "search"
): Promise<TrackCandidate[]> => {
  const market = getMarket()
  // Spotify reduced Search's maximum page size to 10 in February 2026.
  // Fetch a few sequential pages so older and newer clients share one path.
  const requested = Math.max(1, Math.min(50, Math.floor(limit)))
  const pageSize = Math.min(10, requested)
  const pageCount = Math.ceil(requested / pageSize)
  const randomWindow = Math.floor(Math.random() * 12) * pageSize
  const candidates: TrackCandidate[] = []

  for (let page = 0; page < pageCount; page += 1) {
    const offset = randomWindow + page * pageSize
    const response = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${pageSize}&offset=${offset}&market=${market}`
        ),
      SOURCE_TIMEOUT_MS
    )
    candidates.push(...enrichCandidatesFromSearch(response?.tracks?.items ?? [], sourceId))
    if ((response?.tracks?.items ?? []).length < pageSize) break
  }

  return mergeCandidatesWithProvenance(candidates).slice(0, requested)
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

  return searchTracks(parts.join(" "), 50, "genre-era-search")
}

const fetchEraOnlyCandidates = async (
  seed: SeedMetadata,
  settings: SmartConfig
): Promise<TrackCandidate[]> => {
  const eraQuery = buildEraQuery(seed, settings)
  if (!eraQuery) return []
  return searchTracks(eraQuery, 50, "era-search")
}

const fetchRelatedArtistCandidates = async (seed: SeedMetadata): Promise<TrackCandidate[]> => {
  const artistId = getUriId(seed.artistUri)
  if (!artistId) return []

  const relatedResult = await optionalSpotifyCapabilities.run("related-artists", () =>
    Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/artists/${artistId}/related-artists`)
  )
  if (relatedResult.status !== "ok") return []
  const artists = (relatedResult.value?.artists ?? []).slice(0, 6) as Array<{ name?: string }>
  const results = await Promise.allSettled(
    artists
      .filter((artist) => artist.name && artist.name !== seed.artistName)
      .map((artist) => searchTracks(`artist:"${artist.name}"`, 20, "related-artists"))
  )

  const merged: TrackCandidate[] = []
  for (const result of results) {
    if (result.status === "fulfilled") merged.push(...result.value)
  }
  return mergeCandidatesWithProvenance(merged)
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
      const track = (
        item as {
          track?: {
            uri?: string
            playability?: { playable?: boolean }
            artists?: { items?: Array<{ uri?: string; profile?: { name?: string } }> }
            popularity?: number
          }
        }
      ).track
      if (!track?.playability?.playable || !track.uri || track.uri === seed.uri) continue
      albumTracks.push(
        attachSourceProvenance(
          {
            uri: track.uri,
            artistUri: track.artists?.items?.[0]?.uri,
            artistName: track.artists?.items?.[0]?.profile?.name,
            albumUri: seed.albumUri,
            popularity: track.popularity,
          },
          "album-peers"
        )
      )
    }
    return albumTracks
  } catch {
    return []
  }
}

const fetchAudioFeatures = async (
  trackId: string
): Promise<{ tempo?: number; energy?: number; valence?: number } | null> => {
  const result = await optionalSpotifyCapabilities.run("audio-features", () =>
    Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/audio-features/${trackId}`)
  )
  if (result.status !== "ok") return null
  return {
    tempo: result.value?.tempo,
    energy: result.value?.energy,
    valence: result.value?.valence,
  }
}

const fetchRecommendations = async (
  seed: SeedMetadata,
  settings: SmartConfig,
  limit = 50
): Promise<TrackCandidate[]> => {
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
    const hasRequestedSeedFeatures =
      (!settings.matchTempo || seed.tempo != null) &&
      (!settings.matchEnergy || seed.energy != null) &&
      (!settings.matchValence || seed.valence != null)
    const features = hasRequestedSeedFeatures
      ? { tempo: seed.tempo, energy: seed.energy, valence: seed.valence }
      : await fetchAudioFeatures(trackId)
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

  const result = await optionalSpotifyCapabilities.run("recommendations", () =>
    Spicetify.CosmosAsync.get(url)
  )
  return result.status === "ok"
    ? enrichCandidatesFromSearch(result.value?.tracks ?? [], "recommendations")
    : []
}

const fetchSimilarPoolInternal = async (
  seed: SeedMetadata,
  settings: SmartConfig,
  enrichResults: boolean
): Promise<TrackCandidate[]> => {
  const generation = (discoveryGenerations.get(seed.uri) ?? 0) + 1
  discoveryGenerations.set(seed.uri, generation)
  const cachedLateCandidates = takeLateDiscovery(seed.uri)
  const results = await discoveryPipeline.run<TrackCandidate[]>(
    [
      { id: "recommendations", run: () => fetchRecommendations(seed, settings, 50) },
      { id: "inspired-by", run: () => fetchInspiredByMix(seed.uri) },
      { id: "radio", run: () => fetchRadioStationCandidates(seed.uri) },
      { id: "genre-era-search", run: () => fetchGenreEraCandidates(seed, settings) },
      { id: "era-search", run: () => fetchEraOnlyCandidates(seed, settings) },
      { id: "related-artists", run: () => fetchRelatedArtistCandidates(seed) },
      { id: "album-peers", run: () => fetchAlbumPeerCandidates(seed) },
    ],
    {
      quorum: hasDiscoveryQuorum,
      onLateValue: ({ sourceId, value }) => {
        if (discoveryGenerations.get(seed.uri) === generation) {
          rememberLateDiscovery(seed.uri, sourceId, value)
        }
      },
      foregroundDeadlineMs: 4_500,
    }
  )

  const merged: TrackCandidate[] = [...cachedLateCandidates]
  for (const result of results.values) {
    merged.push(
      ...result.value.map((candidate) => attachSourceProvenance(candidate, result.sourceId))
    )
  }
  if (results.degraded) {
    const unavailable = results.diagnostics
      .filter((diagnostic) => diagnostic.status !== "ok" && diagnostic.status !== "empty")
      .map((diagnostic) => `${diagnostic.sourceId}:${diagnostic.status}`)
    if (unavailable.length > 0) {
      console.info(`[Shuffle Similar] Discovery degraded (${unavailable.join(", ")})`)
    }
  }

  let candidates = mergeCandidatesWithProvenance(merged)
    .filter((candidate) => candidate.uri !== seed.uri)
    .filter((candidate) => candidate.uri.startsWith("spotify:track:"))

  candidates = excludeArtist(candidates, seed.artistUri, seed.artistName)

  if (candidates.length < 10 && seed.artistName) {
    const fallback = await searchTracks(
      `year:${seed.releaseYear ?? 2010}`,
      50,
      "fallback-search"
    ).catch(() => [])
    candidates = mergeCandidatesWithProvenance([
      ...candidates,
      ...excludeArtist(fallback, seed.artistUri, seed.artistName),
    ])
  }

  if (!enrichResults) return candidates.filter((candidate) => candidate.uri !== seed.uri)

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

  candidates = filterInstrumentalsAndSoundtracks(candidates, isSeedVocal, isSeedSoundtrack)

  return candidates.filter((candidate) => candidate.uri !== seed.uri)
}

export const fetchSimilarPool = async (
  seed: SeedMetadata,
  settings: SmartConfig
): Promise<TrackCandidate[]> => fetchSimilarPoolInternal(seed, settings, true)

export const fetchPlaylistRecommendations = async (
  seeds: TrackCandidate[],
  settings: SmartConfig,
  limit = 50
): Promise<TrackCandidate[]> => {
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
    const firstSeed = seeds[0]
    const hasRequestedSeedFeatures =
      (!settings.matchTempo || firstSeed?.tempo != null) &&
      (!settings.matchEnergy || firstSeed?.energy != null) &&
      (!settings.matchValence || firstSeed?.valence != null)
    const features = hasRequestedSeedFeatures
      ? {
          tempo: firstSeed?.tempo,
          energy: firstSeed?.energy,
          valence: firstSeed?.valence,
        }
      : await fetchAudioFeatures(seedTrackIds[0])
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

  const result = await optionalSpotifyCapabilities.run("recommendations", () =>
    Spicetify.CosmosAsync.get(url)
  )
  return result.status === "ok"
    ? enrichCandidatesFromSearch(result.value?.tracks ?? [], "playlist-recommendations")
    : []
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

  // Enrich the complete playlist so the final ranker can compare candidates
  // against every track, not just the handful used as network seeds.
  const enrichedPlaylistTracks = await enrichAudioFeaturesAndMetadata(playlistTracks)

  // Build the exclusion set from all playlist track URIs
  const playlistUriSet = new Set(enrichedPlaylistTracks.map((t) => t.uri))

  // Sample seed tracks spread across the playlist for diversity
  const seeds = sampleSpread(
    enrichedPlaylistTracks,
    Math.min(seedCount, enrichedPlaylistTracks.length)
  )

  // Build SeedMetadata for each sampled track
  const seedMetadatas = await mapWithConcurrency(seeds, 2, (candidate) =>
    buildSeedMetadataFromCandidate(candidate)
  )

  // Run discovery with bounded fan-out, then enrich only the merged pool once.
  const poolResults = await mapWithConcurrency(seedMetadatas, 2, (seedMetadata) =>
    fetchSimilarPoolInternal(seedMetadata, settings, false).catch(() => [])
  )

  // Also try the legacy recommendations endpoint as one more signal
  const recoResult = await Promise.allSettled([
    fetchPlaylistRecommendations(seeds, settings, settings.initialQueueSize * 2),
  ])

  // Merge all results
  const merged: TrackCandidate[] = []
  for (const result of poolResults) merged.push(...result)
  for (const result of recoResult) {
    if (result.status === "fulfilled") merged.push(...result.value)
  }

  // Deduplicate and exclude tracks that are in the original playlist
  let deduped = mergeCandidatesWithProvenance(merged)
    .filter((c) => c.uri.startsWith("spotify:track:"))
    .filter((c) => !playlistUriSet.has(c.uri))

  // 1. Batch enrich playlist candidates with audio features and track metadata
  deduped = await enrichAudioFeaturesAndMetadata(deduped)

  // 2. Check if the playlist seeds are vocal and if any is a soundtrack
  const vocalCount = seedMetadatas.filter(
    (s) => s.instrumentalness === undefined || s.instrumentalness < 0.2
  ).length
  const isPlaylistVocal = vocalCount >= seedMetadatas.length / 2

  const isPlaylistSoundtrack = seedMetadatas.some((s) => {
    const isSoundtrackAlbum =
      s.albumName &&
      /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(
        s.albumName
      )
    const isSoundtrackGenre = s.genres.some((g) =>
      /(soundtrack|score|orchestral|movie tunes|show tunes|broadway|musical)/i.test(g)
    )
    return isSoundtrackAlbum || isSoundtrackGenre
  })

  deduped = filterInstrumentalsAndSoundtracks(deduped, isPlaylistVocal, isPlaylistSoundtrack)

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
      const artist = await runWithTimeout(
        () => Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/artists/${artistId}`),
        SOURCE_TIMEOUT_MS
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
    if (!albumName && trackId) {
      const track = await runWithTimeout(
        () =>
          Spicetify.CosmosAsync.get(
            `https://api.spotify.com/v1/tracks/${trackId}?market=${getMarket()}`
          ),
        SOURCE_TIMEOUT_MS
      )
      albumName = track?.album?.name
    }
    if (trackId && instrumentalness === undefined) {
      const featureResult = await optionalSpotifyCapabilities.run("audio-features", () =>
        Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/audio-features/${trackId}`)
      )
      if (featureResult.status === "ok") {
        instrumentalness = featureResult.value?.instrumentalness ?? instrumentalness
      }
    }
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
    tempo: candidate.tempo,
    energy: candidate.energy,
    valence: candidate.valence,
    danceability: candidate.danceability,
    acousticness: candidate.acousticness,
  }
}
