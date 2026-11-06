/**
 * Every user-facing action name in one place: one name per action.
 * Change the wording here; nothing else hard-codes these strings.
 */
export const COPY = {
  toggleOn: "Turn on Similar Mix",
  toggleOff: "Turn off Similar Mix",
  toggleRefreshHint: "Shift+click to refresh",
  toggleBuilding: "Building Similar Mix…",
  toggleRefreshing: "Refreshing Similar Mix…",
  toggleStopping: "Turning off Similar Mix…",
  toggleRetry: "Retry Similar Mix",
  menuStartMix: "Start Similar Mix",
  menuSavePlaylist: "Save Similar Mix as Playlist",
  menuCopyDiagnostics: "Copy Similar Mix diagnostics",
  buildingMix: "Building your Similar Mix...",
  savingPlaylist: "Saving your Similar Mix as a playlist...",
  savePlaylistFailed: "The Similar Mix playlist could not be saved. Try again.",
  timelinePrefix: "Playing similar songs based on",
  savePlayedButton: "Save playlist",
  savingPlayedButton: "Saving…",
  savedPlayedButton: "Saved!",
} as const

export const savedPlaylistMessage = (trackName: string, trackCount: number): string =>
  `Saved "Similar to - ${trackName}" with ${trackCount} tracks. Playing now.`

export const savedPlayedPlaylistMessage = (trackName: string, trackCount: number): string =>
  `Saved "Similar to - ${trackName}" with ${trackCount} played ${trackCount === 1 ? "song" : "songs"}.`

export const timelineSeedLabel = (trackName: string): string =>
  `${COPY.timelinePrefix} ${trackName}`

export const timelineSeedTooltip = (trackName: string, artistName?: string): string =>
  artistName
    ? `${COPY.timelinePrefix} "${trackName}" by ${artistName}`
    : `${COPY.timelinePrefix} "${trackName}"`

export const savePlayedPlaylistTooltip = (trackCount: number): string =>
  trackCount === 1
    ? "Save playlist with 1 song played from this queue"
    : `Save playlist with all ${trackCount} songs played from this queue`
