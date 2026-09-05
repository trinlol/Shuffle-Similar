import { describe, expect, it } from "vitest"
import { attachSourceProvenance } from "../sources/provenance"
import { explainSimilarMixTrack } from "./explainability"

describe("Similar Mix explanations", () => {
  it("states real source provenance and a measurable music match", () => {
    const candidate = attachSourceProvenance(
      attachSourceProvenance({ uri: "spotify:track:next", tempo: 123 }, "radio"),
      "profile-library"
    )
    expect(
      explainSimilarMixTrack(candidate, {
        uri: "spotify:track:seed",
        trackId: "seed",
        trackName: "Seed",
        artistName: "Artist",
        artistUri: "spotify:artist:seed",
        genres: [],
        tempo: 120,
      })
    ).toBe(
      "Selected from track radio and your listening library; it has a close tempo to the seed track."
    )
  })

  it("does not invent a source when metadata does not contain one", () => {
    expect(explainSimilarMixTrack({ uri: "spotify:track:next" }, null)).toBe(
      "Selected to balance similarity, discovery, and variety."
    )
  })
})
