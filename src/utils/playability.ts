import { getUriId } from "./uri"

type WebApiTrack = {
  id?: string
  uri?: string
  is_playable?: boolean
}

export const getMarket = (): string => {
  try {
    const locale = Spicetify.Locale.getLocale().replace("_", "-")
    const country = locale.split("-")[1]
    if (country) return country.toUpperCase()
  } catch {
    // ignore
  }
  return "GB"
}

const toTrackUri = (track: WebApiTrack): string | null => {
  if (track.uri?.startsWith("spotify:track:")) return track.uri
  if (track.id) return `spotify:track:${track.id}`
  return null
}

export const isWebApiTrackPlayable = (track: WebApiTrack | null | undefined): boolean => {
  const uri = track ? toTrackUri(track) : null
  if (!uri) return false
  return track?.is_playable !== false
}

export const filterPlayableUris = async (uris: string[]): Promise<string[]> => {
  const uniqueUris = [...new Set(uris.filter((uri) => uri.startsWith("spotify:track:")))]
  if (uniqueUris.length === 0) return []

  const playableUris = new Set<string>()
  const market = getMarket()

  for (let offset = 0; offset < uniqueUris.length; offset += 50) {
    const chunk = uniqueUris.slice(offset, offset + 50)
    const ids = chunk.map(getUriId).filter(Boolean)
    if (ids.length === 0) {
      for (const uri of chunk) playableUris.add(uri)
      continue
    }

    try {
      const response = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/tracks?ids=${ids.join(",")}&market=${market}`
      )

      const tracks = (response?.tracks ?? []) as Array<WebApiTrack | null>
      let matchedInChunk = 0

      for (const track of tracks) {
        if (!isWebApiTrackPlayable(track)) continue
        const uri = toTrackUri(track!)
        if (!uri) continue
        playableUris.add(uri)
        matchedInChunk += 1
      }

      if (matchedInChunk === 0) {
        for (const uri of chunk) playableUris.add(uri)
      }
    } catch (error) {
      console.warn("[Shuffle Similar] playability check failed, keeping chunk", error)
      for (const uri of chunk) playableUris.add(uri)
    }
  }

  const validated = uniqueUris.filter((uri) => playableUris.has(uri))
  if (validated.length === 0) return uniqueUris

  return validated
}
