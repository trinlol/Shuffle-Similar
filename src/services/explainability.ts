import type { SeedMetadata, TrackCandidate } from "../session/types"
import { getSourceProvenance } from "../sources/provenance"

const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  recommendations: "Spotify recommendations",
  radio: "track radio",
  "inspired-by": "similar artists",
  "related-artists": "related artists",
  "playlist-context": "the selected playlist",
  "playlist-discovery": "playlist discovery",
  "profile-library": "your listening library",
  "artist-discography": "the artist's catalogue",
  "album-peers": "the album",
  "genre-era-search": "genre and era discovery",
  "era-search": "era discovery",
  "taste-profile": "your learned taste profile",
})

const humanList = (values: readonly string[]): string => {
  if (values.length <= 1) return values[0] ?? "discovery signals"
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`
}

/** A short, truthful explanation suitable for a menu notification. It only
 * uses locally available metadata; it never guesses at Spotify's ranking. */
export const explainSimilarMixTrack = (
  candidate: TrackCandidate,
  seed: SeedMetadata | null
): string => {
  const sourceLabels = [
    ...new Set(
      getSourceProvenance(candidate)
        .map((source) => SOURCE_LABELS[source])
        .filter((source): source is string => Boolean(source))
    ),
  ].slice(0, 2)
  const source =
    sourceLabels.length > 0
      ? `Selected from ${humanList(sourceLabels)}`
      : "Selected to balance similarity, discovery, and variety"

  if (
    seed?.tempo != null &&
    candidate.tempo != null &&
    Math.abs(seed.tempo - candidate.tempo) <= 8
  ) {
    return `${source}; it has a close tempo to the seed track.`
  }
  if (
    seed?.energy != null &&
    candidate.energy != null &&
    Math.abs(seed.energy - candidate.energy) <= 0.1
  ) {
    return `${source}; it has similar energy to the seed track.`
  }
  return `${source}.`
}
