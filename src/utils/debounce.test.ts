import { afterEach, describe, expect, it, vi } from "vitest"
import { debounce } from "./debounce"

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("cancels pending timer execution cleanly when cancel() is called", () => {
    vi.useFakeTimers()
    const spy = vi.fn()
    const debounced = debounce(spy, 50)

    debounced()
    debounced.cancel()
    vi.advanceTimersByTime(100)
    expect(spy).not.toHaveBeenCalled()

    debounced()
    vi.advanceTimersByTime(50)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
