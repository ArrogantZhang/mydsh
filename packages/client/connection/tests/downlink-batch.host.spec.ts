/** Host downlink batching across count, byte, time, end, error, and abort limits. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  encodeDownlink,
  type DownlinkBatchOptions,
  type EncodedDownlinkMessage,
} from '../src/downlink-batch.ts'

const BATCH_PREFIX = '{"type":"server-batch","requests":['
const BATCH_SUFFIX = ']}'
const batchOptions: DownlinkBatchOptions = {
  enabled: true,
  maxFrames: 64,
  maxBytes: 262_144,
  flushMs: 16,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function frame(index: number, sessionId = `session-${String(index)}`): RpcRequest<MuxFrame> {
  return {
    rpcId: RpcId(`rpc-${String(index)}`),
    payload: { type: 'session/subscribed', sessionId: sessionId as never, lastSeq: index },
  }
}

function serverRequest(value: RpcRequest<MuxFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: value.rpcId,
    method: value.payload.type,
    payload: value.payload,
  }
}

function serverText(value: RpcRequest<MuxFrame>): string {
  return JSON.stringify(serverRequest(value))
}

function requests(message: EncodedDownlinkMessage): ServerRequest[] {
  const parsed = JSON.parse(message.text) as ServerRequest | {
    type: 'server-batch'
    requests: ServerRequest[]
  }
  return parsed.type === 'server-batch' ? parsed.requests : [parsed]
}

async function * source(count: number): AsyncGenerator<RpcRequest<MuxFrame>> {
  for (let index = 0; index < count; index++) yield frame(index)
}

async function collect(
  count: number,
  options: DownlinkBatchOptions = batchOptions,
): Promise<EncodedDownlinkMessage[]> {
  const abort = new AbortController()
  return collectIterable(encodeDownlink(source(count), options, abort.signal))
}

async function collectIterable<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const value of values) collected.push(value)
  return collected
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

type Pending = {
  resolve: (result: IteratorResult<RpcRequest<MuxFrame>>) => void
  reject: (error: Error) => void
}

class ControlledSource implements AsyncIterable<RpcRequest<MuxFrame>>, AsyncIterator<RpcRequest<MuxFrame>> {
  [Symbol.asyncIterator](): AsyncIterator<RpcRequest<MuxFrame>> {
    return this
  }

  nextCalls = 0
  returnCalls = 0
  maxConcurrentNext = 0
  private concurrentNext = 0
  private readonly pending: Pending[] = []

  next(): Promise<IteratorResult<RpcRequest<MuxFrame>>> {
    this.nextCalls++
    this.concurrentNext++
    this.maxConcurrentNext = Math.max(this.maxConcurrentNext, this.concurrentNext)
    return new Promise((resolve, reject) => {
      this.pending.push({
        resolve: (result) => {
          this.concurrentNext--
          resolve(result)
        },
        reject: (error) => {
          this.concurrentNext--
          reject(error)
        },
      })
    })
  }

  return(): Promise<IteratorResult<RpcRequest<MuxFrame>>> {
    this.returnCalls++
    this.finish()
    return Promise.resolve({ value: undefined, done: true })
  }

  push(value: RpcRequest<MuxFrame>): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('no pending source read')
    pending.resolve({ value, done: false })
  }

  finish(): void {
    for (const pending of this.pending.splice(0)) pending.resolve({ value: undefined, done: true })
  }

  fail(error: Error): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error('no pending source read')
    pending.reject(error)
  }
}

describe('Host downlink batch encoder', () => {
  it('emits each frame as one physical message when batching is disabled', async () => {
    const messages = await collect(65, { ...batchOptions, enabled: false })

    expect(messages).toHaveLength(65)
    expect(messages.every(message => message.kind === 'single' && message.requestCount === 1)).toBe(true)
    expect(messages.flatMap(requests).map(request => request.rpcId))
      .toEqual(Array.from({ length: 65 }, (_, index) => `rpc-${String(index)}`))
  })

  it('flushes 64 requests as one batch and keeps the 65th as a single message', async () => {
    const messages = await collect(65)

    expect(messages.map(message => [message.kind, message.requestCount])).toEqual([
      ['batch', 64],
      ['single', 1],
    ])
    expect(messages.flatMap(requests).map(request => request.rpcId))
      .toEqual(Array.from({ length: 65 }, (_, index) => `rpc-${String(index)}`))
  })

  it('admits an exact complete batch byte fit and carries the next request forward', async () => {
    const values = [
      frame(0, '会'.repeat(4)),
      frame(1, '会'.repeat(5)),
      frame(2, '会'.repeat(6)),
    ] as const
    const exactBytes = Buffer.byteLength(
      `${BATCH_PREFIX}${serverText(values[0])},${serverText(values[1])}${BATCH_SUFFIX}`,
      'utf8',
    )
    async function * valuesSource(): AsyncGenerator<RpcRequest<MuxFrame>> {
      yield * values
    }

    const messages = await collectIterable(encodeDownlink(valuesSource(), {
      ...batchOptions,
      maxBytes: exactBytes,
    }, new AbortController().signal))

    expect(messages.map(message => [message.kind, message.requestCount, message.utf8Bytes])).toEqual([
      ['batch', 2, exactBytes],
      ['single', 1, Buffer.byteLength(serverText(values[2]), 'utf8')],
    ])
    expect(messages[0]?.text).toBe(
      `${BATCH_PREFIX}${serverText(values[0])},${serverText(values[1])}${BATCH_SUFFIX}`,
    )
    const firstMessage = messages[0]
    if (firstMessage === undefined) throw new Error('expected an exact-fit batch')
    expect(JSON.parse(firstMessage.text)).toEqual({
      type: 'server-batch',
      requests: [serverRequest(values[0]), serverRequest(values[1])],
    })
    expect(messages.flatMap(requests).map(request => request.rpcId)).toEqual(['rpc-0', 'rpc-1', 'rpc-2'])
  })

  it('emits a request larger than the wrapped batch limit as its original single text', async () => {
    const value = frame(0, '会'.repeat(16))
    const text = serverText(value)
    const wrappedBytes = Buffer.byteLength(`${BATCH_PREFIX}${text}${BATCH_SUFFIX}`, 'utf8')
    async function * oversizedSource(): AsyncGenerator<RpcRequest<MuxFrame>> {
      yield value
    }

    const [message] = await collectIterable(encodeDownlink(oversizedSource(), {
      ...batchOptions,
      maxBytes: wrappedBytes - 1,
    }, new AbortController().signal))

    expect(message).toEqual({
      text,
      utf8Bytes: Buffer.byteLength(text, 'utf8'),
      requestCount: 1,
      kind: 'single',
    })
  })

  it('flushes a partial batch at the first-item deadline', async () => {
    vi.useFakeTimers()
    const controlled = new ControlledSource()
    const abort = new AbortController()
    const output = encodeDownlink(controlled, batchOptions, abort.signal)[Symbol.asyncIterator]()
    const first = output.next()
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(1)
    controlled.push(frame(0))
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(2)
    let settled = false
    void first.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(15)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(first).resolves.toMatchObject({ value: { kind: 'single', requestCount: 1 } })

    const end = output.next()
    controlled.finish()
    await expect(end).resolves.toMatchObject({ done: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes the remaining requests on clean source end', async () => {
    const messages = await collect(2)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'batch', requestCount: 2 })
    expect(requests(messages[0]!).map(request => request.rpcId)).toEqual(['rpc-0', 'rpc-1'])
  })

  it('aborts a pending read, clears its timer, and reaches iterator cleanup', async () => {
    vi.useFakeTimers()
    const controlled = new ControlledSource()
    const abort = new AbortController()
    const output = encodeDownlink(controlled, batchOptions, abort.signal)[Symbol.asyncIterator]()
    const pending = output.next()
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(1)
    controlled.push(frame(0))
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(2)

    abort.abort()

    await expect(pending).resolves.toMatchObject({ done: true })
    expect(controlled.returnCalls).toBe(1)
    expect(controlled.maxConcurrentNext).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('abandons an unsent partial batch when the source rejects', async () => {
    vi.useFakeTimers()
    const controlled = new ControlledSource()
    const output = encodeDownlink(
      controlled,
      batchOptions,
      new AbortController().signal,
    )[Symbol.asyncIterator]()
    const pending = output.next()
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(1)
    controlled.push(frame(0))
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(2)

    controlled.fail(new Error('source failed'))

    await expect(pending).rejects.toThrow('source failed')
    expect(controlled.returnCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reuses the pending read after a timer flush without concurrent next calls', async () => {
    vi.useFakeTimers()
    const controlled = new ControlledSource()
    const output = encodeDownlink(
      controlled,
      batchOptions,
      new AbortController().signal,
    )[Symbol.asyncIterator]()
    const first = output.next()
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(1)
    controlled.push(frame(0))
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(16)
    await expect(first).resolves.toMatchObject({ value: { requestCount: 1 } })

    const second = output.next()
    await Promise.resolve()
    expect(controlled.nextCalls).toBe(2)
    controlled.push(frame(1))
    await drainMicrotasks()
    expect(controlled.nextCalls).toBe(3)
    controlled.finish()

    await expect(second).resolves.toMatchObject({ value: { requestCount: 1 } })
    await expect(output.next()).resolves.toMatchObject({ done: true })
    expect(controlled.maxConcurrentNext).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes each logical request exactly once when building a batch', async () => {
    const stringify = vi.spyOn(JSON, 'stringify')

    const messages = await collect(2)

    expect(messages).toHaveLength(1)
    expect(stringify.mock.calls.filter(([value]) => {
      if (typeof value !== 'object' || value === null) return false
      return (value as { type?: unknown }).type === 'server-request'
    })).toHaveLength(2)
  })
})
