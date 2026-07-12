# Changelog

All notable changes to Shuffle Similar are documented in this file.

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
