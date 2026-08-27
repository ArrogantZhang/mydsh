/** Failure reported to an event-stream consumer after its retained frame limit is exceeded. */
export class FrameQueueOverflowError extends Error {
  /**
   * @param capacity - the configured maximum retained frame count.
   */
  constructor(readonly capacity: number) {
    super(`event stream frame queue exceeded its ${capacity}-frame capacity`)
    this.name = 'FrameQueueOverflowError'
  }
}

/** A bounded, single-consumer async frame queue. */
export class FrameQueue<F> {
  private readonly buffer: F[] = []
  private waiter: (() => void) | undefined
  private ended = false
  private overflow: FrameQueueOverflowError | undefined

  /**
   * @param capacity - the validated positive maximum retained frame count.
   */
  constructor(private readonly capacity: number) {}

  /** Current retained frame count. */
  get size(): number {
    return this.buffer.length
  }

  /**
   * Retain one frame, or fail the stream without throwing through its producer.
   * @param item - the frame to retain.
   * @returns whether the frame was accepted.
   */
  push(item: F): boolean {
    if (this.ended) return false
    if (this.buffer.length >= this.capacity) {
      this.overflow = new FrameQueueOverflowError(this.capacity)
      this.ended = true
      this.buffer.length = 0
      this.wake()
      return false
    }
    this.buffer.push(item)
    this.wake()
    return true
  }

  /** Finish the stream after its accepted frames drain. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.wake()
  }

  /**
   * Consume accepted frames until end or abort, and report any stored overflow.
   * @param signal - aborts consumption and releases retained frames.
   * @param cleanup - releases the stream's producer subscriptions exactly once.
   * @returns the accepted frames in order.
   */
  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => {
      this.ended = true
      this.buffer.length = 0
      this.wake()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      while (true) {
        const overflow = this.currentOverflow()
        if (overflow !== undefined) throw overflow
        if (this.isAborted(signal)) return
        while (this.buffer.length > 0) {
          yield this.buffer.shift() as F
          const resumedOverflow = this.currentOverflow()
          if (resumedOverflow !== undefined) throw resumedOverflow
          if (this.isAborted(signal)) return
        }
        if (this.ended) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
      }
    } finally {
      this.ended = true
      this.buffer.length = 0
      this.wake()
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  private currentOverflow(): FrameQueueOverflowError | undefined {
    return this.overflow
  }

  private isAborted(signal: AbortSignal): boolean {
    return signal.aborted
  }
}
