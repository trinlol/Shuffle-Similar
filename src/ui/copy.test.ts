import { describe, expect, it } from "vitest"
import { COPY, savedPlaylistMessage } from "./copy"

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
  })

  it("keeps the toggle labels the playbar button has always used", () => {
    expect(COPY.toggleOn).toBe("Turn on Similar Mix")
    expect(`${COPY.toggleOff} · ${COPY.toggleRefreshHint}`).toBe(
      "Turn off Similar Mix · Shift+click to refresh"
    )
  })
})
