type WebApiTrack = {
  id?: string
  uri?: string
  is_playable?: boolean
  is_local?: boolean
}

const QUEUE_PLAYABILITY_PROBE_LIMIT = 12
const QUEUE_PLAYABILITY_PROBE_CONCURRENCY = 3
const QUEUE_PLAYABILITY_CACHE_LIMIT = 512
const QUEUE_PLAYABILITY_CACHE_TTL_MS = 6 * 60 * 60 * 1_000
const QUEUE_PLAYABILITY_TIMEOUT_MS = 3_500

type QueuePlayabilityCacheEntry = {
  playable: boolean
  checkedAt: number
}

const queuePlayabilityCache = new Map<string, QueuePlayabilityCacheEntry>()

export type QueuePlayabilityResult = {
  playableUris: string[]
  rejectedUris: string[]
  uncheckedUris: string[]
  checkedUris: string[]
  degraded: boolean
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
  // Spotify removed the multi-track lookup used by older builds from newer
  // Dev Mode access in February 2026. Every discovery adapter now filters the
  // playability metadata it already receives; this final boundary therefore
  // validates and deduplicates URIs without making a fragile extra request.
  return [...new Set(uris.filter((uri) => uri.startsWith("spotify:track:")))]
}

const runWithTimeout = async <T>(work: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("playability probe timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const cacheQueuePlayability = (key: string, playable: boolean, checkedAt: number): void => {
  queuePlayabilityCache.delete(key)
  queuePlayabilityCache.set(key, { playable, checkedAt })
  while (queuePlayabilityCache.size > QUEUE_PLAYABILITY_CACHE_LIMIT) {
    const oldest = queuePlayabilityCache.keys().next().value
    if (!oldest) break
    queuePlayabilityCache.delete(oldest)
  }
}

const uniqueTrackUris = (uris: readonly string[]): string[] => [
  ...new Set(uris.filter((uri) => uri.startsWith("spotify:track:"))),
]

/**
 * Checks the front of a generated queue with the single-track endpoint. The
 * endpoint is intentionally optional: an unavailable capability must not
 * stop playback, but an explicit unavailable/local result is never queued.
 */
export const verifyQueuePlayability = async (
  uris: readonly string[],
  options: { maxChecks?: number; now?: number } = {}
): Promise<QueuePlayabilityResult> => {
  const uniqueUris = uniqueTrackUris(uris)
  const maxChecks = Math.max(
    0,
    Math.min(uniqueUris.length, options.maxChecks ?? QUEUE_PLAYABILITY_PROBE_LIMIT)
  )
  const market = getMarket()
  const now = options.now ?? Date.now()
  const rejected = new Set<string>()
  const unchecked = new Set<string>(uniqueUris.slice(maxChecks))
  const checked = new Set<string>()
  let degraded = false
  let nextIndex = 0

  const inspect = async (uri: string): Promise<void> => {
    const cacheKey = `${market}:${uri}`
    const cached = queuePlayabilityCache.get(cacheKey)
    if (cached && now - cached.checkedAt <= QUEUE_PLAYABILITY_CACHE_TTL_MS) {
      checked.add(uri)
      if (!cached.playable) rejected.add(uri)
      return
    }

    const id = uri.slice("spotify:track:".length)
    if (!id) {
      checked.add(uri)
      rejected.add(uri)
      return
    }

    try {
      const track = await runWithTimeout<WebApiTrack | null>(
        () => Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${id}?market=${market}`),
        QUEUE_PLAYABILITY_TIMEOUT_MS
      )
      const playable = Boolean(
        track && track.uri === uri && track.is_playable !== false && track.is_local !== true
      )
      checked.add(uri)
      cacheQueuePlayability(cacheKey, playable, now)
      if (!playable) rejected.add(uri)
    } catch {
      // Capability restrictions and transient network failures are degraded,
      // not fatal. The public PlayerAPI remains the final playback contract.
      degraded = true
      unchecked.add(uri)
    }
  }

  const workers = Array.from(
    { length: Math.min(QUEUE_PLAYABILITY_PROBE_CONCURRENCY, maxChecks) },
    async () => {
      while (nextIndex < maxChecks) {
        const index = nextIndex
        nextIndex += 1
        await inspect(uniqueUris[index])
      }
    }
  )
  await Promise.all(workers)

  const acceptedUris = uniqueUris.filter((uri) => !rejected.has(uri))
  const verifiedPlayableUris = acceptedUris.filter((uri) => checked.has(uri))
  const uncheckedUris = acceptedUris.filter((uri) => unchecked.has(uri))

  return {
    // A transiently failed probe is still allowed as a degraded fallback, but
    // it must not be the first track Spotify reaches on Skip when positively
    // verified alternatives exist. Preserve ranking within both groups.
    playableUris:
      verifiedPlayableUris.length > 0 ? [...verifiedPlayableUris, ...uncheckedUris] : uncheckedUris,
    rejectedUris: uniqueUris.filter((uri) => rejected.has(uri)),
    uncheckedUris,
    checkedUris: uniqueUris.filter((uri) => checked.has(uri)),
    degraded,
  }
}

export const resetQueuePlayabilityCache = (): void => queuePlayabilityCache.clear()
