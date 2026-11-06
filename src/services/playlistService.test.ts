import { afterEach, describe, expect, it, vi } from "vitest"
import { sessionManager } from "../session/SessionManager"
import {
  createSimilarPlaylist,
  getSessionPlayedTrackUris,
  savePlayedSessionPlaylist,
} from "./playlistService"

describe("createSimilarPlaylist", () => {
  afterEach(() => {
    sessionManager.endSession()
    vi.unstubAllGlobals()
  })

  it("creates and fills a playlist through Spotify's platform APIs", async () => {
    const rootlistApi = {
      marker: "rootlist",
      createPlaylist: vi.fn(function (this: { marker?: string }) {
        if (this.marker !== "rootlist")
          throw new TypeError("Cannot read properties of undefined (reading '_events')")
        return Promise.resolve("spotify:playlist:new-playlist")
      }),
    }
    const playlistApi = {
      marker: "playlist",
      add: vi.fn(function (this: { marker?: string }) {
        if (this.marker !== "playlist")
          throw new TypeError("Cannot read properties of undefined (reading '_events')")
        return Promise.resolve()
      }),
    }
    vi.stubGlobal("Spicetify", {
      Platform: {
        RootlistAPI: rootlistApi,
        PlaylistAPI: playlistApi,
      },
      CosmosAsync: {
        post: vi.fn().mockResolvedValue(undefined),
      },
    })

    const result = await createSimilarPlaylist("Seed", "Artist", [
      "spotify:track:one",
      "spotify:track:two",
      "spotify:track:one",
    ])

    expect(rootlistApi.createPlaylist).toHaveBeenCalledWith("Similar to - Seed", {
      before: "start",
    })
    expect(playlistApi.add).toHaveBeenCalledWith(
      "spotify:playlist:new-playlist",
      ["spotify:track:one", "spotify:track:two"],
      { before: "start" }
    )
    expect(result).toEqual({
      uri: "spotify:playlist:new-playlist",
      trackCount: 2,
    })
  })

  it("saves a playlist with every song played from the active Similar Mix queue in order", async () => {
    const rootlistApi = {
      createPlaylist: vi.fn().mockResolvedValue("spotify:playlist:played-queue"),
    }
    const playlistApi = {
      add: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal("Spicetify", {
      Player: {
        data: {
          item: { uri: "spotify:track:played-3" },
        },
      },
      Platform: {
        RootlistAPI: rootlistApi,
        PlaylistAPI: playlistApi,
      },
    })

    sessionManager.startSession({
      uri: "spotify:track:seed-song",
      trackId: "seed-song",
      trackName: "Original Song",
      artistName: "Original Artist",
      artistUri: "spotify:artist:orig",
      genres: ["indie pop"],
    })
    sessionManager.setQueuedUris([
      "spotify:track:played-1",
      "spotify:track:played-2",
      "spotify:track:played-3",
      "spotify:track:unplayed-4",
    ])
    sessionManager.recordTrackPlayed("spotify:track:played-1")
    sessionManager.recordTrackPlayed("spotify:track:played-2")

    expect(getSessionPlayedTrackUris()).toEqual([
      "spotify:track:seed-song",
      "spotify:track:played-1",
      "spotify:track:played-2",
      "spotify:track:played-3",
    ])

    const saved = await savePlayedSessionPlaylist()

    expect(rootlistApi.createPlaylist).toHaveBeenCalledWith("Similar to - Original Song", {
      before: "start",
    })
    expect(playlistApi.add).toHaveBeenCalledWith(
      "spotify:playlist:played-queue",
      [
        "spotify:track:seed-song",
        "spotify:track:played-1",
        "spotify:track:played-2",
        "spotify:track:played-3",
      ],
      { before: "start" }
    )
    expect(saved).toEqual({
      uri: "spotify:playlist:played-queue",
      trackCount: 4,
      seedTrackName: "Original Song",
    })
  })
})
