import { buildFromContextMenu, startFromContextMenu } from "../services/shuffleEngine"
import { syncShuffleSimilarFromPlayback } from "./shuffleSimilarUiState"
import { pickSeedFromCollection } from "../sources/profileTracks"
import { isPlaylistContext, isValidPlaybackContext } from "../queue/queueManager"
import { createSimilarPlaylist } from "../services/playlistService"
import { sessionManager } from "../session/SessionManager"

let contextMenuRegistered = false

const runPlayWithShuffleSimilar = (uris: string[]) => {
  Spicetify.showNotification("Building Shuffle Similar queue...")
  setTimeout(() => {
    handlePlayWithShuffleSimilar(uris).catch((error) => {
      console.error("[Shuffle Similar]", error)
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Shuffle Similar failed",
        true
      )
    })
  }, 100)
}

const runCreateSimilarPlaylist = (uris: string[]) => {
  Spicetify.showNotification("Building Shuffle Similar playlist...")
  setTimeout(() => {
    handleCreateSimilarPlaylist(uris).catch((error) => {
      console.error("[Shuffle Similar] Could not create playlist", error)
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Could not create similar playlist",
        true
      )
    })
  }, 100)
}

const getUriType = (uri: string): string | null => {
  try {
    if (!Spicetify.URI) return null
    return Spicetify.URI.fromString(uri).type
  } catch {
    return null
  }
}

const isTrackUri = (uri: string) => {
  if (uri.startsWith("spotify:track:")) return true
  const { Type } = Spicetify.URI ?? {}
  if (!Type) return false
  return getUriType(uri) === Type.TRACK
}

const isArtistUri = (uri: string) => {
  if (uri.startsWith("spotify:artist:")) return true
  const { Type } = Spicetify.URI ?? {}
  if (!Type) return false
  return getUriType(uri) === Type.ARTIST
}

const isAlbumUri = (uri: string) => {
  if (uri.startsWith("spotify:album:")) return true
  const { Type } = Spicetify.URI ?? {}
  if (!Type) return false
  return getUriType(uri) === Type.ALBUM
}

const isPlaylistOnly = (uris: string[]): boolean => {
  if (!uris?.length || uris.length > 1) return false
  return isPlaylistContext(uris[0])
}

const isNonPlaylist = (uris: string[]): boolean => {
  if (!uris?.length) return false

  try {
    if (uris.length > 1) {
      return uris.every(isTrackUri)
    }

    const uri = uris[0]
    return isTrackUri(uri) || isArtistUri(uri) || isAlbumUri(uri)
  } catch {
    return uris.some(
      (uri) =>
        uri.startsWith("spotify:track:") ||
        uri.startsWith("spotify:artist:") ||
        uri.startsWith("spotify:album:")
    )
  }
}

const handlePlayWithShuffleSimilar = async (uris: string[]) => {
  const seedUri = await pickSeedFromCollection(uris)
  if (!seedUri) {
    Spicetify.showNotification("Nothing to play", true)
    return
  }

  const rawContext =
    uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null
  const contextUri = rawContext

  await startFromContextMenu(seedUri, contextUri)
  syncShuffleSimilarFromPlayback()
}

const handleCreateSimilarPlaylist = async (uris: string[]) => {
  const seedUri = await pickSeedFromCollection(uris)
  if (!seedUri) {
    Spicetify.showNotification("Nothing to add to a playlist", true)
    return
  }

  const contextUri =
    uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null
  const { seed, queueUris } = await buildFromContextMenu(seedUri, contextUri)
  let playlist: Awaited<ReturnType<typeof createSimilarPlaylist>>
  try {
    playlist = await createSimilarPlaylist(
      seed.trackName,
      seed.artistName,
      [seed.uri, ...queueUris]
    )
  } finally {
    sessionManager.endSession()
    syncShuffleSimilarFromPlayback()
  }

  await Spicetify.Player.playUri(playlist.uri)

  Spicetify.showNotification(
    `Playing Similar playlist with ${playlist.trackCount} songs`
  )
}


export const registerContextMenu = () => {
  if (contextMenuRegistered) return

  if (!Spicetify.ContextMenu?.Item) {
    throw new Error("Spicetify.ContextMenu.Item is not available")
  }

  new Spicetify.ContextMenu.Item(
    "Shuffle Similar",
    runPlayWithShuffleSimilar,
    isNonPlaylist,
    "enhance"
  ).register()

  new Spicetify.ContextMenu.Item(
    "Create Similar Playlist",
    runCreateSimilarPlaylist,
    isNonPlaylist,
    "playlist"
  ).register()

  new Spicetify.ContextMenu.Item(
    "Shuffle Similar",
    runPlayWithShuffleSimilar,
    isPlaylistOnly,
    "enhance"
  ).register()

  new Spicetify.ContextMenu.Item(
    "Create Similar Playlist",
    runCreateSimilarPlaylist,
    isPlaylistOnly,
    "playlist"
  ).register()

  contextMenuRegistered = true
  console.info("[Shuffle Similar] Context menus registered")
}
