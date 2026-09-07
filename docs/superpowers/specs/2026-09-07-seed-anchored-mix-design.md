# Seed-Anchored Similar Mix — Design

**Date:** 2026-09-07
**Status:** Approved in conversation; pending spec review
**Scope:** `src/algorithm/`, `src/sources/`, `src/services/`, `src/storage/`, `src/session/`

## Problem

Two user-reported symptoms, sharing root causes:

1. **Replays** — the mix surfaces songs heard many times recently.
2. **Unrelated tracks** — the mix drifts away from the seed's sound.

Root causes found in code:

- `blendPhases` in `src/storage/settings.ts` ramps to 80% "profile" family by position 20; profile family = liked tracks, playlist tracks, recently-played.
- `fetchProfilePool` (`src/sources/profileTracks.ts`) merges recently-played tracks with **no seed-relevance filter**.
- Ranking weights (`recommendationPlannerV2.ts`): taste 0.17 outranks context/seed similarity 0.12.
- Familiarity only feeds a 40% discovery *floor* — 60% of any window may be well-known tracks.

Two additional hard rules requested by the user:

3. **Playlist-membership exclusion** — a track in any of the user's playlists may never enter the generated queue (seed track excepted).
4. **Instrumental-seed vocals exclusion** — an instrumental seed (e.g. a movie score) must produce an instrumental-only mix.

## Goals

- A Similar Mix that always sounds like its seed, at any session length.
- No replays of recently heard tracks (14-day hard blackout).
- No playlist-member tracks in the generated queue, ever.
- Instrumental seeds produce instrumental-only mixes.
- Preserve existing infrastructure: relaxation ladders, degraded modes, diagnostics, bounded storage, tests.

## Non-Goals

- No UI/tuning panels (README philosophy: "no preference forms").
- No changes to taste-profile learning semantics (only its ranking weight changes).
- No changes to queue mutation, session recovery, autoplay guard, or UI states.
- Discovery floor (40%), artist/album spacing, MMR redundancy, acoustic pacing — unchanged.

---

## Section 1 — Blend schedule

**Current:** positions 1–4 pure similar → 20+ is 80% profile.

**New:**

| Phase | Positions | Similar | Profile |
|---|---|---|---|
| 1 | 1–4 | 1.0 | 0.0 |
| 2 | 5–9 | 0.85 | 0.15 |
| 3 | 10–19 | 0.75 | 0.25 |
| 4 | 20+ | 0.70 | 0.30 |

Steady state stays **70% seed-similar** forever. Library tracks still appear (~30%) for variety but are gated (Section 3) and can never dominate. `planSlateV2` already enforces blend deficits from settings phases — no planner changes needed.

Artist sessions (discography-as-profile-pool) inherit the new weights automatically.

## Section 2 — Recent-play blackout (14 days, time-accurate)

**Storage:** `shuffleSimilar:playHistory` upgrades from `string[]` to `{ uri, playedAt }[]` (MRU-first, cap 400 entries, ≤512 KB — same bounds discipline as the taste profile). Loader auto-migrates: timestamp-less entries get `playedAt: 0` (eligible but penalized).

**Rule at candidate-filter time:**

- `playedAt` within 14 days → hard exclude (dropped before ranking)
- 14–45 days → score penalty scaling linearly −0.35 → 0
- older → no effect

**Timestamp sources:**

1. `appendPlayHistory` now writes timestamps (primary).
2. Spotify Recently Played API (`me/player/recently-played`, once at mix start) merged into the same ledger — catches plays from other devices the plugin cannot observe.

Empty ledger (fresh install) → no blackout.

**Pool-exhaustion safety:** if hard exclusion would leave fewer than 15 eligible candidates, blackout relaxes to penalty-only for the oldest portion (reuses the `buildHistoryRelaxedExclusions` pattern in `shuffleEngine.ts`).

## Section 3 — Seed-relevance gate

- **Hard gate at ranking input:** candidates with context affinity < 0.15 are removed from the ranked pool entirely (profile family included). `contextAffinity()` already exists in `recommendationPlannerV2.ts` — enforce its floor.
- **Reweight:** context 0.12→0.20, taste 0.17→0.12, feedback 0.35→0.25, fusion 0.2 (unchanged), acoustic 0.08→0.10, novelty 0.08→0.13. Sums to exactly 1.0.
- **Safety valve:** if the gate would remove >60% of the pool, floor relaxes to 0.08 rather than returning an empty mix; emits `relax:relevance-gate` reason code.

Effect: no matter how much the taste profile loves a track, it cannot enter the mix if it does not sound like the seed.

## Section 4 — Profile pool surgery

1. **Remove `recent` (recently-played) from `fetchProfilePool`** — a source of "what you just heard" can only produce replays by construction. Liked tracks remain; the playlist-sampling source is also dropped (Section 5.3 makes its candidates ineligible anyway).
2. `sortByObscurity` stays for pool ordering (serves discovery).
3. Artist sessions: discography-as-profile-pool stays legitimate; the gate uses acoustic distance to the seed, which discography naturally passes.

## Section 5 — Playlist-membership exclusion (hard, non-relaxable)

**Rule:** a track appearing in any playlist the user owns or follows (per `RootlistAPI.getContents()`) can never enter the Similar Mix queue. Seed track is the sole exemption (plays first; already excluded from the generated queue).

**Implementation:**

1. **Membership set built once per mix**, rebuilt in the background on each refill batch (non-blocking; previous set used until refresh completes): enumerate playlists via existing `fetchPlaylistEntries()`, fetch each playlist's tracks via existing `PlaylistAPI.getContents` (reusing `playlistRequestLimiter`), union all URIs into a `Set`. Cached per session with the same invalidation lifecycle as the pools.
2. **Filter location:** the central `filterEligibleCandidates()` choke point (Section 7/8 ordering).
3. **Profile pool consequence:** with playlist tracks excluded everywhere, `fetchProfilePool` drops the playlist-sampling source entirely (all its candidates would be filtered anyway — no wasted fetches). Profile family = liked tracks + taste profile only. **Liked Songs is NOT a playlist for this rule** (user decision).
4. **Playlist-mode mixes:** source-playlist members are already excluded; the rule extends this to all user playlists. Consistent.
5. **Failure mode:** if playlist enumeration fails, the exclusion silently doesn't apply that session — mix proceeds. Enhancement, not blocker.
6. **Cost:** up to N playlist fetches at mix start (3 concurrent, 4s timeout each, same budget the profile pool spends today). Concurrent with existing pool fetches — no critical-path latency added.
7. **Non-relaxable:** if discovery sources come up short, the queue is shorter, never playlist members. Accepted trade-off (user decision: "Spotify has over 100 million songs").

Diagnostics: `filter:playlist-member` reason code.

## Section 6 — Instrumental-seed vocals exclusion (hard, non-relaxable)

**Rule:** if the seed's `instrumentalness ≥ 0.9` (Spotify's instrumental convention), every candidate must have `instrumentalness ≥ 0.5` (matches the 0.5 constant the existing vocal-protection rule uses). Feature-unknown candidates pass a genre/album heuristic.

**Existing context:** `filterInstrumentalsAndSoundtracks` (`similarTracks.ts`) already implements vocal-seed → drop-instrumentals and non-soundtrack-seed → drop-soundtrack-albums. The inverse branch (instrumental seed) does not exist; this section adds it.

**Implementation, layered:**

1. **API level (primary discovery):** when the seed is instrumental, recommendations requests add `min_instrumentalness=0.5` — vocal tracks never get recommended. Extends existing `target_tempo/energy/valence` parameter logic.
2. **Pool level:** new inverse branch in `filterInstrumentalsAndSoundtracks`: `isSeedInstrumental = seed.instrumentalness >= 0.9` → drop candidates with `instrumentalness < 0.5`. When the seed is instrumental, the soundtrack-leakage filter flips to *allow* soundtrack/score albums (a score seed should surface scores).
3. **Feature-unknown heuristic:** no features → keep only if genres or album name suggest instrumental (curated regex list: `soundtrack`, `score`, `classical`, `orchestral`, `ambient`, `instrumental`, jazz-instrumental family; unit-tested). Otherwise drop. Keeps the rule hard without feature data.
4. **Enrichment budget bump:** when the rule is active, per-pass feature-enrichment cap rises 12→60 so feature-based decisions cover most of the pool; heuristic covers the rest. Cache unchanged.
5. **Central choke point:** also runs at `filterEligibleCandidates()` (profile/liked/artist pools bypass `similarTracks`).
6. **Playlist/album mixes:** majority vote across sampled seeds (≥ half with `instrumentalness ≥ 0.9` → apply), mirroring existing `isPlaylistVocal` majority logic.
7. **Neutral zone:** seeds with `0.2 ≤ instrumentalness < 0.9` trigger neither this rule nor existing vocal protection — unchanged behavior.
8. **Non-relaxable:** instrumental seed with empty pool → shorter queue, never vocal tracks.

Diagnostics: `filter:vocal-track` reason code.

## Section 7 — Candidate filter pipeline (single choke point)

All pools (similar, profile/liked, artist discography, playlist candidates) pass through one ordered filter before ranking:

1. Playability
2. Seed URI / canonical duplicates
3. 14-day blackout (Section 2)
4. Playlist membership (Section 5)
5. Relevance gate (Section 3)
6. Vocals match (Section 6)

Each stage emits its reason code when it drops candidates. Relaxable stages (blackout, relevance gate) keep their relaxation logic; hard stages (playlist membership, vocals match) never relax.

## Section 8 — What is NOT changing

- Taste profile learning (outcomes still recorded); only ranking weight drops 0.17→0.12.
- Queue mutation, session recovery, autoplay guard, native-shuffle suppression, UI states.
- Discovery floor (40%), artist spacing (3), album spacing, MMR redundancy, acoustic transition pacing (0.42), relaxation ladder order.
- Degraded-mode source handling, circuit breakers, source quorum behavior.

## Section 9 — Testing & verification

**Unit tests:**

- Blackout filter: 14d exclusion, 14–45d decay curve, migration from `string[]`, relaxation under thin pools.
- Relevance gate: floor enforcement, >60% relaxation trigger, `relax:relevance-gate` code.
- Playlist-membership: exclusion from all pools, seed exemption, enumeration-failure passthrough.
- Instrumental rule: 0.9/0.5 thresholds, heuristic regex list, enrichment-cap bump, playlist majority vote, neutral zone.
- New blend weights: steady state ≥60% similar-family at position 20+.
- Reweight arithmetic: component weights sum to 1.0.

**Regression:** existing `recommendationPlannerV2.test.ts` blend/discovery-floor tests updated to new expectations; full suite green (`npm test`).

**Evaluation:** extend `src/evaluation/recommendationQuality.test.ts` — assert seed-affinity of generated slates improves vs baseline while discovery-eligible ratio stays ≥40%.

**Manual:** `npm run build-local`, run in Spotify, start a mix from a track: early tracks sound like the seed; no track from the last two weeks; no playlist members; movie-score seed → instrumental-only mix.

## Implementation surface (files)

| File | Change |
|---|---|
| `src/storage/settings.ts` | New `blendPhases`; timestamped play-history (schema, migration, cap) |
| `src/sources/profileTracks.ts` | Drop `recent` + playlist-sampling from `fetchProfilePool`; expose playlist-membership fetch |
| `src/sources/similarTracks.ts` | Instrumental branch in `filterInstrumentalsAndSoundtracks`; `min_instrumentalness` param; enrichment cap bump |
| `src/algorithm/recommendationPlannerV2.ts` | Reweight; relevance gate + `relax:relevance-gate` |
| `src/algorithm/filters.ts` | `filterEligibleCandidates()` ordered pipeline |
| `src/services/shuffleEngine.ts` | Wire membership set, blackout ledger, Recently-Played merge, relaxed-exclusion path |
| `src/session/SessionManager.ts` | Timestamped play history reads/writes |
| Tests | New + updated expectations per Section 9 |
