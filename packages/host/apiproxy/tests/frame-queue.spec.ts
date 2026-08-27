import { describe, expect, it } from 'vitest'
import { FrameQueue, FrameQueueOverflowError } from '../src/frame-queue.ts'

async function collect<F>(frames: AsyncIterable<F>): Promise<F[]> {
  const collected: F[] = []
  for await (const frame of frames) collected.push(frame)
  return collected
}

describe('FrameQueue', () => {
  it('fails atomically and releases retained frames when the next push exceeds capacity', async () => {
    const queue = new FrameQueue<{ id: number }>(2)
    const first = { id: 1 }
    const second = { id: 2 }
    let cleanups = 0

    expect(queue.push(first)).toBe(true)
    expect(queue.push(second)).toBe(true)
    expect(queue.size).toBe(2)
    expect(queue.push({ id: 3 })).toBe(false)
    expect(queue.size).toBe(0)
    expect(queue.push({ id: 4 })).toBe(false)

    await expect(collect(queue.iterate(new AbortController().signal, () => { cleanups++ })))
      .rejects.toEqual(new FrameQueueOverflowError(2))
    expect(cleanups).toBe(1)
  })

  it('drains exactly-capacity frames in accepted order before a normal end', async () => {
    const queue = new FrameQueue<number>(3)
    let cleanups = 0

    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    expect(queue.push(3)).toBe(true)
    queue.end()

    await expect(collect(queue.iterate(new AbortController().signal, () => { cleanups++ })))
      .resolves.toEqual([1, 2, 3])
    expect(queue.size).toBe(0)
    expect(cleanups).toBe(1)
  })

  it('reuses released slots across interleaved push and consume without front-removing array storage', async () => {
    const queue = new FrameQueue<number>(3)
    let cleanups = 0
    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    const sizes = [queue.size]
    const iterator = queue.iterate(new AbortController().signal, () => { cleanups++ })
    // Timing assertions are unstable across hosts. Rejecting Array.shift()
    // mechanically pins the O(1) storage choice while the interleaving below
    // exercises slot reuse across the fixed buffer's wrap point.
    const shift = Array.prototype.shift
    Array.prototype.shift = function forbiddenShift(): never {
      throw new Error('FrameQueue must not use Array.shift()')
    }
    let first: IteratorResult<number> | undefined
    let second: IteratorResult<number> | undefined
    let third: IteratorResult<number> | undefined
    let fourth: IteratorResult<number> | undefined
    let finished: IteratorResult<number> | undefined
    try {
      first = await iterator.next()
      sizes.push(queue.size)
      queue.push(3)
      queue.push(4)
      sizes.push(queue.size)
      second = await iterator.next()
      sizes.push(queue.size)
      third = await iterator.next()
      sizes.push(queue.size)
      fourth = await iterator.next()
      sizes.push(queue.size)
      queue.end()
      finished = await iterator.next()
    } finally {
      Array.prototype.shift = shift
    }

    expect([first?.value, second?.value, third?.value, fourth?.value]).toEqual([1, 2, 3, 4])
    expect(sizes).toEqual([2, 1, 3, 2, 1, 0])
    expect(finished).toEqual({ value: undefined, done: true })
    expect(queue.size).toBe(0)
    expect(cleanups).toBe(1)
  })

  it('aborts without delivering retained frames', async () => {
    const queue = new FrameQueue<object>(2)
    const abort = new AbortController()
    let cleanups = 0
    expect(queue.push({ retained: true })).toBe(true)
    abort.abort()

    await expect(collect(queue.iterate(abort.signal, () => { cleanups++ })))
      .resolves.toEqual([])
    expect(queue.size).toBe(0)
    expect(queue.push({ late: true })).toBe(false)
    expect(cleanups).toBe(1)
  })

  it('wakes a waiting consumer for a pushed frame and for end', async () => {
    const queue = new FrameQueue<number>(1)
    let cleanups = 0
    const iterator = queue.iterate(new AbortController().signal, () => { cleanups++ })
    const first = iterator.next()

    expect(queue.push(7)).toBe(true)
    await expect(first).resolves.toEqual({ value: 7, done: false })

    const finished = iterator.next()
    queue.end()
    await expect(finished).resolves.toEqual({ value: undefined, done: true })
    expect(cleanups).toBe(1)
  })

  it('cleans up exactly once when the consumer returns early', async () => {
    const queue = new FrameQueue<number>(2)
    let cleanups = 0
    const iterator = queue.iterate(new AbortController().signal, () => { cleanups++ })
    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)

    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false })
    await iterator.return(undefined)
    await iterator.return(undefined)

    expect(queue.size).toBe(0)
    expect(queue.push(3)).toBe(false)
    expect(cleanups).toBe(1)
  })

  it('rejects pushes after end and preserves an overflow failure after end', async () => {
    const ended = new FrameQueue<number>(1)
    ended.end()
    expect(ended.push(1)).toBe(false)

    const failed = new FrameQueue<number>(1)
    expect(failed.push(1)).toBe(true)
    expect(failed.push(2)).toBe(false)
    failed.end()
    await expect(collect(failed.iterate(new AbortController().signal, () => {})))
      .rejects.toBeInstanceOf(FrameQueueOverflowError)
  })
})
