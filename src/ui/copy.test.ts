import { describe, expect, it } from "vitest"
import {
  COPY,
  savedPlayedPlaylistMessage,
  savedPlaylistMessage,
  savePlayedPlaylistTooltip,
  timelineSeedLabel,
  timelineSeedTooltip,
} from "./copy"

describe("Similar Mix copy", () => {
  it("gives every action a distinct, non-empty name", () => {
    const values = Object.values(COPY)
    expect(values.every((value) => value.trim().length > 0)).toBe(true)
    expect(new Set(values).size).toBe(values.length)
  })

  it("never names the playlist-saving action as starting a mix", () => {
    for (const value of [COPY.menuSavePlaylist, COPY.savingPlaylist, COPY.savePlaylistFailed]) {
      expect(value).not.toMatch(/Start/)
    }
    expect(savedPlaylistMessage("Song", 25)).toBe(
      'Saved "Similar to - Song" with 25 tracks. Playing now.'
    )
    expect(savedPlayedPlaylistMessage("Song", 1)).toBe(
      'Saved "Similar to - Song" with 1 played song.'
    )
    expect(savedPlayedPlaylistMessage("Song", 8)).toBe(
      'Saved "Similar to - Song" with 8 played songs.'
    )
  })

  it("formats the timeline seed label and played-queue playlist tooltip", () => {
    expect(timelineSeedLabel("Ribs")).toBe("Playing similar songs based on Ribs")
    expect(timelineSeedTooltip("Ribs", "Lorde")).toBe(
      'Playing similar songs based on "Ribs" by Lorde'
    )
    expect(savePlayedPlaylistTooltip(1)).toBe("Save playlist with 1 song played from this queue")
    expect(savePlayedPlaylistTooltip(5)).toBe(
      "Save playlist with all 5 songs played from this queue"
    )
  })

  it("keeps the toggle labels the playbar button has always used", () => {
    expect(COPY.toggleOn).toBe("Turn on Similar Mix")
    expect(`${COPY.toggleOff} · ${COPY.toggleRefreshHint}`).toBe(
      "Turn off Similar Mix · Shift+click to refresh"
    )
  })
})
