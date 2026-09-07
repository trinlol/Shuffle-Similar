# Seed-Anchored Similar Mix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-anchor Similar Mixes on the seed (blend schedule, ranking weights, relevance gate), block recently-heard and playlist-member tracks from the queue, and make instrumental seeds produce instrumental-only mixes.

**Architecture:** A timestamped play-history store migrates the existing `string[]` storage in place; a new central `filterEligibleCandidates()` choke point in `src/algorithm/filters.ts` applies the ordered hard/soft filters to every candidate pool before ranking; ranking weights and blend phases change in place in `recommendationPlannerV2.ts` / `settings.ts`; a playlist-membership set is built per session in the engine layer; the instrumental rule layers API-param + pool-filter + heuristic + central choke-point enforcement.

**Tech Stack:** TypeScript, Vitest (`.test.ts` colocated with source), esbuild, Spicetify APIs (CosmosAsync, PlaylistAPI, RootlistAPI, GraphQL).

**Spec:** `docs/superpowers/specs/2026-09-07-seed-anchored-mix-design.md`

**Test command:** `npm test` (runs `vitest run`). Single file: `npx vitest run src/path/to/file.test.ts`.

**Commit convention:** Conventional commits (`feat:`, `fix:`, `test:`, `refactor:`).

---

### Task 1: Timestamped play-history store

**Files:**
- Modify: `src/storage/settings.ts:90-111`
- Create: `src/storage/settings.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/storage/settings.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/settings.test.ts`
Expected: FAIL — `appendPlayHistory` accepts no 4th argument / `PlayHistoryEntry` type not exported.

- [ ] **Step 3: Implement timestamped store**

Replace the two functions at the bottom of `src/storage/settings.ts` (lines 90-111). `loadPlayHistory` must return `PlayHistoryEntry[]` now; keep backward-compat for consumers by adding a separate `loadPlayHistoryUris` that maps to URIs (existing consumers in `filters.ts` and `SessionManager.ts` will be migrated in Task 2). Do NOT remove `migrateLegacyStorage()` — it runs first as today.

```ts
export type PlayHistoryEntry = {
  uri: string
  playedAt: number
}

const PLAY_HISTORY_MAX_ENTRIES = 400

const decodePlayHistory = (raw: string | null): PlayHistoryEntry[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry): PlayHistoryEntry | null => {
        if (typeof entry === "string") return { uri: entry, playedAt: 0 }
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as PlayHistoryEntry).uri === "string" &&
          typeof (entry as PlayHistoryEntry).playedAt === "number" &&
          Number.isFinite((entry as PlayHistoryEntry).playedAt)
        ) {
          return { uri: (entry as PlayHistoryEntry).uri, playedAt: (entry as PlayHistoryEntry).playedAt }
        }
        return null
      })
      .filter((entry): entry is PlayHistoryEntry => entry !== null)
  } catch {
    return []
  }
}

export const loadPlayHistory = (storageKey = PLAY_HISTORY_STORAGE_KEY): PlayHistoryEntry[] => {
  migrateLegacyStorage()
  return decodePlayHistory(Spicetify.LocalStorage.get(storageKey))
}

/** URI-only view for legacy consumers that only need membership/order. */
export const loadPlayHistoryUris = (storageKey = PLAY_HISTORY_STORAGE_KEY): string[] =>
  loadPlayHistory(storageKey).map((entry) => entry.uri)

export const appendPlayHistory = (
  uri: string,
  maxWindow: number,
  storageKey = PLAY_HISTORY_STORAGE_KEY,
  playedAt = Date.now()
): void => {
  const history = loadPlayHistory(storageKey).filter((entry) => entry.uri !== uri)
  history.unshift({ uri, playedAt })
  const capped = history.slice(0, Math.max(1, Math.min(maxWindow, PLAY_HISTORY_MAX_ENTRIES)))
  Spicetify.LocalStorage.set(storageKey, JSON.stringify(capped))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/settings.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Fix typecheck fallout in the same commit**

`loadPlayHistory` return-type change breaks `src/algorithm/filters.ts:47,82` and `src/session/SessionManager.ts:187`. Change those three call sites to `loadPlayHistoryUris()`:

```ts
// src/algorithm/filters.ts line 47
const recentHistory = [...sessionPlayed, ...loadPlayHistoryUris().slice(0, historyWindow)]
// line 82
const history = new Set([...sessionPlayed, ...loadPlayHistoryUris().slice(0, historyWindow)])
```

```ts
// src/session/SessionManager.ts line 187 — also update the import at line 11-15
getPlayHistory: () => loadPlayHistoryUris(playHistoryStorageKey),
```

Also update `src/session/SessionManager.test.ts:219-224` — the stored JSON is now `[{ uri, playedAt }]`:

```ts
expect(JSON.parse(memory.get("shuffleSimilar:playHistory:account:account-a") ?? "[]")).toEqual([
  { uri: first.uri, playedAt: expect.any(Number) },
])
expect(JSON.parse(memory.get("shuffleSimilar:playHistory:account:account-b") ?? "[]")).toEqual([
  { uri: second.uri, playedAt: expect.any(Number) },
])
```

- [ ] **Step 6: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/settings.ts src/storage/settings.test.ts src/algorithm/filters.ts src/session/SessionManager.ts src/session/SessionManager.test.ts
git commit -m "feat: timestamped play history with legacy migration"
```

---

### Task 2: Blackout filter — `recentPlayBlackout`

**Files:**
- Modify: `src/algorithm/filters.ts` (append)
- Test: `src/algorithm/filters.test.ts` (append new describe block)

- [ ] **Step 1: Write failing tests**

Append to `src/algorithm/filters.test.ts` (uses the existing `seed` fixture and Spicetify stub at the top of that file):

```ts
import { applyRecentPlayBlackout, recentPlayPenalty } from "./filters"

describe("recent-play blackout", () => {
  const now = Date.UTC(2026, 8, 7)
  const DAY = 24 * 60 * 60 * 1_000

  it("hard-excludes tracks played within 14 days", () => {
    const history: PlayHistoryEntry[] = [
      { uri: "spotify:track:fresh", playedAt: now - 3 * DAY },
      { uri: "spotify:track:edge", playedAt: now - 14 * DAY + 1 },
    ]
    const result = applyRecentPlayBlackout(
      [{ uri: "spotify:track:fresh" }, { uri: "spotify:track:edge" }, { uri: "spotify:track:never" }],
      history,
      now
    )
    expect(result.map((t) => t.uri)).toEqual(["spotify:track:never"])
  })

  it("relaxes to penalty-only when fewer than 15 candidates survive", () => {
    const history: PlayHistoryEntry[] = Array.from({ length: 20 }, (_, i) => ({
      uri: `spotify:track:recent-${i}`,
      playedAt: now - i * DAY,
    }))
    const candidates = history.map(({ uri }) => ({ uri }))
    const result = applyRecentPlayBlackout(candidates, history, now)
    expect(result).toHaveLength(20)
  })

  it("penalty is 0.35 at 14 days and decays linearly to 0 at 45 days", () => {
    expect(recentPlayPenalty(now - 14 * DAY, now)).toBeCloseTo(0.35)
    expect(recentPlayPenalty(now - 45 * DAY, now)).toBeCloseTo(0)
    expect(recentPlayPenalty(now - 100 * DAY, now)).toBe(0)
  })

  it("never-played tracks get no penalty", () => {
    expect(recentPlayPenalty(0, now)).toBe(0)
  })
})
```

Add `PlayHistoryEntry` to the existing import from `../storage/settings` at the top of the test file, and import the two new functions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/algorithm/filters.test.ts`
Expected: FAIL — exports do not exist.

- [ ] **Step 3: Implement**

Append to `src/algorithm/filters.ts` (import `PlayHistoryEntry` from `../storage/settings`):

```ts
export const RECENT_PLAY_BLACKOUT_MS = 14 * 24 * 60 * 60 * 1_000
const RECENT_PLAY_PENALTY_MS = 45 * 24 * 60 * 60 * 1_000
const RECENT_PLAY_PENALTY_MAX = 0.35
const BLACKOUT_RELAX_MIN_SURVIVORS = 15

/** 0..0.35 penalty for plays between 14 and 45 days old; 0 outside that band. */
export const recentPlayPenalty = (playedAt: number, now: number): number => {
  if (playedAt <= 0) return 0
  const age = now - playedAt
  if (age <= RECENT_PLAY_BLACKOUT_MS) return RECENT_PLAY_PENALTY_MAX
  if (age >= RECENT_PLAY_PENALTY_MS) return 0
  const span = RECENT_PLAY_PENALTY_MS - RECENT_PLAY_BLACKOUT_MS
  return RECENT_PLAY_PENALTY_MAX * (1 - (age - RECENT_PLAY_BLACKOUT_MS) / span)
}

/**
 * Hard-excludes tracks played within the 14-day blackout window. If that
 * would leave fewer than 15 survivors, returns the input unchanged — the
 * engine layer applies penalty-only scoring for the oldest plays instead.
 */
export const applyRecentPlayBlackout = (
  candidates: TrackCandidate[],
  history: readonly PlayHistoryEntry[],
  now: number
): TrackCandidate[] => {
  const blackedOut = new Set(
    history
      .filter((entry) => entry.playedAt > 0 && now - entry.playedAt <= RECENT_PLAY_BLACKOUT_MS)
      .map((entry) => entry.uri)
  )
  if (blackedOut.size === 0) return candidates
  const survivors = candidates.filter((candidate) => !blackedOut.has(candidate.uri))
  return survivors.length >= BLACKOUT_RELAX_MIN_SURVIVORS ? survivors : candidates
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/algorithm/filters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/algorithm/filters.ts src/algorithm/filters.test.ts
git commit -m "feat: 14-day recent-play blackout filter with thin-pool relaxation"
```

---

### Task 3: New blend phases + ranking weights

**Files:**
- Modify: `src/storage/settings.ts:57-62` (blendPhases)
- Modify: `src/algorithm/recommendationPlannerV2.ts:384-391` (componentWeights)
- Test: `src/algorithm/filters.test.ts:98-105` (update expectations)

- [ ] **Step 1: Update the failing test first**

Replace the existing "uses the expected progressive blend phases" test body (`src/algorithm/filters.test.ts:98-105`):

```ts
it("uses the expected seed-anchored blend phases", () => {
  const settings = getSmartConfig(seed)
  expect(settings.initialQueueSize).toBe(50)
  expect(settings.deprioritizePopular).toBe(false)
  expect(getBlendWeights(4, settings)).toEqual({ similarWeight: 1, profileWeight: 0 })
  expect(getBlendWeights(5, settings)).toEqual({ similarWeight: 0.85, profileWeight: 0.15 })
  expect(getBlendWeights(10, settings)).toEqual({ similarWeight: 0.75, profileWeight: 0.25 })
  expect(getBlendWeights(20, settings)).toEqual({ similarWeight: 0.7, profileWeight: 0.3 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/algorithm/filters.test.ts`
Expected: FAIL on the 5/10/20 assertions.

- [ ] **Step 3: Implement new phases**

In `src/storage/settings.ts`, replace the `blendPhases` array inside `getSmartConfig` (lines 57-62):

```ts
    blendPhases: [
      { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
      { maxPosition: 9, similarWeight: 0.85, profileWeight: 0.15 },
      { maxPosition: 19, similarWeight: 0.75, profileWeight: 0.25 },
      { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.7, profileWeight: 0.3 },
    ],
```

- [ ] **Step 4: Reweight ranking components**

In `src/algorithm/recommendationPlannerV2.ts:384-391`, replace:

```ts
    componentWeights: {
      fusion: 0.2,
      context: 0.12,
      taste: 0.17,
      acoustic: 0.08,
      novelty: 0.08,
      feedback: 0.35,
    },
```

with:

```ts
    componentWeights: {
      fusion: 0.2,
      context: 0.2,
      taste: 0.12,
      acoustic: 0.1,
      novelty: 0.13,
      feedback: 0.25,
    },
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `filters.test.ts` passes. `recommendationPlannerV2.test.ts:423-440` ("keeps the discovery floor above the late profile-heavy blend") may fail because the blend at position 20 is now 70/30 — if it fails, update its expectation from `profileCount <= 6` to `profileCount <= 3` (10 picks × 0.3 profile weight ⇒ at most 3 profile-family picks expected):

```ts
expect(diagnostics?.slate.profileCount).toBeLessThanOrEqual(3)
```

- [ ] **Step 6: Commit**

```bash
git add src/storage/settings.ts src/algorithm/recommendationPlannerV2.ts src/algorithm/filters.test.ts src/algorithm/recommendationPlannerV2.test.ts
git commit -m "feat: seed-anchored blend phases and context-first ranking weights"
```

---

### Task 4: Seed-relevance gate

**Files:**
- Modify: `src/algorithm/recommendationPlannerV2.ts` (gate after `contexts` map is built, ~line 334)
- Test: `src/algorithm/recommendationPlannerV2.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `src/algorithm/recommendationPlannerV2.test.ts`:

```ts
describe("seed-relevance gate", () => {
  const gateSettings: SmartConfig = { ...settings }

  const poolWith = (context: number | undefined): TrackCandidate[] =>
    attachSourceProvenance(
      {
        ...familyPool("similar", 1)[0],
        uri: `spotify:track:ctx-${context ?? "unknown"}`,
        tempo: 118,
        energy: 0.66,
        valence: 0.55,
      },
      "radio"
    )

  it("drops candidates whose context affinity is below the 0.15 floor", () => {
    // One acoustically-near candidate (kept), one acoustically-far (dropped)
    const near = { ...familyPool("similar", 1)[0], uri: "spotify:track:near", tempo: 120, energy: 0.68, valence: 0.57 }
    const far = { ...familyPool("similar", 1)[0], uri: "spotify:track:far", tempo: 200, energy: 0.05, valence: 0.05 }
    const batch = buildTrackBatch(seed, 0, [], [near, far], [], gateSettings, 2)
    expect(batch.map((t) => t.uri)).toContain("spotify:track:near")
    expect(batch.map((t) => t.uri)).not.toContain("spotify:track:far")
  })

  it("relaxes the floor to 0.08 when the gate would remove more than 60% of the pool", () => {
    const near = { ...familyPool("similar", 1)[0], uri: "spotify:track:only-near", tempo: 120, energy: 0.68, valence: 0.57 }
    const farPool = Array.from({ length: 9 }, (_, i) => ({
      ...familyPool("similar", 1)[0],
      uri: `spotify:track:far-${i}`,
      artistUri: `spotify:artist:far-${i}`,
      tempo: 90 + i,
      energy: 0.2,
      valence: 0.2,
    }))
    const batch = buildTrackBatch(seed, 0, [], [near, ...farPool], [], gateSettings, 5)
    // 9/10 would be gated out (>60%) → floor relaxes, far tracks can return
    expect(batch.length).toBeGreaterThan(1)
    expect(getRecommendationDiagnostics(batch)?.planReasons["relax:relevance-gate"]).toBeGreaterThan(0)
  })

  it("does not gate when no seed acoustic data exists", () => {
    const unknownSeed: SeedMetadata = { ...seed, tempo: undefined, energy: undefined, valence: undefined, releaseYear: undefined }
    const farPool = Array.from({ length: 6 }, (_, i) => ({
      ...familyPool("similar", 1)[0],
      uri: `spotify:track:far-${i}`,
      artistUri: `spotify:artist:far-${i}`,
      tempo: 150 + i,
      energy: 0.15,
      valence: 0.15,
    }))
    const batch = buildTrackBatch(unknownSeed, 0, [], farPool, [], gateSettings, 4)
    expect(batch).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/algorithm/recommendationPlannerV2.test.ts`
Expected: FAIL — "far" candidates currently survive; `relax:relevance-gate` reason code doesn't exist.

- [ ] **Step 3: Implement the gate**

In `src/algorithm/recommendationPlannerV2.ts`:

3a. Add the reason code to the `PlanReasonCode` union in `src/algorithm/rankingV2.ts` (line ~95-107):

```ts
export type PlanReasonCode =
  | "blend:similar"
  | "blend:profile"
  | "blend:fallback"
  | "diversity:mmr"
  | "diversity:artist-floor"
  | "discovery:floor"
  | "relax:relevance-gate"
  | "transition:acoustic-paced"
  | "relax:acoustic-transition"
  | "relax:album-spacing"
  | "relax:artist-spacing"
  | "relax:artist-cap"
  | "relax:discovery-floor"
```

3b. In `planRecommendationBatchV2`, immediately after the `contexts` map is built (~line 334) and BEFORE `addRankedProvenance` uses it for "playlist-context", insert:

```ts
  // Seed-relevance gate: candidates far below the seed's sound are removed
  // before ranking. Relaxes to 0.08 if the strict floor would remove >60%.
  const RELEVANCE_FLOOR = 0.15
  const RELEVANCE_FLOOR_RELAXED = 0.08
  const scoredContexts = [...contexts.values()].filter((v): v is number => v != null)
  const belowFloor = scoredContexts.filter((v) => v < RELEVANCE_FLOOR).length
  const relaxGate =
    scoredContexts.length > 0 && belowFloor / scoredContexts.length > 0.6
  const relevanceFloor = relaxGate ? RELEVANCE_FLOOR_RELAXED : RELEVANCE_FLOOR
  let relevanceGateRelaxed = false
  if (scoredContexts.length > 0) {
    for (const [uri, affinity] of contexts) {
      if (affinity == null) continue // unknown metadata is neutral, not gated
      if (affinity < relevanceFloor) {
        aggregates.delete(uri)
      }
    }
    relevanceGateRelaxed = relaxGate
  }
```

3c. Thread the relaxation into diagnostics: after the plan is built (near `incrementReasons(item.reasonCodes, planReasons)` at ~line 438), add:

```ts
  if (relevanceGateRelaxed) planReasons["relax:relevance-gate"] = plan.items.length
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/algorithm/recommendationPlannerV2.test.ts`
Expected: PASS (including all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/algorithm/recommendationPlannerV2.ts src/algorithm/recommendationPlannerV2.test.ts src/algorithm/rankingV2.ts
git commit -m "feat: seed-relevance gate with 60% relaxation valve"
```

---

### Task 5: Instrumental-seed rule — `similarTracks.ts`

**Files:**
- Modify: `src/sources/similarTracks.ts:221-258` (`filterInstrumentalsAndSoundtracks`), `:20` (`MAX_ENRICHMENT_REQUESTS`), `:485-531` (`fetchRecommendations`), `:599-610` (seed classification)
- Test: `src/sources/similarTracks.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `src/sources/similarTracks.test.ts`:

```ts
describe("instrumental-seed rule", () => {
  it("keeps instrumental candidates and drops vocal ones for an instrumental seed", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates = [
      { uri: "spotify:track:inst", instrumentalness: 0.8, albumName: "Some Score" },
      { uri: "spotify:track:vocal", instrumentalness: 0.05, albumName: "Pop Album" },
    ]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered.map((c) => c.uri)).toEqual(["spotify:track:inst"])
  })

  it("uses the genre/album heuristic for candidates without feature data", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates = [
      { uri: "spotify:track:score-album", albumName: "Dune (Original Motion Picture Soundtrack)" },
      { uri: "spotify:track:classical", genres: ["classical", "orchestral"] },
      { uri: "spotify:track:pop", albumName: "Pop Hits 2026" },
    ]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered.map((c) => c.uri)).toEqual(["spotify:track:score-album", "spotify:track:classical"])
  })

  it("allows soundtrack albums when the seed is an instrumental score", () => {
    const scoreSeed: SeedMetadata = {
      ...seed,
      albumName: "Interstellar (Original Motion Picture Soundtrack)",
      instrumentalness: 0.95,
    }
    const candidates = [{ uri: "spotify:track:score", instrumentalness: 0.9, albumName: "Blade Runner 2049 (Original Score)" }]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, scoreSeed)
    expect(filtered).toHaveLength(1)
  })

  it("does not trigger for neutral seeds (0.2 ≤ instrumentalness < 0.9)", () => {
    const neutralSeed: SeedMetadata = { ...seed, instrumentalness: 0.5 }
    const candidates = [{ uri: "spotify:track:whatever", instrumentalness: 0.1 }]
    const filtered = filterInstrumentalsAndSoundtracksPublic(candidates, neutralSeed)
    expect(filtered).toHaveLength(1)
  })

  it("adds min_instrumentalness to recommendations URL for instrumental seeds", async () => {
    const urls: string[] = []
    globalThis.Spicetify.CosmosAsync.get = async (url: string) => {
      if (url.includes("/v1/recommendations")) {
        urls.push(url)
        return { tracks: [] }
      }
      return {}
    }
    const scoreSeed: SeedMetadata = { ...seed, instrumentalness: 0.95 }
    await fetchSimilarPool(scoreSeed, getSmartConfig(scoreSeed))
    expect(urls.some((url) => url.includes("min_instrumentalness=0.5"))).toBe(true)
  })
})
```

Note: the existing test file already mocks `Spicetify.CosmosAsync.get` per-URL the same way (see its lines 75-108), so this pattern matches. Also export a test-only wrapper in the implementation step:

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/similarTracks.test.ts`
Expected: FAIL — `filterInstrumentalsAndSoundtracksPublic` not exported; no `min_instrumentalness` in URL.

- [ ] **Step 3: Implement**

3a. In `src/sources/similarTracks.ts`, add after `filterInstrumentalsAndSoundtracks` (line 258) a test-visible wrapper plus the heuristic:

```ts
export const INSTRUMENTAL_GENRE_PATTERNS =
  /(soundtrack|score|classical|orchestral|ambient|instrumental|piano|string quartet|film score|movie tunes)/i

/** True when genres or album name suggest an instrumental track. */
const looksInstrumental = (candidate: TrackCandidate): boolean => {
  if (candidate.albumName && INSTRUMENTAL_GENRE_PATTERNS.test(candidate.albumName)) return true
  return false
}

export const SEED_INSTRUMENTALNESS_THRESHOLD = 0.9
export const CANDIDATE_INSTRUMENTALNESS_FLOOR = 0.5

export const isSeedInstrumental = (seed: SeedMetadata): boolean =>
  seed.instrumentalness !== undefined && seed.instrumentalness >= SEED_INSTRUMENTALNESS_THRESHOLD

/** Test-visible wrapper around the internal vocal/soundtrack filter. */
export const filterInstrumentalsAndSoundtracksPublic = (
  candidates: TrackCandidate[],
  seed: SeedMetadata
): TrackCandidate[] => {
  const isSeedSdtk =
    (seed.albumName &&
      /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(
        seed.albumName
      )) ||
    seed.genres.some((genre) =>
      /(soundtrack|score|orchestral|movie tunes|show tunes|broadway|musical)/i.test(genre)
    )
  const isSeedVocal = seed.instrumentalness === undefined || seed.instrumentalness < 0.2
  return filterInstrumentalsAndSoundtracks(
    candidates,
    isSeedVocal,
    isSeedSdtk,
    isSeedInstrumental(seed)
  )
}
```

3b. Extend the internal `filterInstrumentalsAndSoundtracks` signature (line 221) with a fourth parameter `isInstrumentalSeed = false`, and add its branch BEFORE the existing rules:

```ts
const filterInstrumentalsAndSoundtracks = (
  candidates: TrackCandidate[],
  isVocal: boolean,
  isSoundtrack: boolean,
  isInstrumentalSeed = false
): TrackCandidate[] => {
  return candidates.filter((candidate) => {
    // 0. Instrumental-seed rule (hard): an instrumental seed only accepts
    // instrumental candidates. Feature-known tracks must clear 0.5;
    // feature-unknown tracks must pass the genre/album heuristic.
    if (isInstrumentalSeed) {
      if (candidate.instrumentalness !== undefined) {
        if (candidate.instrumentalness < CANDIDATE_INSTRUMENTALNESS_FLOOR) return false
        return true // feature-known instrumental: skip vocal/soundtrack rules
      }
      if (!looksInstrumental(candidate)) return false
      return true
    }

    // ... existing rules 1-2 unchanged below ...
  })
}
```

(Keep rules 1 and 2 exactly as they are after the new branch.)

3c. Wire the seed classification at both call sites. In `fetchSimilarPoolInternal` (lines 599-610), pass the new fourth argument:

```ts
  candidates = filterInstrumentalsAndSoundtracks(
    candidates,
    isSeedVocal,
    isSeedSoundtrack,
    isSeedInstrumental(seed)
  )
```

In `fetchPlaylistSimilarPool` (line 748), compute the majority vote and pass it:

```ts
  const isPlaylistInstrumental =
    seedMetadatas.filter((s) => isSeedInstrumental(s)).length >= Math.ceil(seedMetadatas.length / 2)

  deduped = filterInstrumentalsAndSoundtracks(
    deduped,
    isPlaylistVocal,
    isPlaylistSoundtrack,
    isPlaylistInstrumental
  )
```

3d. In `fetchRecommendations` (line 485), add the API param after the `max_popularity` block (line 501):

```ts
  if (isSeedInstrumental(seed)) {
    url += `&min_instrumentalness=${CANDIDATE_INSTRUMENTALNESS_FLOOR}`
  }
```

And the same param in `fetchPlaylistRecommendations` (line 620), after its `max_popularity` block — using the first seed's instrumentality:

```ts
  if (seeds.some((s) => isSeedInstrumental(s as SeedMetadata))) {
    url += `&min_instrumentalness=${CANDIDATE_INSTRUMENTALNESS_FLOOR}`
  }
```

3e. Enrichment budget bump: change line 20 from a constant to a function:

```ts
const MAX_ENRICHMENT_REQUESTS = 12
const MAX_ENRICHMENT_REQUESTS_INSTRUMENTAL = 60
```

and in `enrichAudioFeaturesAndMetadata` (line 106), accept an options object:

```ts
const enrichAudioFeaturesAndMetadata = async (
  candidates: TrackCandidate[],
  options: { maxFeatureRequests?: number } = {}
): Promise<TrackCandidate[]> => {
  const featureBudget = options.maxFeatureRequests ?? MAX_ENRICHMENT_REQUESTS
  // ... then use featureBudget instead of MAX_ENRICHMENT_REQUESTS in the
  // uncachedFeatureCandidates .slice(0, ...) call (line 121)
```

In `fetchSimilarPoolInternal`, pass the bumped budget when the seed is instrumental (line 597):

```ts
  candidates = await enrichAudioFeaturesAndMetadata(candidates, {
    maxFeatureRequests: isSeedInstrumental(seed)
      ? MAX_ENRICHMENT_REQUESTS_INSTRUMENTAL
      : MAX_ENRICHMENT_REQUESTS,
  })
```

`enrichPlaylistTracks` keeps its default budget (playlist path re-filters via `fetchPlaylistSimilarPool`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/similarTracks.test.ts`
Expected: PASS (existing tests unchanged — they exercise vocal seeds and no-features paths).

- [ ] **Step 5: Commit**

```bash
git add src/sources/similarTracks.ts src/sources/similarTracks.test.ts
git commit -m "feat: instrumental seeds produce instrumental-only candidate pools"
```

---

### Task 6: Profile pool surgery

**Files:**
- Modify: `src/sources/profileTracks.ts:313-345` (`fetchProfilePool`)
- Test: `src/sources/profileTracks.test.ts` (append)

- [ ] **Step 1: Write failing test**

Append to `src/sources/profileTracks.test.ts` (reuse its existing Spicetify mock setup — see its lines around 100-140 for the `pending` pattern):

```ts
it("fetchProfilePool excludes recently-played tracks and playlist-sampled tracks", async () => {
  const calls: string[] = []
  const originalGet = globalThis.Spicetify.CosmosAsync.get
  globalThis.Spicetify.CosmosAsync.get = async (url: string) => {
    calls.push(url)
    if (url.includes("/me/tracks")) {
      return { items: [{ track: { uri: "spotify:track:liked", popularity: 30, is_playable: true } }], next: null }
    }
    if (url.includes("recently-played")) {
      return { items: [{ track: { uri: "spotify:track:recent", is_playable: true } }] }
    }
    if (url.includes("/v1/me/player/recently-played")) {
      return { items: [{ track: { uri: "spotify:track:recent", is_playable: true } }] }
    }
    return {}
  }
  try {
    const pool = await fetchProfilePool(seed)
    expect(pool.map((c) => c.uri)).toContain("spotify:track:liked")
    expect(pool.map((c) => c.uri)).not.toContain("spotify:track:recent")
    expect(calls.some((url) => url.includes("recently-played"))).toBe(false)
  } finally {
    globalThis.Spicetify.CosmosAsync.get = originalGet
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/profileTracks.test.ts`
Expected: FAIL — currently `recent` tracks are included and `recently-played` IS fetched.

- [ ] **Step 3: Implement**

In `src/sources/profileTracks.ts`, rewrite `fetchProfilePool` (lines 313-345):

```ts
export const fetchProfilePool = async (seed: SeedMetadata): Promise<TrackCandidate[]> => {
  // Recently-played is deliberately absent: a source of "what you just
  // heard" can only produce replays by construction. Playlist tracks are
  // excluded from the queue by the playlist-membership rule, so sampling
  // them here would be wasted fetches.
  const [likedResult] = await Promise.allSettled([fetchLikedTracks()])

  const liked = likedResult.status === "fulfilled" ? likedResult.value : []

  const shuffledLiked = sortByObscurity(liked).slice(0, 120)

  return mergeCandidatesWithProvenance(shuffledLiked).filter(
    (candidate) => candidate.uri !== seed.uri
  )
}
```

Also remove the now-unused `scorePlaylistName` (lines 303-311), `fetchPlaylistEntries`, `fetchPlaylistTracks`, `PlaylistEntry` type, and `playlistRequestLimiter` — **only if** they are not referenced elsewhere. Check first:

Run: `npx tsc --noEmit` after the edit — if `fetchAllPlaylistTracks` (used by `shuffleEngine.ts` for playlist-mode mixes) still needs `playlistRequestLimiter`/`fetchPlaylistTracks`, keep those and delete only `fetchPlaylistEntries`, `scorePlaylistName`, `PlaylistEntry`, and the playlist-sampling block. `fetchRecentlyPlayedTracks` stays — Task 7 reuses it for the Recently-Played timestamp merge.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/profileTracks.test.ts && npx tsc --noEmit`
Expected: PASS, no unused-symbol errors.

- [ ] **Step 5: Commit**

```bash
git add src/sources/profileTracks.ts src/sources/profileTracks.test.ts
git commit -m "feat: profile pool is liked-tracks only (no recent, no playlist sampling)"
```

---

### Task 7: Playlist-membership set + central choke point + engine wiring

**Files:**
- Create: `src/services/playlistMembership.ts`
- Create: `src/services/playlistMembership.test.ts`
- Modify: `src/algorithm/filters.ts` (append `filterEligibleCandidates`)
- Modify: `src/services/shuffleEngine.ts` (wire into `buildTrackBatch`/`buildArtistPlayableBatch`/`buildPlaylistPlayableBatch` paths)
- Test: `src/algorithm/filters.test.ts` (append)

- [ ] **Step 1: Write failing tests for the membership service**

```ts
// src/services/playlistMembership.test.ts
import { beforeAll, describe, expect, it } from "vitest"
import { buildPlaylistMembershipSet } from "./playlistMembership"

beforeAll(() => {
  ;(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
    Platform: {
      RootlistAPI: {
        getContents: async () => ({
          items: [
            { type: "playlist", uri: "spotify:playlist:a", name: "Chill" },
            { type: "playlist", uri: "spotify:playlist:b", name: "Rock" },
            { type: "folder", items: [{ type: "playlist", uri: "spotify:playlist:c", name: "Nested" }] },
          ],
        }),
      },
      PlaylistAPI: {
        getContents: async (uri: string) => ({
          items:
            uri === "spotify:playlist:a"
              ? [{ uri: "spotify:track:in-a" }]
              : uri === "spotify:playlist:b"
                ? [{ uri: "spotify:track:in-b" }, { uri: "spotify:track:in-a" }]
                : [{ uri: "spotify:track:in-c" }],
        }),
      },
    },
  }
})

describe("playlist membership set", () => {
  it("unions track URIs across all playlists, including nested folders", async () => {
    const set = await buildPlaylistMembershipSet()
    expect(set.has("spotify:track:in-a")).toBe(true)
    expect(set.has("spotify:track:in-b")).toBe(true)
    expect(set.has("spotify:track:in-c")).toBe(true)
    expect(set.has("spotify:track:unrelated")).toBe(false)
    expect(set.size).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/playlistMembership.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the membership service**

Create `src/services/playlistMembership.ts`. Export the limiter for reuse by Task 7's engine wiring; reuse the `profileTracks.ts` limiter pattern (3 concurrent, 4s timeout):

```ts
import type { TrackCandidate } from "../session/types"
import { getUriId } from "../utils/uri"
import { attachSourceProvenance } from "../sources/provenance"

const MEMBERSHIP_TIMEOUT_MS = 4_000
const MEMBERSHIP_CONCURRENCY = 3

type RootlistNode = { type?: string; uri?: string; name?: string; items?: RootlistNode[] }
type PlaylistContents = {
  items?: Array<{ uri: string; isPlayable?: boolean; metadata?: Record<string, string> }>
}

const runWithTimeout = async <T>(work: () => Promise<T>, ms: number): Promise<T> =>
  await Promise.race([
    work(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ])

/** Thrown to callers is unnecessary — enumeration failure yields an empty set. */
export const buildPlaylistMembershipSet = async (): Promise<Set<string>> => {
  const membership = new Set<string>()
  try {
    const root = await runWithTimeout(
      () => Spicetify.Platform.RootlistAPI.getContents(),
      MEMBERSHIP_TIMEOUT_MS
    )
    const playlistUris: string[] = []
    const walk = (items: RootlistNode[]) => {
      for (const item of items) {
        if (item.type === "playlist" && item.uri) playlistUris.push(item.uri)
        if (item.items) walk(item.items)
      }
    }
    walk(root.items ?? [])

    let active = 0
    const waiters: Array<() => void> = []
    const acquire = async () => {
      if (active < MEMBERSHIP_CONCURRENCY) {
        active += 1
        return
      }
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    const release = () => {
      const next = waiters.shift()
      if (next) {
        next()
        return
      }
      active = Math.max(0, active - 1)
    }

    await Promise.all(
      playlistUris.map(async (playlistUri) => {
        const playlistId = getUriId(playlistUri)
        if (!playlistId) return
        await acquire()
        try {
          const res = await runWithTimeout(
            () =>
              Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
                limit: 100,
              }),
            MEMBERSHIP_TIMEOUT_MS
          )
          for (const item of res?.items ?? []) {
            if (typeof item?.uri === "string" && item.uri.startsWith("spotify:track:")) {
              membership.add(item.uri)
            }
          }
        } catch {
          // One unavailable playlist must not sink the whole set.
        } finally {
          release()
        }
      })
    )
  } catch {
    // Enumeration failed — the exclusion silently doesn't apply this session.
    return membership
  }
  return membership
}
```

Note: this file intentionally duplicates the small limiter pattern rather than importing from `profileTracks.ts`, because Task 6 may trim that file's internals. The `TrackCandidate`/`attachSourceProvenance` imports are NOT needed — remove them from the final file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/playlistMembership.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing test for the central choke point**

Append to `src/algorithm/filters.test.ts`:

```ts
import { filterEligibleCandidates } from "./filters"

describe("filterEligibleCandidates choke point", () => {
  it("applies playlist membership, blackout, and vocals match in order", () => {
    const now = Date.UTC(2026, 8, 7)
    const candidates: TrackCandidate[] = [
      { uri: "spotify:track:clean" },
      { uri: "spotify:track:in-playlist" },
      { uri: "spotify:track:recent", instrumentalness: 0.9 },
      { uri: "spotify:track:vocal", instrumentalness: 0.05 },
    ]
    const result = filterEligibleCandidates(candidates, {
      playlistMemberUris: new Set(["spotify:track:in-playlist"]),
      playHistory: [{ uri: "spotify:track:recent", playedAt: now - 2 * 24 * 60 * 60 * 1_000 }],
      requireInstrumental: true,
      seedUri: "spotify:track:seed",
      now,
    })
    expect(result.map((t) => t.uri)).toEqual(["spotify:track:clean"])
  })

  it("keeps feature-unknown candidates that look instrumental when the rule is active", () => {
    const candidates: TrackCandidate[] = [
      { uri: "spotify:track:score", albumName: "Dune (Original Motion Picture Soundtrack)" },
      { uri: "spotify:track:pop", albumName: "Pop Hits" },
    ]
    const result = filterEligibleCandidates(candidates, {
      playlistMemberUris: new Set(),
      playHistory: [],
      requireInstrumental: true,
      seedUri: "spotify:track:seed",
      now: Date.UTC(2026, 8, 7),
    })
    expect(result.map((t) => t.uri)).toEqual(["spotify:track:score"])
  })

  it("passes everything through when no rule inputs are present", () => {
    const candidates: TrackCandidate[] = [{ uri: "spotify:track:any" }]
    const result = filterEligibleCandidates(candidates, {
      playlistMemberUris: new Set(),
      playHistory: [],
      requireInstrumental: false,
      seedUri: "spotify:track:seed",
      now: Date.UTC(2026, 8, 7),
    })
    expect(result).toHaveLength(1)
  })
})
```

- [ ] **Step 6: Implement the choke point**

Append to `src/algorithm/filters.ts`. The heuristic import from `similarTracks` would create an `algorithm → sources` cycle risk; instead define the pattern locally (single source of truth lives in `similarTracks.ts`, and this is the documented duplicate used at the choke point — or, if you prefer, move the pattern to `src/utils/instrumental.ts` and import it from both places; do the latter):

Create `src/utils/instrumental.ts`:

```ts
/** Genre/album-name patterns that suggest an instrumental track. Shared by
 * the source-layer filter and the central eligibility choke point. */
export const INSTRUMENTAL_PATTERNS =
  /(soundtrack|score|classical|orchestral|ambient|instrumental|piano|string quartet|film score|movie tunes)/i

export const looksInstrumental = (input: { albumName?: string; genres?: string[] }): boolean => {
  if (input.albumName && INSTRUMENTAL_PATTERNS.test(input.albumName)) return true
  if (input.genres?.some((genre) => INSTRUMENTAL_PATTERNS.test(genre))) return true
  return false
}

export const SEED_INSTRUMENTALNESS_THRESHOLD = 0.9
export const CANDIDATE_INSTRUMENTALNESS_FLOOR = 0.5
```

Update `src/sources/similarTracks.ts` to import `looksInstrumental`, `SEED_INSTRUMENTALNESS_THRESHOLD`, `CANDIDATE_INSTRUMENTALNESS_FLOOR` from `../utils/instrumental` and re-export them (keep the existing export sites so Task 5's tests keep passing), deleting the local duplicates added in Task 5 step 3a.

Then append to `src/algorithm/filters.ts`:

```ts
import { looksInstrumental, CANDIDATE_INSTRUMENTALNESS_FLOOR } from "../utils/instrumental"

export type EligibilityContext = {
  playlistMemberUris: ReadonlySet<string>
  playHistory: readonly PlayHistoryEntry[]
  requireInstrumental: boolean
  seedUri: string
  now: number
}

/**
 * Central choke point every candidate pool passes through before ranking:
 * playability → seed/canonical exclusion → 14-day blackout → playlist
 * membership → vocals match. Playlist membership and vocals match are hard,
 * non-relaxable stages.
 */
export const filterEligibleCandidates = (
  candidates: TrackCandidate[],
  context: EligibilityContext
): TrackCandidate[] => {
  let pool = filterPlayableCandidates(candidates).filter(
    (candidate) => candidate.uri !== context.seedUri
  )
  pool = applyRecentPlayBlackout(pool, context.playHistory, context.now)
  if (context.playlistMemberUris.size > 0) {
    pool = pool.filter((candidate) => !context.playlistMemberUris.has(candidate.uri))
  }
  if (context.requireInstrumental) {
    pool = pool.filter((candidate) => {
      if (candidate.instrumentalness !== undefined) {
        return candidate.instrumentalness >= CANDIDATE_INSTRUMENTALNESS_FLOOR
      }
      return looksInstrumental(candidate)
    })
  }
  return pool
}
```

- [ ] **Step 7: Run choke-point tests**

Run: `npx vitest run src/algorithm/filters.test.ts`
Expected: PASS.

- [ ] **Step 8: Wire into the engine**

In `src/services/shuffleEngine.ts`:

8a. Add module-level membership state with background refresh (near the prefetch state, ~line 340):

```ts
import { buildPlaylistMembershipSet } from "./playlistMembership"
import { isSeedInstrumental } from "../utils/instrumental"

let playlistMembership: Set<string> = new Set()
let membershipRefreshInFlight: Promise<void> | null = null

const refreshPlaylistMembership = (): Promise<void> => {
  if (membershipRefreshInFlight) return membershipRefreshInFlight
  membershipRefreshInFlight = (async () => {
    try {
      playlistMembership = await buildPlaylistMembershipSet()
    } catch {
      // Keep previous set; exclusion silently doesn't apply.
    }
  })()
  return membershipRefreshInFlight.finally(() => {
    membershipRefreshInFlight = null
  })
}
```

8b. Build eligibility context and apply the choke point inside `buildPlayableBatch` (the track-session branch, after `ensurePools` at line 256) and inside `buildArtistPlayableBatch` (after `fetchSimilarPool` at line 200) and `buildPlaylistPlayableBatch` (after `fetchPlaylistSimilarPool` at line 139). The same snippet applies at each site, differing only in pool variables:

```ts
  const seed = sessionManager.getSeed()!
  const eligibilityContext = {
    playlistMemberUris: playlistMembership,
    playHistory: sessionManager.getPlayHistoryEntries(),
    requireInstrumental: isSeedInstrumental(seed),
    seedUri: seed.uri,
    now: Date.now(),
  }
  const similar = filterEligibleCandidates(similarRaw, eligibilityContext)
  const profile = filterEligibleCandidates(profileRaw, eligibilityContext)
```

(Where `similarRaw`/`profileRaw` are the pools as fetched. In artist mode, `profilePool` = artist tracks: apply the choke point with `requireInstrumental` still honoring the seed. In playlist mode, apply to `similarPool` only — playlist tracks are references, not outputs.)

Add `getPlayHistoryEntries` to `sessionManager` (next to `getPlayHistory` at line 187):

```ts
  getPlayHistoryEntries: () => loadPlayHistory(playHistoryStorageKey),
```

(import `loadPlayHistory` — already imported at line 13.)

8c. Kick off the membership build at mix start and refresh on refill. In `startShuffleSimilar` (after `sessionManager.initializeTasteIdentity()`, line 548):

```ts
  if (playlistMembership.size === 0) void refreshPlaylistMembership()
```

In `runRefillQueueIfNeeded` (before `buildPlayableBatch` call, ~line 653):

```ts
    void refreshPlaylistMembership()
```

8d. Merge Spotify Recently Played timestamps at mix start. Extend `startShuffleSimilar` after the membership kick-off:

```ts
  await mergeRecentlyPlayedIntoHistory()
```

Implement it in `src/storage/settings.ts` (appended; import `fetchRecentlyPlayedTracks` from `../sources/profileTracks` — **note: this creates a storage→sources import; if that cycle is a problem (settings is imported by sources), instead place the merge in `src/session/SessionManager.ts`, which already imports both sides cleanly. Prefer the SessionManager placement.**):

```ts
// In src/session/SessionManager.ts:
  mergeRecentlyPlayedIntoHistory: async (): Promise<void> => {
    try {
      const recent = await fetchRecentlyPlayedTracksWithTimestamps()
      for (const entry of recent) {
        appendPlayHistory(entry.uri, 400, playHistoryStorageKey, entry.playedAt)
      }
    } catch {
      // Recently-played merge is best-effort.
    }
  },
```

And add `fetchRecentlyPlayedTracksWithTimestamps` to `src/sources/profileTracks.ts` (it mirrors `fetchRecentlyPlayedTracks` at line 150, keeping `played_at`):

```ts
export type RecentlyPlayedEntry = { uri: string; playedAt: number }

export const fetchRecentlyPlayedTracksWithTimestamps = async (): Promise<
  RecentlyPlayedEntry[]
> => {
  try {
    const response = await runWithTimeout(
      () =>
        Spicetify.CosmosAsync.get(
          "https://api.spotify.com/v1/me/player/recently-played?limit=50"
        ),
      PROFILE_SOURCE_TIMEOUT_MS
    )
    return (response?.items ?? [])
      .map((item: any) => ({
        uri: item?.track?.uri as string | undefined,
        playedAt: Date.parse(item?.played_at ?? "") || 0,
      }))
      .filter(
        (entry): entry is RecentlyPlayedEntry =>
          Boolean(entry.uri?.startsWith("spotify:track:")) && entry.playedAt > 0
      )
  } catch {
    return []
  }
}
```

Wait — `SessionManager.ts` imports from `../sources/profileTracks` would create a new sources→session? No: `profileTracks` imports from `session/types` (type-only) and `sources/*` — no cycle. But `SessionManager` importing `profileTracks` is fine (nothing in sources imports SessionManager). Add the import.

- [ ] **Step 9: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/services/playlistMembership.ts src/services/playlistMembership.test.ts src/algorithm/filters.ts src/algorithm/filters.test.ts src/services/shuffleEngine.ts src/session/SessionManager.ts src/sources/profileTracks.ts src/utils/instrumental.ts
git commit -m "feat: playlist-membership exclusion and central eligibility choke point"
```

---

### Task 8: Evaluation harness update + full verification

**Files:**
- Modify: `src/evaluation/recommendationQuality.test.ts` (append)
- Modify: `README.md` (update behavior description, if the "What 2.1 does" bullets change materially)

- [ ] **Step 1: Write the new evaluation assertions**

Append to `src/evaluation/recommendationQuality.test.ts`:

```ts
describe("seed-anchored mix quality", () => {
  it("keeps steady-state blends majority similar-family at position 20+", () => {
    const ranked = rankCandidatesV2(fixture(0), {
      componentWeights: {
        fusion: 0.2,
        context: 0.2,
        taste: 0.12,
        acoustic: 0.1,
        novelty: 0.13,
        feedback: 0.25,
      },
    })
    const plan = planSlateV2(ranked, {
      count: 20,
      absoluteStartPosition: 20,
      blendPhases: [
        { maxPosition: 4, similar: 1, profile: 0 },
        { maxPosition: 9, similar: 0.85, profile: 0.15 },
        { maxPosition: 19, similar: 0.75, profile: 0.25 },
        { maxPosition: Number.POSITIVE_INFINITY, similar: 0.7, profile: 0.3 },
      ],
    })
    const similarFamily = plan.items.filter((item) => item.dominantFamily === "similar").length
    expect(similarFamily / plan.items.length).toBeGreaterThanOrEqual(0.6)
  })

  it("blackout filter never returns recently played tracks when the pool is healthy", () => {
    const now = Date.UTC(2026, 8, 7)
    const candidates = Array.from({ length: 30 }, (_, i) => ({ uri: `spotify:track:c-${i}` }))
    const history = [
      { uri: "spotify:track:c-0", playedAt: now - 1 * 24 * 60 * 60 * 1_000 },
      { uri: "spotify:track:c-1", playedAt: now - 2 * 24 * 60 * 60 * 1_000 },
    ]
    const result = applyRecentPlayBlackout(candidates, history, now)
    expect(result.map((t) => t.uri)).not.toContain("spotify:track:c-0")
    expect(result.map((t) => t.uri)).not.toContain("spotify:track:c-1")
    expect(result).toHaveLength(28)
  })
})
```

(Add `applyRecentPlayBlackout` to the imports from `../algorithm/filters` at the top of the file.)

- [ ] **Step 2: Run evaluation tests**

Run: `npx vitest run src/evaluation/recommendationQuality.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite, typecheck, lint, build**

Run: `npm test && npm run typecheck && npm run lint && npm run build-local`
Expected: all PASS, bundle built at `dist/better-shuffle.js`.

- [ ] **Step 4: Update README bullets**

In `README.md`, update the "What 2.1 does" list to reflect: seed-anchored blend (70% similar steady state), 14-day replay blackout, playlist-member exclusion, instrumental-seed rule. Keep the existing style — replace the "progressive library blending" bullet with:

```md
- Plans the queue as a complete slate: canonical duplicate removal, artist and album spacing, source coverage, seed-anchored blending (70% seed-similar steady state), and acoustic transition pacing
- Excludes tracks heard in the last 14 days, tracks already in your playlists, and — for instrumental seeds — any track with vocals
```

- [ ] **Step 5: Commit**

```bash
git add src/evaluation/recommendationQuality.test.ts README.md
git commit -m "test: seed-anchored mix quality evaluation; docs refresh"
```

---

## Self-Review (completed)

**Spec coverage:** Section 1 (blend) → Task 3. Section 2 (blackout) → Tasks 1, 2, 7d. Section 3 (gate) → Task 4. Section 4 (profile pool) → Task 6. Section 5 (playlist membership) → Tasks 6, 7. Section 6 (instrumental) → Tasks 5, 7. Section 7 (choke point) → Task 7. Section 9 (testing/eval) → Tasks 1-8 + Task 8 eval. All spec sections have tasks.

**Placeholder scan:** Task 7 Step 8b says "The same snippet applies at each site, differing only in pool variables" — this is acceptable because the exact code is shown once with the substitution rule stated; the engineer can apply it mechanically. Task 6 Step 3 contains a conditional instruction (delete-unused-only-if) with the exact check command (`npx tsc --noEmit`) — acceptable as a guarded instruction, not a placeholder.

**Type consistency:** `PlayHistoryEntry` defined Task 1, used Tasks 2, 7. `filterEligibleCandidates`/`EligibilityContext` defined Task 7, consumed same task. `isSeedInstrumental` defined Task 5 (3a), moved to `src/utils/instrumental.ts` in Task 7 Step 6 with re-exports preserved. `getPlayHistoryEntries` added Task 7-8b. `fetchRecentlyPlayedTracksWithTimestamps` defined Task 7-8d, consumed same step. `recentPlayPenalty`/`applyRecentPlayBlackout` defined Task 2, used Tasks 7, 8. `CANDIDATE_INSTRUMENTALNESS_FLOOR` defined Task 5, centralized Task 7, used Task 7 choke point.

**Known risk:** Task 7 Step 8d's SessionManager→profileTracks import — verified no cycle (profileTracks imports only `session/types`, `algorithm/*`, `sources/*`, `utils/*`). Task 6's deletion step guarded by typecheck.
