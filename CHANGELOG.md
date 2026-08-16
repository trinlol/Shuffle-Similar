# Changelog

All notable changes to Shuffle Similar are documented in this file.

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
