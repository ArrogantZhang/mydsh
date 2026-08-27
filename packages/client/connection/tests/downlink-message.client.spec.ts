/** Browser downlink decoding and WebSocket protocol-failure behavior. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { RpcMessage } from '../src/client/api.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'
import {
  decodeDownlinkMessage,
  MAX_SERVER_BATCH_REQUESTS,
  serverBatchSchema,
} from '../src/downlink-message.ts'

type WebSocketGlobal = { WebSocket?: typeof WebSocket }
type Win = { location?: { hostname: string; search: string; origin: string } }

const originalWebSocket = globalThis.WebSocket
const sockets: FakeWebSocket[] = []

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = []
  delayClose = false
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string | URL) {
    super()
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) return
    this.closeCalls.push({ code, reason })
    if (this.delayClose) {
      this.readyState = FakeWebSocket.CLOSING
      return
    }
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  finishClose(): void {
    if (this.readyState !== FakeWebSocket.CLOSING) throw new Error('socket is not closing')
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function request(rpcId: string, payload: unknown): Record<string, unknown> {
  return { type: 'server-request', rpcId, method: 'events/push', payload }
}

function subscribed(rpcId: string, lastSeq = 1): Record<string, unknown> {
  return request(rpcId, {
    type: 'session/subscribed',
    sessionId: 'session-downlink',
    lastSeq,
  })
}

function decodeMux(message: unknown) {
  return decodeDownlinkMessage(JSON.stringify(message), muxFrameSchema)
}

beforeEach(() => {
  ;(globalThis as Win).location = {
    hostname: 'localhost',
    search: '',
    origin: 'http://localhost:3080',
  }
  ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  delete (globalThis as Win).location
  sockets.length = 0
  vi.restoreAllMocks()
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
})

describe('downlink message decoder', () => {
  it('accepts one mux ServerRequest', () => {
    expect(decodeMux(subscribed('single-rpc', 7))).toMatchObject({
      ok: true,
      requests: [{
        full: { type: 'server-request', rpcId: 'single-rpc', method: 'events/push' },
        envelope: {
          rpcId: 'single-rpc',
          payload: { type: 'session/subscribed', sessionId: 'session-downlink', lastSeq: 7 },
        },
      }],
    })
  })

  it('accepts a two-member server batch', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: [subscribed('first-rpc'), subscribed('second-rpc', 2)],
    })

    expect(decoded.ok).toBe(true)
    expect(decoded.requests).toHaveLength(2)
  })

  it('preserves batch order and rpcIds', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: [subscribed('rpc-2', 2), subscribed('rpc-1', 1)],
    })

    expect(decoded.requests).toMatchObject([
      { full: { rpcId: 'rpc-2' }, envelope: { rpcId: 'rpc-2', payload: { lastSeq: 2 } } },
      { full: { rpcId: 'rpc-1' }, envelope: { rpcId: 'rpc-1', payload: { lastSeq: 1 } } },
    ])
  })

  it('accepts exactly the maximum batch size', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: Array.from(
        { length: MAX_SERVER_BATCH_REQUESTS },
        (_, index) => subscribed(`rpc-${index}`, index),
      ),
    })

    expect(decoded.ok).toBe(true)
    expect(decoded.requests).toHaveLength(MAX_SERVER_BATCH_REQUESTS)
  })

  it('rejects a batch above the maximum size', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: Array.from(
        { length: MAX_SERVER_BATCH_REQUESTS + 1 },
        (_, index) => subscribed(`rpc-${index}`, index),
      ),
    })

    expect(decoded).toEqual({ ok: false, category: 'wrapper', requests: [] })
  })

  it('classifies an oversized batch before parsing its malformed member', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: Array.from(
        { length: MAX_SERVER_BATCH_REQUESTS + 1 },
        (_, index) => index === 0 ? { type: 'server-request' } : subscribed(`rpc-${index}`, index),
      ),
    })

    expect(decoded).toEqual({ ok: false, category: 'wrapper', requests: [] })
  })

  it('rejects an empty batch', () => {
    expect(decodeMux({ type: 'server-batch', requests: [] }))
      .toEqual({ ok: false, category: 'wrapper', requests: [] })
  })

  it.each([
    ['invalid JSON', '{', 'json'],
    ['an unknown wrapper', JSON.stringify({ type: 'client-request' }), 'wrapper'],
    ['an invalid single envelope', JSON.stringify({ type: 'server-request' }), 'envelope'],
  ] as const)('categorizes %s without decoded requests', (_name, text, category) => {
    expect(decodeDownlinkMessage(text, muxFrameSchema))
      .toEqual({ ok: false, category, requests: [] })
  })

  it('rejects an invalid inner envelope', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: [subscribed('valid-rpc'), { type: 'server-request', payload: {} }],
    })

    expect(decoded).toEqual({ ok: false, category: 'envelope', requests: [] })
  })

  it('validates every server-batch member through the server request schema', () => {
    expect(() => serverBatchSchema.parse({
      type: 'server-batch',
      requests: [subscribed('valid-rpc'), { type: 'server-request' }],
    })).toThrow()
  })

  it('exposes a real Zod schema with bounded safe parsing', () => {
    expect(serverBatchSchema.safeParse({
      type: 'server-batch',
      requests: [subscribed('valid-rpc')],
    })).toMatchObject({ success: true })
    expect(serverBatchSchema.safeParse({ type: 'server-batch', requests: [] }))
      .toMatchObject({ success: false })
  })

  it('publishes no prefix when the second stream payload is invalid', () => {
    const decoded = decodeMux({
      type: 'server-batch',
      requests: [subscribed('valid-rpc'), request('invalid-rpc', { marker: 'invalid' })],
    })

    expect(decoded).toEqual({ ok: false, category: 'payload', requests: [] })
  })

  it('parses host payloads with the supplied stream schema', () => {
    const decoded = decodeDownlinkMessage(JSON.stringify(request('host-rpc', {
      type: 'host/session-status',
      sessionId: 'session-downlink',
      running: true,
    })), hostFrameSchema)

    expect(decoded).toMatchObject({
      ok: true,
      requests: [{
        full: { rpcId: 'host-rpc' },
        envelope: {
          rpcId: 'host-rpc',
          payload: { type: 'host/session-status', sessionId: 'session-downlink', running: true },
        },
      }],
    })
  })
})

describe('WebApiClient downlink messages', () => {
  it('delivers every member of a batch to envelope observers and the stream in order', async () => {
    const client = new WebApiClient()
    const envelopes: RpcMessage[][] = []
    client.subscribeEnvelopes((batch) => { envelopes.push([...batch]) })
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })

    sockets[0]!.receive(JSON.stringify({
      type: 'server-batch',
      requests: [subscribed('first-rpc', 1), subscribed('second-rpc', 2)],
    }))

    await expect(first).resolves.toMatchObject({
      value: { rpcId: 'first-rpc', payload: { lastSeq: 1 } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { rpcId: 'second-rpc', payload: { lastSeq: 2 } },
    })
    await vi.waitFor(() => {
      expect(envelopes.map(batch => batch.map(message => message.rpcId)))
        .toEqual([['first-rpc', 'second-rpc']])
    })
    expect(envelopes[0]?.map(message => message.type === 'server-request' ? message.method : message.type))
      .toEqual(['events/push', 'events/push'])

    const end = iterator.next()
    abort.abort()
    await expect(end).resolves.toMatchObject({ done: true })
  })

  it('closes on an invalid second payload without delivering its valid prefix or logging payload data', async () => {
    const client = new WebApiClient()
    const envelopes: RpcMessage[] = []
    client.subscribeEnvelopes((batch) => { envelopes.push(...batch) })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })

    sockets[0]!.receive(JSON.stringify({
      type: 'server-batch',
      requests: [
        subscribed('valid-rpc'),
        request('invalid-rpc', { marker: 'INJECTED-PAYLOAD-MARKER' }),
      ],
    }))

    await expect(pending).resolves.toMatchObject({ done: true })
    await vi.waitFor(() => { expect(sockets[0]!.closeCalls).toHaveLength(1) })
    expect(sockets[0]!.closeCalls).toEqual([
      { code: 1002, reason: 'invalid downlink message' },
    ])
    expect(envelopes).toEqual([])
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[client-connection] invalid WebSocket message on /api/events.mux (payload)',
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain('INJECTED-PAYLOAD-MARKER')
  })

  it('closes an oversized batch as a wrapper failure without publishing members', async () => {
    const client = new WebApiClient()
    const envelopes: RpcMessage[] = []
    client.subscribeEnvelopes((batch) => { envelopes.push(...batch) })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })

    sockets[0]!.receive(JSON.stringify({
      type: 'server-batch',
      requests: Array.from(
        { length: MAX_SERVER_BATCH_REQUESTS + 1 },
        (_, index) => index === 0 ? { type: 'server-request' } : subscribed(`rpc-${index}`, index),
      ),
    }))

    await expect(pending).resolves.toMatchObject({ done: true })
    expect(envelopes).toEqual([])
    expect(sockets[0]!.closeCalls).toEqual([
      { code: 1002, reason: 'invalid downlink message' },
    ])
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[client-connection] invalid WebSocket message on /api/events.mux (wrapper)',
    )
  })

  it('closes a binary downlink message as a protocol error', async () => {
    const client = new WebApiClient()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const abort = new AbortController()
    const iterator = client.events.host({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })

    sockets[0]!.receive(new Uint8Array([1, 2, 3]))

    await expect(pending).resolves.toMatchObject({ done: true })
    expect(sockets[0]!.closeCalls).toEqual([
      { code: 1002, reason: 'invalid downlink message' },
    ])
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[client-connection] invalid WebSocket message on /api/events.host (binary)',
    )
  })

  it('latches the first protocol failure throughout the closing window', async () => {
    const client = new WebApiClient()
    const envelopes: RpcMessage[] = []
    client.subscribeEnvelopes((batch) => { envelopes.push(...batch) })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    const socket = sockets[0]!
    socket.delayClose = true

    socket.receive(JSON.stringify({
      type: 'server-batch',
      requests: [
        subscribed('rejected-prefix'),
        request('invalid-rpc', { marker: 'INJECTED-PAYLOAD-MARKER' }),
      ],
    }))
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSING) })
    socket.receive(JSON.stringify(subscribed('late-valid')))
    socket.receive('{')
    await Promise.resolve()

    expect(socket.closeCalls).toEqual([{ code: 1002, reason: 'invalid downlink message' }])
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[client-connection] invalid WebSocket message on /api/events.mux (payload)',
    )
    expect(envelopes).toEqual([])
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    socket.finishClose()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('keeps an accepted envelope ahead of the protocol-failure end marker', async () => {
    const client = new WebApiClient()
    const envelopes: RpcMessage[] = []
    client.subscribeEnvelopes((batch) => { envelopes.push(...batch) })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const accepted = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    const socket = sockets[0]!
    socket.delayClose = true

    socket.receive(JSON.stringify(subscribed('accepted-rpc')))
    socket.receive('{')
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSING) })
    socket.finishClose()

    await expect(accepted).resolves.toMatchObject({ value: { rpcId: 'accepted-rpc' } })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await vi.waitFor(() => { expect(envelopes.map(message => message.rpcId)).toEqual(['accepted-rpc']) })
    expect(error).toHaveBeenCalledTimes(1)
  })
})
