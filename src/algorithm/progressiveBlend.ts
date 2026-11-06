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

export type BatchPlanningOptions = {
  recentHistoryUris?: readonly string[]
  excludedCanonicalKeys?: readonly string[]
  queueTailUris?: readonly string[]
  rngSeed?: string | number
  explorationBand?: number
  explorationTemperature?: number
  habitualArtistKeys?: ReadonlySet<string>
  recentArtistKeys?: readonly string[]
  topTrackUris?: ReadonlySet<string>
  exposureMultipliers?: ReadonlyMap<string, number>
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
  discoveryHistory: readonly boolean[] = [],
  planningOptions: BatchPlanningOptions = {}
): TrackCandidate[] => {
  const profileIsSeedDiscography =
    profilePool.length > 0 &&
    profilePool.every(
      (candidate) =>
        candidate.artistUri === seed.artistUri || candidate.artistName === seed.artistName
    )

  let similar = dedupeCandidates(filterPlayableCandidates(similarPool))
  let profile = dedupeCandidates(filterPlayableCandidates(profilePool))

  if (settings.excludeSeedArtistEarly && !profileIsSeedDiscography) {
    similar = excludeArtist(similar, seed.artistUri, seed.artistName)
    if (position <= 10) {
      profile = excludeArtist(profile, seed.artistUri, seed.artistName)
    } else {
      let seedArtistCount = 0
      profile = profile.filter((candidate) => {
        const isSeedArtist =
          Boolean(seed.artistUri && candidate.artistUri === seed.artistUri) ||
          Boolean(
            seed.artistName &&
              candidate.artistName?.trim().toLowerCase() === seed.artistName.trim().toLowerCase()
          )
        if (!isSeedArtist) return true
        if (seedArtistCount < 1) {
          seedArtistCount += 1
          return true
        }
        return false
      })
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
    excludedCanonicalKeys: planningOptions.excludedCanonicalKeys,
    queueTailUris: planningOptions.queueTailUris ?? sessionPlayedUris,
    recentHistoryUris: planningOptions.recentHistoryUris,
    habitualArtistKeys: planningOptions.habitualArtistKeys,
    recentArtistKeys: planningOptions.recentArtistKeys,
    topTrackUris: planningOptions.topTrackUris,
    exposureMultipliers: planningOptions.exposureMultipliers,
    familiarUris: new Set(familiarUris),
    referenceTracks,
    discoveryHistory,
    settings,
    count,
    absoluteStartPosition: position,
    rngSeed: planningOptions.rngSeed,
    explorationBand: planningOptions.explorationBand,
    explorationTemperature: planningOptions.explorationTemperature,
  })
}

export const buildSinglePoolBatch = (
  seed: SeedMetadata | null,
  pool: TrackCandidate[],
  sessionPlayedUris: string[],
  settings: SmartConfig,
  count: number,
  absoluteStartPosition = 0,
  planningOptions: BatchPlanningOptions = {}
): TrackCandidate[] => {
  const playedSet = new Set(sessionPlayedUris)
  let eligiblePool = filterPlayableCandidates(pool).filter((track) => !playedSet.has(track.uri))

  if (eligiblePool.length === 0) {
    // If everything has been played, reset playedSet (except very recent history) to allow repeating
    const recentHistory = sessionPlayedUris.slice(-settings.historyPenaltyWindow)
    playedSet.clear()
    for (const uri of recentHistory) playedSet.add(uri)
    eligiblePool = filterPlayableCandidates(pool).filter((track) => !playedSet.has(track.uri))
  }

  return planRecommendationBatchV2({
    mode: "single",
    seed,
    pools: [
      {
        candidates: filterPlayableCandidates(pool),
        source: "single-pool",
        family: "profile",
        weight: 1,
      },
    ],
    excludedUris: [...playedSet],
    excludedCanonicalKeys: planningOptions.excludedCanonicalKeys,
    queueTailUris: planningOptions.queueTailUris ?? sessionPlayedUris,
    recentHistoryUris: planningOptions.recentHistoryUris,
    habitualArtistKeys: planningOptions.habitualArtistKeys,
    recentArtistKeys: planningOptions.recentArtistKeys,
    topTrackUris: planningOptions.topTrackUris,
    exposureMultipliers: planningOptions.exposureMultipliers,
    familiarUris: new Set(sessionPlayedUris),
    settings,
    count,
    absoluteStartPosition,
    rngSeed: planningOptions.rngSeed,
    explorationBand: planningOptions.explorationBand,
    explorationTemperature: planningOptions.explorationTemperature,
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
  discoveryHistory: readonly boolean[] = [],
  planningOptions: BatchPlanningOptions = {}
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
    pools: [
      {
        candidates: playableCandidates,
        source: "playlist-discovery",
        family: "similar",
        weight: 1,
      },
    ],
    referenceTracks: playlistTracks,
    excludedUris: [...playlistUris, ...excludedHistory],
    excludedCanonicalKeys: planningOptions.excludedCanonicalKeys,
    queueTailUris: planningOptions.queueTailUris ?? sessionPlayedUris,
    recentHistoryUris: planningOptions.recentHistoryUris,
    habitualArtistKeys: planningOptions.habitualArtistKeys,
    recentArtistKeys: planningOptions.recentArtistKeys,
    exposureMultipliers: planningOptions.exposureMultipliers,
    topTrackUris: new Set([...topTrackUris, ...(planningOptions.topTrackUris ?? [])]),
    familiarUris: new Set([...playlistUris, ...topTrackUris, ...sessionPlayedUris]),
    discoveryHistory,
    settings: { ...settings, deprioritizePopular: true },
    count,
    absoluteStartPosition,
    rngSeed: planningOptions.rngSeed,
    explorationBand: planningOptions.explorationBand,
    explorationTemperature: planningOptions.explorationTemperature,
  })
}
