const PLAYLIST_TRACK_LIMIT = 100

type CreatedPlaylist = {
  uri?: string
}

type PlaylistPlatform = {
  RootlistAPI?: {
    createPlaylist?: (name: string, options: { before: "start" }) => Promise<string | CreatedPlaylist>
  }
  PlaylistAPI?: {
    add?: (playlistUri: string, uris: string[], options: { before: "start" }) => Promise<unknown>
  }
}

const uniqueTrackUris = (uris: string[]): string[] => [
  ...new Set(uris.filter((uri) => uri.startsWith("spotify:track:"))),
]

const playlistNameForSeed = (trackName: string, artistName: string): string => {
  const seedLabel = trackName || artistName || "My Mix"
  return `Similar to - ${seedLabel}`.slice(0, 100)
}

export const createSimilarPlaylist = async (
  trackName: string,
  artistName: string,
  uris: string[]
): Promise<{ uri: string; trackCount: number }> => {
  const trackUris = uniqueTrackUris(uris)
  if (trackUris.length === 0) {
    throw new Error("No tracks were available to save.")
  }

  const platform = Spicetify.Platform as typeof Spicetify.Platform & PlaylistPlatform
  const rootlistApi = platform.RootlistAPI
  const playlistApi = platform.PlaylistAPI
  if (!rootlistApi?.createPlaylist || !playlistApi?.add) {
    throw new Error("Spotify's playlist tools are not available. Restart Spotify and try again.")
  }

  const created = await rootlistApi.createPlaylist(playlistNameForSeed(trackName, artistName), {
    before: "start",
  })
  const playlistUri = typeof created === "string" ? created : created?.uri
  if (!playlistUri?.startsWith("spotify:playlist:")) {
    throw new Error("Spotify could not create the playlist.")
  }

  for (let offset = 0; offset < trackUris.length; offset += PLAYLIST_TRACK_LIMIT) {
    await playlistApi.add(
      playlistUri,
      trackUris.slice(offset, offset + PLAYLIST_TRACK_LIMIT),
      { before: "start" }
    )
  }

  return {
    uri: playlistUri,
    trackCount: trackUris.length,
  }
}
