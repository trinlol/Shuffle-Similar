# Better Shuffle

A Spicetify extension that replaces Spotify's profile-heavy autoplay with a progressive shuffle. It starts with tracks similar in genre and era to your seed song, then gradually blends in your liked songs and playlists.

![Spicetify Better Shuffle](preview-banner.png)

## Install

### Marketplace (recommended)

1. Install [Spicetify](https://spicetify.app/docs/getting-started) and the [Marketplace](https://spicetify.app/docs/getting-started) extension
2. Open **Spicetify → Marketplace → Extensions**
3. Search for **Better Shuffle** and click **Install**
4. Restart Spotify if prompted

### Manual

Download `better-shuffle.js` from this repository and copy it to your Spicetify Extensions folder:

| Platform | Path |
|----------|------|
| Windows | `%appdata%\spicetify\Extensions\` |
| Linux | `~/.config/spicetify/Extensions/` |
| macOS | `~/spicetify_data/Extensions/` |

Then enable the extension:

```bash
spicetify config extensions better-shuffle.js
spicetify apply
```

## Features

- **Play with Better Shuffle** context menu on tracks, albums, playlists, and artists
- **Dedicated playbar button** for Better Shuffle (separate from Spotify shuffle)
- **Native shuffle is blocked** while Better Shuffle is active
- Progressive blend curve: similar tracks first, library/playlists later
- True shuffle with artist spacing and recent-play deprioritization
- Settings for era window, queue size, refill threshold, and more

## Usage

1. Right-click a track, album, playlist, or artist and choose **Play with Better Shuffle**
2. Or click the **Better Shuffle** button (left of Spotify shuffle) in the playbar: first click enables, second reshuffles (hover shows refresh), third turns off
3. While Better Shuffle is on, Spotify's built-in shuffle is greyed out and unclickable
4. Open **Spicetify menu → Better Shuffle** to adjust settings

## Development

Requires [Spicetify CLI](https://spicetify.app/docs/getting-started).

```bash
npm install
npm run build-local   # outputs to dist/better-shuffle.js
npm run watch         # watch + output to local Spicetify Extensions folder (Windows)
spicetify watch -e
```

Before publishing a release, rebuild marketplace assets:

```bash
npm run build:release
npm run generate:preview
```

Commit `better-shuffle.js`, `preview-icon.png`, and `preview-banner.png` alongside source changes.

## Publishing

This extension is listed on the Spicetify Marketplace via GitHub discovery. To publish or update:

1. Push to a **public** GitHub repository
2. Add the [`spicetify-extensions`](https://github.com/topics/spicetify-extensions) topic in repo settings
3. Ensure `manifest.json`, `preview-icon.png`, `better-shuffle.js`, and `README.md` are on the default branch
4. Run `npm run build:release` and `npm run generate:preview`, then commit the built assets before each release

See the [Publishing to Marketplace](https://github.com/spicetify/marketplace/wiki/Publishing-to-Marketplace) guide for full details.

## License

MIT — see [LICENSE](LICENSE).
