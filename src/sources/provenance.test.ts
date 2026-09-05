import { describe, expect, it } from "vitest"
import {
  attachSourceProvenance,
  getSourceProvenance,
  mergeCandidatesWithProvenance,
} from "./provenance"

describe("source provenance", () => {
  it("attaches inspectable provenance and merges it across duplicate candidates", () => {
    const merged = mergeCandidatesWithProvenance([
      attachSourceProvenance({ uri: "spotify:track:one", artistName: "Artist" }, "radio"),
      attachSourceProvenance({ uri: "spotify:track:one", albumName: "Album" }, "genre-era-search"),
      attachSourceProvenance({ uri: "spotify:track:two" }, "inspired-by"),
    ])

    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ artistName: "Artist", albumName: "Album" })
    expect(getSourceProvenance(merged[0])).toEqual(["radio", "genre-era-search"])
    expect(Object.keys(merged[0])).toContain("sourceProvenance")
  })

  it("deduplicates and bounds provenance attached by noisy source combinations", () => {
    let candidate = { uri: "spotify:track:one" }
    for (let index = 0; index < 30; index += 1) {
      candidate = attachSourceProvenance(candidate, `source-${index}`)
    }
    candidate = attachSourceProvenance(candidate, "source-29")

    const provenance = getSourceProvenance(candidate)
    expect(provenance.length).toBeLessThanOrEqual(12)
    expect(new Set(provenance).size).toBe(provenance.length)
    expect(provenance).toContain("source-29")
  })
})
