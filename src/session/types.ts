export type TrackCandidate = {
  uri: string
  artistUri?: string
  artistName?: string
  albumUri?: string
  popularity?: number
  releaseYear?: number
}

export type SeedMetadata = {
  uri: string
  trackId: string
  trackName: string
  artistName: string
  artistUri: string
  albumUri?: string
  releaseYear?: number
  genres: string[]
}

export type BlendPhase = {
  maxPosition: number
  similarWeight: number
  profileWeight: number
}
