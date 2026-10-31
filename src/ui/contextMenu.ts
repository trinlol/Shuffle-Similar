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
import { shuffleSimilarStatus, syncShuffleSimilarFromPlayback } from "./shuffleSimilarUiState"
import { triggerRefreshShuffleSimilar, triggerToggleShuffleSimilar } from "./toggleButton"

let contextMenuRegistered = false
let profileMenuRegistered = false
let contextMenuV2Patched = false
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
  }, 100)
}

const runPlayWithShuffleSimilar = (uris: string[]) => {
  Spicetify.showNotification("Building your Similar Mix...")
  runContextAction(
    () => handlePlayWithShuffleSimilar(uris),
    "Similar Mix could not start. Try another selection."
  )
}

const runCreateSimilarPlaylist = (uris: string[]) => {
  Spicetify.showNotification("Creating your Similar playlist...")
  runContextAction(
    () => handleCreateSimilarPlaylist(uris),
    "The Similar playlist could not be created. Try again."
  )
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

const isCollectionUri = (uri: string): boolean =>
  uri.startsWith("spotify:collection:") || /^spotify:user:[^:]+:collection$/i.test(uri)

const isPlaylistOnly = (uris: string[]): boolean => {
  if (!uris?.length || uris.length > 1) return false
  return isPlaylistContext(uris[0]) || isCollectionUri(uris[0])
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

const isSupportedSimilarMixTarget = (uris: string[]): boolean =>
  isNonPlaylist(uris) || isPlaylistOnly(uris)

const patchContextMenuV2 = () => {
  if (contextMenuV2Patched) return
  const contextMenuV2 = (
    Spicetify as typeof Spicetify & {
      ContextMenuV2?: {
        parseProps?: (props: Record<string, unknown> | undefined) => string[] | undefined
      }
    }
  ).ContextMenuV2

  if (!contextMenuV2 || typeof contextMenuV2.parseProps !== "function") return

  const originalParseProps = contextMenuV2.parseProps.bind(contextMenuV2)
  contextMenuV2.parseProps = (props) => {
    const parsed = originalParseProps(props)
    if (parsed && parsed.length > 0) return parsed
    if (!props || typeof props !== "object") return parsed

    const candidates = [
      props.target,
      props.entityUri,
      props.contextUri,
      (props.track as { uri?: unknown } | undefined)?.uri,
      (props.album as { uri?: unknown } | undefined)?.uri,
      (props.playlist as { uri?: unknown } | undefined)?.uri,
      (props.artist as { uri?: unknown } | undefined)?.uri,
      (props.data as { uri?: unknown } | undefined)?.uri,
    ]

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.startsWith("spotify:")) {
        return [candidate]
      }
    }

    if (Array.isArray(props.items)) {
      const itemUris = props.items
        .map((item) =>
          typeof item === "string"
            ? item
            : typeof (item as { uri?: unknown } | null)?.uri === "string"
              ? ((item as { uri: string }).uri ?? "")
              : ""
        )
        .filter((uri) => uri.startsWith("spotify:"))
      if (itemUris.length > 0) return itemUris
    }

    return parsed
  }

  contextMenuV2Patched = true
}

const registerProfileMenu = () => {
  if (profileMenuRegistered) return
  if (!Spicetify.Menu?.Item || !Spicetify.Menu?.SubMenu) return

  const toggleItem = new Spicetify.Menu.Item(
    "Similar Mix Active",
    sessionManager.isToggleEnabled(),
    () => {
      triggerToggleShuffleSimilar()
    }
  )

  const refreshItem = new Spicetify.Menu.Item("Refresh Similar Mix", false, () => {
    triggerRefreshShuffleSimilar()
  })

  const createPlaylistItem = new Spicetify.Menu.Item(
    "Create Similar Playlist from Current Track",
    false,
    () => {
      const currentUri = Spicetify.Player.data?.item?.uri
      if (!currentUri) {
        Spicetify.showNotification("Play a track first to create a Similar playlist", true)
        return
      }
      runCreateSimilarPlaylist([currentUri])
    }
  )

  const subMenu = new Spicetify.Menu.SubMenu("Shuffle Similar", [
    toggleItem,
    refreshItem,
    createPlaylistItem,
  ])
  subMenu.register()

  shuffleSimilarStatus.subscribe(() => {
    toggleItem.setState(sessionManager.isToggleEnabled())
  })

  profileMenuRegistered = true
  console.info("[Shuffle Similar] Profile menu registered")
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

  Spicetify.showNotification(
    `Created "Similar to - ${seed.trackName}" with ${playlist.trackCount} tracks. Playing now.`
  )
}

export const registerContextMenu = () => {
  patchContextMenuV2()
  registerProfileMenu()

  if (contextMenuRegistered) return

  if (!Spicetify.ContextMenu?.Item) {
    throw new Error("Spicetify.ContextMenu.Item is not available")
  }

  new Spicetify.ContextMenu.Item(
    "Start Similar Mix",
    runPlayWithShuffleSimilar,
    isSupportedSimilarMixTarget,
    "enhance"
  ).register()

  new Spicetify.ContextMenu.Item(
    "Create Similar Playlist",
    runCreateSimilarPlaylist,
    isSupportedSimilarMixTarget,
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

  contextMenuRegistered = true
  console.info("[Shuffle Similar] Context menus registered")
}
