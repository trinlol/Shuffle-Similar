import { excludeArtist } from "../algorithm/filters"
import {
  filterSoundtracksAndInstrumentals,
  hasDisqualifyingTitleMismatch,
  inferSeedGenres,
  isSoundtrackSeed,
  isVocalSeed,
  SOUNDTRACK_ALBUM_REGEX,
} from "../algorithm/genreAffinity"
import { fisherYatesShuffle } from "../algorithm/shuffle"
import type { SeedMetadata, TrackCandidate } from "../session/types"
import type { SmartConfig } from "../storage/settings"
import { getMarket } from "../utils/playability"
import { getUriId } from "../utils/uri"
import { resetProfileCaches } from "./profileTracks"
import { attachSourceProvenance, mergeCandidatesWithProvenance } from "./provenance"
import { SourcePipeline } from "./sourcePipeline"
import { BoundedCache, optionalSpotifyCapabilities, runWithTimeout } from "./spotifyApiAdapter"
import {
  candidateFromUri,
  enrichCandidateArtistGenres,
  enrichCandidatesFromSearch,
  fetchArtistGenres,
  getArtistGenreCacheSize,
  resetArtistGenreCache,
} from "./trackMetadata"

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
  maxConcurrency: 7,
  failureThreshold: 2,
  cooldownMs: 90_000,
})

const DISCOVERY_QUORUM_CANDIDATES = 40
const DISCOVERY_CACHE_TTL_MS = 2 * 60_000
const HIGH_AFFINITY_SOURCES = new Set(["recommendations", "inspired-by", "radio"])
const BREADTH_SOURCES = new Set(["genre-era-search", "related-artists", "discovered-on"])
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
  lateDiscoveryCache.clear()
  discoveryGenerations.clear()
  resetArtistGenreCache()
  resetProfileCaches()
  optionalSpotifyCapabilities.reset()
  discoveryPipeline.reset()
}

export const getSpotifySourceDiagnostics = () => ({
  capabilities: optionalSpotifyCapabilities.snapshot(),
  caches: {
    audioFeatures: featureCache.size,
    metadata: metadataCache.size,
    artistGenres: getArtistGenreCacheSize(),
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

const fetchPlaylistCandidates = async (
  playlistUri: string,
  sourceId: string,
  limit = 100
): Promise<TrackCandidate[]> => {
  try {
    const playlistId = getUriId(playlistUri)
    if (!playlistId) return []
    const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
      limit,
    })

    return (res.items ?? [])
      .filter(
        (item: { uri: string; isPlayable?: boolean }) =>
          item.uri?.startsWith("spotify:track:") && item.isPlayable !== false
      )
      .map((item: { uri: string; metadata?: Record<string, string> }) =>
        candidateFromUri(item.uri, item.metadata, sourceId)
      )
  } catch {
    return []
  }
}

export const capArtistFrequencyInSource = (
  candidates: TrackCandidate[],
  maxPerArtist = 2
): TrackCandidate[] => {
  const counts = new Map<string, number>()
  const capped: TrackCandidate[] = []

  for (const candidate of candidates) {
    const artistKey =
      candidate.artistUri?.trim().toLowerCase() ??
      (candidate.artistName ? `name:${candidate.artistName.trim().toLowerCase()}` : undefined)

    if (!artistKey) {
      capped.push(candidate)
      continue
    }

    const current = counts.get(artistKey) ?? 0
    if (current < maxPerArtist) {
      counts.set(artistKey, current + 1)
      capped.push(candidate)
    }
  }

  if (capped.length <= 2) return capped

  const head = capped.slice(0, 2)
  const rest = capped.slice(2)
  const gentlyShuffled: TrackCandidate[] = []
  for (let i = 0; i < rest.length; i += 4) {
    gentlyShuffled.push(...fisherYatesShuffle(rest.slice(i, i + 4)))
  }

  return [...head, ...gentlyShuffled]
}

const fetchInspiredByMix = async (seedUri: string): Promise<TrackCandidate[]> => {
  try {
    const response = await Spicetify.CosmosAsync.get(
      `https://spclient.wg.spotify.com/inspiredby-mix/v2/seed_to_playlist/${seedUri}?response-format=json`
    )

    const playlistUri = response?.mediaItems?.[0]?.uri
    if (!playlistUri) return []
    const candidates = await fetchPlaylistCandidates(playlistUri, "inspired-by")
    return capArtistFrequencyInSource(candidates, 2)
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
          name?: string
          albumOfTrack?: { uri?: string; name?: string }
          album?: { uri?: string; name?: string }
          artists?: { items?: Array<{ uri?: string; profile?: { name?: string } }> }
        }
        uri?: string
      }
      const track = entry.track ?? entry
      const uri = track.uri
      if (!uri) continue
      const artist = "artists" in track ? track.artists?.items?.[0] : undefined
      const album = "albumOfTrack" in track ? (track.albumOfTrack ?? track.album) : undefined
      candidates.push(
        attachSourceProvenance(
          {
            uri,
            trackName: "name" in track ? track.name : undefined,
            artistUri: artist?.uri,
            artistName: artist?.profile?.name,
            albumUri: album?.uri,
            albumName: album?.name,
          },
          "radio"
        )
      )
    }
    return capArtistFrequencyInSource(candidates, 2)
  } catch {
    return []
  }
}

export const searchTracks = async (
  query: string,
  limit = 50,
  sourceId = "search",
  options: { maxOffsetPages?: number } = {}
): Promise<TrackCandidate[]> => {
  const market = getMarket()
  // Spotify reduced Search's maximum page size to 10 in February 2026.
  // Fetch a few sequential pages within a tight relevance window so top-ranked
  // results are preferred instead of drifting into deep karaoke/tribute pages.
  const requested = Math.max(1, Math.min(50, Math.floor(limit)))
  const pageSize = Math.min(10, requested)
  const pageCount = Math.ceil(requested / pageSize)
  const maxOffsetPages = Math.max(1, Math.floor(options.maxOffsetPages ?? 3))
  let baseOffset = Math.floor(Math.random() * maxOffsetPages) * pageSize
  const candidates: TrackCandidate[] = []

  const fetchPage = async (offset: number) => {
    const response = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${pageSize}&offset=${offset}&market=${market}`
        ),
      SOURCE_TIMEOUT_MS
    )
    return response?.tracks?.items ?? []
  }

  let firstItems = await fetchPage(baseOffset)
  if (firstItems.length === 0 && baseOffset > 0) {
    baseOffset = 0
    firstItems = await fetchPage(0)
  }
  candidates.push(...enrichCandidatesFromSearch(firstItems, sourceId))

  if (firstItems.length >= pageSize && pageCount > 1) {
    const remainingPages = Array.from({ length: pageCount - 1 }, (_, index) => index + 1)
    const pageResults = await Promise.all(
      remainingPages.map((page) => fetchPage(baseOffset + page * pageSize).catch(() => []))
    )
    for (const items of pageResults) {
      candidates.push(...enrichCandidatesFromSearch(items, sourceId))
      if (items.length < pageSize) break
    }
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
  settings: SmartConfig,
  deepDiscovery = false
): Promise<TrackCandidate[]> => {
  // Never execute a genre-less year search: naked era queries pull completely
  // unrelated songs across every genre on Spotify.
  const seedGenres = seed.genres.map((genre) => genre.trim()).filter(Boolean)
  if (seedGenres.length === 0) return []

  const eraQuery = buildEraQuery(seed, settings)
  const shuffledGenres = fisherYatesShuffle(seedGenres)
  const selectedGenres = shuffledGenres.slice(0, deepDiscovery ? 3 : 2)
  const genreBatches = await Promise.all(
    selectedGenres.map(async (genre, index) => {
      const limit = deepDiscovery ? 40 : index === 0 ? 30 : 20
      const queryWithEra = eraQuery ? `genre:"${genre}" ${eraQuery}` : `genre:"${genre}"`
      let results = await searchTracks(queryWithEra, limit, "genre-era-search", {
        maxOffsetPages: deepDiscovery ? 7 : 4,
      }).catch(() => [])
      if ((results.length < 6 || deepDiscovery) && eraQuery) {
        const broader = await searchTracks(
          `genre:"${genre}"`,
          deepDiscovery ? 30 : 20,
          "genre-era-search",
          {
            maxOffsetPages: deepDiscovery ? 7 : 4,
          }
        ).catch(() => [])
        results = mergeCandidatesWithProvenance([...results, ...broader])
      }
      return results.map((candidate) => ({
        ...candidate,
        genres: [...new Set([...(candidate.genres ?? []), genre])],
      }))
    })
  )

  return mergeCandidatesWithProvenance(genreBatches.flat())
}

type RelatedArtistSummary = {
  uri?: string
  name?: string
  genres?: string[]
}

const fetchRelatedArtistsViaGraphQl = async (
  artistUri: string
): Promise<RelatedArtistSummary[]> => {
  if (!artistUri) return []
  const definitions = Spicetify.GraphQL?.Definitions
  if (!definitions || typeof Spicetify.GraphQL?.Request !== "function") return []

  const extractRelated = (data: Record<string, unknown> | undefined): RelatedArtistSummary[] => {
    type RelatedNode = {
      uri?: string
      id?: string
      profile?: { name?: string }
    }
    const artistUnion = data?.artistUnion as
      | {
          relatedContent?: {
            relatedArtistsV2?: { items?: RelatedNode[] }
            relatedArtists?: { items?: RelatedNode[] }
          }
        }
      | undefined
    const items =
      artistUnion?.relatedContent?.relatedArtistsV2?.items ??
      artistUnion?.relatedContent?.relatedArtists?.items ??
      []
    return items
      .map((item) => ({
        uri: item.uri ?? (item.id ? `spotify:artist:${item.id}` : undefined),
        name: item.profile?.name,
      }))
      .filter((item) => Boolean(item.uri || item.name))
  }

  if (definitions.queryArtistRelated) {
    try {
      const { data, errors } = await runWithTimeout(
        () => Spicetify.GraphQL.Request(definitions.queryArtistRelated, { uri: artistUri }),
        SOURCE_TIMEOUT_MS
      )
      if (!errors?.length) {
        const related = extractRelated(data)
        if (related.length > 0) return related
      }
    } catch {
      // Fall through to queryArtistOverview
    }
  }

  if (definitions.queryArtistOverview) {
    try {
      const locale = Spicetify.Locale?.getLocale?.() ?? "en"
      const { data, errors } = await runWithTimeout(
        () =>
          Spicetify.GraphQL.Request(definitions.queryArtistOverview, {
            uri: artistUri,
            locale,
            includePrerelease: false,
          }),
        SOURCE_TIMEOUT_MS
      )
      if (!errors?.length) return extractRelated(data)
    } catch {
      return []
    }
  }

  return []
}

const fetchArtistTopTracksViaGraphQl = async (
  artist: RelatedArtistSummary
): Promise<TrackCandidate[]> => {
  if (!artist.uri) return []
  const queryArtistOverview = Spicetify.GraphQL?.Definitions?.queryArtistOverview
  if (!queryArtistOverview || typeof Spicetify.GraphQL?.Request !== "function") return []

  try {
    const locale = Spicetify.Locale?.getLocale?.() ?? "en"
    const { data, errors } = await runWithTimeout(
      () =>
        Spicetify.GraphQL.Request(queryArtistOverview, {
          uri: artist.uri,
          locale,
          includePrerelease: false,
        }),
      SOURCE_TIMEOUT_MS
    )
    if (errors?.length) return []
    let topTracks: unknown[] = data?.artistUnion?.discography?.topTracks?.items ?? []
    if (topTracks.length === 0) {
      const albumItems: Array<{
        releases?: { items?: Array<{ tracks?: { items?: unknown[] } }> }
        tracks?: { items?: unknown[] }
      }> =
        data?.artistUnion?.discography?.popularReleasesAlbums?.items ??
        data?.artistUnion?.discography?.albums?.items ??
        []
      for (const albumItem of albumItems) {
        const items =
          albumItem?.releases?.items?.[0]?.tracks?.items ?? albumItem?.tracks?.items ?? []
        for (const item of items) {
          if (item) topTracks.push(item)
        }
      }
    }

    if (topTracks.length >= 5) {
      const deeper = topTracks.slice(2, Math.min(10, topTracks.length))
      const head = topTracks.slice(0, 2)
      const tail = topTracks.slice(10)
      topTracks = [...deeper, ...head, ...tail]
    }

    type GraphQlArtistTrack = {
      uri?: string
      name?: string
      popularity?: number
      playability?: { playable?: boolean }
      albumOfTrack?: { uri?: string; name?: string }
      artists?: { items?: Array<{ uri?: string; profile?: { name?: string } }> }
    }

    const tracks: TrackCandidate[] = []
    for (const entry of topTracks) {
      const item = entry as { track?: GraphQlArtistTrack } | GraphQlArtistTrack
      const track: GraphQlArtistTrack | undefined =
        "track" in item && item.track ? item.track : (item as GraphQlArtistTrack)
      if (!track?.uri || track.playability?.playable === false) continue
      const primaryArtist = track.artists?.items?.[0]
      tracks.push(
        attachSourceProvenance(
          {
            uri: track.uri,
            trackName: track.name,
            artistUri: primaryArtist?.uri ?? artist.uri,
            artistName: primaryArtist?.profile?.name ?? artist.name,
            albumUri: track.albumOfTrack?.uri,
            albumName: track.albumOfTrack?.name,
            popularity: track.popularity,
            ...(artist.genres?.length ? { genres: artist.genres } : {}),
          },
          "related-artists"
        )
      )
    }
    return tracks
  } catch {
    return []
  }
}

const fetchRelatedArtistCandidates = async (
  seed: SeedMetadata,
  deepDiscovery = false
): Promise<TrackCandidate[]> => {
  const artistId = getUriId(seed.artistUri)
  if (!artistId) return []
  const artistUri = seed.artistUri || `spotify:artist:${artistId}`
  const artistLimit = deepDiscovery ? 12 : 8

  let artists: RelatedArtistSummary[] = []
  const relatedResult = await optionalSpotifyCapabilities.run("related-artists", () =>
    Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/artists/${artistId}/related-artists`)
  )
  if (relatedResult.status === "ok") {
    artists = (
      (relatedResult.value?.artists ?? []) as Array<{
        id?: string
        uri?: string
        name?: string
        genres?: string[]
      }>
    )
      .slice(0, 20)
      .map((artist) => ({
        uri: artist.uri ?? (artist.id ? `spotify:artist:${artist.id}` : undefined),
        name: artist.name,
        genres: Array.isArray(artist.genres)
          ? artist.genres.filter((genre): genre is string => typeof genre === "string")
          : undefined,
      }))
  } else {
    artists = (await fetchRelatedArtistsViaGraphQl(artistUri)).slice(0, 20)
  }

  const filteredArtists = artists.filter(
    (artist) =>
      (artist.uri || artist.name) &&
      artist.uri !== seed.artistUri &&
      artist.name !== seed.artistName
  )
  if (filteredArtists.length === 0) return []

  let sampledArtists: RelatedArtistSummary[]
  if (filteredArtists.length <= 2) {
    sampledArtists = [...filteredArtists]
  } else {
    const head = filteredArtists.slice(0, 2)
    const rest = fisherYatesShuffle(filteredArtists.slice(2))
    sampledArtists = [...head, ...rest].slice(0, artistLimit)
  }

  // 2-Hop Related Artist Expansion (GraphQL)
  const definitions = Spicetify.GraphQL?.Definitions
  const hasGraphQlRelated = Boolean(
    definitions?.queryArtistRelated || definitions?.queryArtistOverview
  )
  if (filteredArtists.length >= 2 && hasGraphQlRelated) {
    const hop1Candidates = sampledArtists.filter((a) => a.uri).slice(0, 2)
    const knownUris = new Set(
      [seed.artistUri, ...filteredArtists.map((a) => a.uri)].filter(Boolean)
    )
    const knownNames = new Set(
      [seed.artistName, ...filteredArtists.map((a) => a.name)].filter(Boolean)
    )

    const hop1Uris = hop1Candidates
      .map((hop1) => hop1.uri)
      .filter((uri): uri is string => typeof uri === "string" && uri.length > 0)

    const hop2Results = await Promise.allSettled(
      hop1Uris.map((uri) => fetchRelatedArtistsViaGraphQl(uri))
    )
    const hop2Artists: RelatedArtistSummary[] = []
    for (const res of hop2Results) {
      if (res.status === "fulfilled") {
        for (const a of res.value) {
          if ((a.uri && knownUris.has(a.uri)) || (a.name && knownNames.has(a.name))) continue
          if (a.uri) knownUris.add(a.uri)
          if (a.name) knownNames.add(a.name)
          hop2Artists.push(a)
          if (hop2Artists.length >= 4) break
        }
      }
      if (hop2Artists.length >= 4) break
    }
    sampledArtists.push(...hop2Artists.slice(0, 4))
  }

  const results = await mapWithConcurrency(sampledArtists, 3, async (artist) => {
    const graphQlTracks = await fetchArtistTopTracksViaGraphQl(artist)
    if (graphQlTracks.length > 0 && !deepDiscovery) return graphQlTracks.slice(0, 3)
    if (!artist.name) return graphQlTracks.slice(0, 3)
    const searched = await searchTracks(
      `artist:"${artist.name}"`,
      deepDiscovery ? 18 : 12,
      "related-artists",
      {
        maxOffsetPages: deepDiscovery ? 3 : 1,
      }
    ).catch(() => [])
    const taggedSearch = artist.genres?.length
      ? searched.map((track) => ({ ...track, genres: artist.genres }))
      : searched
    return mergeCandidatesWithProvenance([...graphQlTracks, ...taggedSearch]).slice(0, 3)
  })

  return mergeCandidatesWithProvenance(results.flat())
}

const fetchDiscoveredOnCandidates = async (
  seed: SeedMetadata,
  deepDiscovery = false
): Promise<TrackCandidate[]> => {
  const artistId = getUriId(seed.artistUri)
  const artistUri = seed.artistUri || (artistId ? `spotify:artist:${artistId}` : "")
  if (!artistUri) return []

  const definitions = Spicetify.GraphQL?.Definitions
  if (!definitions || typeof Spicetify.GraphQL?.Request !== "function") return []

  type DiscoveredPlaylist = { uri?: string; name?: string }
  const extractPlaylists = (data: Record<string, unknown> | undefined): DiscoveredPlaylist[] => {
    type DiscoveredNode = {
      data?: { __typename?: string; uri?: string; name?: string }
      uri?: string
      name?: string
    }
    const artistUnion = data?.artistUnion as
      | {
          relatedContent?: {
            discoveredOnV2?: { items?: DiscoveredNode[] }
            discoveredOn?: { items?: DiscoveredNode[] }
          }
        }
      | undefined
    const items =
      artistUnion?.relatedContent?.discoveredOnV2?.items ??
      artistUnion?.relatedContent?.discoveredOn?.items ??
      []
    return items
      .map((item) => ({
        uri: item.data?.uri ?? item.uri,
        name: item.data?.name ?? item.name,
      }))
      .filter((playlist) => Boolean(playlist.uri?.includes(":playlist:")))
  }

  let playlists: DiscoveredPlaylist[] = []
  if (definitions.queryArtistDiscoveredOn) {
    try {
      const { data, errors } = await runWithTimeout(
        () => Spicetify.GraphQL.Request(definitions.queryArtistDiscoveredOn, { uri: artistUri }),
        SOURCE_TIMEOUT_MS
      )
      if (!errors?.length) playlists = extractPlaylists(data)
    } catch {
      // Fall through to queryArtistOverview
    }
  }

  if (playlists.length === 0 && definitions.queryArtistOverview) {
    try {
      const locale = Spicetify.Locale?.getLocale?.() ?? "en"
      const { data, errors } = await runWithTimeout(
        () =>
          Spicetify.GraphQL.Request(definitions.queryArtistOverview, {
            uri: artistUri,
            locale,
            includePrerelease: false,
          }),
        SOURCE_TIMEOUT_MS
      )
      if (!errors?.length) playlists = extractPlaylists(data)
    } catch {
      return []
    }
  }

  const seedIsSoundtrack = isSoundtrackSeed(seed)
  const selectedPlaylists = playlists
    .filter((playlist) => {
      if (!playlist.uri) return false
      if (!seedIsSoundtrack && playlist.name && SOUNDTRACK_ALBUM_REGEX.test(playlist.name)) {
        return false
      }
      return true
    })
    .slice(0, deepDiscovery ? 6 : 3)

  if (selectedPlaylists.length === 0) return []
  const results = await Promise.allSettled(
    selectedPlaylists.map((playlist) =>
      fetchPlaylistCandidates(playlist.uri ?? "", "discovered-on", deepDiscovery ? 70 : 40)
    )
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
            name?: string
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
            trackName: track.name,
            artistUri: track.artists?.items?.[0]?.uri,
            artistName: track.artists?.items?.[0]?.profile?.name,
            albumUri: seed.albumUri,
            albumName: seed.albumName,
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
  limit = 50,
  deepDiscovery = false
): Promise<TrackCandidate[]> => {
  const trackId = seed.trackId
  const artistId = getUriId(seed.artistUri)
  if (!trackId) return []

  const market = getMarket()
  let url = `https://api.spotify.com/v1/recommendations?limit=${limit}&market=${market}&seed_tracks=${trackId}`
  const shouldOmitArtist = seed.genres.length >= 2 && deepDiscovery
  if (artistId && !shouldOmitArtist) {
    url += `&seed_artists=${artistId}`
  }
  if (seed.genres.length > 0) {
    url += `&seed_genres=${encodeURIComponent(seed.genres.slice(0, 2).join(","))}`
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

export type FetchSimilarPoolOptions = {
  deepDiscovery?: boolean
}

const fetchSimilarPoolInternal = async (
  seed: SeedMetadata,
  settings: SmartConfig,
  enrichResults: boolean,
  options: FetchSimilarPoolOptions = {}
): Promise<TrackCandidate[]> => {
  const deepDiscovery = Boolean(options.deepDiscovery)
  const generation = (discoveryGenerations.get(seed.uri) ?? 0) + 1
  discoveryGenerations.set(seed.uri, generation)
  const cachedLateCandidates = takeLateDiscovery(seed.uri)
  const effectiveSettings = deepDiscovery ? { ...settings, deprioritizePopular: false } : settings
  const results = await discoveryPipeline.run<TrackCandidate[]>(
    [
      {
        id: "recommendations",
        run: () =>
          fetchRecommendations(seed, effectiveSettings, deepDiscovery ? 80 : 50, deepDiscovery),
      },
      { id: "related-artists", run: () => fetchRelatedArtistCandidates(seed, deepDiscovery) },
      { id: "discovered-on", run: () => fetchDiscoveredOnCandidates(seed, deepDiscovery) },
      { id: "inspired-by", run: () => fetchInspiredByMix(seed.uri) },
      { id: "radio", run: () => fetchRadioStationCandidates(seed.uri) },
      {
        id: "genre-era-search",
        run: () => fetchGenreEraCandidates(seed, settings, deepDiscovery),
      },
      { id: "album-peers", run: () => fetchAlbumPeerCandidates(seed) },
    ],
    {
      quorum: hasDiscoveryQuorum,
      keepBackgroundRunningOnQuorum: true,
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
    .filter((candidate) => !hasDisqualifyingTitleMismatch(seed, candidate))

  candidates = excludeArtist(candidates, seed.artistUri, seed.artistName)

  if (candidates.length < 10) {
    const primaryGenre = seed.genres.map((genre) => genre.trim()).find(Boolean)
    const fallbackQuery = primaryGenre
      ? `genre:"${primaryGenre}"`
      : seed.artistName
        ? `"${seed.artistName}"`
        : null
    if (fallbackQuery) {
      const fallback = await searchTracks(fallbackQuery, 30, "fallback-search", {
        maxOffsetPages: primaryGenre ? 2 : 1,
      }).catch(() => [])
      const taggedFallback = primaryGenre
        ? fallback.map((candidate) => ({
            ...candidate,
            genres: [...new Set([...(candidate.genres ?? []), primaryGenre])],
          }))
        : fallback
      candidates = mergeCandidatesWithProvenance([
        ...candidates,
        ...excludeArtist(taggedFallback, seed.artistUri, seed.artistName),
      ])
    }
  }

  if (!enrichResults) return candidates.filter((candidate) => candidate.uri !== seed.uri)

  const [featureEnriched, genreEnriched] = await Promise.all([
    enrichAudioFeaturesAndMetadata(candidates),
    enrichCandidateArtistGenres(candidates, 18),
  ])
  candidates = featureEnriched.map((candidate, index) => {
    const genres = genreEnriched[index]?.genres ?? candidate.genres
    return genres?.length ? { ...candidate, genres } : candidate
  })

  const effectiveGenres = inferSeedGenres(seed, candidates)
  const seedIsSoundtrack = isSoundtrackSeed(seed, effectiveGenres)
  const seedIsVocal = isVocalSeed(seed)

  candidates = filterSoundtracksAndInstrumentals(candidates, seedIsVocal, seedIsSoundtrack).filter(
    (candidate) => !hasDisqualifyingTitleMismatch(seed, candidate)
  )

  return candidates.filter((candidate) => candidate.uri !== seed.uri)
}

export const fetchSimilarPool = async (
  seed: SeedMetadata,
  settings: SmartConfig,
  options: FetchSimilarPoolOptions = {}
): Promise<TrackCandidate[]> => fetchSimilarPoolInternal(seed, settings, true, options)

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

  // 1. Batch enrich playlist candidates with audio features, track metadata, and artist genres
  const [featureEnriched, genreEnriched] = await Promise.all([
    enrichAudioFeaturesAndMetadata(deduped),
    enrichCandidateArtistGenres(deduped, 16),
  ])
  deduped = featureEnriched.map((candidate, index) => {
    const genres = genreEnriched[index]?.genres ?? candidate.genres
    return genres?.length ? { ...candidate, genres } : candidate
  })

  // 2. Check if the playlist seeds are vocal and if any is a soundtrack
  const vocalCount = seedMetadatas.filter((s) => isVocalSeed(s)).length
  const isPlaylistVocal = vocalCount >= seedMetadatas.length / 2
  const isPlaylistSoundtrack = seedMetadatas.some((s) => isSoundtrackSeed(s))

  deduped = filterSoundtracksAndInstrumentals(deduped, isPlaylistVocal, isPlaylistSoundtrack)

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
  const genres = candidate.genres?.length
    ? candidate.genres
    : artistId
      ? await fetchArtistGenres(artistId)
      : []

  // Fetch track metadata and features for playlist seed tracks too
  let albumName = candidate.albumName
  let trackName = candidate.trackName ?? ""
  let instrumentalness = candidate.instrumentalness
  try {
    if ((!albumName || !trackName) && trackId) {
      const track = await runWithTimeout(
        () =>
          Spicetify.CosmosAsync.get(
            `https://api.spotify.com/v1/tracks/${trackId}?market=${getMarket()}`
          ),
        SOURCE_TIMEOUT_MS
      )
      albumName = albumName ?? track?.album?.name
      trackName = trackName || (track?.name ?? "")
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
    trackName,
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
