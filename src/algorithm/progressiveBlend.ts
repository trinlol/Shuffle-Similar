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
  const albumSpacing = 2

  while (selected.length < count && (similar.length > 0 || profile.length > 0)) {
    const recentKeys = getRecentKeys(recentPlayed, settings.artistSpacing)
    const useSimilar =
      similar.length > 0 &&
      (profile.length === 0 || Math.random() < similarWeight / Math.max(0.0001, similarWeight + profileWeight))

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
      seedProfile: seed,
      skipFeedback: settings.skipFeedback,
    })

    if (!picked) break

    selected.push(picked)
    recentPlayed.push(picked)
    playedSet.add(picked.uri)

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

  // Selection is already random; preserve this constraint-safe ordering.
  return selected
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
      seedProfile: seed ?? undefined,
      skipFeedback: settings.skipFeedback,
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
        seedProfile: seed ?? undefined,
        skipFeedback: settings.skipFeedback,
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

  return selected
}

/**
 * Playlist mode: all playlist tracks are references, while only tracks outside
 * the playlist are eligible outputs. This keeps the playlist's full sound
 * profile in play without simply replaying its contents.
 */
export const buildPlaylistBatch = (
  playlistTracks: TrackCandidate[],
  candidatePool: TrackCandidate[],
  sessionPlayedUris: string[],
  topTrackUris: string[],
  settings: SmartConfig,
  count: number
): TrackCandidate[] => {
  const playlistUris = new Set(playlistTracks.map((track) => track.uri))
  const playedUris = new Set(sessionPlayedUris)
  let eligible = dedupeCandidates(filterPlayableCandidates(candidatePool)).filter(
    (candidate) => !playlistUris.has(candidate.uri) && !playedUris.has(candidate.uri)
  )

  if (eligible.length === 0) {
    const recent = new Set(sessionPlayedUris.slice(-settings.historyPenaltyWindow))
    eligible = dedupeCandidates(filterPlayableCandidates(candidatePool)).filter(
      (candidate) => !playlistUris.has(candidate.uri) && !recent.has(candidate.uri)
    )
  }

  const historyWeights = computeHistoryWeights(eligible, sessionPlayedUris, settings.historyPenaltyWindow)
  const topTracks = new Set(topTrackUris)
  const selected: TrackCandidate[] = []
  const recentPlayed: TrackCandidate[] = []

  while (selected.length < count && eligible.length > 0) {
    const picked = pickFromPool(eligible, {
      recentKeys: getRecentKeys(recentPlayed, settings.artistSpacing),
      artistSpacing: settings.artistSpacing,
      albumSpacing: 2,
      favorObscure: true,
      historyWeights,
      playlistProfiles: playlistTracks,
      topTrackUris: topTracks,
      skipFeedback: settings.skipFeedback,
    })
    if (!picked) break
    selected.push(picked)
    recentPlayed.push(picked)
    eligible = eligible.filter((candidate) => candidate.uri !== picked.uri)
  }

  return selected
}
