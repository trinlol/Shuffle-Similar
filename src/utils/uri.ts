type SpotifyUri = Spicetify.URI & {
  _base62Id?: string
  id?: string
}

export const getUriId = (uri: string): string => {
  const uriObj = Spicetify.URI.fromString(uri) as SpotifyUri
  return uriObj._base62Id ?? uriObj.id ?? uri.split(":").pop() ?? ""
}
