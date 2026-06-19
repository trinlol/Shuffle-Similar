# Shuffle Similar

A Spicetify extension that plays songs similar to your seed (from radio, inspired-by, genre/era, and related-artist sources) with optional progressive blend into your liked songs and playlists.

![Spicetify Shuffle Similar](preview-banner.png)

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
- **Dedicated playbar button** for Shuffle Similar (separate from Spotify shuffle)
- **Native shuffle is blocked** while Shuffle Similar is active
- Progressive blend curve: similar tracks first, library/playlists later
- True shuffle with artist spacing and recent-play deprioritization
- Settings for era window, queue size, refill threshold, and more

## Usage

1. Right-click a track, album, playlist, or artist and choose **Shuffle Similar**
2. Or click the **Shuffle Similar** button (left of Spotify shuffle) in the playbar: first click enables, second reshuffles (hover shows refresh), third turns off
3. While Shuffle Similar is on, Spotify's built-in shuffle is greyed out and unclickable
4. Open **Profile menu (top right icon) → Shuffle Similar** to adjust settings

## License

MIT - see [LICENSE](LICENSE).
