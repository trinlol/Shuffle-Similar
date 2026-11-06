import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearExposureLedger,
  computeExposureMultipliers,
  EXPOSURE_LEDGER_STORAGE_KEY,
  recordBatchExposure,
  setExposureLedgerAccountKey,
} from "./exposureLedger"

const memory = new Map<string, string>()

const setupMockStorage = () => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    LocalStorage: {
      get: (key: string) => memory.get(key) ?? null,
      set: (key: string, value: string) => memory.set(key, value),
      remove: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
    },
  }
}

describe("exposureLedger", () => {
  const BASE_TIME = 1_700_000_000_000 // fixed reference epoch

  beforeEach(() => {
    memory.clear()
    setupMockStorage()
    setExposureLedgerAccountKey(null)
  })

  afterEach(() => {
    setExposureLedgerAccountKey(null)
  })

  it("records queued, played, substantial-play, and early-skip outcomes with correct deltas and counters", () => {
    const track = {
      uri: "spotify:track:t1",
      trackName: "Song One",
      artistUri: "spotify:artist:a1",
      artistName: "Artist One",
    }

    // Record queued impression
    recordBatchExposure([track], "queued", BASE_TIME)
    let raw = JSON.parse(memory.get(EXPOSURE_LEDGER_STORAGE_KEY) ?? "{}")
    expect(raw.tracks["spotify:track:t1"].score).toBeCloseTo(0.25)
    expect(raw.tracks["spotify:track:t1"].impressions).toBe(1)
    expect(raw.artists["spotify:artist:a1"].score).toBeCloseTo(0.18)
    expect(raw.artists["spotify:artist:a1"].impressions).toBe(1)

    // Record substantial play
    recordBatchExposure([track], "substantial-play", BASE_TIME)
    raw = JSON.parse(memory.get(EXPOSURE_LEDGER_STORAGE_KEY) ?? "{}")
    expect(raw.tracks["spotify:track:t1"].score).toBeCloseTo(0.25 + 0.7)
    expect(raw.tracks["spotify:track:t1"].plays).toBe(1)
    expect(raw.artists["spotify:artist:a1"].score).toBeCloseTo(0.18 + 0.55)
    expect(raw.artists["spotify:artist:a1"].plays).toBe(1)

    // Record completion / played
    recordBatchExposure([track], "played", BASE_TIME)
    raw = JSON.parse(memory.get(EXPOSURE_LEDGER_STORAGE_KEY) ?? "{}")
    expect(raw.tracks["spotify:track:t1"].score).toBeCloseTo(0.25 + 0.7 + 1.0)
    expect(raw.tracks["spotify:track:t1"].plays).toBe(2)
    expect(raw.artists["spotify:artist:a1"].score).toBeCloseTo(0.18 + 0.55 + 0.8)
    expect(raw.artists["spotify:artist:a1"].plays).toBe(2)

    // Record early-skip
    recordBatchExposure([track], "early-skip", BASE_TIME)
    raw = JSON.parse(memory.get(EXPOSURE_LEDGER_STORAGE_KEY) ?? "{}")
    expect(raw.tracks["spotify:track:t1"].score).toBeCloseTo(0.25 + 0.7 + 1.0 + 1.5)
    expect(raw.tracks["spotify:track:t1"].skips).toBe(1)
    expect(raw.artists["spotify:artist:a1"].score).toBeCloseTo(0.18 + 0.55 + 0.8 + 1.85)
    expect(raw.artists["spotify:artist:a1"].skips).toBe(1)
  })

  it("decays track exposure with 72-hour half-life and artist exposure with 7-day half-life", () => {
    const track = {
      uri: "spotify:track:decay-test",
      artistUri: "spotify:artist:decay-artist",
    }

    recordBatchExposure([track], "played", BASE_TIME)

    // Immediately at BASE_TIME:
    const immediateMultipliers = computeExposureMultipliers([track], BASE_TIME)
    const initialMul = immediateMultipliers.get(track.uri) ?? 0
    expect(initialMul).toBeLessThan(0.7)

    // 72 hours later (track half-life): track score should be 50% of 1.0 = 0.5
    const hour72 = BASE_TIME + 72 * 60 * 60 * 1_000
    const mul72h = computeExposureMultipliers([track], hour72).get(track.uri) ?? 0
    expect(mul72h).toBeGreaterThan(initialMul)

    // 7 days later (artist half-life = 168 hours): artist score should be 50% of 0.8 = 0.4
    const day7 = BASE_TIME + 7 * 24 * 60 * 60 * 1_000
    const mulDay7 = computeExposureMultipliers([track], day7).get(track.uri) ?? 0
    expect(mulDay7).toBeGreaterThan(mul72h)

    // 30 days later: should have decayed back close to 1.0
    const day30 = BASE_TIME + 30 * 24 * 60 * 60 * 1_000
    const mulDay30 = computeExposureMultipliers([track], day30).get(track.uri) ?? 0
    expect(mulDay30).toBeGreaterThan(0.97)

    // 60 days later: fully back to 1.0
    const day60 = BASE_TIME + 60 * 24 * 60 * 60 * 1_000
    const mulDay60 = computeExposureMultipliers([track], day60).get(track.uri) ?? 0
    expect(mulDay60).toBeCloseTo(1.0, 2)
  })

  it("applies artist cooldown across different tracks by the same artist", () => {
    const track1 = {
      uri: "spotify:track:hit-song",
      trackName: "Hit Song",
      artistUri: "spotify:artist:taylor",
      artistName: "Taylor Swift",
    }
    const track2 = {
      uri: "spotify:track:deep-cut",
      trackName: "Deep Cut",
      artistUri: "spotify:artist:taylor",
      artistName: "Taylor Swift",
    }

    // Play track 1
    recordBatchExposure([track1], "played", BASE_TIME)

    // Compute multiplier for track 2: track 2 was never played, but its artist was!
    const multipliers = computeExposureMultipliers([track1, track2], BASE_TIME)
    const track1Mul = multipliers.get(track1.uri) ?? 0
    const track2Mul = multipliers.get(track2.uri) ?? 0

    // Track 1 has both track and artist exposure cooldown
    // Track 2 has artist exposure cooldown only
    expect(track1Mul).toBeLessThan(track2Mul)
    expect(track2Mul).toBeLessThan(1.0)
    // Artist delta 0.8: M_artist = exp(-0.55 * 0.8) ≈ 0.644, M_track = 1.0 -> multiplier ≈ 0.644
    expect(track2Mul).toBeCloseTo(Math.exp(-0.55 * 0.8), 2)
  })

  it("cools down canonical duplicates across different versions of a song", () => {
    const albumVersion = {
      uri: "spotify:track:album-ver",
      trackName: "Cruel Summer - Album Version",
      artistUri: "spotify:artist:taylor",
      artistName: "Taylor Swift",
    }
    const singleVersion = {
      uri: "spotify:track:single-ver",
      trackName: "Cruel Summer",
      artistUri: "spotify:artist:taylor",
      artistName: "Taylor Swift",
    }

    // Play album version
    recordBatchExposure([albumVersion], "played", BASE_TIME)

    // Multiplier for single version should be cooled down via canonical key
    const multipliers = computeExposureMultipliers([singleVersion], BASE_TIME)
    const singleMul = multipliers.get(singleVersion.uri) ?? 0
    // Should be heavily cooled down (both track canonical match and artist match)
    expect(singleMul).toBeLessThan(0.4)
  })

  it("recovers gracefully from malformed JSON and clearExposureLedger clears data", () => {
    memory.set(EXPOSURE_LEDGER_STORAGE_KEY, "{corrupt-invalid-json!!")

    // computeExposureMultipliers shouldn't throw and should return 1.0 for unexposed
    const multipliers = computeExposureMultipliers([{ uri: "spotify:track:test" }], BASE_TIME)
    expect(multipliers.get("spotify:track:test")).toBe(1.0)

    // recordBatchExposure should safely overwrite
    recordBatchExposure([{ uri: "spotify:track:test" }], "queued", BASE_TIME)
    const afterMultipliers = computeExposureMultipliers([{ uri: "spotify:track:test" }], BASE_TIME)
    expect(afterMultipliers.get("spotify:track:test")).toBeLessThan(1.0)

    // clearExposureLedger
    clearExposureLedger()
    expect(memory.has(EXPOSURE_LEDGER_STORAGE_KEY)).toBe(false)
  })

  it("isolates exposure memory across accounts", () => {
    const track = { uri: "spotify:track:acc-test", artistUri: "spotify:artist:acc-artist" }

    setExposureLedgerAccountKey("user-1")
    recordBatchExposure([track], "played", BASE_TIME)
    expect(computeExposureMultipliers([track], BASE_TIME).get(track.uri)).toBeLessThan(0.7)

    // Switch account to user-2
    setExposureLedgerAccountKey("user-2")
    expect(computeExposureMultipliers([track], BASE_TIME).get(track.uri)).toBe(1.0)

    // Switch back to user-1
    setExposureLedgerAccountKey("user-1")
    expect(computeExposureMultipliers([track], BASE_TIME).get(track.uri)).toBeLessThan(0.7)
  })

  it("prunes excess track and artist keys beyond capacity bounds", () => {
    // Generate 450 tracks with 350 artists
    const tracks = Array.from({ length: 450 }, (_, i) => ({
      uri: `spotify:track:bulk-${i}`,
      artistUri: `spotify:artist:bulk-${i % 350}`,
    }))

    recordBatchExposure(tracks, "queued", BASE_TIME)
    const raw = JSON.parse(memory.get(EXPOSURE_LEDGER_STORAGE_KEY) ?? "{}")
    expect(Object.keys(raw.tracks).length).toBeLessThanOrEqual(400)
    expect(Object.keys(raw.artists).length).toBeLessThanOrEqual(300)
  })
})
