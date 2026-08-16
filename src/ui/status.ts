export type SimilarMixStatus =
  | "off"
  | "building"
  | "on"
  | "refreshing"
  | "stopping"
  | "error"
  | "degraded"

export type SimilarMixStatusTone = "neutral" | "positive" | "informative" | "warning" | "negative"

export interface SimilarMixStatusCopy {
  readonly label: string
  readonly detail: string
  readonly tone: SimilarMixStatusTone
  readonly busy: boolean
}

const statusCopy = <T extends SimilarMixStatusCopy>(copy: T): Readonly<T> => Object.freeze(copy)

export const SIMILAR_MIX_STATUS_COPY: Readonly<Record<SimilarMixStatus, SimilarMixStatusCopy>> =
  Object.freeze({
    off: statusCopy({
      label: "Similar Mix",
      detail: "Ready to shape the queue around what’s playing.",
      tone: "neutral",
      busy: false,
    }),
    building: statusCopy({
      label: "Building your mix",
      detail: "Finding tracks that fit this moment.",
      tone: "informative",
      busy: true,
    }),
    on: statusCopy({
      label: "Similar Mix is on",
      detail: "Your queue is adapting as you listen.",
      tone: "positive",
      busy: false,
    }),
    refreshing: statusCopy({
      label: "Refreshing your mix",
      detail: "Tuning what comes next.",
      tone: "informative",
      busy: true,
    }),
    stopping: statusCopy({
      label: "Turning Similar Mix off",
      detail: "Restoring your regular queue.",
      tone: "neutral",
      busy: true,
    }),
    error: statusCopy({
      label: "Mix paused",
      detail: "We couldn’t update your mix. Try again.",
      tone: "negative",
      busy: false,
    }),
    degraded: statusCopy({
      label: "Mix still playing",
      detail: "Recommendations are limited right now.",
      tone: "warning",
      busy: false,
    }),
  })

export type SimilarMixErrorCode =
  | "offline"
  | "rate_limited"
  | "no_active_track"
  | "playback_unavailable"
  | "service_unavailable"
  | "permission_denied"
  | "storage_unavailable"
  | "unexpected"

export type SimilarMixErrorRecovery = "retry" | "wait" | "choose_track" | "choose_device" | "none"

export interface SimilarMixPublicError {
  readonly code: SimilarMixErrorCode
  readonly title: string
  readonly message: string
  readonly retryable: boolean
  readonly recovery: SimilarMixErrorRecovery
}

const publicError = (
  code: SimilarMixErrorCode,
  title: string,
  message: string,
  retryable: boolean,
  recovery: SimilarMixErrorRecovery
): SimilarMixPublicError => Object.freeze({ code, title, message, retryable, recovery })

export const SIMILAR_MIX_ERROR_COPY: Readonly<Record<SimilarMixErrorCode, SimilarMixPublicError>> = Object.freeze({
  offline: publicError(
    "offline",
    "Connection interrupted",
    "Your mix will recover when Spotify is back online.",
    true,
    "retry"
  ),
  rate_limited: publicError(
    "rate_limited",
    "Taking a quick breather",
    "Spotify needs a moment. We’ll try again shortly.",
    true,
    "wait"
  ),
  no_active_track: publicError(
    "no_active_track",
    "Play something first",
    "Start a track, then turn on Similar Mix.",
    true,
    "choose_track"
  ),
  playback_unavailable: publicError(
    "playback_unavailable",
    "Playback unavailable",
    "Choose an active device and try again.",
    true,
    "choose_device"
  ),
  service_unavailable: publicError(
    "service_unavailable",
    "Mix service unavailable",
    "Spotify couldn’t refresh the mix. Try again in a moment.",
    true,
    "retry"
  ),
  permission_denied: publicError(
    "permission_denied",
    "Similar Mix needs access",
    "Reconnect Spotify before trying again.",
    false,
    "none"
  ),
  storage_unavailable: publicError(
    "storage_unavailable",
    "Learning is temporarily limited",
    "Your mix can continue, but listening preferences may not be saved.",
    true,
    "retry"
  ),
  unexpected: publicError(
    "unexpected",
    "Mix paused",
    "We couldn’t update your mix. Try again.",
    true,
    "retry"
  ),
})

const readErrorHint = (error: unknown, key: string): unknown => {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined

  try {
    return (error as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const normalizeHint = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_")
}

const ERROR_CODE_HINTS: Readonly<Record<string, SimilarMixErrorCode>> = Object.freeze({
  OFFLINE: "offline",
  NETWORK_ERROR: "offline",
  ERR_NETWORK: "offline",
  ECONNREFUSED: "offline",
  RATE_LIMITED: "rate_limited",
  TOO_MANY_REQUESTS: "rate_limited",
  NO_ACTIVE_TRACK: "no_active_track",
  MISSING_SEED: "no_active_track",
  NO_ACTIVE_DEVICE: "playback_unavailable",
  PLAYBACK_UNAVAILABLE: "playback_unavailable",
  RECOMMENDATIONS_UNAVAILABLE: "service_unavailable",
  SERVICE_UNAVAILABLE: "service_unavailable",
  PERMISSION_DENIED: "permission_denied",
  UNAUTHORIZED: "permission_denied",
  STORAGE_UNAVAILABLE: "storage_unavailable",
  QUOTA_EXCEEDED: "storage_unavailable",
})

/** Converts opaque failures into an allow-listed, display-safe public error. */
export const mapSimilarMixError = (error: unknown): SimilarMixPublicError => {
  const statusHint = readErrorHint(error, "status") ?? readErrorHint(error, "statusCode")
  const status = typeof statusHint === "number" && Number.isFinite(statusHint) ? statusHint : undefined

  if (status === 401 || status === 403) return SIMILAR_MIX_ERROR_COPY.permission_denied
  if (status === 429) return SIMILAR_MIX_ERROR_COPY.rate_limited
  if (status === 0) return SIMILAR_MIX_ERROR_COPY.offline
  if (status !== undefined && status >= 500 && status <= 599) {
    return SIMILAR_MIX_ERROR_COPY.service_unavailable
  }

  const rawCode = typeof error === "string" ? error : readErrorHint(error, "code")
  const code = normalizeHint(rawCode)
  const mappedCode = code ? ERROR_CODE_HINTS[code] : undefined
  return SIMILAR_MIX_ERROR_COPY[mappedCode ?? "unexpected"]
}

export interface SimilarMixStatusSnapshot {
  readonly state: SimilarMixStatus
  readonly copy: SimilarMixStatusCopy
  readonly error?: SimilarMixPublicError
  readonly revision: number
  readonly updatedAt: number
}

export type SimilarMixStatusListener = (snapshot: SimilarMixStatusSnapshot) => void

export interface SimilarMixStatusTransaction {
  readonly state: "building" | "refreshing" | "stopping"
  commit(state?: "on" | "off"): boolean
  fail(error: unknown): boolean
  degrade(error: unknown): boolean
}

export interface SimilarMixStatusController {
  getSnapshot(): SimilarMixStatusSnapshot
  subscribe(listener: SimilarMixStatusListener, options?: { readonly emitCurrent?: boolean }): () => void
  transitionTo(state: SimilarMixStatus, error?: unknown): SimilarMixStatusSnapshot
  beginTransition(state: "building" | "refreshing" | "stopping"): SimilarMixStatusTransaction
}

export interface SimilarMixStatusControllerOptions {
  readonly initialState?: SimilarMixStatus
  readonly now?: () => number
}

const hasSameVisibleState = (
  current: SimilarMixStatusSnapshot,
  state: SimilarMixStatus,
  error?: SimilarMixPublicError
): boolean => current.state === state && current.error?.code === error?.code

export const createSimilarMixStatus = (
  options: SimilarMixStatusControllerOptions = {}
): SimilarMixStatusController => {
  const now = options.now ?? Date.now
  const listeners = new Set<SimilarMixStatusListener>()
  let transactionEpoch = 0
  let revision = 0

  const createSnapshot = (
    state: SimilarMixStatus,
    error: SimilarMixPublicError | undefined,
    currentRevision: number
  ): SimilarMixStatusSnapshot => Object.freeze({
    state,
    copy: SIMILAR_MIX_STATUS_COPY[state],
    ...(error ? { error } : {}),
    revision: currentRevision,
    updatedAt: now(),
  })

  let snapshot = createSnapshot(options.initialState ?? "off", undefined, revision)

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A broken view must not prevent other observers or state progress.
      }
    }
  }

  const publish = (state: SimilarMixStatus, error?: unknown): SimilarMixStatusSnapshot => {
    const safeError = state === "error" || state === "degraded" ? mapSimilarMixError(error) : undefined
    if (hasSameVisibleState(snapshot, state, safeError)) return snapshot

    revision += 1
    snapshot = createSnapshot(state, safeError, revision)
    notify()
    return snapshot
  }

  const transitionTo = (state: SimilarMixStatus, error?: unknown): SimilarMixStatusSnapshot => {
    transactionEpoch += 1
    return publish(state, error)
  }

  const beginTransition = (
    state: "building" | "refreshing" | "stopping"
  ): SimilarMixStatusTransaction => {
    transactionEpoch += 1
    const epoch = transactionEpoch
    let settled = false
    publish(state)

    const settle = (nextState: SimilarMixStatus, error?: unknown): boolean => {
      if (settled || epoch !== transactionEpoch) {
        settled = true
        return false
      }

      settled = true
      transactionEpoch += 1
      publish(nextState, error)
      return true
    }

    return Object.freeze({
      state,
      commit: (nextState: "on" | "off" = state === "stopping" ? "off" : "on") => settle(nextState),
      fail: (error: unknown) => settle("error", error),
      degrade: (error: unknown) => settle("degraded", error),
    })
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (
      listener: SimilarMixStatusListener,
      subscriptionOptions: { readonly emitCurrent?: boolean } = {}
    ) => {
      listeners.add(listener)
      if (subscriptionOptions.emitCurrent !== false) {
        try {
          listener(snapshot)
        } catch {
          // Subscription remains useful if a future render succeeds.
        }
      }

      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
    transitionTo,
    beginTransition,
  })
}

const CAPSULE_ID = "similar-mix-status"
const STYLE_ID = "similar-mix-status-styles"

const CAPSULE_STYLES = `
  #${CAPSULE_ID} {
    --similar-mix-accent: var(--spice-subtext, #b3b3b3);
    box-sizing: border-box;
    display: inline-grid;
    grid-template-columns: 8px minmax(0, 1fr);
    align-items: center;
    column-gap: 10px;
    max-width: min(360px, 100%);
    min-height: 40px;
    padding: 7px 12px;
    border: 1px solid rgba(var(--spice-rgb-text, 255, 255, 255), 0.12);
    border-radius: 999px;
    color: var(--spice-text, #ffffff);
    background: var(--spice-card, rgba(255, 255, 255, 0.08));
    font-family: var(--encore-body-font-stack, inherit);
    line-height: 1.25;
    pointer-events: none;
    contain: layout paint style;
    transition: opacity 180ms ease, transform 180ms ease, border-color 180ms ease;
  }

  #${CAPSULE_ID}[data-tone="positive"] { --similar-mix-accent: var(--spice-button, #1ed760); }
  #${CAPSULE_ID}[data-tone="informative"] { --similar-mix-accent: var(--spice-button-active, #1fdf64); }
  #${CAPSULE_ID}[data-tone="warning"] { --similar-mix-accent: #f5c451; }
  #${CAPSULE_ID}[data-tone="negative"] { --similar-mix-accent: #f15e6c; }
  #${CAPSULE_ID}[data-state="off"] { opacity: 0.72; }

  #${CAPSULE_ID} .similar-mix-status__indicator {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--similar-mix-accent);
  }

  #${CAPSULE_ID}[aria-busy="true"] .similar-mix-status__indicator::after {
    content: "";
    position: absolute;
    inset: -4px;
    border: 1px solid var(--similar-mix-accent);
    border-radius: inherit;
    animation: similar-mix-status-breathe 1.4s ease-out infinite;
  }

  #${CAPSULE_ID} .similar-mix-status__content { min-width: 0; }
  #${CAPSULE_ID} .similar-mix-status__label,
  #${CAPSULE_ID} .similar-mix-status__detail {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #${CAPSULE_ID} .similar-mix-status__label {
    color: var(--spice-text, #ffffff);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }
  #${CAPSULE_ID} .similar-mix-status__detail {
    margin-top: 1px;
    color: var(--spice-subtext, #b3b3b3);
    font-size: 11px;
    font-weight: 400;
  }

  @keyframes similar-mix-status-breathe {
    from { opacity: 0.72; transform: scale(0.65); }
    to { opacity: 0; transform: scale(1.35); }
  }

  @media (prefers-reduced-motion: reduce) {
    #${CAPSULE_ID} { transition: none; }
    #${CAPSULE_ID}[aria-busy="true"] .similar-mix-status__indicator::after { animation: none; }
  }
`

export interface SimilarMixStatusMountOptions {
  readonly document?: Document | null
  readonly target?: HTMLElement | null
}

export interface SimilarMixStatusMount {
  readonly element: HTMLElement
  update(snapshot?: SimilarMixStatusSnapshot): boolean
  unmount(): void
}

interface InternalStatusMount extends SimilarMixStatusMount {
  readonly controller: SimilarMixStatusController
  readonly target: HTMLElement
}

const mounts = new WeakMap<Document, InternalStatusMount>()

const resolveDocument = (provided: Document | null | undefined): Document | null => {
  if (provided !== undefined) return provided
  return typeof document === "undefined" ? null : document
}

const injectCapsuleStyles = (doc: Document) => {
  if (doc.getElementById(STYLE_ID)) return

  const style = doc.createElement("style")
  style.id = STYLE_ID
  style.textContent = CAPSULE_STYLES
  ;(doc.head ?? doc.documentElement).appendChild(style)
}

export const mountSimilarMixStatus = (
  controller: SimilarMixStatusController,
  options: SimilarMixStatusMountOptions = {}
): SimilarMixStatusMount | null => {
  const doc = resolveDocument(options.document)
  if (!doc) return null

  const target = options.target ?? doc.body
  if (!target) return null

  const current = mounts.get(doc)
  if (current?.controller === controller && current.target === target) {
    if (!target.contains(current.element)) target.appendChild(current.element)
    current.update()
    return current
  }
  current?.unmount()

  injectCapsuleStyles(doc)

  const element = doc.createElement("div")
  element.id = CAPSULE_ID
  element.className = "similar-mix-status"
  element.setAttribute("role", "status")
  element.setAttribute("aria-live", "polite")
  element.setAttribute("aria-atomic", "true")

  const indicator = doc.createElement("span")
  indicator.className = "similar-mix-status__indicator"
  indicator.setAttribute("aria-hidden", "true")

  const content = doc.createElement("span")
  content.className = "similar-mix-status__content"
  const label = doc.createElement("strong")
  label.className = "similar-mix-status__label"
  const detail = doc.createElement("span")
  detail.className = "similar-mix-status__detail"
  content.append(label, detail)
  element.append(indicator, content)
  target.appendChild(element)

  let disposed = false
  let unsubscribe: () => void = () => undefined

  const update = (nextSnapshot = controller.getSnapshot()): boolean => {
    if (disposed) return false

    const { state, copy, error } = nextSnapshot
    element.dataset.state = state
    element.dataset.tone = copy.tone
    element.setAttribute("aria-busy", copy.busy ? "true" : "false")
    label.textContent = state === "error" && error ? error.title : copy.label
    detail.textContent = error ? error.message : copy.detail
    return true
  }

  const mount: InternalStatusMount = {
    controller,
    target,
    element,
    update,
    unmount: () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      element.remove()
      if (mounts.get(doc) === mount) mounts.delete(doc)
    },
  }

  mounts.set(doc, mount)
  unsubscribe = controller.subscribe(update)
  return mount
}

export const updateSimilarMixStatus = (
  mount: SimilarMixStatusMount | null | undefined,
  snapshot?: SimilarMixStatusSnapshot
): boolean => mount?.update(snapshot) ?? false

export const unmountSimilarMixStatus = (mount: SimilarMixStatusMount | null | undefined): void => {
  mount?.unmount()
}
