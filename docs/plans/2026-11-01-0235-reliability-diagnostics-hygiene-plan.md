# Reliability, Diagnostics and Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Similar Mix's queue handling event-driven and regression-tested against a laggy Spotify, make failures diagnosable, and clear the repository hygiene backlog.

**Architecture:** One `queueState` module becomes the only code that reads Spotify queue internals and waits on Spotify's `queue_update` event, with polling as a fallback. A reusable fake Spotify with configurable lag backs the unit tests, and a CDP smoke script checks the real app. A bounded in-memory operation log feeds a "Copy diagnostics" action and short error reference codes.

**Tech Stack:** TypeScript (strict), Vitest 4, Biome 2.5, esbuild, Node >=22, Spicetify extension API, GitHub Actions, `gh` CLI.

**Spec:** The six recommendations accepted on 2026-11-01 (restated as R1-R6 below). No separate design document.

## Requirements

- **R1** Queue handling must not depend on fixed sleeps or scattered private Spotify state.
- **R2** Queue tests must exercise a Spotify whose state lags its own promises, and a live smoke check must exist.
- **R3** Every queue failure must leave a diagnosable trail without leaking listening data.
- **R4** One name per user-facing action.
- **R5** Zero lint warnings, no stale Dependabot PRs, tagged releases built by CI, `shuffleEngine.ts` split by responsibility.
- **R6** The seed-anchored work lands in small reviewable PRs and then ships.

## Observed Spotify behaviour (measured on Spotify 1.3.6, Spicetify 2.46.4)

These facts drive the design. The fake Spotify in Task 2 must reproduce them.

- `PlayerAPI.clearQueue()` and `addToQueue()` resolve **before** local queue state changes; state follows 130-880 ms later.
- Spotify emits `queue_update` on `Spicetify.Platform.PlayerAPI._events` once per operation, about 150 ms after it. `event.data` is `{ current, queued, nextUp }`. When it fires, `Spicetify.Queue.nextTracks` and `PlayerAPI._queue._queue.nextTracks` are already updated.
- A multi-track `addToQueue` rewrites from the local snapshot, so adding during the lag window re-adds stale queued tracks.
- On `songchange`, `Spicetify.Queue.nextTracks[0]` still lists the new current track for 50-100 ms.
- During playback a clear issued right after a track change was not reflected within 2 s and needed a second clear (inferred cause: stale queue revision; not proven).
- Queued entries have `provider === "queue"`; Spotify's own `isQueued` is exactly that test.

## Global Constraints

- Formatting is enforced by Biome: 2 spaces, double quotes, no semicolons, trailing commas `es5`, line width 100.
- TypeScript `strict`; no new runtime dependencies; Node >=22.
- Prefer public Spicetify APIs. Private Spotify internals may be touched only inside `src/queue/queueState.ts` after Task 4.
- `shuffle-similar.js` at the repo root is the committed release bundle. Any commit that changes `src/**` or `package.json` version must include the bundle rebuilt with `npm run build:release`. CI fails on a stale bundle.
- Every task ends green on: `npm run lint`, `npm run typecheck`, `npm test`, `npm run check:bundle`.
- Do not bump the version outside Task 14.
- Git pushes and `gh` commands must run from the Windows PowerShell tool in the project folder. The Linux shell has no GitHub credentials. Local files are shared between both.
- Live checks need Spotify started with `--remote-debugging-port=9222`. Restart it normally afterwards so the port is closed.
- Commit messages end with the attribution lines the session supplies.
- Never edit `shuffle-similar.js` by hand and never `git push --force`.

## Review Focus

1. A queue operation that Spotify silently drops, so `queue_update` never fires: waits must be bounded, retry once, then continue to verification. Never hang, never throw a new error (Tasks 3, 4).
2. A Spotify build with no `queue_update` event or no `Spicetify.Queue`: the reader returns an empty snapshot instead of throwing, and polling still resolves waits (Task 3).
3. The playing track appears at the queue head and is legitimately queued again later: only the head copy may be ignored by the foreign-track guard (Task 4).
4. Toggle, refresh, context menu or refill collide with a track change: operations stay serialized, with no interleaved clear/add pairs (Task 4).
5. Diagnostics must never contain track URIs, account IDs or taste data (Task 6).

---

### Task 1: Clear the Dependabot backlog

**Files:**
- Modify: `.github/workflows/ci.yml` (only if the action bumps require it), `package.json`, `package-lock.json`, `shuffle-similar.js` (only if the esbuild bump changes bundle output)

**Interfaces:** none.

- [ ] **Step 1:** List the three open Dependabot PRs: `gh pr list --state open` (actions/checkout 4 to 7, actions/setup-node 4 to 7, dev-dependencies group of 4).
- [ ] **Step 2:** For each Actions PR, comment `@dependabot rebase`, wait for CI, and merge with `gh pr merge <n> --squash` only when `gh pr checks <n>` is all green.
- [ ] **Step 3:** For the dev-dependencies PR, check out its branch and run `npm ci && npm run lint && npm run typecheck && npm test && npm run build:release`. If `git diff --quiet -- shuffle-similar.js` fails, commit the rebuilt bundle to that branch.
- [ ] **Step 4:** Merge it, pull `main`, and confirm `gh run list --branch main --limit 1` shows `success`.
- [ ] **Step 5:** Record the merged PR numbers in the final summary. Nothing else to commit.

### Task 2: Fake Spotify test harness (R2)

**Files:**
- Create: `src/test/fakeSpotify.ts`, `src/test/fakeSpotify.test.ts`

**Interfaces:**
- Produces:
  - `type FakeSpotifyOptions = { applyDelayMs?: number /* default 150 */; headLagMs?: number /* default 80 */; contextTail?: string[]; dropWhileStale?: boolean /* default false */; emitQueueUpdate?: boolean /* default true */ }`
  - `type FakeSpotify = { install(): void; queued(): string[]; upcoming(): string[]; playing(): string | null; nextTrack(): void; fireSongChange(): void; operations: Array<{ op: "clear" | "add"; count: number; atMs: number }> }`
  - `createFakeSpotify(options?: FakeSpotifyOptions): FakeSpotify`
- `install()` calls `vi.stubGlobal("Spicetify", ...)` providing `Queue.nextTracks`, `Player.data`, `Player.addEventListener`, `Platform.PlayerAPI.{clearQueue,addToQueue,play,_queue,_events}`. `_events.addListener/removeListener("queue_update", cb)` must work. Timers use `setTimeout`, so tests drive it with `vi.useFakeTimers()`.

- [ ] **Step 1: Write failing tests** in `fakeSpotify.test.ts`, each using fake timers:
  - `clearQueue resolves before state changes`: after `await clearQueue()`, `queued()` is still the old list; after `advanceTimersByTime(150)` it is `[]`.
  - `addToQueue during the lag window re-adds stale queued tracks` (pins the 80/33 mechanism).
  - `nextTrack lists the new current track at index 0 for headLagMs only`.
  - `queue_update fires once per operation after applyDelayMs, with public queue already updated`.
  - `dropWhileStale ignores a clear issued inside the lag window`.
- [ ] **Step 2:** Run `npx vitest run src/test/fakeSpotify.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3:** Implement `createFakeSpotify` in `src/test/fakeSpotify.ts` as a small state machine: a committed list, a pending update scheduled with `setTimeout(applyDelayMs)`, and `provider: "queue" | "context"` per entry (queued entries first, then `contextTail`).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** `npm run lint && npm run typecheck`, then commit `test: add lagging fake Spotify harness`.

### Task 3: `queueState` module (R1)

**Files:**
- Create: `src/queue/queueState.ts`, `src/queue/queueState.test.ts`

**Interfaces:**
- Consumes: `createFakeSpotify` from Task 2.
- Produces:
  - `type QueueEntry = { uri: string; provider: string | null }`
  - `type QueueSnapshot = { entries: QueueEntry[]; revision: string | null; source: "public" | "internal" | "none" }`
  - `readQueueSnapshot(): QueueSnapshot` reads `Spicetify.Queue.nextTracks`, falls back to `Spicetify.Platform.PlayerAPI._queue._queueState` (`nextUp` then `queued`), and **never throws**.
  - `queuedUris(snapshot?: QueueSnapshot): string[]` returns entries with `provider === "queue"`, deduped, in order.
  - `waitForQueue(predicate: (s: QueueSnapshot) => boolean, options: { timeoutMs: number; pollMs?: number }): Promise<{ met: boolean; snapshot: QueueSnapshot }>`

- [ ] **Step 1: Write failing tests:**
  - `resolves immediately when the predicate already holds`.
  - `resolves on queue_update without polling` (fake with `applyDelayMs: 150`, `pollMs: 10_000`; resolves by about 150 ms).
  - `falls back to polling when no queue_update event is emitted` (`emitQueueUpdate: false`, `pollMs: 25`).
  - `returns met:false at timeoutMs and removes its listener` (assert the listener count is zero afterwards).
  - `readQueueSnapshot returns source "none" and does not throw when Spicetify.Queue and _queue are missing` (Review Focus 2).
- [ ] **Step 2:** `npx vitest run src/queue/queueState.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `waitForQueue` evaluates the predicate first, then subscribes via `Spicetify.Platform.PlayerAPI._events.addListener("queue_update", cb)` (skip silently if absent), re-evaluates on each event and each `pollMs` tick (default 100), and always unsubscribes and clears timers on exit.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5:** Lint, typecheck, commit `feat: add event-driven queue state reader`.

### Task 4: Migrate queue code onto `queueState` (R1, R2)

**Files:**
- Modify: `src/queue/queueManager.ts` (`getRawUpcomingQueueUris` ~L155, `countLocallyQueuedEntries` ~L195, `waitForQueueClearToSettle` ~L210, `readPrivateUpcomingQueueUris` ~L320, `waitForQueueConvergence` ~L370, the `wait(100)`/`wait(250)`/`wait(400)` sites)
- Modify: `src/queue/queueManager.test.ts`, `src/queue/autoplayGuard.test.ts`, `src/queue/queueMutationCoordinator.test.ts`

**Interfaces:**
- Consumes: `readQueueSnapshot`, `queuedUris`, `waitForQueue` (Task 3); `createFakeSpotify` (Task 2).
- Produces: `export const QUEUE_TIMING: { readonly clearSettleMs: 2_000; readonly operationTimeoutMs: 5_000; readonly postVerifyGuardMs: 250; readonly afterPlayDelayMs: 400 }` in `queueManager.ts`; no other exported function changes name or signature.

- [ ] **Step 1: Write failing regression tests on the fake** in `queueManager.test.ts` (replace the hand-rolled lag test; keep all other existing tests):
  - `replace does not re-add stale queued tracks when the clear lags` (the 80/33 case; assert final queue equals the requested mix and `commit.verified`).
  - `replace continues when queue_update never arrives for a clear` (`dropWhileStale: true`; one retry, then verification decides; no throw).
  - `fresh takeover accepts a context tail after the full mix`.
- [ ] **Step 2:** In `autoplayGuard.test.ts` add `drops only one copy of the playing track from the head` (queue `[playing, a, playing]`: the second copy is still treated as upcoming; Review Focus 3).
- [ ] **Step 3:** In `queueMutationCoordinator.test.ts` add `concurrent replaceUpcomingQueue calls never interleave` using the fake: `operations` reads `clear, add, clear, add` (Review Focus 4).
- [ ] **Step 4:** Run `npx vitest run src/queue`. Expected: new tests FAIL or are unreachable until migration.
- [ ] **Step 5:** Migrate `queueManager.ts` onto `queueState`: delete `readPrivateUpcomingQueueUris` and `countLocallyQueuedEntries`; implement `waitForQueueClearToSettle` as `waitForQueue((s) => queuedUris(s).length === 0, { timeoutMs: QUEUE_TIMING.clearSettleMs })`; rebuild `waitForQueueConvergence` on `waitForQueue` while keeping its strict/stableReads semantics and its return shape. Reword the comment that mentions `_queue._client.setQueue`.
- [ ] **Step 6:** Verify isolation: `grep -rn "_queueState\|_queue?\._queue\|_queue\._client\|_queue\._events" src --include=*.ts | grep -v "\.test\."` lists only `src/queue/queueState.ts`.
- [ ] **Step 7:** `npm test` (all existing suites plus the new ones pass), `npm run build:release`, `npm run check:bundle`.
- [ ] **Step 8:** Commit `refactor: route all Spotify queue reads and waits through queueState`.

### Task 5: Live smoke script (R2)

**Files:**
- Create: `scripts/smoke-spotify.mjs`
- Modify: `package.json` (`"smoke": "node scripts/smoke-spotify.mjs"`), `README.md` (Development section)

**Interfaces:** CLI only. Exit code 0 when every check passes.

- [ ] **Step 1:** Implement the script. It connects over CDP to `http://127.0.0.1:9222/json` (Node's global `fetch` and `WebSocket`), evaluates in the `xpui` page, mutes volume first and restores volume and pause state in a `finally`. Checks, each printed as `PASS <name>` or `FAIL <name>: <detail>`:
  - `extension loaded`: the `[data-testid="shuffle-similar-button"]` element exists.
  - `enable builds a mix`: after clicking it, the status capsule reaches `on` within 30 s and `Spicetify.Queue.nextTracks` holds more than 20 entries with `provider === "queue"`.
  - `no queue rebuild on track change`: wrap `PlayerAPI.clearQueue` and `addToQueue`, call `Spicetify.Player.next()` three times with 6 s between, and assert zero calls to either and a queued count that shrinks by at most 1 per skip.
  - `no unexpected notification`: no `showNotification` call during the skips.
- [ ] **Step 2:** Document in `README.md`: start Spotify with `--remote-debugging-port=9222`, play any track, run `npm run smoke`.
- [ ] **Step 3:** Run it against the live app. Expected: four `PASS` lines, exit 0.
- [ ] **Step 4:** Prove it detects the old bug: install the v2.1.2 bundle (`gh release download v2.1.2 -p shuffle-similar.js`), reload Spotify, run `npm run smoke`. Expected: at least one `FAIL`. Reinstall the current bundle afterwards.
- [ ] **Step 5:** Commit `test: add live Spotify smoke script`.

### Task 6: Operation log and diagnostics report (R3)

**Files:**
- Create: `src/diagnostics/operationLog.ts`, `src/diagnostics/operationLog.test.ts`, `types/build.d.ts`
- Modify: `esbuild.config.mjs` (add `define: { __SHUFFLE_SIMILAR_VERSION__: JSON.stringify(version) }`), `src/queue/queueManager.ts`, `src/services/shuffleEngine.ts`

**Interfaces:**
- Produces:
  - `type OperationRecord = { at: number; op: string; outcome: "ok" | "retry" | "timeout" | "failed" | "info"; durationMs?: number; counts?: Record<string, number>; reason?: string }`
  - `recordOperation(record: Omit<OperationRecord, "at"> & { at?: number }): void` (ring buffer, capacity 50)
  - `getOperations(): readonly OperationRecord[]`, `clearOperations(): void`
  - `buildDiagnosticsReport(): string` returns pretty JSON with `extensionVersion` (guarded `typeof __SHUFFLE_SIMILAR_VERSION__ !== "undefined"`), `spicetifyVersion`, `spotifyVersion` (null when unavailable), `generatedAt`, `toggleEnabled`, `sessionActive`, `operations`.
- Records may contain only numbers and short reason codes.

- [ ] **Step 1: Write failing tests:**
  - `keeps only the newest 50 records`.
  - `report is valid JSON with the documented keys`.
  - `a full fake-Spotify mix start and track change leaves no "spotify:track:" or "spotify:user:" text in the report` (Review Focus 5).
- [ ] **Step 2:** `npx vitest run src/diagnostics`. Expected: FAIL.
- [ ] **Step 3:** Implement the module and `types/build.d.ts` (`declare const __SHUFFLE_SIMILAR_VERSION__: string`).
- [ ] **Step 4:** Add `recordOperation` calls: in `queueManager.ts` around clear, settle (including the retry), add and convergence verification, with counts and durations; in `shuffleEngine.ts` for mix start, commit, foreign-track cleanup, refill and playback recovery. Reasons are fixed codes such as `queue_not_confirmed`.
- [ ] **Step 5:** `npm test` and `npm run build:release`; confirm the banner and `__SHUFFLE_SIMILAR_VERSION__` resolve (`grep -c "2\.1\.3" shuffle-similar.js` is at least 1).
- [ ] **Step 6:** Commit `feat: record queue operations for diagnostics`.

### Task 7: "Copy diagnostics" action (R3)

**Files:**
- Create: `src/diagnostics/copyDiagnostics.ts`, `src/diagnostics/copyDiagnostics.test.ts`
- Modify: `src/ui/contextMenu.ts` (`registerContextMenu`), `src/app.tsx`

**Interfaces:**
- Consumes: `buildDiagnosticsReport` (Task 6).
- Produces: `copyDiagnostics(): Promise<boolean>` writes the report to the clipboard (`navigator.clipboard.writeText`, falling back to `Spicetify.Platform.ClipboardAPI.copy`) and shows `Diagnostics copied` or `Could not copy diagnostics` through `Spicetify.showNotification`.

- [ ] **Step 1: Write failing tests:** `returns true and notifies on success`; `returns false and notifies when the clipboard rejects` (permission denied); `falls back to ClipboardAPI when navigator.clipboard is missing`.
- [ ] **Step 2:** `npx vitest run src/diagnostics/copyDiagnostics.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `copyDiagnostics`; register `new Spicetify.ContextMenu.Item("Copy Similar Mix diagnostics", () => void copyDiagnostics(), () => true, "copy")` in `registerContextMenu`; expose `globalThis.__shuffleSimilarDiagnostics = buildDiagnosticsReport` in `app.tsx` for console use.
- [ ] **Step 4:** `npm test`; run `npm run smoke` (Task 5) to confirm the live app still passes; right-click a track and confirm the item copies valid JSON.
- [ ] **Step 5:** Rebuild the bundle and commit `feat: add Copy Similar Mix diagnostics`.

### Task 8: Error reference codes (R3)

**Files:**
- Modify: `src/ui/status.ts` (`SimilarMixPublicError`, `mapSimilarMixError` ~L193, capsule detail rendering), `src/ui/toggleButton.ts` (`notifyPublicError` ~L382), `src/queue/queueManager.ts` (`QueueOperationTimeoutError` and the thrown errors), `src/ui/status.test.ts`

**Interfaces:**
- Produces: `SimilarMixPublicError` gains `readonly ref?: string`. `type QueueFailureReason = "queue_timeout" | "queue_clear_failed" | "queue_not_confirmed" | "queue_replace_failed"`. Errors thrown by the queue layer and the engine carry `reason: QueueFailureReason`. `mapSimilarMixError` copies `reason` into `ref` only if it is in a fixed allow-list.

- [ ] **Step 1: Write failing tests** in `status.test.ts`: `copies an allow-listed reason into ref`; `drops unknown or non-string reasons`; `survives a throwing reason getter`; `capsule detail and notification text end with (ref: <reason>) when present`.
- [ ] **Step 2:** `npx vitest run src/ui/status.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Attach `reason` where the errors are created (`Spotify could not clear the upcoming queue`, `Spotify could not replace the upcoming queue`, `Spotify did not confirm the Similar Mix queue`, queue timeouts).
- [ ] **Step 4:** `npm test`, rebuild bundle, commit `feat: show short reference codes on Similar Mix errors`.

### Task 9: One name per action (R4)

**Files:**
- Create: `src/ui/copy.ts`, `src/ui/copy.test.ts`
- Modify: `src/ui/contextMenu.ts` (item labels ~L176-195 and notifications), `src/ui/toggleButton.ts` (`getToggleButtonPresentation` labels ~L177-183), `README.md` ("Use it" section), `CHANGELOG.md`

**Interfaces:**
- Produces `export const COPY = { toggleOn: "Turn on Similar Mix", toggleOff: "Turn off Similar Mix", toggleRefreshHint: "Shift+click to refresh", menuStartMix: "Start Similar Mix", menuSavePlaylist: "Save Similar Mix as Playlist", menuCopyDiagnostics: "Copy Similar Mix diagnostics" } as const`. This is the default naming; the owner may change the strings in this one file.

- [ ] **Step 1: Write failing test** `copy.test.ts`: all `COPY` values are distinct and non-empty, and none of the playlist-saving strings contain the word "Start".
- [ ] **Step 2:** `npx vitest run src/ui/copy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `copy.ts` and replace every hard-coded label with `COPY.*`. The saved-playlist notification reads `Saved "Similar to - <track>" with <n> tracks. Playing now.`
- [ ] **Step 4:** Verify: `grep -rn "Create Similar Playlist" src README.md` prints nothing. Existing toggle-button tests still pass (`npx vitest run src/ui`).
- [ ] **Step 5:** Update the README "Use it" bullets to the new names; rebuild bundle; commit `refactor: one consistent name per Similar Mix action`.

### Task 10: Zero lint warnings, enforced (R5)

**Files:**
- Modify: `src/algorithm/filters.ts:194-195`, `src/algorithm/rankingV2.test.ts:172-176`, `src/sources/artistTracks.ts:38,54`, `src/sources/profileTracks.ts:158-160,216,246`, `src/sources/similarTracks.test.ts:197`, `src/sources/similarTracks.ts:273`, `src/sources/sourcePipeline.ts:121`, `biome.json`

**Interfaces:** none (behavior-preserving).

- [ ] **Step 1:** `npx biome check .` and record the baseline warning list (the `queueManager.ts` `any` is already gone after Task 4).
- [ ] **Step 2:** Fix each: `useOptionalChain` with `npx biome check --write` where marked FIXABLE; replace `!` with a guard or a narrowed local; replace `any` with `unknown` plus a narrowing helper, or a typed interface added under `types/`. No `biome-ignore` comments.
- [ ] **Step 3:** `npx biome check .` reports no warnings or errors, and `npm test` still passes with unchanged assertions.
- [ ] **Step 4:** Set `"style": { "noNonNullAssertion": "error" }` and `"suspicious": { "noExplicitAny": "error" }` in `biome.json`; `npm run lint` exits 0.
- [ ] **Step 5:** Rebuild the bundle if any `src/**` changed; commit `chore: clear all lint warnings and enforce them`.

### Task 11: Release workflow (R5)

**Files:**
- Create: `.github/workflows/release.yml`, `scripts/extract-changelog.mjs`, `scripts/extract-changelog.test.mjs`

**Interfaces:**
- Produces `extractChangelogSection(changelog: string, version: string): string | null` (text under `## [version] - date` up to the next `## [`, trimmed, without the heading) and a CLI `node scripts/extract-changelog.mjs <version>` that prints it and exits 1 when missing.

- [ ] **Step 1: Write failing tests** in `extract-changelog.test.mjs`: finds `2.1.3`; stops before `## [2.1.2]`; works for the last section in the file; returns `null` for an unknown version.
- [ ] **Step 2:** `npx vitest run scripts/extract-changelog.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement the script.
- [ ] **Step 4:** Write `release.yml`. Triggers: push of tags `v*.*.*`, and `workflow_dispatch` with a boolean input `dry_run` defaulting to true. Permissions: `contents: write`. Steps: checkout, setup-node (`node-version-file: .nvmrc`), `npm ci`, lint, typecheck, test, `npm run build:release`, fail if `git diff --quiet -- shuffle-similar.js` fails, fail if the tag is not `v$(node -p "require('./package.json').version")`, build `notes.md` as the changelog section plus the manual-install block used by previous releases, then (unless dry run) `gh release create "$GITHUB_REF_NAME" shuffle-similar.js --title "Shuffle Similar $GITHUB_REF_NAME" --notes-file notes.md`.
- [ ] **Step 5:** Verify with `gh workflow run release.yml -f dry_run=true` then `gh run watch`. Expected: success, with `notes.md` printed in the log and no release created.
- [ ] **Step 6:** Commit `ci: build and publish releases from version tags`. The tag-triggered path is first exercised by Task 14.

### Task 12: Split `shuffleEngine.ts` by responsibility (R5)

**Files:**
- Create: `src/services/mixBuilder.ts` (L79-336: `getSessionConfig`, `queueUrisFromBatch`, `ensurePools`, `buildPlaylistPlayableBatch`, `buildArtistPlayableBatch`, `buildPlayableBatch`), `src/services/refill.ts` (L362-390 `prefetchNextBatch`, L632-720 refill and `rerankUpcomingAfterFeedback`), `src/services/playbackRecovery.ts` (L722-781 `handlePlaybackFailure`, `teachSimilarMixPreference`)
- Modify: `src/services/shuffleEngine.ts` (keeps prepare/start/commit/`handleSongChange`; re-exports the public API), `src/services/shuffleEngine.test.ts`

**Interfaces:**
- Produces: every symbol exported from `shuffleEngine.ts` today (`startShuffleSimilar`, `startFromContextMenu`, `buildFromContextMenu`, `reshuffleFromCurrentTrack`, `reshuffleOnToggleOff`, `refillQueueIfNeeded`, `handleSongChange`, `handlePlaybackFailure`, `teachSimilarMixPreference`, `recoverSimilarMixSession`, `clearSimilarMixRecovery`) stays importable from `./shuffleEngine` unchanged, so no other file's imports change.

- [ ] **Step 1:** Baseline: `npm test` passes; record `wc -l src/services/shuffleEngine.ts` (802).
- [ ] **Step 2:** Move one group at a time, in this order: `mixBuilder`, `playbackRecovery`, `refill`. After each move run `npm run typecheck && npx vitest run src/services`. Update `vi.mock` module paths in `shuffleEngine.test.ts` only where a mocked symbol moved; no assertion changes.
- [ ] **Step 3:** Break any import cycle by passing the dependency as a parameter, not by merging files back.
- [ ] **Step 4:** Full verification: `npm test`, `npm run build:release`, `npm run smoke`. `shuffleEngine.ts` is now under 450 lines.
- [ ] **Step 5:** One commit per moved group, e.g. `refactor: extract mix building from shuffleEngine`.

### Task 13: Land the seed-anchored work as small PRs (R6)

**Files:** none new; branches only. Source: `wip/seed-anchored-mix-2026-10-31` (18 commits ahead of `main`, 3 behind).

**Interfaces:** none.

- [ ] **Step 1:** Merge `main` into the WIP branch again; resolve the generated `shuffle-similar.js` conflict by rebuilding with `npm run build:release`, never by hand. Run the full CI set.
- [ ] **Step 2:** Group the commits by theme with `git log main..wip/seed-anchored-mix-2026-10-31 --oneline`: (a) liked-tracks profile pool and eligibility choke point, (b) seed-relevance gate and instrumental seeds, (c) playlist-membership exclusion, (d) quality-evaluation tests and docs, (e) UI changes (`toggleButton.ts`, `contextMenu.ts`, `playbarControls.ts`).
- [ ] **Step 3:** For each group create `feat/<theme>` from the current `main`, `git cherry-pick` its commits, rebuild the bundle, run the full CI set, push, and `gh pr create` with a body listing what changed and how it was verified.
- [ ] **Step 4:** Run the smoke script (Task 5) against a build of each PR branch.
- [ ] **Step 5:** Stop. Merging these PRs is the owner's decision; do not merge them. Report the PR links.

### Task 14: Release v2.2.0 (R5, R6)

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `shuffle-similar.js`

**Interfaces:** consumes the workflow from Task 11.

- [ ] **Step 1:** Precondition: every PR from Task 13 that the owner approved is merged and `main` CI is green. If none were approved, release only the Tasks 1-12 work.
- [ ] **Step 2:** Bump to `2.2.0` in `package.json` and `package-lock.json`; add a `## [2.2.0] - <date>` section to `CHANGELOG.md` covering diagnostics, error reference codes, the renamed menu item, and whichever Task 13 features merged.
- [ ] **Step 3:** `npm run build:release && npm run check:bundle`, then full CI set.
- [ ] **Step 4:** Commit `release: v2.2.0`, push `main`, wait for CI, then `git tag v2.2.0 && git push origin v2.2.0`.
- [ ] **Step 5:** Verify with `gh run watch` that the release workflow succeeds, and `gh release view v2.2.0` shows `shuffle-similar.js` attached and its digest equals `Get-FileHash shuffle-similar.js -Algorithm SHA256`. If the workflow fails, publish manually with `gh release create` exactly as for v2.1.3 and open an issue for the workflow.
