# Shuffle Similar 2.0

Shuffle Similar builds a coherent **Similar Mix** around the track, album, artist, or playlist you choose. It combines several Spotify discovery paths with your own listening context, spaces repeats, paces musical transitions, and quietly adapts when you skip. There are no preference forms or tuning panels to maintain.

## What 2.0 does

- Fuses ranked candidates from radio, inspired-by, search, related-artist, era, playlist, and library sources instead of trusting one endpoint
- Plans the queue as a complete slate: canonical duplicate removal, artist and album spacing, source coverage, progressive library blending, and acoustic transition pacing
- Learns from clear playback outcomes such as completion, substantial listening, and genuine early skips; pauses, seeks, errors, and leaving the mix do not poison the profile
- Saves a bounded, decaying taste profile locally in Spicetify storage; it is not uploaded as extension telemetry
- Re-ranks what comes next immediately after an early skip
- Keeps working in a documented degraded mode when an optional Spotify discovery capability is unavailable
- Commits queue changes transactionally and only shows the active state after Spotify confirms the new queue
- Provides keyboard, screen-reader, focus, busy, error, reduced-motion, and high-contrast-aware states that fit Spotify's playbar

## Install

### Marketplace

1. Install [Spicetify](https://spicetify.app/docs/getting-started) and Marketplace.
2. Open **Spicetify → Marketplace → Extensions**.
3. Search for **Shuffle Similar** and select **Install**.
4. Restart Spotify if prompted.

### Manual

Download `shuffle-similar.js` from [Releases](https://github.com/trinlol/Shuffle-Similar/releases), copy it into your Spicetify Extensions folder, then run:

```bash
spicetify config extensions shuffle-similar.js
spicetify apply
```

| Platform | Extensions folder |
| --- | --- |
| Windows | `%appdata%\spicetify\Extensions\` |
| Linux | `~/.config/spicetify/Extensions/` |
| macOS | `~/spicetify_data/Extensions/` |

## Use it

- Click the playbar control immediately left of Spotify's shuffle button to build a Similar Mix around the current track.
- Click the active control to turn Similar Mix off. **Shift+click** it while active to refresh the mix.
- Right-click a track, album, artist, or playlist and choose **Start Similar Mix**.
- Choose **Create Similar Playlist** to save a generated mix without leaving the automatic queue active.

While Similar Mix is active, Spotify's shuffle control remains focusable but unavailable. Its label explains that turning Similar Mix off restores native shuffle.

## How the intelligence works

Candidate lists retain their source and rank. A weighted reciprocal-rank fusion stage combines that evidence with context affinity, the local taste profile, acoustic similarity, novelty, and bounded skip feedback. Missing metadata is neutral rather than a reason to discard a track.

The slate planner then balances relevance against redundancy. It avoids duplicate versions, limits early artist concentration, spaces albums and artists when the pool permits, smooths abrupt acoustic jumps, and progressively shifts from close similarity toward the listener's library. When a constraint cannot be satisfied, the planner relaxes it in a fixed, inspectable order instead of silently returning an empty queue.

Spotify periodically changes which Web API capabilities are available to development-mode apps. Shuffle Similar treats recommendations, related artists, and audio features as optional signals and preserves healthy search, radio, playlist, artist, and library results when one source times out or is restricted.

## Privacy and reset

Automatic learning is stored only in Spicetify's local storage. The profile is versioned, bounded, time-decayed, and can recover from malformed or older data. Removing the extension's local storage entry `shuffleSimilar:tasteProfile:v2` resets learned preferences.

## Development

```bash
npm test
npm run typecheck
npm run build-local
```

The release bundle is produced with `npm run build:release`.

## License

MIT — see [LICENSE](LICENSE).
