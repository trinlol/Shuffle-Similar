import { describe, expect, it } from "vitest"
import {
  planSlateV2,
  rankCandidatesV2,
  type BlendFamily,
  type RankableCandidate,
} from "./rankingV2"

const familyCandidates = (family: BlendFamily, count: number): RankableCandidate[] =>
  Array.from({ length: count }, (_, index) => ({
    uri: `spotify:track:${family}-${index}`,
    title: `${family} ${index}`,
    artistUris: [`spotify:artist:${family}-${index}`],
    albumUri: `spotify:album:${family}-${index}`,
    provenance: [{ source: `${family}-source`, family, rank: 1 }],
  }))

describe("rankCandidatesV2", () => {
  it("fuses weighted source ranks instead of discarding provenance", () => {
    const candidates: RankableCandidate[] = [
      {
        uri: "spotify:track:single-source",
        title: "Single Source",
        provenance: [{ source: "radio", family: "similar", rank: 1 }],
      },
      {
        uri: "spotify:track:multi-source",
        title: "Multi Source",
        provenance: [
          { source: "radio", family: "similar", rank: 10 },
          { source: "library", family: "profile", rank: 1 },
        ],
      },
    ]

    const ranked = rankCandidatesV2(candidates, {
      sourceWeights: { radio: 1, library: 2 },
    })

    expect(ranked.map((candidate) => candidate.uri)).toEqual([
      "spotify:track:multi-source",
      "spotify:track:single-source",
    ])
  })

  it("redistributes missing signal weight across available score components", () => {
    const [ranked] = rankCandidatesV2([
      {
        uri: "spotify:track:partial-metadata",
        provenance: [{ source: "radio", family: "similar", rank: 1 }],
        signals: { tasteAffinity: 0.8 },
      },
    ])

    const effectiveWeight = Object.values(ranked.breakdown.effectiveWeights).reduce(
      (sum, value) => sum + value,
      0
    )
    const contributionTotal = Object.values(ranked.breakdown.contributions).reduce(
      (sum, value) => sum + value,
      0
    )

    expect(effectiveWeight).toBeCloseTo(1)
    expect(ranked.breakdown.effectiveWeights.context).toBe(0)
    expect(ranked.score).toBeCloseTo(contributionTotal)
  })

  it("keeps sparse candidates rankable and explains their partial metadata", () => {
    const ranked = rankCandidatesV2([
      {
        uri: "spotify:track:sparse-a",
        provenance: [{ source: "inspired-by", family: "similar", rank: 1 }],
      },
      {
        uri: "spotify:track:sparse-b",
        provenance: [{ source: "library", family: "profile", rank: 1 }],
      },
    ])
    const plan = planSlateV2(ranked, { count: 3, rngSeed: "sparse" })

    expect(ranked.every((candidate) => candidate.reasonCodes.includes("rank:partial-metadata"))).toBe(
      true
    )
    expect(plan.metrics.selectedCount).toBe(2)
  })

  it("responds immediately to skip evidence without making it a hard exclusion", () => {
    const candidates: RankableCandidate[] = [
      {
        uri: "spotify:track:skip-neighbor",
        title: "Skip Neighbor",
        artistUris: ["spotify:artist:skipped"],
        albumUri: "spotify:album:neighbor",
        acoustic: { tempo: 121, energy: 0.71, valence: 0.59 },
        provenance: [{ source: "radio", family: "similar", rank: 1 }],
      },
      {
        uri: "spotify:track:alternative",
        title: "Alternative",
        artistUris: ["spotify:artist:other"],
        albumUri: "spotify:album:alternative",
        acoustic: { tempo: 170, energy: 0.25, valence: 0.2 },
        provenance: [{ source: "radio", family: "similar", rank: 1 }],
      },
    ]
    const before = new Map(rankCandidatesV2(candidates).map((candidate) => [candidate.uri, candidate]))
    const after = new Map(
      rankCandidatesV2(candidates, {
        skipSignals: [
          {
            artistUris: ["spotify:artist:skipped"],
            acoustic: { tempo: 120, energy: 0.7, valence: 0.6 },
            confidence: 1,
          },
        ],
      }).map((candidate) => [candidate.uri, candidate])
    )

    expect(after.get("spotify:track:skip-neighbor")!.score).toBeLessThan(
      before.get("spotify:track:skip-neighbor")!.score
    )
    expect(after.get("spotify:track:skip-neighbor")!.score).toBeGreaterThan(0)
    expect(after.get("spotify:track:skip-neighbor")!.reasonCodes).toContain(
      "rank:skip-penalized"
    )
  })
})

describe("planSlateV2", () => {
  it("applies progressive blend phases to each absolute queue position", () => {
    const ranked = rankCandidatesV2([
      ...familyCandidates("similar", 20),
      ...familyCandidates("profile", 20),
    ])

    const plan = planSlateV2(ranked, {
      count: 16,
      absoluteStartPosition: 0,
      rngSeed: "phase-regression",
    })

    expect(plan.items.slice(0, 5).map((item) => item.dominantFamily)).toEqual([
      "similar",
      "similar",
      "similar",
      "similar",
      "similar",
    ])
    expect(plan.items.slice(5).some((item) => item.dominantFamily === "profile")).toBe(true)
    expect(plan.items[10].blendWeights).toEqual({ similar: 0.4, profile: 0.6 })
  })

  it("replays exactly for one seed while allowing another seed to explore", () => {
    const ranked = rankCandidatesV2([
      ...familyCandidates("similar", 12),
      ...familyCandidates("profile", 12),
    ])
    const build = (rngSeed: string) =>
      planSlateV2(ranked, { count: 12, absoluteStartPosition: 5, rngSeed }).items.map(
        (item) => item.candidate.uri
      )

    expect(build("listener-a")).toEqual(build("listener-a"))
    expect(build("listener-a")).not.toEqual(build("listener-b"))
  })

  it("returns a duplicate-free slate with strong early artist spacing", () => {
    const candidates: RankableCandidate[] = Array.from({ length: 6 }, (_, artist) =>
      Array.from({ length: 2 }, (_, track) => ({
        uri: `spotify:track:diverse-${artist}-${track}`,
        title:
          artist === 0
            ? track === 0
              ? "Midnight Signal"
              : "Midnight Signal - 2011 Remaster"
            : `Track ${artist}-${track}`,
        artistUris: [`spotify:artist:${artist}`],
        albumUri: `spotify:album:${artist}-${track}`,
        provenance: [{ source: "radio", family: "similar" as const, rank: 1 }],
      }))
    ).flat()

    const plan = planSlateV2(rankCandidatesV2(candidates), {
      count: 12,
      absoluteStartPosition: 0,
      rngSeed: "diversity",
    })
    const uris = plan.items.map((item) => item.candidate.uri)

    expect(plan.metrics.selectedCount).toBe(11)
    expect(uris).not.toEqual(
      expect.arrayContaining(["spotify:track:diverse-0-0", "spotify:track:diverse-0-1"])
    )
    expect(plan.metrics.artistSpacingViolations).toBe(0)
    expect(plan.metrics.maxArtistCountFirst20).toBeLessThanOrEqual(2)
    expect(plan.metrics.canonicalDuplicateViolations).toBe(0)
  })

  it("keeps tracks from one album at least four intervening positions apart", () => {
    const candidates: RankableCandidate[] = [
      ...Array.from({ length: 2 }, (_, index) => ({
        uri: `spotify:track:shared-album-${index}`,
        title: `Shared Album ${index}`,
        artistUris: [`spotify:artist:shared-${index}`],
        albumUri: "spotify:album:shared",
        provenance: [{ source: "radio", family: "similar" as const, rank: index + 1 }],
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        uri: `spotify:track:album-spacer-${index}`,
        title: `Album Spacer ${index}`,
        artistUris: [`spotify:artist:spacer-${index}`],
        albumUri: `spotify:album:spacer-${index}`,
        provenance: [{ source: "radio", family: "similar" as const, rank: 40 + index }],
      })),
    ]
    const plan = planSlateV2(rankCandidatesV2(candidates), {
      count: candidates.length,
      rngSeed: "album-spacing",
    })
    const sharedPositions = plan.items
      .map((item, index) => ({ index, albumUri: item.candidate.albumUri }))
      .filter((entry) => entry.albumUri === "spotify:album:shared")
      .map((entry) => entry.index)

    expect(sharedPositions[1] - sharedPositions[0]).toBeGreaterThanOrEqual(5)
    expect(plan.metrics.albumSpacingViolations).toBe(0)
  })

  it("paces acoustic transitions instead of taking a higher-ranked abrupt jump", () => {
    const queueTail: RankableCandidate[] = [
      {
        uri: "spotify:track:current",
        title: "Current",
        artistUris: ["spotify:artist:current"],
        albumUri: "spotify:album:current",
        acoustic: { tempo: 120, energy: 0.72, valence: 0.6 },
        provenance: [],
      },
    ]
    const ranked = rankCandidatesV2([
      {
        uri: "spotify:track:abrupt",
        title: "Abrupt",
        artistUris: ["spotify:artist:abrupt"],
        albumUri: "spotify:album:abrupt",
        acoustic: { tempo: 200, energy: 0.05, valence: 0.05 },
        provenance: [{ source: "radio", family: "similar", rank: 1 }],
      },
      {
        uri: "spotify:track:smooth",
        title: "Smooth",
        artistUris: ["spotify:artist:smooth"],
        albumUri: "spotify:album:smooth",
        acoustic: { tempo: 124, energy: 0.68, valence: 0.58 },
        provenance: [{ source: "radio", family: "similar", rank: 10 }],
      },
    ])

    const plan = planSlateV2(ranked, {
      count: 1,
      queueTail,
      maxAcousticTransition: 0.3,
      rngSeed: "pacing",
    })

    expect(plan.items[0].candidate.uri).toBe("spotify:track:smooth")
    expect(plan.items[0].reasonCodes).toContain("transition:acoustic-paced")
    expect(plan.metrics.acousticTransitionViolations).toBe(0)
  })

  it("relaxes soft constraints in a declared order when the pool is thin", () => {
    const queueTail: RankableCandidate[] = [
      {
        uri: "spotify:track:tail",
        title: "Tail",
        artistUris: ["spotify:artist:only"],
        albumUri: "spotify:album:only",
        acoustic: { tempo: 70, energy: 0.1, valence: 0.1 },
        provenance: [],
      },
    ]
    const ranked = rankCandidatesV2([
      {
        uri: "spotify:track:last-resort",
        title: "Last Resort",
        artistUris: ["spotify:artist:only"],
        albumUri: "spotify:album:only",
        acoustic: { tempo: 195, energy: 0.95, valence: 0.9 },
        provenance: [{ source: "radio", family: "similar", rank: 1 }],
      },
    ])

    const plan = planSlateV2(ranked, {
      count: 3,
      queueTail,
      maxAcousticTransition: 0.2,
      rngSeed: "thin-pool",
    })
    const relaxations = plan.items[0].reasonCodes.filter((reason) => reason.startsWith("relax:"))

    expect(plan.metrics.selectedCount).toBe(1)
    expect(relaxations).toEqual([
      "relax:acoustic-transition",
      "relax:album-spacing",
      "relax:artist-spacing",
    ])
  })
})
