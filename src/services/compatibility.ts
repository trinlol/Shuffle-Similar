export type QueueCompatibilityReport = {
  ready: boolean
  missing: string[]
}

const functionAt = (value: unknown, path: readonly string[]): boolean => {
  let current: unknown = value
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return false
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === "function"
}

/** Checks the public queue contract that v2 relies on before it mutates playback. */
export const inspectQueueCompatibility = (runtime: unknown): QueueCompatibilityReport => {
  const required = [
    ["Platform", "PlayerAPI", "clearQueue"],
    ["Platform", "PlayerAPI", "addToQueue"],
    ["Platform", "PlayerAPI", "play"],
  ] as const
  const missing = required
    .filter((path) => !functionAt(runtime, path))
    .map((path) => `Spicetify.${path.join(".")}`)
  return { ready: missing.length === 0, missing }
}

export const assertQueueCompatibility = (): void => {
  const report = inspectQueueCompatibility(Spicetify)
  if (report.ready) return
  const error = new Error(`Spotify is not ready for Similar Mix (${report.missing.join(", ")})`)
  ;(error as Error & { code?: string }).code = "SERVICE_UNAVAILABLE"
  throw error
}
