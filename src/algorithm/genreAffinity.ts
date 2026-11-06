import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSourceProvenance } from "../sources/provenance"
import { type AcousticProfile, acousticDistanceV2 } from "./rankingV2"

/**
 * Genre-agnostic structural, graph-co-occurrence, and acoustic coherence engine.
 *
 * Design principle: NO musical genres, artists, or songs are hardcoded here.
 * Spotify maintains 6,000+ evolving micro-genres; instead of a static genre table,
 * compatibility is derived algorithmically from:
 *   1. Syntactic compound-phrase structure (head-final noun agreement, contiguous
 *      multi-token stems, and head-modifier role-inversion penalties).
 *   2. Dynamic artist-graph co-occurrence (`expandSeedGenresFromGraph`), which learns
 *      sister/bridge tags directly from the seed's live Spotify neighborhood.
 *   3. Continuous 6D acoustic vector distance (`acousticDistanceV2`) and the
 *      recording-format protections mandated by `.agents/AGENTS.md` (vocal vs.
 *      instrumental/soundtrack scores and novelty/karaoke/sped-up edits).
 */

export const SOUNDTRACK_ALBUM_REGEX =
  /\b(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Motion Picture|Original Cast|Broadway|Musical|Film Score|Game Score|Original Series|Original Television|Original Game Soundtrack|Video Game OST|Anime Soundtrack|Motion Picture Cast|Cast Recording)\b/i

export const SOUNDTRACK_GENRE_REGEX =
  /\b(soundtrack|score|orchestral soundtrack|movie tunes|show tunes|broadway|musical|video game music|anime score|film score|original game soundtrack|video game ost|anime soundtrack|motion picture cast|cast recording)\b/i

export const SOUNDTRACK_TITLE_REGEX =
  /\((?:from|music from)\s+["']?[^)"']+["']?\s+(?:soundtrack|original motion picture|score|musical|ost)\)/i

export const INSTRUMENTAL_TITLE_OR_GENRE_REGEX =
  /\b(instrumental|orchestral score|symphony no\.|concerto|sonata|solo piano|ambient instrumental|backing track)\b/i

const DISQUALIFYING_TITLE_TAG_REGEX =
  /\b(sped up|nightcore|slowed|8d audio|karaoke|backing track|instrumental version|piano version|lullaby|made famous by|tribute to|ringtone|commentary|track by track)\b/i

const INTERIOR_CONJUNCTIONS = new Set(["and", "of", "the"])

const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\b([a-z])\s*&\s*([a-z])\b/g, "$1$2")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")

type ParsedGenrePhrase = {
  canonical: string
  tokens: string[]
  head: string
  modifiers: Set<string>
  bigrams: Set<string>
}

const MAX_PARSED_GENRE_PHRASE_CACHE = 2_048
const parsedGenrePhraseCache = new Map<string, ParsedGenrePhrase | null>()

export const getParsedGenrePhraseCacheSize = (): number => parsedGenrePhraseCache.size

const cacheParsedGenrePhrase = (
  raw: string,
  parsed: ParsedGenrePhrase | null
): ParsedGenrePhrase | null => {
  if (
    !parsedGenrePhraseCache.has(raw) &&
    parsedGenrePhraseCache.size >= MAX_PARSED_GENRE_PHRASE_CACHE
  ) {
    const oldestKey = parsedGenrePhraseCache.keys().next().value
    if (oldestKey !== undefined) {
      parsedGenrePhraseCache.delete(oldestKey)
    }
  }
  parsedGenrePhraseCache.set(raw, parsed)
  return parsed
}

const parseGenrePhrase = (raw: string): ParsedGenrePhrase | null => {
  if (parsedGenrePhraseCache.has(raw)) {
    return parsedGenrePhraseCache.get(raw) ?? null
  }

  const normalized = normalizeText(raw)
  if (!normalized) {
    return cacheParsedGenrePhrase(raw, null)
  }
  const rawTokens = normalized.split(" ").filter(Boolean)
  if (rawTokens.length === 0) {
    return cacheParsedGenrePhrase(raw, null)
  }

  const tokens =
    rawTokens.length >= 3
      ? rawTokens.filter(
          (token, index) =>
            index === 0 || index === rawTokens.length - 1 || !INTERIOR_CONJUNCTIONS.has(token)
        )
      : rawTokens

  if (tokens.length === 0) {
    return cacheParsedGenrePhrase(raw, null)
  }
  const head = tokens[tokens.length - 1]
  const modifiers = new Set(tokens.slice(0, -1))
  const bigrams = new Set<string>()
  for (let i = 0; i < tokens.length - 1; i += 1) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`)
  }

  const parsed: ParsedGenrePhrase = {
    canonical: tokens.join(" "),
    tokens,
    head,
    modifiers,
    bigrams,
  }
  return cacheParsedGenrePhrase(raw, parsed)
}

/**
 * Computes structural affinity in [0, 1] between two parsed genre phrases without
 * any hardcoded genre dictionary:
 * - Exact phrase match -> 1.0
 * - Same syntactic head noun (e.g. two sub-styles of the same primary category) -> 0.68..0.96
 * - Shared contiguous multi-word compound stem (e.g. "singer songwriter" in
 *   "singer songwriter pop") -> 0.78..0.90
 * - Head-modifier role inversion (one phrase's primary head noun is merely a leading
 *   adjective on a different head noun, e.g. X vs "X Y") -> 0.10
 * - Modifier-only overlap with different heads -> scaled small by token union (<= 0.11)
 */
const scorePhrasePair = (left: ParsedGenrePhrase, right: ParsedGenrePhrase): number => {
  if (left.canonical === right.canonical) return 1.0

  let hasSharedBigram = false
  for (const bigram of left.bigrams) {
    if (right.bigrams.has(bigram)) {
      hasSharedBigram = true
      break
    }
  }

  let sharedModifiers = 0
  for (const mod of left.modifiers) {
    if (right.modifiers.has(mod)) sharedModifiers += 1
  }
  const modifierUnion = left.modifiers.size + right.modifiers.size - sharedModifiers
  const modifierJaccard = modifierUnion > 0 ? sharedModifiers / modifierUnion : 0

  if (left.head === right.head) {
    if (hasSharedBigram) return 0.9
    if (left.modifiers.size === 0 || right.modifiers.size === 0) return 0.82
    return 0.68 + 0.28 * modifierJaccard
  }

  if (hasSharedBigram) {
    return 0.78
  }

  // Head-modifier role inversion: left's primary category noun only appears as a
  // modifier of right's different category noun (or vice versa).
  if (right.modifiers.has(left.head) || left.modifiers.has(right.head)) {
    return 0.1
  }

  if (sharedModifiers > 0) {
    const tokenUnion = new Set([...left.tokens, ...right.tokens]).size
    return tokenUnion > 0 ? 0.22 * (sharedModifiers / tokenUnion) : 0
  }

  return 0
}

/**
 * Computes genre compatibility in [0, 1] between two dynamic tag sets.
 * Returns `null` when either side lacks tags so callers distinguish "unknown"
 * metadata from an active mismatch.
 */
export const scoreGenreCompatibility = (
  seedGenres: readonly string[] | undefined,
  candidateGenres: readonly string[] | undefined
): number | null => {
  const parsedSeed = (seedGenres ?? [])
    .map(parseGenrePhrase)
    .filter((entry): entry is ParsedGenrePhrase => entry !== null)
  const parsedCandidate = (candidateGenres ?? [])
    .map(parseGenrePhrase)
    .filter((entry): entry is ParsedGenrePhrase => entry !== null)

  if (parsedSeed.length === 0 || parsedCandidate.length === 0) return null

  let maxPair = 0
  let sumSeedToCandidate = 0
  const bestByCandidate = new Float64Array(parsedCandidate.length)

  for (let i = 0; i < parsedSeed.length; i += 1) {
    const s = parsedSeed[i]
    let bestForSeed = 0
    for (let j = 0; j < parsedCandidate.length; j += 1) {
      const score = scorePhrasePair(s, parsedCandidate[j])
      if (score > bestForSeed) bestForSeed = score
      if (score > bestByCandidate[j]) bestByCandidate[j] = score
      if (score > maxPair) maxPair = score
    }
    sumSeedToCandidate += bestForSeed
  }

  let sumCandidateToSeed = 0
  for (let j = 0; j < parsedCandidate.length; j += 1) {
    sumCandidateToSeed += bestByCandidate[j]
  }

  const meanSeedCoverage = sumSeedToCandidate / parsedSeed.length
  const meanCandidateCoverage = sumCandidateToSeed / parsedCandidate.length
  const bidirectionalCoverage = 0.5 * (meanSeedCoverage + meanCandidateCoverage)

  return Math.max(0, Math.min(1, 0.55 * maxPair + 0.45 * bidirectionalCoverage))
}

const NEIGHBOR_TRUSTED_SOURCES = new Set([
  "inspired-by",
  "radio",
  "recommendations",
  "related-artists",
  "discovered-on",
  "playlist-recommendations",
])

const artistIdentity = (candidate: Pick<TrackCandidate, "artistUri" | "artistName">): string =>
  normalizeText(candidate.artistUri || candidate.artistName || "")

const getTrustedGraphNeighbors = (neighbors: readonly TrackCandidate[]): TrackCandidate[] =>
  neighbors.filter((candidate) => {
    const provenance = getSourceProvenance(candidate)
    return (
      provenance.length === 0 || provenance.some((source) => NEIGHBOR_TRUSTED_SOURCES.has(source))
    )
  })

/**
 * Resolves effective seed genres when Spotify omits genre tags on a brand-new or
 * independent artist by finding consensus tags shared across >= 2 distinct
 * trusted neighbor artists.
 */
export const inferSeedGenres = (
  seed: Pick<SeedMetadata, "genres"> | undefined,
  neighbors: readonly TrackCandidate[] = []
): string[] => {
  const direct = (seed?.genres ?? []).map((genre) => genre.trim()).filter(Boolean)
  if (direct.length > 0) return direct

  const trustedNeighbors = getTrustedGraphNeighbors(neighbors)
  const artistsByGenre = new Map<string, Set<string>>()
  const displayGenre = new Map<string, string>()

  for (const neighbor of trustedNeighbors) {
    if (!neighbor.genres?.length) continue
    const artistKey = artistIdentity(neighbor) || neighbor.uri
    for (const rawGenre of neighbor.genres) {
      const key = normalizeText(rawGenre)
      if (!key) continue
      if (!displayGenre.has(key)) displayGenre.set(key, rawGenre.trim())
      const artists = artistsByGenre.get(key) ?? new Set<string>()
      artists.add(artistKey)
      artistsByGenre.set(key, artists)
    }
  }

  return [...artistsByGenre.entries()]
    .filter(([, artists]) => artists.size >= 2)
    .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([key]) => displayGenre.get(key) ?? key)
}

/**
 * Dynamically expands the seed's genre profile using empirical co-occurrence on
 * compatible artists in the seed's live discovery graph. This bridges sister
 * genres organically (whatever genre world the user plays) without hardcoding
 * genre relationships.
 */
export const expandSeedGenresFromGraph = (
  seed: Pick<SeedMetadata, "genres"> | undefined,
  neighbors: readonly TrackCandidate[] = []
): string[] => {
  const baseGenres = inferSeedGenres(seed, neighbors)
  if (baseGenres.length === 0 || neighbors.length === 0) return baseGenres

  const existingKeys = new Set(baseGenres.map(normalizeText).filter(Boolean))
  const trustedNeighbors = getTrustedGraphNeighbors(neighbors)
  const bridgeArtistsByGenre = new Map<string, Set<string>>()
  const displayGenre = new Map<string, string>()

  for (const neighbor of trustedNeighbors) {
    if (!neighbor.genres?.length) continue
    const compat = scoreGenreCompatibility(baseGenres, neighbor.genres)
    if (compat === null || compat < 0.45) continue

    const artistKey = artistIdentity(neighbor) || neighbor.uri
    for (const rawGenre of neighbor.genres) {
      const key = normalizeText(rawGenre)
      if (!key || existingKeys.has(key)) continue
      if (!displayGenre.has(key)) displayGenre.set(key, rawGenre.trim())
      const artists = bridgeArtistsByGenre.get(key) ?? new Set<string>()
      artists.add(artistKey)
      bridgeArtistsByGenre.set(key, artists)
    }
  }

  const learnedBridges = [...bridgeArtistsByGenre.entries()]
    .filter(([, artists]) => artists.size >= 2)
    .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([key]) => displayGenre.get(key) ?? key)

  return [...baseGenres, ...learnedBridges]
}

/**
 * Flags tracks that carry novelty/karaoke/sped-up/nightcore/tribute format tags
 * unless the seed track itself intentionally belongs to that format.
 */
export const hasDisqualifyingTitleMismatch = (
  seed: Pick<SeedMetadata, "trackName"> | undefined,
  candidate: Pick<TrackCandidate, "trackName" | "albumName">
): boolean => {
  const candidateTitle = `${candidate.trackName ?? ""} ${candidate.albumName ?? ""}`.trim()
  if (!candidateTitle) return false
  if (!DISQUALIFYING_TITLE_TAG_REGEX.test(candidateTitle)) return false

  const seedTitle = seed?.trackName ?? ""
  if (seedTitle && DISQUALIFYING_TITLE_TAG_REGEX.test(seedTitle)) return false
  return true
}

/**
 * Detects jarring 6D acoustic vector mismatches against the seed track when audio
 * features are available.
 */
export const isSonicOutlier = (
  seed: AcousticProfile | undefined,
  candidate: AcousticProfile | undefined
): boolean => {
  if (!seed || !candidate) return false
  const distance = acousticDistanceV2(seed, candidate)
  if (distance !== null && distance > 0.46) return true

  if (
    seed.energy != null &&
    candidate.energy != null &&
    seed.acousticness != null &&
    candidate.acousticness != null
  ) {
    const energyDelta = Math.abs(seed.energy - candidate.energy)
    const acousticDelta = Math.abs(seed.acousticness - candidate.acousticness)
    if (energyDelta > 0.55 && acousticDelta > 0.6) return true
  }

  if (
    seed.instrumentalness != null &&
    seed.instrumentalness < 0.2 &&
    candidate.instrumentalness != null &&
    candidate.instrumentalness > 0.5
  ) {
    return true
  }

  return false
}

export const isSoundtrackSeed = (
  seed: Pick<SeedMetadata, "albumName" | "genres"> | undefined,
  inferredGenres: readonly string[] = []
): boolean => {
  if (!seed) return false
  if (seed.albumName && SOUNDTRACK_ALBUM_REGEX.test(seed.albumName)) return true
  const genres = seed.genres?.length ? seed.genres : inferredGenres
  return genres.some((genre) => SOUNDTRACK_GENRE_REGEX.test(genre))
}

export const isVocalSeed = (seed: Pick<SeedMetadata, "instrumentalness"> | undefined): boolean =>
  !seed || seed.instrumentalness === undefined || seed.instrumentalness < 0.2

/**
 * Centralizes AGENTS.md Vocal Tracks Protection and Soundtrack Leakage Protection
 * across both similarPool and profilePool.
 */
export const filterSoundtracksAndInstrumentals = (
  candidates: readonly TrackCandidate[],
  isVocal: boolean,
  isSoundtrack: boolean
): TrackCandidate[] => {
  return candidates.filter((candidate) => {
    // 1. Vocal Tracks Protection: reject high-instrumentalness tracks in vocal sessions.
    if (isVocal) {
      if (candidate.instrumentalness !== undefined && candidate.instrumentalness > 0.5) {
        return false
      }
      if (candidate.instrumentalness === undefined) {
        const matchesInstrumental =
          Boolean(
            candidate.trackName && INSTRUMENTAL_TITLE_OR_GENRE_REGEX.test(candidate.trackName)
          ) ||
          Boolean(
            candidate.albumName && INSTRUMENTAL_TITLE_OR_GENRE_REGEX.test(candidate.albumName)
          ) ||
          Boolean(candidate.genres?.some((genre) => INSTRUMENTAL_TITLE_OR_GENRE_REGEX.test(genre)))
        if (matchesInstrumental) {
          return false
        }
      }
    }

    // 2. Soundtrack Leakage Protection (album name, title tag, OR artist score-focused genres).
    if (!isSoundtrack) {
      const hasSoundtrackAlbum = Boolean(
        candidate.albumName && SOUNDTRACK_ALBUM_REGEX.test(candidate.albumName)
      )
      const hasSoundtrackTitle = Boolean(
        candidate.trackName && SOUNDTRACK_TITLE_REGEX.test(candidate.trackName)
      )
      const hasScoreFocusedGenres = Boolean(
        candidate.genres?.length &&
          candidate.genres.some((genre) => SOUNDTRACK_GENRE_REGEX.test(genre))
      )

      if (hasSoundtrackAlbum || hasSoundtrackTitle || hasScoreFocusedGenres) {
        const isDisneyOrVocalPopException =
          isVocal &&
          candidate.instrumentalness !== undefined &&
          candidate.instrumentalness < 0.2 &&
          candidate.popularity !== undefined &&
          candidate.popularity >= 60

        return isDisneyOrVocalPopException
      }
    }

    return true
  })
}

const hasAcousticFeatures = (profile: AcousticProfile | undefined): boolean => {
  if (!profile) return false
  const count = [
    profile.tempo,
    profile.energy,
    profile.valence,
    profile.danceability,
    profile.acousticness,
    profile.instrumentalness,
  ].filter((value) => typeof value === "number" && Number.isFinite(value)).length
  return count >= 2
}

/**
 * Filters the user's library/playlist `profilePool` so only tracks that genuinely
 * belong in the current seed's sonic, graph, and genre neighborhood enter the mix.
 */
export const filterProfilePoolForSeedCoherence = (
  profilePool: readonly TrackCandidate[],
  seed: SeedMetadata,
  similarPool: readonly TrackCandidate[]
): TrackCandidate[] => {
  if (profilePool.length === 0) return []

  const effectiveSeedGenres = expandSeedGenresFromGraph(seed, similarPool)
  const vocal = isVocalSeed(seed)
  const soundtrack = isSoundtrackSeed(seed, effectiveSeedGenres)

  const cleaned = filterSoundtracksAndInstrumentals(profilePool, vocal, soundtrack).filter(
    (candidate) =>
      candidate.uri !== seed.uri &&
      !hasDisqualifyingTitleMismatch(seed, candidate) &&
      !isSonicOutlier(seed, candidate)
  )

  if (cleaned.length === 0) return []

  const affiliatedArtists = new Set<string>()

  for (const neighbor of similarPool) {
    const neighborCompat = scoreGenreCompatibility(effectiveSeedGenres, neighbor.genres)
    if (neighborCompat !== null && neighborCompat < 0.28) continue
    const key = artistIdentity(neighbor)
    if (key) affiliatedArtists.add(key)
    if (neighbor.artistName) affiliatedArtists.add(normalizeText(neighbor.artistName))
  }

  const hasGenreSignal = effectiveSeedGenres.length > 0
  const hasAcousticSignal = hasAcousticFeatures(seed)
  const hasNeighborhoodSignal = affiliatedArtists.size >= 2

  // Total offline/metadata-blackout fallback: preserve cleaned library tracks only when
  // we have zero genre, acoustic, or neighborhood signals to discriminate with.
  if (!hasGenreSignal && !hasAcousticSignal && !hasNeighborhoodSignal) {
    return cleaned
  }

  // Identify user playlists whose sampled tracks co-occur with the seed's artist/genre world.
  const playlistStats = new Map<
    string,
    { total: number; matchingArtists: Set<string>; matchingCount: number }
  >()
  for (const candidate of cleaned) {
    const playlistTags = getSourceProvenance(candidate).filter((source) =>
      source.startsWith("profile-playlist:")
    )
    if (playlistTags.length === 0) continue
    const cArtist = artistIdentity(candidate)
    const cName = candidate.artistName ? normalizeText(candidate.artistName) : ""
    const isAffiliated =
      (cArtist && affiliatedArtists.has(cArtist)) || (cName && affiliatedArtists.has(cName))
    const compat = scoreGenreCompatibility(effectiveSeedGenres, candidate.genres)
    const isGenreMatch = compat !== null && compat >= 0.5

    for (const tag of playlistTags) {
      const stats = playlistStats.get(tag) ?? {
        total: 0,
        matchingArtists: new Set<string>(),
        matchingCount: 0,
      }
      stats.total += 1
      if (isAffiliated || isGenreMatch) {
        stats.matchingCount += 1
        if (cArtist || cName) stats.matchingArtists.add(cArtist || cName)
      }
      playlistStats.set(tag, stats)
    }
  }

  const coherentPlaylists = new Set<string>()
  for (const [tag, stats] of playlistStats.entries()) {
    if (
      stats.matchingArtists.size >= 2 &&
      stats.total > 0 &&
      stats.matchingCount / stats.total >= 0.25
    ) {
      coherentPlaylists.add(tag)
    }
  }

  const filtered = cleaned.filter((candidate) => {
    const genreCompat = scoreGenreCompatibility(effectiveSeedGenres, candidate.genres)
    // Hard veto on known genre clash, even if the track came from a mixed playlist.
    if (genreCompat !== null && genreCompat < 0.28) return false

    const cArtist = artistIdentity(candidate)
    const cName = candidate.artistName ? normalizeText(candidate.artistName) : ""
    if ((cArtist && affiliatedArtists.has(cArtist)) || (cName && affiliatedArtists.has(cName))) {
      return true
    }

    if (genreCompat !== null && genreCompat >= 0.45) {
      return true
    }

    const acousticDist = acousticDistanceV2(seed, candidate)
    if (
      acousticDist !== null &&
      acousticDist <= 0.24 &&
      (genreCompat === null || genreCompat >= 0.35)
    ) {
      return true
    }

    const inCoherentPlaylist = getSourceProvenance(candidate).some((source) =>
      coherentPlaylists.has(source)
    )
    if (inCoherentPlaylist && (genreCompat === null || genreCompat >= 0.35)) {
      return true
    }

    return false
  })

  const artistCounts = new Map<string, number>()
  const capped: TrackCandidate[] = []
  for (const candidate of filtered) {
    const key =
      artistIdentity(candidate) ||
      (candidate.artistName ? normalizeText(candidate.artistName) : candidate.uri)
    const count = artistCounts.get(key) ?? 0
    if (count < 2) {
      artistCounts.set(key, count + 1)
      capped.push(candidate)
    }
  }

  return capped
}
