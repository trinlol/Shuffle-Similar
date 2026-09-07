import { getUriId } from "../utils/uri"

const MEMBERSHIP_TIMEOUT_MS = 4_000
const MEMBERSHIP_CONCURRENCY = 3

type RootlistNode = { type?: string; uri?: string; name?: string; items?: RootlistNode[] }
type RootlistRoot = RootlistNode[] | { items?: RootlistNode[] }

const runWithTimeout = async <T>(work: () => Promise<T>, ms: number): Promise<T> =>
  await Promise.race([
    work(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ])

/** Enumeration failure yields an empty set — exclusion silently doesn't apply. */
export const buildPlaylistMembershipSet = async (): Promise<Set<string>> => {
  const membership = new Set<string>()
  try {
    const root = (await runWithTimeout(
      () => Spicetify.Platform.RootlistAPI.getContents() as Promise<RootlistRoot>,
      MEMBERSHIP_TIMEOUT_MS
    )) as RootlistRoot
    const playlistUris: string[] = []
    const walk = (items: RootlistNode[]) => {
      for (const item of items) {
        if (item.type === "playlist" && item.uri) playlistUris.push(item.uri)
        if (item.items) walk(item.items)
      }
    }
    // The rootlist payload is either the node list itself or a node with items.
    if (Array.isArray(root)) walk(root)
    else walk(root.items ?? [])

    let active = 0
    const waiters: Array<() => void> = []
    const acquire = async () => {
      if (active < MEMBERSHIP_CONCURRENCY) {
        active += 1
        return
      }
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    const release = () => {
      const next = waiters.shift()
      if (next) {
        next()
        return
      }
      active = Math.max(0, active - 1)
    }

    await Promise.all(
      playlistUris.map(async (playlistUri) => {
        const playlistId = getUriId(playlistUri)
        if (!playlistId) return
        await acquire()
        try {
          type PlaylistContents = { items?: Array<{ uri?: string; isPlayable?: boolean }> }
          const res = await runWithTimeout<PlaylistContents>(
            () =>
              Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
                limit: 100,
              }) as Promise<PlaylistContents>,
            MEMBERSHIP_TIMEOUT_MS
          )
          for (const item of res?.items ?? []) {
            if (
              typeof item?.uri === "string" &&
              item.uri.startsWith("spotify:track:") &&
              item.isPlayable !== false
            ) {
              membership.add(item.uri)
            }
          }
        } catch {
          // One unavailable playlist must not sink the whole set.
        } finally {
          release()
        }
      })
    )
  } catch {
    // Enumeration failed — exclusion silently doesn't apply this session.
  }
  return membership
}
