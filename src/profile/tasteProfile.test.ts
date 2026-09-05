import { describe, expect, it, vi } from "vitest"
import type { TrackCandidate } from "../session/types"
import {
  createEmptyTasteProfile,
  createSpicetifyLocalStorageAdapter,
  createTasteProfileStore,
  getTasteProfileConfidence,
  MAX_PROFILE_SIGNALS,
  recordExplicitTasteFeedback,
  recordPlaybackOutcome,
  scoreTasteAffinity,
  TASTE_PROFILE_SCHEMA_VERSION,
  TASTE_PROFILE_STORAGE_KEY,
  type TasteProfileStorage,
} from "./tasteProfile"

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 7, 3)

const candidate = (
  id: string,
  artist = id,
  acoustic: Partial<TrackCandidate> = {}
): TrackCandidate => ({
  uri: `spotify:track:${id}`,
  artistUri: `spotify:artist:${artist}`,
  tempo: 120,
  energy: 0.7,
  valence: 0.6,
  danceability: 0.65,
  acousticness: 0.2,
  instrumentalness: 0.05,
  ...acoustic,
})

const memoryStorage = (initial?: string): TasteProfileStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(TASTE_PROFILE_STORAGE_KEY, initial)
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  }
}

describe("taste profile persistence", () => {
  it("records explicit positive and negative outcomes in separate bounded signal channels", () => {
    let profile = createEmptyTasteProfile(NOW)
    profile = recordPlaybackOutcome(profile, {
      type: "completion",
      candidate: candidate("loved", "artist-loved"),
      genres: ["Indie Pop", "indie pop", "Alt Z"],
      occurredAt: NOW,
    })
    profile = recordPlaybackOutcome(profile, {
      type: "early-skip",
      candidate: candidate("skipped", "artist-skipped", { energy: 0.95 }),
      genres: ["Aggrotech"],
      occurredAt: NOW + 1,
    })

    expect(profile.version).toBe(TASTE_PROFILE_SCHEMA_VERSION)
    expect(profile.signals.tracks.map((signal) => signal.sentiment)).toEqual([1, -1])
    expect(profile.signals.artists.map((signal) => signal.key)).toEqual([
      "spotify:artist:artist-loved",
      "spotify:artist:artist-skipped",
    ])
    expect(profile.signals.genres.map((signal) => signal.key)).toEqual([
      "indie pop",
      "alt z",
      "aggrotech",
    ])
    expect(profile.signals.acousticPositive).toHaveLength(1)
    expect(profile.signals.acousticNegative).toHaveLength(1)
  })

  it("round-trips through injected storage and recovers safely from malformed data", () => {
    const storage = memoryStorage("{definitely-not-json")
    const store = createTasteProfileStore(storage)

    expect(store.load(NOW)).toEqual(createEmptyTasteProfile(NOW))
    expect(storage.values.has(TASTE_PROFILE_STORAGE_KEY)).toBe(false)

    const recorded = store.record({
      type: "substantial-play",
      candidate: candidate("played"),
      genres: ["Dream Pop"],
      occurredAt: NOW,
    })
    expect(JSON.parse(storage.values.get(TASTE_PROFILE_STORAGE_KEY) ?? "").version).toBe(
      TASTE_PROFILE_SCHEMA_VERSION
    )
    expect(store.load(NOW)).toEqual(recorded)
  })

  it("migrates a valid v1 event log and ignores unknown future schemas without throwing", () => {
    const v1 = JSON.stringify({
      version: 1,
      updatedAt: NOW,
      events: [
        {
          type: "completion",
          trackUri: "spotify:track:v1",
          artistUri: "spotify:artist:v1",
          genres: ["Synthwave"],
          acoustic: { tempo: 110, energy: 0.8, valence: 0.55 },
          occurredAt: NOW,
        },
      ],
    })
    const migrated = createTasteProfileStore(memoryStorage(v1)).load(NOW)
    expect(migrated.version).toBe(TASTE_PROFILE_SCHEMA_VERSION)
    expect(migrated.signals.tracks[0]).toMatchObject({
      key: "spotify:track:v1",
      sentiment: 1,
    })
    expect(migrated.signals.acousticPositive).toHaveLength(1)

    const futureStorage = memoryStorage(JSON.stringify({ version: 999, data: "leave me alone" }))
    expect(createTasteProfileStore(futureStorage).load(NOW)).toEqual(createEmptyTasteProfile(NOW))
    expect(futureStorage.values.has(TASTE_PROFILE_STORAGE_KEY)).toBe(true)
  })

  it("caps persisted state even under a long playback history", () => {
    let profile = createEmptyTasteProfile(NOW)
    for (let index = 0; index < 2_000; index += 1) {
      profile = recordPlaybackOutcome(profile, {
        type: index % 4 === 0 ? "early-skip" : "completion",
        candidate: candidate(String(index), String(index % 300)),
        genres: [`genre-${index % 100}`, `microgenre-${index}`],
        occurredAt: NOW + index,
      })
    }

    const signalCount =
      profile.signals.tracks.length +
      profile.signals.artists.length +
      profile.signals.genres.length +
      profile.signals.acousticPositive.length +
      profile.signals.acousticNegative.length
    expect(signalCount).toBeLessThanOrEqual(MAX_PROFILE_SIGNALS)
    expect(profile.signals.tracks[profile.signals.tracks.length - 1]?.key).toBe(
      "spotify:track:1999"
    )
  })

  it("wraps Spicetify.LocalStorage without coupling tests to the global", () => {
    const localStorage = {
      get: vi.fn(() => "stored"),
      set: vi.fn(),
      remove: vi.fn(),
    }
    const adapter = createSpicetifyLocalStorageAdapter(localStorage)

    expect(adapter.get("key")).toBe("stored")
    adapter.set("key", "value")
    adapter.remove("key")
    expect(localStorage.set).toHaveBeenCalledWith("key", "value")
    expect(localStorage.remove).toHaveBeenCalledWith("key")
  })
})

describe("taste affinity scoring", () => {
  const readyPositiveProfile = () => {
    let profile = createEmptyTasteProfile(NOW)
    for (const [index, genre] of ["indie pop", "dream pop", "alt z", "indietronica"].entries()) {
      profile = recordPlaybackOutcome(profile, {
        type: "completion",
        candidate: candidate(`positive-${index}`, "favored-artist", {
          tempo: 118 + index,
          energy: 0.68,
        }),
        genres: [genre],
        occurredAt: NOW - index * DAY,
      })
    }
    return profile
  }

  it("gates learned ranking during cold start", () => {
    let profile = createEmptyTasteProfile(NOW)
    for (let index = 0; index < 2; index += 1) {
      profile = recordPlaybackOutcome(profile, {
        type: "completion",
        candidate: candidate(`early-${index}`, "favored-artist"),
        genres: ["indie pop"],
        occurredAt: NOW,
      })
    }

    expect(getTasteProfileConfidence(profile, NOW).ready).toBe(false)
    expect(
      scoreTasteAffinity(candidate("new", "favored-artist"), profile, {
        genres: ["indie pop"],
        now: NOW,
      })
    ).toBe(1)
  })

  it("boosts learned matches and penalizes explicit early-skip matches", () => {
    let profile = readyPositiveProfile()
    const liked = candidate("liked-new", "favored-artist", { tempo: 120, energy: 0.68 })
    const disliked = candidate("disliked-new", "skipped-artist", { tempo: 190, energy: 0.98 })
    profile = recordPlaybackOutcome(profile, {
      type: "early-skip",
      candidate: candidate("skipped-reference", "skipped-artist", {
        tempo: 190,
        energy: 0.98,
        valence: 0.1,
        danceability: 0.2,
      }),
      genres: ["aggrotech"],
      occurredAt: NOW,
    })

    const likedScore = scoreTasteAffinity(liked, profile, {
      genres: ["indie pop"],
      now: NOW,
    })
    const dislikedScore = scoreTasteAffinity(disliked, profile, {
      genres: ["aggrotech"],
      now: NOW,
    })
    expect(getTasteProfileConfidence(profile, NOW).ready).toBe(true)
    expect(likedScore).toBeGreaterThan(1)
    expect(dislikedScore).toBeLessThan(1)
    expect(likedScore).toBeGreaterThan(dislikedScore)
  })

  it("lets stale negative feedback decay toward neutral and never mutates state", () => {
    let recent = readyPositiveProfile()
    recent = recordPlaybackOutcome(recent, {
      type: "early-skip",
      candidate: candidate("skip", "skipped-artist", { tempo: 188, energy: 0.97 }),
      genres: ["aggrotech"],
      occurredAt: NOW,
    })
    const original = structuredClone(recent)
    const target = candidate("target", "skipped-artist", { tempo: 188, energy: 0.97 })

    const recentScore = scoreTasteAffinity(target, recent, { genres: ["aggrotech"], now: NOW })
    const staleScore = scoreTasteAffinity(target, recent, {
      genres: ["aggrotech"],
      now: NOW + 180 * DAY,
    })

    expect(Math.abs(staleScore - 1)).toBeLessThan(Math.abs(recentScore - 1))
    expect(recent).toEqual(original)
  })

  it("gives explicit feedback extra influence only in the matching listening context", () => {
    let profile = readyPositiveProfile()
    for (let index = 0; index < 3; index += 1) {
      profile = recordExplicitTasteFeedback(profile, {
        sentiment: -1,
        candidate: candidate(`night-skip-${index}`, "night-artist", { tempo: 188, energy: 0.95 }),
        genres: ["aggrotech"],
        contextKey: "track:night",
        occurredAt: NOW - index * DAY,
      })
    }

    const target = candidate("night-target", "night-artist", { tempo: 188, energy: 0.95 })
    const night = scoreTasteAffinity(target, profile, {
      genres: ["aggrotech"],
      now: NOW,
      contextKey: "track:night",
    })
    const morning = scoreTasteAffinity(target, profile, {
      genres: ["aggrotech"],
      now: NOW,
      contextKey: "track:morning",
    })

    expect(night).toBeLessThan(morning)
  })
})
