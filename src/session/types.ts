export type TrackCandidate = {
  uri: string
  artistUri?: string
  artistName?: string
  albumUri?: string
  albumName?: string
  trackName?: string
  popularity?: number
  releaseYear?: number
  instrumentalness?: number
}

export type SeedMetadata = {
  uri: string
  trackId: string
  trackName: string
  artistName: string
  artistUri: string
  albumUri?: string
  albumName?: string
  releaseYear?: number
  genres: string[]
  instrumentalness?: number
}

export type BlendPhase = {
  maxPosition: number
  similarWeight: number
  profileWeight: number
}
