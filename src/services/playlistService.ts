import { sessionManager } from "../session/SessionManager"

const PLAYLIST_TRACK_LIMIT = 100

type CreatedPlaylist = {
  uri?: string
}

type PlaylistPlatform = {
  RootlistAPI?: {
    createPlaylist?: (
      name: string,
      options: { before: "start" }
    ) => Promise<string | CreatedPlaylist>
  }
  PlaylistAPI?: {
    add?: (playlistUri: string, uris: string[], options: { before: "start" }) => Promise<unknown>
  }
}

const uniqueTrackUris = (uris: string[]): string[] => [
  ...new Set(uris.filter((uri) => uri.startsWith("spotify:track:"))),
]

const playlistNameForSeed = (trackName: string, _artistName: string): string => {
  const seedLabel = trackName.trim()
  if (!seedLabel) {
    throw new Error("Spotify could not load the selected song name. Please try again.")
  }
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

  const chunks: string[][] = []
  for (let offset = 0; offset < trackUris.length; offset += PLAYLIST_TRACK_LIMIT) {
    chunks.push(trackUris.slice(offset, offset + PLAYLIST_TRACK_LIMIT))
  }
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    await playlistApi.add(playlistUri, chunks[index], {
      before: "start",
    })
  }

  return {
    uri: playlistUri,
    trackCount: trackUris.length,
  }
}

/**
 * Returns every track URI played in the active Similar Mix queue in playback order,
 * starting with the original seed song and including the currently playing owned track.
 */
export const getSessionPlayedTrackUris = (): string[] => {
  if (!sessionManager.isActive()) return []
  const played = sessionManager.getPlayedUris()
  const currentUri =
    typeof Spicetify !== "undefined" ? (Spicetify.Player?.data?.item?.uri ?? null) : null
  if (
    currentUri?.startsWith("spotify:track:") &&
    sessionManager.ownsQueueTrack(currentUri) &&
    !sessionManager.isQuarantined(currentUri) &&
    !played.includes(currentUri)
  ) {
    return uniqueTrackUris([...played, currentUri])
  }
  return uniqueTrackUris(played)
}

/**
 * Creates a playlist containing every song played so far in the active Similar Mix queue
 * without interrupting current playback.
 */
export const savePlayedSessionPlaylist = async (): Promise<{
  uri: string
  trackCount: number
  seedTrackName: string
}> => {
  const seed = sessionManager.getSeed()
  if (!sessionManager.isActive() || !seed) {
    throw new Error("Start Similar Mix first to save played songs as a playlist.")
  }

  const playedUris = getSessionPlayedTrackUris()
  if (playedUris.length === 0) {
    throw new Error("No played songs are available in this queue yet.")
  }

  const playlist = await createSimilarPlaylist(seed.trackName, seed.artistName, playedUris)
  return {
    ...playlist,
    seedTrackName: seed.trackName,
  }
}
