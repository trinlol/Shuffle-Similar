import { copyDiagnostics } from "../diagnostics/copyDiagnostics"
import { isPlaylistContext, isValidPlaybackContext } from "../queue/queueManager"
import { explainSimilarMixTrack } from "../services/explainability"
import { createSimilarPlaylist } from "../services/playlistService"
import {
  buildFromContextMenu,
  startFromContextMenu,
  teachSimilarMixPreference,
} from "../services/shuffleEngine"
import { sessionManager } from "../session/SessionManager"
import { pickSeedFromCollection } from "../sources/profileTracks"
import { COPY, savedPlaylistMessage } from "./copy"
import { syncShuffleSimilarFromPlayback } from "./shuffleSimilarUiState"

let contextMenuRegistered = false
let contextActionBusy = false

const formatContextActionError = (error: unknown, fallbackMessage: string): string => {
  const reason = error instanceof Error ? error.message.trim() : ""
  if (!reason) return fallbackMessage
  return `Similar Mix: ${reason.slice(0, 180)}`
}

const runContextAction = (work: () => Promise<void>, fallbackMessage: string) => {
  if (contextActionBusy) {
    Spicetify.showNotification("Similar Mix is already working on that request")
    return
  }
  contextActionBusy = true
  setTimeout(() => {
    work()
      .catch((error) => {
        console.error("[Shuffle Similar]", error)
        Spicetify.showNotification(formatContextActionError(error, fallbackMessage), true)
      })
      .finally(() => {
        contextActionBusy = false
      })
  }, 0)
}

const runPlayWithShuffleSimilar = (uris: string[]) => {
  Spicetify.showNotification(COPY.buildingMix)
  setTimeout(() => {
    handlePlayWithShuffleSimilar(uris).catch((error) => {
      if (error instanceof Error && error.name === "StaleMixBuildError") return
      console.error("[Shuffle Similar]", error)
      Spicetify.showNotification(
        formatContextActionError(error, "Similar Mix could not start. Try another selection."),
        true
      )
    })
  }, 0)
}

const runCreateSimilarPlaylist = (uris: string[]) => {
  Spicetify.showNotification(COPY.savingPlaylist)
  runContextAction(() => handleCreateSimilarPlaylist(uris), COPY.savePlaylistFailed)
}

const runPreferenceFeedback = (uris: string[], sentiment: -1 | 1) => {
  const label = sentiment > 0 ? "Learning from this track..." : "Tuning away from this track..."
  Spicetify.showNotification(label)
  runContextAction(async () => {
    await teachSimilarMixPreference(uris[0], sentiment)
    Spicetify.showNotification(
      sentiment > 0 ? "Similar Mix will lean more this way" : "Similar Mix will avoid this sound"
    )
  }, "Similar Mix could not save that preference. Try again.")
}

const showTrackExplanation = (uris: string[]) => {
  const candidate = sessionManager.getCandidate(uris[0])
  if (!candidate) {
    Spicetify.showNotification("This track is not part of the active Similar Mix", true)
    return
  }
  Spicetify.showNotification(explainSimilarMixTrack(candidate, sessionManager.getSeed()))
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

  const rawContext = uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null
  const contextUri = rawContext

  await startFromContextMenu(seedUri, contextUri)
  syncShuffleSimilarFromPlayback()
}

const isSingleTrack = (uris: string[]): boolean => uris.length === 1 && isTrackUri(uris[0])

const handleCreateSimilarPlaylist = async (uris: string[]) => {
  const seedUri = await pickSeedFromCollection(uris)
  if (!seedUri) {
    Spicetify.showNotification("Nothing to add to a playlist", true)
    return
  }

  const contextUri = uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null
  const { seed, queueUris } = await buildFromContextMenu(seedUri, contextUri)
  const playlist = await createSimilarPlaylist(seed.trackName, seed.artistName, [
    seed.uri,
    ...queueUris,
  ])

  await Spicetify.Player.playUri(playlist.uri)

  Spicetify.showNotification(savedPlaylistMessage(seed.trackName, playlist.trackCount))
}

export const registerContextMenu = () => {
  if (contextMenuRegistered) return

  if (!Spicetify.ContextMenu?.Item) {
    throw new Error("Spicetify.ContextMenu.Item is not available")
  }

  new Spicetify.ContextMenu.Item(
    COPY.menuStartMix,
    runPlayWithShuffleSimilar,
    isNonPlaylist,
    "enhance"
  ).register()

  new Spicetify.ContextMenu.Item(
    COPY.menuSavePlaylist,
    runCreateSimilarPlaylist,
    isNonPlaylist,
    "playlist"
  ).register()

  new Spicetify.ContextMenu.Item(
    COPY.menuStartMix,
    runPlayWithShuffleSimilar,
    isPlaylistOnly,
    "enhance"
  ).register()

  new Spicetify.ContextMenu.Item(
    COPY.menuSavePlaylist,
    runCreateSimilarPlaylist,
    isPlaylistOnly,
    "playlist"
  ).register()

  new Spicetify.ContextMenu.Item(
    "More like this",
    (uris) => runPreferenceFeedback(uris, 1),
    isSingleTrack,
    "heart"
  ).register()

  new Spicetify.ContextMenu.Item(
    "Less like this",
    (uris) => runPreferenceFeedback(uris, -1),
    isSingleTrack
  ).register()

  new Spicetify.ContextMenu.Item("Why this track?", showTrackExplanation, isSingleTrack).register()

  new Spicetify.ContextMenu.Item(
    COPY.menuCopyDiagnostics,
    () => void copyDiagnostics(),
    () => true,
    "copy"
  ).register()

  contextMenuRegistered = true
  console.info("[Shuffle Similar] Context menus registered")
}
