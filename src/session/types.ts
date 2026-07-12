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
  tempo?: number
  energy?: number
  valence?: number
  danceability?: number
  acousticness?: number
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
  popularity?: number
  tempo?: number
  energy?: number
  valence?: number
  danceability?: number
  acousticness?: number
}

export type AcousticProfile = Pick<
  TrackCandidate,
  "tempo" | "energy" | "valence" | "danceability" | "acousticness" | "instrumentalness"
>

export type SkipFeedback = {
  artistUri?: string
  artistName?: string
  profile: AcousticProfile
}

export type BlendPhase = {
  maxPosition: number
  similarWeight: number
  profileWeight: number
}
