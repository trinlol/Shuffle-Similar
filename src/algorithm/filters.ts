import type { TrackCandidate } from "../session/types"
import { loadPlayHistory } from "../storage/settings"
import { pickWeightedRandom, popularityWeight } from "./shuffle"

export const dedupeCandidates = (candidates: TrackCandidate[]): TrackCandidate[] => {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.uri)) return false
    seen.add(candidate.uri)
    return true
  })
}

export const filterPlayableCandidates = (candidates: TrackCandidate[]): TrackCandidate[] => {
  return candidates.filter((candidate) => Boolean(candidate.uri?.startsWith("spotify:track:")))
}

export const excludeArtist = (
  candidates: TrackCandidate[],
  artistUri?: string,
  artistName?: string
): TrackCandidate[] => {
  if (!artistUri && !artistName) return candidates
  return candidates.filter((candidate) => {
    if (artistUri && candidate.artistUri === artistUri) return false
    if (artistName && candidate.artistName === artistName) return false
    return true
  })
}

/**
 * Graduated history penalty.  Instead of a binary fresh/stale split,
 * every candidate receives a decay-based weight multiplier.
 * Recently played tracks get exponentially lower weight rather than
 * being entirely excluded, so they *can* still appear when the pool
 * is thin but are strongly deprioritised.
 *
 * Returns candidates annotated with a `_historyWeight` that
 * pickFromPool will fold into its weighted selection.
 */
export const computeHistoryWeights = (
  candidates: TrackCandidate[],
  sessionPlayed: string[],
  historyWindow: number
): Map<string, number> => {
  const recentHistory = [...sessionPlayed, ...loadPlayHistory().slice(0, historyWindow)]

  // Build a position map — lower index = more recently played
  const positionMap = new Map<string, number>()
  for (let i = 0; i < recentHistory.length; i += 1) {
    if (!positionMap.has(recentHistory[i])) {
      positionMap.set(recentHistory[i], i)
    }
  }

  const weights = new Map<string, number>()
  for (const candidate of candidates) {
    const position = positionMap.get(candidate.uri)
    if (position === undefined) {
      // Never played — full weight
      weights.set(candidate.uri, 1.0)
    } else {
      // Exponential decay: very recently played ≈ 0.05, old plays ≈ 0.8+
      const decay = Math.min(1.0, 0.05 + 0.95 * (1 - Math.exp(-position / 30)))
      weights.set(candidate.uri, decay)
    }
  }

  return weights
}

/**
 * Legacy filter kept for backward-compat during the transition.
 * Prefers fresh candidates but falls back to stale when pool is empty.
 */
export const applyHistoryPenalty = (
  candidates: TrackCandidate[],
  sessionPlayed: string[],
  historyWindow: number
): TrackCandidate[] => {
  const history = new Set([...sessionPlayed, ...loadPlayHistory().slice(0, historyWindow)])
  const fresh: TrackCandidate[] = []
  const stale: TrackCandidate[] = []

  for (const candidate of candidates) {
    if (history.has(candidate.uri)) stale.push(candidate)
    else fresh.push(candidate)
  }

  return fresh.length > 0 ? fresh : stale
}

export const sortByObscurity = (candidates: TrackCandidate[]): TrackCandidate[] => {
  return [...candidates].sort((a, b) => (a.popularity ?? 50) - (b.popularity ?? 50))
}

// ── Spacing helpers ─────────────────────────────────────────────────

export const respectsArtistSpacing = (
  candidate: TrackCandidate,
  recentArtists: string[],
  spacing: number
): boolean => {
  if (!candidate.artistUri && !candidate.artistName) return true
  const key = candidate.artistUri ?? candidate.artistName ?? ""
  return !recentArtists.slice(-spacing).includes(key)
}

/**
 * Prevents tracks from the same album appearing within `spacing`
 * positions of each other.
 */
export const respectsAlbumSpacing = (
  candidate: TrackCandidate,
  recentAlbums: string[],
  spacing: number
): boolean => {
  if (!candidate.albumUri) return true
  return !recentAlbums.slice(-spacing).includes(candidate.albumUri)
}

export type RecentKeys = {
  artists: string[]
  albums: string[]
}

export const getRecentKeys = (played: TrackCandidate[], spacing: number): RecentKeys => {
  const recent = played.slice(-spacing)
  return {
    artists: recent
      .map((track) => track.artistUri ?? track.artistName ?? "")
      .filter(Boolean),
    albums: recent
      .map((track) => track.albumUri ?? "")
      .filter(Boolean),
  }
}

/** @deprecated Use getRecentKeys instead */
export const getRecentArtists = (played: TrackCandidate[], spacing: number): string[] => {
  return played
    .slice(-spacing)
    .map((track) => track.artistUri ?? track.artistName ?? "")
    .filter(Boolean)
}

// ── Picking ─────────────────────────────────────────────────────────

/**
 * Era affinity bonus: gives a small weight boost to tracks whose
 * release year is close to the seed's release year.
 */
const eraAffinityWeight = (
  candidate: TrackCandidate,
  seedYear: number | undefined,
  eraWindow: number
): number => {
  if (seedYear == null || candidate.releaseYear == null) return 1.0
  const distance = Math.abs(candidate.releaseYear - seedYear)
  if (distance <= eraWindow) return 1.3
  if (distance <= eraWindow * 2) return 1.1
  return 1.0
}

export type PickFromPoolOptions = {
  recentKeys: RecentKeys
  artistSpacing: number
  albumSpacing: number
  favorObscure: boolean
  historyWeights?: Map<string, number>
  seedYear?: number
  eraWindow?: number
}

/**
 * Picks a single track from the pool using composite weighted selection.
 * Combines: popularity curve, graduated history penalty, era affinity,
 * artist spacing, and album spacing.
 */
export const pickFromPool = (
  pool: TrackCandidate[],
  options: PickFromPoolOptions
): TrackCandidate | null => {
  const { recentKeys, artistSpacing, albumSpacing, favorObscure, historyWeights, seedYear, eraWindow } = options

  // Filter for spacing — prefer candidates that respect both artist and album spacing
  const eligible = pool.filter(
    (candidate) =>
      respectsArtistSpacing(candidate, recentKeys.artists, artistSpacing) &&
      respectsAlbumSpacing(candidate, recentKeys.albums, albumSpacing)
  )

  // Fall back to artist-only spacing, then to full pool
  const artistOnly = eligible.length > 0
    ? eligible
    : pool.filter((candidate) => respectsArtistSpacing(candidate, recentKeys.artists, artistSpacing))
  const pickPool = artistOnly.length > 0 ? artistOnly : pool

  if (pickPool.length === 0) return null

  // Build composite weights
  const weights = pickPool.map((candidate) => {
    let weight = popularityWeight(candidate.popularity ?? 50, favorObscure)

    // Graduated history penalty
    if (historyWeights) {
      weight *= historyWeights.get(candidate.uri) ?? 1.0
    }

    // Era affinity bonus
    if (seedYear != null && eraWindow != null) {
      weight *= eraAffinityWeight(candidate, seedYear, eraWindow)
    }

    return Math.max(0.01, weight)
  })

  return pickWeightedRandom(pickPool, weights)
}
