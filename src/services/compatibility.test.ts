import { describe, expect, it } from "vitest"
import { inspectQueueCompatibility } from "./compatibility"

describe("queue compatibility", () => {
  it("accepts the public playback queue contract", () => {
    expect(inspectQueueCompatibility({
      Platform: { PlayerAPI: { clearQueue() {}, addToQueue() {}, play() {} } },
    })).toEqual({ ready: true, missing: [] })
  })

  it("names missing capabilities before a queue mutation begins", () => {
    expect(inspectQueueCompatibility({ Platform: { PlayerAPI: { clearQueue() {} } } }))
      .toEqual({
        ready: false,
        missing: [
          "Spicetify.Platform.PlayerAPI.addToQueue",
          "Spicetify.Platform.PlayerAPI.play",
        ],
      })
  })
})
