import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  appendPlayHistory,
  loadPlayHistory,
  PLAY_HISTORY_STORAGE_KEY,
  type PlayHistoryEntry,
} from "./settings"

const storage = new Map<string, string>()

vi.stubGlobal("Spicetify", {
  LocalStorage: {
    get: (key: string) => storage.get(key) ?? null,
    set: (key: string, value: string) => void storage.set(key, value),
    remove: (key: string) => void storage.delete(key),
    clear: () => void storage.clear(),
  },
})

beforeEach(() => {
  storage.clear()
})

describe("timestamped play history", () => {
  it("round-trips entries with timestamps, MRU-first", () => {
    const now = Date.UTC(2026, 8, 7)
    appendPlayHistory("spotify:track:a", 400, PLAY_HISTORY_STORAGE_KEY, now)
    appendPlayHistory("spotify:track:b", 400, PLAY_HISTORY_STORAGE_KEY, now - 1_000)
    const history = loadPlayHistory(PLAY_HISTORY_STORAGE_KEY)
    expect(history.map((e) => e.uri)).toEqual(["spotify:track:b", "spotify:track:a"])
    expect(history[0].playedAt).toBe(now - 1_000)
  })

  it("deduplicates on re-append, keeping the newest timestamp", () => {
    const t0 = Date.UTC(2026, 8, 1)
    const t1 = Date.UTC(2026, 8, 7)
    appendPlayHistory("spotify:track:a", 400, PLAY_HISTORY_STORAGE_KEY, t0)
    appendPlayHistory("spotify:track:a", 400, PLAY_HISTORY_STORAGE_KEY, t1)
    const history = loadPlayHistory(PLAY_HISTORY_STORAGE_KEY)
    expect(history).toHaveLength(1)
    expect(history[0].playedAt).toBe(t1)
  })

  it("migrates legacy string[] entries with playedAt 0", () => {
    storage.set(
      PLAY_HISTORY_STORAGE_KEY,
      JSON.stringify(["spotify:track:old", "spotify:track:older"])
    )
    const history = loadPlayHistory(PLAY_HISTORY_STORAGE_KEY)
    expect(history).toEqual<PlayHistoryEntry[]>([
      { uri: "spotify:track:old", playedAt: 0 },
      { uri: "spotify:track:older", playedAt: 0 },
    ])
  })

  it("caps entries at maxWindow", () => {
    for (let i = 0; i < 5; i++) {
      appendPlayHistory(`spotify:track:${i}`, 3, PLAY_HISTORY_STORAGE_KEY)
    }
    expect(loadPlayHistory(PLAY_HISTORY_STORAGE_KEY)).toHaveLength(3)
  })

  it("treats malformed JSON as empty history", () => {
    storage.set(PLAY_HISTORY_STORAGE_KEY, "{{{not-json")
    expect(loadPlayHistory(PLAY_HISTORY_STORAGE_KEY)).toEqual([])
  })
})
