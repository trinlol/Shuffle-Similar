export type PrefetchedQueue = {
  revision: number
  generation?: number
  uris: string[]
}

type StoredPrefetch = PrefetchedQueue & { generation: number; expiresAt: number }

/** Keeps planning work warm, but never treats prefetching as queue ownership. */
export const createPrefetchCache = (ttlMs = 45_000) => {
  let entry: StoredPrefetch | null = null

  return {
    save: (prefetch: PrefetchedQueue, now = Date.now()): void => {
      const uris = [
        ...new Set(prefetch.uris.filter((uri) => uri.startsWith("spotify:track:"))),
      ].slice(0, 100)
      entry =
        uris.length > 0
          ? {
              revision: prefetch.revision,
              generation: prefetch.generation ?? 0,
              uris,
              expiresAt: now + Math.max(1, ttlMs),
            }
          : null
    },
    take: (revision: number, generation = 0, now = Date.now()): string[] | null => {
      if (
        !entry ||
        entry.revision !== revision ||
        entry.generation !== generation ||
        entry.expiresAt < now
      ) {
        entry = null
        return null
      }
      const uris = [...entry.uris]
      entry = null
      return uris
    },
    has: (revision: number, generation = 0, now = Date.now()): boolean =>
      Boolean(
        entry &&
          entry.revision === revision &&
          entry.generation === generation &&
          entry.expiresAt >= now
      ),
    clear: (): void => {
      entry = null
    },
  }
}
