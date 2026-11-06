# Changelog

All notable changes to Shuffle Similar are documented in this file.

## [Unreleased]

## [2.2.0] - 2026-11-06

### Added

- **Genre, graph, and acoustic coherence filtering**: Structural genre-phrase matching, live artist-graph tag expansion, 6D acoustic outlier gating, and vocal/soundtrack/novelty filtering keep mixes anchored to the seed song's vibe without leaking movie scores, instrumentals, or unrelated genres
- **Cross-session exposure decay & canonical repeat protection**: Exponentially decayed exposure tracking (`played`, `completed`, `queued`, `early-skip`) plus canonical title and artist history keep repeated mixes around the same seed or artist fresh
- **Playbar seed banner & one-click Save playlist**: Displays the active seed song beside the playback timeline with a **Save playlist** action that saves every song played during the current Similar Mix session
- **Clean queue lifecycle on manual clicks & detours**: Clicking a song outside the active Similar Mix scraps the old mix queue cleanly, **Add to queue** plays manual detour songs without ending or poisoning the active mix, and starting **Similar Mix** on a different track clears the previous mix queue first
- **Copy Similar Mix diagnostics** in the context menu: a short log of recent queue operations (no tracks or account details) to paste into bug reports
- Error messages end with a short reference code, for example `(ref: queue_not_confirmed)`

### Changed

- The context-menu action that saves a mix as a playlist is now called **Save Similar Mix as Playlist** (was "Create Similar Playlist"), so it can't be confused with **Start Similar Mix**

### Fixed

- Stops rebuilding the queue (and showing "Added to queue") on every song change after Spotify silently drops one of the mix's tracks. Only a non-manual track placed in front of the mix's own tracks now counts as foreign
- The Similar Mix playbar button now appears when the playing playlist's name contains "Similar", "Smart" or "Better", such as playlists saved by Shuffle Similar itself
- A refill that was waiting its turn can no longer overwrite a mix started in the meantime
- Waiting for Spotify's queue now follows its `queue_update` event instead of fixed sleeps, and a fallback that crashed before Spotify's queue loaded is fixed
- Plugged memory leaks across playbar remounts and multi-hour sessions: destroys detached `Tippy` tooltips, reuses the timeline banner element, tracks DOM and event-emitter references with `WeakRef`, cancels replaced debounce timers, and bounds active-session registries and caches

## [2.1.3] - 2026-10-31

### Fixed

- Stops rebuilding the whole queue after nearly every track change. Spotify's queue briefly still lists the song that just started, which was mistaken for foreign tracks, so the mix was cleared and re-added and Spotify showed "Added to queue"
- Starting or refreshing a mix no longer fails with "Spotify did not confirm the Similar Mix queue" when tracks were already queued. Spotify reports a queue clear before it takes effect, and the old queued tracks were written back in front of the new mix
- A lagging Spotify queue snapshot can no longer turn a successful clear into "Spotify could not replace the upcoming queue"; the clear is retried once and the result is still verified
- Error and degraded status banners fade after a few seconds instead of staying on screen until restart


## [2.1.2] - 2026-08-31

### Fixed

- Treats qualified version titles such as `Single Version`, `Album Version`, `Original Mix`, and `Bonus Track` as duplicates of the base recording, so a mix no longer plays the same song twice under different suffixes
- Starts up on clients that expose the player before the settings menu and modal APIs, which the extension never used
- Removed a `forceRefreshPools` start option that callers passed but the start path never read

### Changed

- The release banner version now derives from `package.json`, so a rebuilt bundle cannot report a stale version
- The queue orchestrator no longer imports the DOM-bound playbar layer, making its refill, ownership, and recovery rules unit-testable
- Added continuous integration running typecheck, tests, and a stale-release-bundle check


## [2.1.1] - 2026-08-16

### Fixed

- Accepts Spotify context or autoplay tracks appended after the complete, correctly ordered Similar Mix without mistaking them for a failed queue takeover
- Keeps appended Spotify context tracks outside Similar Mix ownership and refill counts
- Continues to retry or reject a takeover when a foreign track interrupts the requested Similar Mix order
- Ignores unrelated stale private queue snapshots when Spotify's public queue already confirms the requested mix
- Defers automatic early-skip reranking until a safe refill so pressing Next cannot replace Spotify's queue during `songchange`
- Invalidates cached and in-flight prefetch generations after an early skip so the next safe refill uses the new taste signal
- Shows the underlying context-menu failure reason instead of a generic start error

## [2.1.0] - 2026-08-16

### Added

- Neutral playback-failure watchdog and quarantine recovery for owned tracks that Spotify cannot start
- Diverse-source foreground quorum with bounded, generation-scoped advisory results from late sources
- Account-scoped learning from confirmed plays, repeats, Top Items, and Recently Played history
- Bounded positive anchors and a rolling 40% discovery-eligible floor to learn taste without creating an echo chamber
- Recovery persistence for adaptive anchors and discovery history

### Changed

- Starting a Similar Mix now invalidates old queue work, detaches prior context, clears Spotify's queue, installs the new slate, and verifies stable public/private queue order before taking ownership
- Queue refills and reranks share one serialized mutation lane and ignore stale session revisions
- Playlist profile sampling and source discovery now have foreground latency bounds
- Discovery history now reflects tracks actually encountered instead of unseen future queue entries

### Fixed

- Restores the previous queue when a fresh install fails after clearing it
- Rejects reordered, duplicated, foreign, or stale observable queue tails
- Prevents older song-change callbacks and in-flight refills from corrupting playback recovery
- Advances past an unavailable track only when the immediate next entry is owned and not quarantined

## [2.0.1] - 2026-08-16

### Fixed

- Verified playable tracks now lead the generated queue when individual validation requests fail, preventing the first Skip from landing on a transiently unchecked song

## [2.0.0] - 2026-08-16

### Added

- Persistent, private, time-decayed taste profile learned from completion, substantial play, and unambiguous early skips
- Multi-source reciprocal-rank fusion with inspectable provenance and missing-signal weight redistribution
- Deterministic slate planning with canonical duplicate removal, artist and album spacing, early-artist caps, acoustic pacing, progressive blending, and explicit constraint relaxation
- Immediate upcoming-queue re-ranking after negative feedback
- Bounded source concurrency, timeouts, circuit breaking, degraded-mode diagnostics, and current Spotify development-mode API compatibility
- Transactional queue commits with stale-request cancellation and queue convergence checks
- Explicit building, active, refreshing, stopping, degraded, and error states with accessible status announcements and reduced-motion support
- Deterministic recommendation quality harnesses and regression coverage for learning, ranking, source failure, queue integrity, and playbar behavior

### Changed

- Renamed the in-player experience to **Similar Mix** while retaining the Shuffle Similar extension name
- Changed the active playbar interaction to click-to-disable and Shift+click-to-refresh, with matching icon, tooltip, and ARIA behavior
- Made Spotify's native shuffle control focusable and self-explanatory while Similar Mix owns the queue
- Made playlist creation a pure build path so it cannot interrupt or leak an active queue session
- Reduced Spotify client overhead by filtering playbar mutations before scheduling DOM work and inspecting only newly added nodes for legacy controls
- Minified release builds, cutting the shipped extension from about 216 KB to 101 KB without changing recommendation behavior
- Updated the build dependency chain to audited releases with no known npm vulnerabilities

### Fixed

- Progressive blend weights now update for every absolute queue position, including within the initial batch
- Playlist- and artist-generated candidates are registered so their playback outcomes can teach the profile
- Duplicate or foreign song-change events no longer advance the session
- Optional source failures no longer discard healthy candidate pools
- Removed hard dependencies on Spotify endpoints unavailable to newer development-mode apps
- Removed full-playbar rescans and unnecessary debounce timer churn during unrelated Spotify UI updates

## [1.8.2] - 2026-07-12

### Fixed

- Playlist names now retry exact-track metadata through Spotify search when the selected song is not currently playing or the direct lookup fails
- Unresolved song titles now show a clear error instead of creating a misleading `Similar to - My Mix` playlist

## [1.8.1] - 2026-07-12

### Fixed

- Creating and playing a similar playlist now leaves Shuffle Similar and its native-shuffle guard visibly disabled

## [1.8.0] - 2026-07-12

### Added

- **Create Similar Playlist** - right-click a track, album, artist, or playlist to generate a new playlist named after the seed song and immediately play it
- **Automatic Skip Learning** - early skips influence later recommendations without adding settings or manual feedback controls
- **Playlist-Wide Similarity** - playlist mode scores recommendations against the full playlist profile instead of relying on a small seed sample
- **Regression Tests** - deterministic coverage for recommendation filters, weighted selection, and Spotify playlist creation

### Improved

- Stronger artist spacing and playlist-affinity ranking for more varied, coherent results
- Audio-feature scoring across tempo, energy, valence, danceability, acousticness, and instrumentalness
- Larger default recommendation batches with additional related-artist and playlist seed coverage

### Fixed

- Spotify Desktop playlist creation now preserves the internal API receiver and reliably inserts generated tracks
- Creating a similar playlist no longer starts or leaves behind the automatic Shuffle Similar queue
- Popularity and weighted-random calculations are guarded against invalid numeric values

## [1.0.0] - 2026-06-20

### Added

- **Shuffle Similar Context Menu** - support for tracks, albums, playlists, and artists
- **Dedicated Playbar Button** - separate toggle with native shuffle blocking
- **Progressive Shuffle** - plays similar songs first, then progressively blends in library or playlist tracks
- **Variety Controls** - artist spacing, era window constraints, and recent-play deprioritization to avoid repeating tracks
- **Flexible Settings** - customize queue size, refill threshold, and audio feature matching weights
- **Large Collection Support** - handles playlists up to 2,000 tracks with multi-seed recommendation sampling
