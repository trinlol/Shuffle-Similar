# Shuffle Similar

Play songs similar to your selected song, playlist, album, or artist using radio, inspired-by, genre, era, and related-artist sources. Shuffle Similar learns automatically from early skips and can either manage your queue or create a permanent playlist from its recommendations.

## Install

### Marketplace (recommended)

1. Install [Spicetify](https://spicetify.app/docs/getting-started) and the [Marketplace](https://spicetify.app/docs/getting-started) extension
2. Open **Spicetify → Marketplace → Extensions**
3. Search for **Shuffle Similar** and click **Install**
4. Restart Spotify if prompted

### Manual

Download `shuffle-similar.js` from [Releases](https://github.com/trinlol/Shuffle-Similar/releases) and copy it to your Spicetify Extensions folder:

| Platform | Path |
|----------|------|
| Windows | `%appdata%\spicetify\Extensions\` |
| Linux | `~/.config/spicetify/Extensions/` |
| macOS | `~/spicetify_data/Extensions/` |

Then enable the extension:

```bash
spicetify config extensions shuffle-similar.js
spicetify apply
```

## Features

- **Shuffle Similar** context menu on tracks, albums, playlists, and artists
- **Create Similar Playlist** context action that creates `Similar to - <song name>`, fills it with generated recommendations, and starts playing it
- **Dedicated playbar button** for Shuffle Similar (separate from Spotify shuffle)
- **Native shuffle is blocked** while Shuffle Similar is active
- Automatic skip learning with no extra controls or feedback prompts
- Playlist-wide similarity scoring and progressive blending into your library
- True shuffle with artist spacing, acoustic matching, and recent-play deprioritization
- Settings for era window, queue size, refill threshold, and more

## Usage

1. Right-click a track, album, playlist, or artist and choose **Shuffle Similar**
2. Choose **Create Similar Playlist** instead to generate a permanent playlist and play it without activating the automatic queue
3. Or click the **Shuffle Similar** button (left of Spotify shuffle) in the playbar: first click enables, second reshuffles (hover shows refresh), third turns off
4. While Shuffle Similar is on, Spotify's built-in shuffle is greyed out and unclickable
5. Open **Profile menu (top right icon) → Shuffle Similar** to adjust settings

## How recommendations work

Shuffle Similar combines related-artist discovery, inspired-by playlists, genre and era matching, your library, and the selected playlist's overall sound. Early skips are treated as implicit feedback during the active session, so similar candidates and repeated artists are automatically deprioritized.

## License

MIT - see [LICENSE](LICENSE).
