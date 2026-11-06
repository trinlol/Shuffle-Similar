import { canonicalKeysForTrack } from "../algorithm/rankingV2"
import type { TrackCandidate } from "../session/types"

export const EXPOSURE_LEDGER_STORAGE_KEY = "shuffleSimilar:exposureLedger:v1"

export type ExposureOutcomeType =
  | "queued"
  | "substantial-play"
  | "completion"
  | "played"
  | "early-skip"

export type ExposureRecord = {
  key: string
  score: number
  updatedAt: number
  plays: number
  impressions: number
  skips: number
}

export type ExposureLedgerState = {
  tracks: Record<string, ExposureRecord>
  artists: Record<string, ExposureRecord>
}

const MAX_TRACK_KEYS = 400
const MAX_ARTIST_KEYS = 300
const MAX_STORED_BYTES = 256 * 1024

const TRACK_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1_000 // 72 hours
const ARTIST_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1_000 // 7 days

const TRACK_DELTAS: Record<ExposureOutcomeType, number> = {
  queued: 0.25,
  "substantial-play": 0.7,
  completion: 1.0,
  played: 1.0,
  "early-skip": 1.5,
}

const ARTIST_DELTAS: Record<ExposureOutcomeType, number> = {
  queued: 0.18,
  "substantial-play": 0.55,
  completion: 0.8,
  played: 0.8,
  "early-skip": 1.85,
}

let currentAccountKey: string | null = null
let cachedLedger: {
  storageKey: string
  raw: string
  state: ExposureLedgerState
} | null = null

export const setExposureLedgerAccountKey = (accountId: string | null): void => {
  currentAccountKey = accountId
}

const getExposureStorageKey = (): string => {
  if (currentAccountKey) {
    return `${EXPOSURE_LEDGER_STORAGE_KEY}:account:${currentAccountKey}`
  }
  return EXPOSURE_LEDGER_STORAGE_KEY
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const normalizeArtistUriKey = (uri: string): string => uri.trim().toLowerCase()

export const normalizeArtistNameKey = (name: string): string =>
  `name:${name.trim().toLowerCase().replace(/\s+/g, " ")}`

const getDecayedRecordScore = (
  record: ExposureRecord | undefined,
  halfLifeMs: number,
  now: number
): number => {
  if (!record || record.score <= 0) return 0
  const elapsed = Math.max(0, now - record.updatedAt)
  return record.score * 0.5 ** (elapsed / halfLifeMs)
}

const getLocalStorage = (): {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
} | null => {
  try {
    const spicetify = (
      globalThis as unknown as {
        Spicetify?: {
          LocalStorage?: {
            get: (key: string) => string | null
            set: (key: string, value: string) => void
            remove: (key: string) => void
          }
        }
      }
    ).Spicetify
    const storage = spicetify?.LocalStorage
    if (
      storage &&
      typeof storage.get === "function" &&
      typeof storage.set === "function" &&
      typeof storage.remove === "function"
    ) {
      return storage
    }
  } catch {
    // Ignore runtime lookup failures.
  }
  return null
}

const loadLedger = (): ExposureLedgerState => {
  const storage = getLocalStorage()
  if (!storage) return { tracks: {}, artists: {} }
  try {
    const storageKey = getExposureStorageKey()
    const raw = storage.get(storageKey)
    if (!raw) {
      cachedLedger = null
      return { tracks: {}, artists: {} }
    }
    if (cachedLedger && cachedLedger.storageKey === storageKey && cachedLedger.raw === raw) {
      return {
        tracks: { ...cachedLedger.state.tracks },
        artists: { ...cachedLedger.state.artists },
      }
    }
    const parsed = JSON.parse(raw) as Partial<ExposureLedgerState>
    const tracks: Record<string, ExposureRecord> = {}
    const artists: Record<string, ExposureRecord> = {}

    if (parsed && typeof parsed === "object") {
      if (parsed.tracks && typeof parsed.tracks === "object") {
        for (const [key, value] of Object.entries(parsed.tracks)) {
          if (
            value &&
            typeof value.score === "number" &&
            Number.isFinite(value.score) &&
            typeof value.updatedAt === "number"
          ) {
            tracks[key] = {
              key: value.key || key,
              score: value.score,
              updatedAt: value.updatedAt,
              plays: typeof value.plays === "number" ? value.plays : 0,
              impressions: typeof value.impressions === "number" ? value.impressions : 0,
              skips: typeof value.skips === "number" ? value.skips : 0,
            }
          }
        }
      }
      if (parsed.artists && typeof parsed.artists === "object") {
        for (const [key, value] of Object.entries(parsed.artists)) {
          if (
            value &&
            typeof value.score === "number" &&
            Number.isFinite(value.score) &&
            typeof value.updatedAt === "number"
          ) {
            artists[key] = {
              key: value.key || key,
              score: value.score,
              updatedAt: value.updatedAt,
              plays: typeof value.plays === "number" ? value.plays : 0,
              impressions: typeof value.impressions === "number" ? value.impressions : 0,
              skips: typeof value.skips === "number" ? value.skips : 0,
            }
          }
        }
      }
    }
    cachedLedger = {
      storageKey,
      raw,
      state: {
        tracks: { ...tracks },
        artists: { ...artists },
      },
    }
    return { tracks, artists }
  } catch {
    return { tracks: {}, artists: {} }
  }
}

const pruneLedger = (
  ledger: ExposureLedgerState,
  now: number
): { state: ExposureLedgerState; serialized: string } => {
  const trackEntries = Object.entries(ledger.tracks)
  let tracks = ledger.tracks
  if (trackEntries.length > MAX_TRACK_KEYS) {
    const scored = trackEntries
      .map(([key, record]) => ({
        key,
        record,
        decayed: getDecayedRecordScore(record, TRACK_HALF_LIFE_MS, now),
      }))
      .sort((a, b) => b.decayed - a.decayed || b.record.updatedAt - a.record.updatedAt)
      .slice(0, MAX_TRACK_KEYS)

    tracks = {}
    for (const entry of scored) {
      tracks[entry.key] = entry.record
    }
  }

  const artistEntries = Object.entries(ledger.artists)
  let artists = ledger.artists
  if (artistEntries.length > MAX_ARTIST_KEYS) {
    const scored = artistEntries
      .map(([key, record]) => ({
        key,
        record,
        decayed: getDecayedRecordScore(record, ARTIST_HALF_LIFE_MS, now),
      }))
      .sort((a, b) => b.decayed - a.decayed || b.record.updatedAt - a.record.updatedAt)
      .slice(0, MAX_ARTIST_KEYS)

    artists = {}
    for (const entry of scored) {
      artists[entry.key] = entry.record
    }
  }

  let result: ExposureLedgerState = { tracks, artists }
  let serialized = JSON.stringify(result)
  while (serialized.length > MAX_STORED_BYTES) {
    const remainingTracks = Object.entries(result.tracks)
    const remainingArtists = Object.entries(result.artists)
    if (remainingTracks.length === 0 && remainingArtists.length === 0) break

    // Drop the lowest decayed score entries from both tracks and artists
    const prunedTracks: Record<string, ExposureRecord> = {}
    remainingTracks
      .map(([key, record]) => ({
        key,
        record,
        decayed: getDecayedRecordScore(record, TRACK_HALF_LIFE_MS, now),
      }))
      .sort((a, b) => b.decayed - a.decayed)
      .slice(0, Math.max(1, Math.floor(remainingTracks.length * 0.8)))
      .forEach((entry) => {
        prunedTracks[entry.key] = entry.record
      })

    const prunedArtists: Record<string, ExposureRecord> = {}
    remainingArtists
      .map(([key, record]) => ({
        key,
        record,
        decayed: getDecayedRecordScore(record, ARTIST_HALF_LIFE_MS, now),
      }))
      .sort((a, b) => b.decayed - a.decayed)
      .slice(0, Math.max(1, Math.floor(remainingArtists.length * 0.8)))
      .forEach((entry) => {
        prunedArtists[entry.key] = entry.record
      })

    result = { tracks: prunedTracks, artists: prunedArtists }
    serialized = JSON.stringify(result)
  }

  return { state: result, serialized }
}

const saveLedger = (ledger: ExposureLedgerState, now: number): void => {
  const storage = getLocalStorage()
  if (!storage) return
  try {
    const storageKey = getExposureStorageKey()
    const { state: prunedState, serialized } = pruneLedger(ledger, now)
    storage.set(storageKey, serialized)
    cachedLedger = {
      storageKey,
      raw: serialized,
      state: {
        tracks: { ...prunedState.tracks },
        artists: { ...prunedState.artists },
      },
    }
  } catch {
    // LocalStorage write may fail (quota exceeded, disabled, etc.)
  }
}

export const clearExposureLedger = (): void => {
  cachedLedger = null
  const storage = getLocalStorage()
  if (!storage) return
  try {
    storage.remove(getExposureStorageKey())
  } catch {
    // Ignore error
  }
}

export const recordBatchExposure = (
  tracks: ReadonlyArray<
    Pick<TrackCandidate, "uri"> &
      Partial<Pick<TrackCandidate, "trackName" | "artistUri" | "artistName">>
  >,
  outcome: ExposureOutcomeType,
  now = Date.now()
): void => {
  if (tracks.length === 0) return

  const ledger = loadLedger()
  const trackDelta = TRACK_DELTAS[outcome] ?? 0
  const artistDelta = ARTIST_DELTAS[outcome] ?? 0

  const isPlay = outcome === "played" || outcome === "substantial-play" || outcome === "completion"
  const isSkip = outcome === "early-skip"
  const isImpression = outcome === "queued"

  for (const track of tracks) {
    if (!track.uri) continue

    const trackKeys = new Set<string>()
    trackKeys.add(track.uri.trim())
    const canonical = canonicalKeysForTrack(track)
    for (const key of canonical) trackKeys.add(key)

    for (const key of trackKeys) {
      const existing = ledger.tracks[key]
      const decayed = getDecayedRecordScore(existing, TRACK_HALF_LIFE_MS, now)
      ledger.tracks[key] = {
        key,
        score: decayed + trackDelta,
        updatedAt: now,
        plays: (existing?.plays ?? 0) + (isPlay ? 1 : 0),
        impressions: (existing?.impressions ?? 0) + (isImpression ? 1 : 0),
        skips: (existing?.skips ?? 0) + (isSkip ? 1 : 0),
      }
    }

    const artistKeys = new Set<string>()
    if (track.artistUri) {
      artistKeys.add(normalizeArtistUriKey(track.artistUri))
    }
    if (track.artistName) {
      artistKeys.add(normalizeArtistNameKey(track.artistName))
    }

    for (const key of artistKeys) {
      const existing = ledger.artists[key]
      const decayed = getDecayedRecordScore(existing, ARTIST_HALF_LIFE_MS, now)
      ledger.artists[key] = {
        key,
        score: decayed + artistDelta,
        updatedAt: now,
        plays: (existing?.plays ?? 0) + (isPlay ? 1 : 0),
        impressions: (existing?.impressions ?? 0) + (isImpression ? 1 : 0),
        skips: (existing?.skips ?? 0) + (isSkip ? 1 : 0),
      }
    }
  }

  saveLedger(ledger, now)
}

export const computeExposureMultipliers = (
  candidates: ReadonlyArray<Pick<TrackCandidate, "uri" | "trackName" | "artistUri" | "artistName">>,
  now = Date.now()
): Map<string, number> => {
  const result = new Map<string, number>()
  if (candidates.length === 0) return result

  const ledger = loadLedger()

  for (const candidate of candidates) {
    if (!candidate.uri) continue

    // Track exposure
    const trackKeys = [candidate.uri.trim(), ...canonicalKeysForTrack(candidate)]
    let maxTrackExposure = 0
    for (const key of trackKeys) {
      const record = ledger.tracks[key]
      if (record) {
        const decayed = getDecayedRecordScore(record, TRACK_HALF_LIFE_MS, now)
        if (decayed > maxTrackExposure) maxTrackExposure = decayed
      }
    }

    // Artist exposure
    const artistKeys: string[] = []
    if (candidate.artistUri) {
      artistKeys.push(normalizeArtistUriKey(candidate.artistUri))
    }
    if (candidate.artistName) {
      artistKeys.push(normalizeArtistNameKey(candidate.artistName))
    }

    let maxArtistExposure = 0
    for (const key of artistKeys) {
      const record = ledger.artists[key]
      if (record) {
        const decayed = getDecayedRecordScore(record, ARTIST_HALF_LIFE_MS, now)
        if (decayed > maxArtistExposure) maxArtistExposure = decayed
      }
    }

    const mTrack = clamp(Math.exp(-0.8 * maxTrackExposure), 0.08, 1.0)
    const mArtist = clamp(Math.exp(-0.55 * maxArtistExposure), 0.12, 1.0)
    const multiplier = clamp(mTrack * mArtist, 0.05, 1.0)

    result.set(candidate.uri, multiplier)
  }

  return result
}
