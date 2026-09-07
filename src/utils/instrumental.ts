/** Genre/album-name patterns that suggest an instrumental track. Shared by
 * the source-layer filter and the central eligibility choke point. */
export const INSTRUMENTAL_PATTERNS =
  /(soundtrack|\bscore\b|\bclassical\b|\borchestral\b|\bambient\b|\binstrumental\b|\bpiano\b|\bquartet\b|\bfilm score\b|\bmovie tunes\b)/i

export const VOCAL_INDICATOR_PATTERNS =
  /\b(vocal|vocals|lyrics|sung|sing|sings|feat\.|greatest hits|live at)\b/i

/** True when genres or album name suggest an instrumental track. */
export const looksInstrumental = (input: { albumName?: string; genres?: string[] }): boolean => {
  const albumName = input.albumName
  const albumMatches =
    albumName !== undefined &&
    INSTRUMENTAL_PATTERNS.test(albumName) &&
    !VOCAL_INDICATOR_PATTERNS.test(albumName)
  const genreMatches = input.genres?.some(
    (genre) => INSTRUMENTAL_PATTERNS.test(genre) && !VOCAL_INDICATOR_PATTERNS.test(genre)
  )
  return Boolean(albumMatches || genreMatches)
}

export const SEED_INSTRUMENTALNESS_THRESHOLD = 0.9
export const CANDIDATE_INSTRUMENTALNESS_FLOOR = 0.5
