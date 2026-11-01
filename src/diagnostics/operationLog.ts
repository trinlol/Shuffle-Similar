/**
 * A bounded, in-memory record of recent queue and mix operations, so a
 * failure can be explained after the fact. Records hold only operation
 * names, outcomes, numbers and short reason codes: never track URIs,
 * account identifiers or taste data.
 */

export type OperationOutcome = "ok" | "retry" | "timeout" | "failed" | "info"

export type OperationRecord = {
  at: number
  op: string
  outcome: OperationOutcome
  durationMs?: number
  counts?: Record<string, number>
  reason?: string
}

export type DiagnosticsState = { toggleEnabled: boolean; sessionActive: boolean }

const CAPACITY = 50
const SHORT_CODE = /^[a-z][a-z0-9_.]{0,39}$/
/** Count keys are code identifiers, so camelCase is allowed; still no URIs or spaces. */
const COUNT_KEY = /^[a-z][a-zA-Z0-9_]{0,39}$/

const records: OperationRecord[] = []
let stateProvider: (() => DiagnosticsState) | null = null

const sanitizeCounts = (counts?: Record<string, number>): Record<string, number> | undefined => {
  if (!counts) return undefined
  const clean: Record<string, number> = {}
  for (const [key, value] of Object.entries(counts)) {
    if (COUNT_KEY.test(key) && typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value
    }
  }
  return Object.keys(clean).length > 0 ? clean : undefined
}

export const recordOperation = (record: Omit<OperationRecord, "at"> & { at?: number }): void => {
  if (!SHORT_CODE.test(record.op)) return
  const entry: OperationRecord = {
    at: record.at ?? Date.now(),
    op: record.op,
    outcome: record.outcome,
  }
  if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) {
    entry.durationMs = Math.max(0, Math.round(record.durationMs))
  }
  const counts = sanitizeCounts(record.counts)
  if (counts) entry.counts = counts
  if (typeof record.reason === "string" && SHORT_CODE.test(record.reason)) {
    entry.reason = record.reason
  }
  records.push(entry)
  if (records.length > CAPACITY) records.splice(0, records.length - CAPACITY)
}

export const getOperations = (): readonly OperationRecord[] =>
  records.map((record) => ({ ...record }))

export const clearOperations = (): void => {
  records.length = 0
}

/** Lets the app supply toggle/session state without this module importing it. */
export const registerDiagnosticsState = (provider: (() => DiagnosticsState) | null): void => {
  stateProvider = provider
}

type VersionRuntime = { Config?: { version?: unknown }; Platform?: { version?: unknown } }

const readString = (read: () => unknown): string | null => {
  try {
    const value = read()
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

export const buildDiagnosticsReport = (): string => {
  const runtime =
    typeof Spicetify === "undefined" ? undefined : (Spicetify as unknown as VersionRuntime)
  let state: DiagnosticsState | null = null
  try {
    state = stateProvider?.() ?? null
  } catch {
    state = null
  }
  return JSON.stringify(
    {
      extensionVersion:
        typeof __SHUFFLE_SIMILAR_VERSION__ !== "undefined" ? __SHUFFLE_SIMILAR_VERSION__ : null,
      spicetifyVersion: readString(() => runtime?.Config?.version),
      spotifyVersion: readString(() => runtime?.Platform?.version),
      generatedAt: new Date().toISOString(),
      toggleEnabled: state?.toggleEnabled ?? null,
      sessionActive: state?.sessionActive ?? null,
      operations: getOperations(),
    },
    null,
    2
  )
}
