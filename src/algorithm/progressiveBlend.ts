import type { BlendPhase, SeedMetadata, TrackCandidate } from "../session/types"
import type { SmartConfig } from "../storage/settings"
import {
  computeHistoryWeights,
  dedupeCandidates,
  excludeArtist,
  filterPlayableCandidates,
  getRecentKeys,
  pickFromPool,
} from "./filters"
import { softShuffle } from "./shuffle"

export const getBlendWeights = (position: number, settings: SmartConfig) => {
  const phases = settings.blendPhases
  const phase = phases.find((entry) => position <= entry.maxPosition) ?? phases[phases.length - 1]
  return {
    similarWeight: phase.similarWeight,
    profileWeight: phase.profileWeight,
  }
}

export const buildTrackBatch = (
  seed: SeedMetadata,
  position: number,
  sessionPlayedUris: string[],
  similarPool: TrackCandidate[],
  profilePool: TrackCandidate[],
  settings: SmartConfig,
  count: number
): TrackCandidate[] => {
  const { similarWeight, profileWeight } = getBlendWeights(position, settings)
  const playedSet = new Set(sessionPlayedUris)
  const excludeEarlyArtist = settings.excludeSeedArtistEarly && position <= 4

  let similar = dedupeCandidates(filterPlayableCandidates(similarPool)).filter(
    (candidate) => !playedSet.has(candidate.uri)
  )
  let profile = dedupeCandidates(filterPlayableCandidates(profilePool)).filter(
    (candidate) => !playedSet.has(candidate.uri)
  )

  if (excludeEarlyArtist) {
    similar = excludeArtist(similar, seed.artistUri, seed.artistName)
    profile = excludeArtist(profile, seed.artistUri, seed.artistName)
  }

  // Compute graduated history weights for both pools
  const similarHistoryWeights = computeHistoryWeights(similar, sessionPlayedUris, settings.historyPenaltyWindow)
  const profileHistoryWeights = computeHistoryWeights(profile, sessionPlayedUris, settings.historyPenaltyWindow)

  const selected: TrackCandidate[] = []
  const recentPlayed: TrackCandidate[] = []
  // Cross-pool dedup set: prevents picking the same URI from both pools
  const pickedSet = new Set<string>()
  const albumSpacing = 2

  while (selected.length < count && (similar.length > 0 || profile.length > 0)) {
    const recentKeys = getRecentKeys(recentPlayed, settings.artistSpacing)
    const useSimilar =
      similar.length > 0 &&
      (profile.length === 0 || Math.random() < similarWeight / (similarWeight + profileWeight))

    const pool = useSimilar ? similar : profile
    const favorObscure = settings.deprioritizePopular
    const historyWeights = useSimilar ? similarHistoryWeights : profileHistoryWeights

    const picked = pickFromPool(pool, {
      recentKeys,
      artistSpacing: settings.artistSpacing,
      albumSpacing,
      favorObscure,
      historyWeights,
      seedYear: seed.releaseYear,
      eraWindow: settings.eraWindow,
    })

    if (!picked) break

    selected.push(picked)
    recentPlayed.push(picked)
    playedSet.add(picked.uri)
    pickedSet.add(picked.uri)

    // Remove from the source pool
    if (useSimilar) {
      similar = similar.filter((candidate) => candidate.uri !== picked.uri)
    } else {
      profile = profile.filter((candidate) => candidate.uri !== picked.uri)
    }

    // Cross-pool dedup: also remove from the other pool
    if (useSimilar) {
      profile = profile.filter((candidate) => candidate.uri !== picked.uri)
    } else {
      similar = similar.filter((candidate) => candidate.uri !== picked.uri)
    }
  }

  // Soft shuffle preserves the deliberate ordering (spacing, era affinity)
  // while introducing enough jitter (±3 positions) to feel unpredictable
  return softShuffle(selected, 3)
}

export const buildSinglePoolBatch = (
  seed: SeedMetadata | null,
  pool: TrackCandidate[],
  sessionPlayedUris: string[],
  settings: SmartConfig,
  count: number
): TrackCandidate[] => {
  const playedSet = new Set(sessionPlayedUris)
  let eligiblePool = pool.filter((track) => !playedSet.has(track.uri))

  if (eligiblePool.length === 0) {
    // If everything has been played, reset playedSet (except very recent history) to allow repeating
    const recentHistory = sessionPlayedUris.slice(-settings.historyPenaltyWindow)
    playedSet.clear()
    recentHistory.forEach((uri) => playedSet.add(uri))
    eligiblePool = pool.filter((track) => !playedSet.has(track.uri))
  }

  const historyWeights = computeHistoryWeights(eligiblePool, sessionPlayedUris, settings.historyPenaltyWindow)

  const selected: TrackCandidate[] = []
  const recentPlayed: TrackCandidate[] = []
  const albumSpacing = 2

  while (selected.length < count && eligiblePool.length > 0) {
    const recentKeys = getRecentKeys(recentPlayed, settings.artistSpacing)
    const favorObscure = settings.deprioritizePopular

    const picked = pickFromPool(eligiblePool, {
      recentKeys,
      artistSpacing: settings.artistSpacing,
      albumSpacing,
      favorObscure,
      historyWeights,
      seedYear: seed?.releaseYear,
      eraWindow: settings.eraWindow,
    })

    if (!picked) {
      // If spacing constraints are too tight and we can't pick, pick without spacing
      const fallbackPicked = pickFromPool(eligiblePool, {
        recentKeys: { artists: [], albums: [] },
        artistSpacing: 0,
        albumSpacing: 0,
        favorObscure,
        historyWeights,
        seedYear: seed?.releaseYear,
        eraWindow: settings.eraWindow,
      })
      if (!fallbackPicked) break
      selected.push(fallbackPicked)
      recentPlayed.push(fallbackPicked)
      playedSet.add(fallbackPicked.uri)
      eligiblePool = eligiblePool.filter((track) => track.uri !== fallbackPicked.uri)
    } else {
      selected.push(picked)
      recentPlayed.push(picked)
      playedSet.add(picked.uri)
      eligiblePool = eligiblePool.filter((track) => track.uri !== picked.uri)
    }
  }

  return softShuffle(selected, 3)
}
