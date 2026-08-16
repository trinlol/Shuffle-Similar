import type { SeedMetadata, TrackCandidate } from "../session/types"
import type { SmartConfig } from "../storage/settings"
import { dedupeCandidates, excludeArtist, filterPlayableCandidates } from "./filters"
import { planRecommendationBatchV2 } from "./recommendationPlannerV2"

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
  count: number,
  familiarUris: readonly string[] = sessionPlayedUris,
  referenceTracks: TrackCandidate[] = [],
  discoveryHistory: readonly boolean[] = []
): TrackCandidate[] => {
  const excludeEarlyArtist = settings.excludeSeedArtistEarly && position <= 4
  const profileIsSeedDiscography = profilePool.length > 0 && profilePool.every((candidate) =>
    candidate.artistUri === seed.artistUri || candidate.artistName === seed.artistName
  )

  let similar = dedupeCandidates(filterPlayableCandidates(similarPool))
  let profile = dedupeCandidates(filterPlayableCandidates(profilePool))

  if (excludeEarlyArtist) {
    similar = excludeArtist(similar, seed.artistUri, seed.artistName)
    if (!profileIsSeedDiscography) {
      profile = excludeArtist(profile, seed.artistUri, seed.artistName)
    }
  }

  return planRecommendationBatchV2({
    mode: profileIsSeedDiscography ? "artist" : "track",
    seed,
    pools: [
      { candidates: similar, source: "similar-discovery", family: "similar", weight: 1 },
      { candidates: profile, source: "profile-library", family: "profile", weight: 0.9 },
    ],
    excludedUris: sessionPlayedUris,
    queueTailUris: sessionPlayedUris,
    familiarUris: new Set(familiarUris),
    referenceTracks,
    discoveryHistory,
    settings,
    count,
    absoluteStartPosition: position,
  })
}

export const buildSinglePoolBatch = (
  seed: SeedMetadata | null,
  pool: TrackCandidate[],
  sessionPlayedUris: string[],
  settings: SmartConfig,
  count: number,
  absoluteStartPosition = 0
): TrackCandidate[] => {
  const playedSet = new Set(sessionPlayedUris)
  let eligiblePool = filterPlayableCandidates(pool).filter((track) => !playedSet.has(track.uri))

  if (eligiblePool.length === 0) {
    // If everything has been played, reset playedSet (except very recent history) to allow repeating
    const recentHistory = sessionPlayedUris.slice(-settings.historyPenaltyWindow)
    playedSet.clear()
    recentHistory.forEach((uri) => playedSet.add(uri))
    eligiblePool = filterPlayableCandidates(pool).filter((track) => !playedSet.has(track.uri))
  }

  return planRecommendationBatchV2({
    mode: "single",
    seed,
    pools: [{ candidates: filterPlayableCandidates(pool), source: "single-pool", family: "profile", weight: 1 }],
    excludedUris: [...playedSet],
    queueTailUris: sessionPlayedUris,
    familiarUris: new Set(sessionPlayedUris),
    settings,
    count,
    absoluteStartPosition,
  })
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
  count: number,
  absoluteStartPosition = 0,
  mode: "playlist" | "album" = "playlist",
  discoveryHistory: readonly boolean[] = []
): TrackCandidate[] => {
  const playlistUris = new Set(playlistTracks.map((track) => track.uri))
  const playedUris = new Set(sessionPlayedUris)
  const playableCandidates = dedupeCandidates(filterPlayableCandidates(candidatePool))
  let eligible = playableCandidates.filter(
    (candidate) => !playlistUris.has(candidate.uri) && !playedUris.has(candidate.uri)
  )
  let excludedHistory: ReadonlySet<string> = playedUris

  if (eligible.length === 0) {
    const recent = new Set(sessionPlayedUris.slice(-settings.historyPenaltyWindow))
    excludedHistory = recent
    eligible = playableCandidates.filter(
      (candidate) => !playlistUris.has(candidate.uri) && !recent.has(candidate.uri)
    )
  }

  return planRecommendationBatchV2({
    mode,
    seed: null,
    pools: [{ candidates: playableCandidates, source: "playlist-discovery", family: "similar", weight: 1 }],
    referenceTracks: playlistTracks,
    excludedUris: [...playlistUris, ...excludedHistory],
    queueTailUris: sessionPlayedUris,
    topTrackUris: new Set(topTrackUris),
    familiarUris: new Set([...playlistUris, ...topTrackUris, ...sessionPlayedUris]),
    discoveryHistory,
    settings: { ...settings, deprioritizePopular: true },
    count,
    absoluteStartPosition,
  })
}
