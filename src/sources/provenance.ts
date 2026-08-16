import type { TrackCandidate } from "../session/types"

const MAX_PROVENANCE_ENTRIES = 12
const MAX_SOURCE_ID_LENGTH = 80

export type ProvenancedTrackCandidate = TrackCandidate & {
  sourceProvenance?: string[]
}

const cleanSourceId = (sourceId: string): string | null => {
  const cleaned = sourceId.trim().slice(0, MAX_SOURCE_ID_LENGTH)
  return cleaned || null
}

export const getSourceProvenance = (candidate: TrackCandidate): readonly string[] => {
  const provenance = (candidate as ProvenancedTrackCandidate).sourceProvenance
  if (!Array.isArray(provenance)) return []
  return provenance.filter((source): source is string => typeof source === "string")
}

export const attachSourceProvenance = (
  candidate: TrackCandidate,
  sourceId: string
): ProvenancedTrackCandidate => {
  const source = cleanSourceId(sourceId)
  const existing = getSourceProvenance(candidate)
  const combined = source ? [...existing.filter((entry) => entry !== source), source] : [...existing]
  return {
    ...candidate,
    sourceProvenance: combined.slice(-MAX_PROVENANCE_ENTRIES),
  }
}

export const mergeCandidatesWithProvenance = (
  candidates: readonly TrackCandidate[]
): TrackCandidate[] => {
  const merged = new Map<string, ProvenancedTrackCandidate>()
  for (const candidate of candidates) {
    if (!candidate.uri) continue
    const existing = merged.get(candidate.uri)
    if (!existing) {
      merged.set(candidate.uri, {
        ...candidate,
        sourceProvenance: [...getSourceProvenance(candidate)].slice(-MAX_PROVENANCE_ENTRIES),
      })
      continue
    }

    const definedValues = Object.fromEntries(
      Object.entries(candidate).filter(
        ([key, value]) => key !== "sourceProvenance" && value !== undefined && value !== null
      )
    ) as Partial<TrackCandidate>
    const provenance = [
      ...getSourceProvenance(existing),
      ...getSourceProvenance(candidate),
    ].filter((source, index, all) => all.indexOf(source) === index)
    merged.set(candidate.uri, {
      ...existing,
      ...definedValues,
      uri: candidate.uri,
      sourceProvenance: provenance.slice(-MAX_PROVENANCE_ENTRIES),
    })
  }
  return [...merged.values()]
}
