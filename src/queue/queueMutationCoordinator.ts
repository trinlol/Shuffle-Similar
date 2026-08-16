/** One mutation lane prevents refill, feedback, recovery, and fresh takeover
 * from invalidating each other's queue verification snapshots. */
export class QueueMutationCoordinator {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
