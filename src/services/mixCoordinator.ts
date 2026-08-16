export class StaleMixBuildError extends Error {
  readonly code = "STALE_MIX_BUILD"

  constructor() {
    super("A newer Similar Mix request replaced this one")
    this.name = "StaleMixBuildError"
  }
}

/**
 * Gives every live build a monotonic token and serializes the small commit
 * section that mutates Spotify's queue. Fetching and ranking stay concurrent.
 * Only the newest token may enter a commit, but a commit that has already
 * begun is allowed to finish atomically; a newer build can replace it only
 * after its own preparation succeeds.
 */
export class LatestMixCoordinator {
  private generation = 0
  private commitTail: Promise<void> = Promise.resolve()

  begin(): number {
    this.generation += 1
    return this.generation
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }

  assertCurrent(token: number): void {
    if (!this.isCurrent(token)) throw new StaleMixBuildError()
  }

  async commit<T>(token: number, work: () => Promise<T>): Promise<T> {
    const previous = this.commitTail
    let release: () => void = () => undefined
    this.commitTail = new Promise<void>((resolve) => { release = resolve })

    await previous.catch(() => undefined)
    try {
      this.assertCurrent(token)
      return await work()
    } finally {
      release()
    }
  }
}
