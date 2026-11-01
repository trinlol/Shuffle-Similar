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
} as const

export const savedPlaylistMessage = (trackName: string, trackCount: number): string =>
  `Saved "Similar to - ${trackName}" with ${trackCount} tracks. Playing now.`
