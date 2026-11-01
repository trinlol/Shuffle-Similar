/** Short, user-visible reference codes for queue failures. Shared by the
 * queue layer (which throws them) and the UI (which shows them). */
export const QUEUE_FAILURE_REASONS = [
  "queue_timeout",
  "queue_clear_failed",
  "queue_not_confirmed",
  "queue_replace_failed",
] as const

export type QueueFailureReason = (typeof QUEUE_FAILURE_REASONS)[number]

const REASON_SET: ReadonlySet<string> = new Set(QUEUE_FAILURE_REASONS)

export const isQueueFailureReason = (value: unknown): value is QueueFailureReason =>
  typeof value === "string" && REASON_SET.has(value)

export type QueueError = Error & { code: "SERVICE_UNAVAILABLE"; reason: QueueFailureReason }

export const createQueueError = (message: string, reason: QueueFailureReason): QueueError =>
  Object.assign(new Error(message), { code: "SERVICE_UNAVAILABLE" as const, reason })
