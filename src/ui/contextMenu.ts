import { startFromContextMenu } from "../services/shuffleEngine"
import { syncBetterShuffleFromPlayback } from "./betterShuffleUiState"
import { pickSeedFromCollection } from "../sources/profileTracks"
import { isPlaylistContext, isValidPlaybackContext } from "../queue/queueManager"

let contextMenuRegistered = false

const runPlayWithBetterShuffle = (uris: string[]) => {
  Spicetify.showNotification("Building Better Shuffle queue...")
  setTimeout(() => {
    handlePlayWithBetterShuffle(uris).catch((error) => {
      console.error("[Better Shuffle]", error)
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Better Shuffle failed",
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

const shouldShowMenu = (uris: string[]) => {
  if (!uris?.length) return false

  try {
    if (uris.length > 1) {
      return uris.every(isTrackUri)
    }

    const uri = uris[0]
    if (isTrackUri(uri) || isArtistUri(uri)) return true

    return false
  } catch {
    return uris.some((uri) => uri.startsWith("spotify:track:") || uri.startsWith("spotify:artist:"))
  }
}

const handlePlayWithBetterShuffle = async (uris: string[]) => {
  const seedUri = await pickSeedFromCollection(uris)
  if (!seedUri) {
    Spicetify.showNotification("Nothing to play", true)
    return
  }

  const rawContext =
    uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null
  const contextUri = rawContext && !isPlaylistContext(rawContext) ? rawContext : null

  await startFromContextMenu(seedUri, contextUri)
  syncBetterShuffleFromPlayback()
}

export const registerContextMenu = () => {
  if (contextMenuRegistered) return

  if (!Spicetify.ContextMenu?.Item) {
    throw new Error("Spicetify.ContextMenu.Item is not available")
  }

  new Spicetify.ContextMenu.Item(
    "Play with Better Shuffle",
    runPlayWithBetterShuffle,
    shouldShowMenu,
    "enhance"
  ).register()

  contextMenuRegistered = true
  console.info("[Better Shuffle] Context menu registered")
}
