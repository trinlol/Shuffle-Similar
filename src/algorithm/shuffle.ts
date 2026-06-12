export const fisherYatesShuffle = <T>(array: T[]): T[] => {
  const result = [...array]
  let counter = result.length
  if (counter <= 1) return result

  while (counter > 0) {
    const index = Math.floor(Math.random() * counter)
    counter -= 1
    const temp = result[counter]
    result[counter] = result[index]
    result[index] = temp
  }

  return result
}

export const pickRandom = <T>(items: T[]): T | null => {
  if (items.length === 0) return null
  return items[Math.floor(Math.random() * items.length)]
}

export const pickWeightedRandom = <T>(items: T[], weights: number[]): T | null => {
  if (items.length === 0) return null
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) return pickRandom(items)

  let roll = Math.random() * total
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index]
    if (roll <= 0) return items[index]
  }

  return items[items.length - 1]
}

/**
 * Gentle position-jitter shuffle that preserves the overall ordering
 * from buildTrackBatch while introducing enough randomness to feel
 * unpredictable.  Each element is displaced by at most ±jitter positions.
 */
export const softShuffle = <T>(array: T[], jitter = 3): T[] => {
  if (array.length <= 1) return [...array]

  const indexed = array.map((item, index) => ({
    item,
    sortKey: index + (Math.random() * 2 - 1) * jitter,
  }))

  indexed.sort((a, b) => a.sortKey - b.sortKey)
  return indexed.map((entry) => entry.item)
}

/**
 * Converts raw Spotify popularity (0–100) into a smooth selection weight.
 * Lower popularity → higher weight when `favorObscure` is true.
 * Uses an exponential curve so the transition is gradual rather than a
 * harsh linear inversion.
 *
 * @param popularity  Raw Spotify popularity score (0–100)
 * @param favorObscure  If true, obscure tracks get more weight
 * @param steepness  Controls how aggressively obscure tracks are favored (default 2.5)
 */
export const popularityWeight = (
  popularity: number,
  favorObscure: boolean,
  steepness = 2.5
): number => {
  const pop = Math.max(0, Math.min(100, popularity ?? 50))

  if (!favorObscure) return 1

  // Normalize to 0–1 range, invert, then apply exponential curve
  const normalized = 1 - pop / 100
  return Math.pow(normalized, 1) * steepness + 0.3
}
