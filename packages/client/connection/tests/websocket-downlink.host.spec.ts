import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../src/api-path.ts'
import {
  DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS,
  WebSocketDownlinks,
  type WebSocketDownlinkOptions,
} from '../src/websocket-downlink.ts'

type MuxSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
type HostSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<HostFrame>>

const running: (() => Promise<void>)[] = []
const TEST_COMPRESSION_CONCURRENCY = 4
const BATCH_PREFIX = '{"type":"server-batch","requests":['
const BATCH_SUFFIX = ']}'

afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()))
})

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle<F>(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
  await untilAbort(signal)
}

function api(mux: MuxSource, host: HostSource): ApiProxy {
  return {
    events: {
      mux: (_request, signal) => mux(signal),
      host: (_request, signal) => host(signal),
    },
  } as ApiProxy
}

function configuredDownlinks(
  proxy: ApiProxy,
  overrides: Partial<WebSocketDownlinkOptions> = {},
): WebSocketDownlinks {
  return new WebSocketDownlinks(proxy, { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS, ...overrides })
}

function serverOptions(downlinks: WebSocketDownlinks): {
  maxPayload?: number
  perMessageDeflate?: boolean | {
    threshold?: number
    concurrencyLimit?: number
    serverNoContextTakeover?: boolean
    clientNoContextTakeover?: boolean
  }
} {
  return (downlinks as unknown as {
    server: { options: ReturnType<typeof serverOptions> }
  }).server.options
}

function peer(url: string, compression = false): WebSocket {
  return new WebSocket(url, {
    perMessageDeflate: compression
      ? {
        concurrencyLimit: TEST_COMPRESSION_CONCURRENCY,
        threshold: 0,
      }
      : false,
  })
}

function muxFrame(rpcId: string, sessionId: string): RpcRequest<MuxFrame> {
  return {
    rpcId: RpcId(rpcId),
    payload: { type: 'session/subscribed', sessionId: sessionId as never, lastSeq: 0 },
  }
}

function serializedFrameBytes(frame: RpcRequest<MuxFrame>): number {
  return Buffer.byteLength(serializedFrameText(frame), 'utf8')
}

function serializedFrameText(frame: RpcRequest<MuxFrame>): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  })
}

async function serve(downlinks: WebSocketDownlinks): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    if (pathname === MUX_EVENTS_PATH) downlinks.handleMux(request, socket, head)
    else if (pathname === HOST_EVENTS_PATH) downlinks.handleHost(request, socket, head)
    else socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

function read(socket: WebSocket): Promise<ServerRequest> {
  return once(socket, 'message').then(([data]) => JSON.parse(String(data)) as ServerRequest)
}

function rawDataText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString()
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString()
  return data.toString()
}

function isServerRequestWithRpcId(value: unknown, rpcId: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.type === 'server-request' && candidate.rpcId === rpcId
}

function readTextUpTo(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = []
    const finish = (): void => {
      socket.off('message', onMessage)
      socket.off('close', finish)
      resolve(messages)
    }
    const onMessage = (data: WebSocket.RawData): void => {
      messages.push(rawDataText(data))
      if (messages.length === count) finish()
    }
    socket.on('message', onMessage)
    socket.once('close', finish)
  })
}

async function readUpTo<T = ServerRequest>(socket: WebSocket, count: number): Promise<T[]> {
  return (await readTextUpTo(socket, count)).map(text => JSON.parse(text) as T)
}

function physicalRequests(message: unknown): ServerRequest[] {
  const parsed = message as ServerRequest | { type: 'server-batch'; requests: ServerRequest[] }
  return parsed.type === 'server-batch' ? parsed.requests : [parsed]
}

function batchMessage(message: unknown): { type: 'server-batch'; requests: ServerRequest[] } {
  expect(message).toMatchObject({ type: 'server-batch' })
  const batch = message as { type: 'server-batch'; requests: ServerRequest[] }
  expect(Array.isArray(batch.requests)).toBe(true)
  return batch
}

function singleMessage(message: unknown): ServerRequest {
  expect(message).toMatchObject({ type: 'server-request' })
  return message as ServerRequest
}

async function acceptedSocket(downlinks: WebSocketDownlinks): Promise<WebSocket> {
  const server = (downlinks as unknown as { server: { clients: Set<WebSocket> } }).server
  let accepted: WebSocket | undefined
  await vi.waitFor(() => {
    accepted = server.clients.values().next().value
    expect(accepted).toBeDefined()
  })
  return accepted as WebSocket
}

async function stalledSendHarness(options: {
  frame: RpcRequest<MuxFrame>
  downlink?: Partial<WebSocketDownlinkOptions>
  stallSend?: boolean
}) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let finish!: () => void
  const sourceFinished = new Promise<void>((resolve) => { finish = resolve })
  const downlinks = configuredDownlinks(api(
    async function * (signal) {
      try {
        await gate
        yield options.frame
        await untilAbort(signal)
      } finally {
        finish()
      }
    },
    idle,
  ), options.downlink)
  const host = await serve(downlinks)
  const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
  await once(socket, 'open')
  const accepted = await acceptedSocket(downlinks)
  let callback: ((error?: Error) => void) | undefined
  let sent!: () => void
  const sendCalled = new Promise<void>((resolve) => { sent = resolve })
  const originalSend = accepted.send.bind(accepted)
  const send = vi.spyOn(accepted, 'send').mockImplementation(((
    data: WebSocket.Data,
    optionsOrCallback?: unknown,
    done?: (error?: Error) => void,
  ) => {
    callback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback as (error?: Error) => void
      : done
    sent()
    if (options.stallSend !== false) return
    originalSend(data, callback)
  }) as WebSocket['send'])
  const terminate = vi.spyOn(accepted, 'terminate')
  const cleanups: (() => void)[] = [
    () => { terminate.mockRestore() },
    () => { send.mockRestore() },
  ]
  const closed = once(socket, 'close')
  running.push(async () => {
    for (const cleanup of cleanups.reverse()) cleanup()
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    await host.close()
  })
  return {
    socket,
    send,
    terminate,
    closed,
    sendCalled,
    sourceFinished,
    release,
    completeSend: (error?: Error) => { callback?.(error) },
    mockBufferedAmount: (values: number[], fallback = values.at(-1) ?? 0) => {
      const bufferedAmount = vi.spyOn(accepted, 'bufferedAmount', 'get').mockReturnValue(fallback)
      for (const value of values) bufferedAmount.mockReturnValueOnce(value)
      cleanups.push(() => { bufferedAmount.mockRestore() })
    },
  }
}

describe('WebSocket downlinks', () => {
  it('disables compression negotiation by default', async () => {
    const downlinks = configuredDownlinks(api(idle, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    expect(socket.extensions).toBe('')
    expect(serverOptions(downlinks).perMessageDeflate).toBe(false)
    expect(serverOptions(downlinks).maxPayload).toBe(1024)
    socket.close()
    await once(socket, 'close')
  })

  it('negotiates no-context-takeover and applies the configured compression threshold', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const small = muxFrame('compression-small', 'small')
    const large = muxFrame('compression-large', 'x'.repeat(1024))
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        await gate
        yield small
        yield large
        await untilAbort(signal)
      },
      idle,
    ), {
      compression: true,
      compressionThresholdBytes: 512,
      compressionConcurrency: TEST_COMPRESSION_CONCURRENCY,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`, true)
    const upgraded = once(socket, 'upgrade')
    await once(socket, 'open')
    const [response] = await upgraded as [IncomingMessage]
    const extension = String(response.headers['sec-websocket-extensions'])
    const accepted = await acceptedSocket(downlinks)
    const sender = (accepted as unknown as {
      _sender: { dispatch: (...args: unknown[]) => void }
    })._sender
    const dispatch = vi.spyOn(sender, 'dispatch')
    const messages = readUpTo(socket, 2)
    release()
    expect((await messages).map(message => message.rpcId)).toEqual([
      'compression-small',
      'compression-large',
    ])
    const compressionDecisions = dispatch.mock.calls.slice(0, 2).map(args => args[1])
    dispatch.mockRestore()
    const closed = once(socket, 'close')
    socket.close()
    await closed
    expect(socket.extensions).toContain('permessage-deflate')
    expect(extension).toContain('server_no_context_takeover')
    expect(extension).toContain('client_no_context_takeover')
    expect(serverOptions(downlinks).perMessageDeflate).toEqual(expect.objectContaining({
      threshold: 512,
      concurrencyLimit: TEST_COMPRESSION_CONCURRENCY,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    }))
    expect(serializedFrameBytes(small)).toBeLessThan(512)
    expect(serializedFrameBytes(large)).toBeGreaterThan(512)
    expect(compressionDecisions).toEqual([false, true])
  })

  it('rejects a different process-wide compression concurrency after disposal', async () => {
    const first = configuredDownlinks(api(idle, idle), {
      compression: true,
      compressionConcurrency: TEST_COMPRESSION_CONCURRENCY,
    })
    await first.close()
    let second: WebSocketDownlinks | undefined
    let failure: unknown
    try {
      second = configuredDownlinks(api(idle, idle), {
        compression: true,
        compressionConcurrency: TEST_COMPRESSION_CONCURRENCY + 1,
      })
    } catch (error) {
      failure = error
    }
    if (second !== undefined) await second.close()
    expect(String(failure)).toBe(
      'Error: websocket compression concurrency is already 4; changing it to 5 requires a process restart',
    )
  })

  it('delivers a serialized frame at the exact queued-byte limit', async () => {
    const frame = muxFrame('exact-byte-limit', '会'.repeat(16))
    let finished!: () => void
    const sourceFinished = new Promise<void>((resolve) => { finished = resolve })
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          yield frame
          await untilAbort(signal)
        } finally {
          finished()
        }
      },
      idle,
    ), { maxBufferedBytes: serializedFrameBytes(frame) })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    expect((await read(socket)).rpcId).toBe('exact-byte-limit')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await sourceFinished
  })

  it('rejects an oversized serialized frame before a real WebSocket can deliver it', async () => {
    const frame = muxFrame('oversized-frame', '会'.repeat(16))
    let aborted = false
    let finished!: () => void
    const sourceFinished = new Promise<void>((resolve) => { finished = resolve })
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          yield frame
          await untilAbort(signal)
        } finally {
          aborted = signal.aborted
          finished()
        }
      },
      idle,
    ), { maxBufferedBytes: serializedFrameBytes(frame) - 1 })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    const closed = once(socket, 'close')
    const messages = await readUpTo(socket, 1)
    if (messages.length > 0) {
      socket.close()
      await closed
    } else {
      await closed
    }
    await sourceFinished
    expect(messages).toEqual([])
    expect(aborted).toBe(true)
  })

  it('adds the serialized frame bytes to bytes already buffered before sending', async () => {
    const frame = muxFrame('buffered-plus-frame', 'buffered-plus-frame')
    const harness = await stalledSendHarness({
      frame,
      downlink: { maxBufferedBytes: serializedFrameBytes(frame) + 8 },
      stallSend: false,
    })
    harness.mockBufferedAmount([9])
    const messages = readUpTo(harness.socket, 1)
    harness.release()
    expect(await messages).toEqual([])
    await harness.closed
    expect(harness.terminate).toHaveBeenCalledOnce()
    expect(harness.send).not.toHaveBeenCalled()
    await harness.sourceFinished
  })

  it('checks buffered bytes immediately after send returns', async () => {
    const harness = await stalledSendHarness({
      frame: muxFrame('immediate-buffer-check', 'immediate-buffer-check'),
      downlink: { maxBufferedBytes: 1_000_000 },
    })
    harness.mockBufferedAmount([0], 1_000_001)
    harness.release()
    await harness.sendCalled
    const fusedImmediately = harness.terminate.mock.calls.length === 1
    if (!fusedImmediately) harness.completeSend()
    await harness.closed
    await harness.sourceFinished
    expect(fusedImmediately).toBe(true)
    expect(harness.terminate).toHaveBeenCalledOnce()
  })

  it('checks buffered bytes again after the send callback', async () => {
    const harness = await stalledSendHarness({
      frame: muxFrame('callback-buffer-check', 'callback-buffer-check'),
      downlink: { maxBufferedBytes: 1_000_000 },
    })
    harness.mockBufferedAmount([0, 0], 1_000_001)
    harness.release()
    await harness.sendCalled
    harness.completeSend()
    const fusedAfterCallback = harness.terminate.mock.calls.length === 1
    if (!fusedAfterCallback) harness.socket.terminate()
    await harness.closed
    await harness.sourceFinished
    expect(fusedAfterCallback).toBe(true)
    expect(harness.terminate).toHaveBeenCalledOnce()
  })

  it('terminates a send whose callback never fires and ignores its late callback', async () => {
    const harness = await stalledSendHarness({
      frame: muxFrame('timeout-frame', 'timeout-session'),
      downlink: { sendTimeoutMs: 20 },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      harness.release()
      await vi.advanceTimersByTimeAsync(20)
      const terminatedOnTimeout = harness.terminate.mock.calls.length === 1
      if (!terminatedOnTimeout) harness.socket.terminate()
      await harness.closed
      await harness.sourceFinished
      harness.completeSend()
      await vi.advanceTimersByTimeAsync(20)
      expect(terminatedOnTimeout).toBe(true)
      expect(harness.terminate).toHaveBeenCalledOnce()
      expect(harness.send).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes each server request once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        await gate
        yield {
          rpcId: RpcId('serialize-once'),
          payload: { type: 'session/subscribed', sessionId: 'session-serialize' as never, lastSeq: 0 },
        }
        await untilAbort(signal)
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const stringify = vi.spyOn(JSON, 'stringify')
    const frame = read(socket)
    release()
    expect((await frame).rpcId).toBe('serialize-once')
    expect(stringify.mock.calls.filter(args => isServerRequestWithRpcId(args[0], 'serialize-once')))
      .toHaveLength(1)
    stringify.mockRestore()
    const closed = once(socket, 'close')
    socket.close()
    await closed
  })

  it('sends 65 frames as a 64-request batch followed by one single message', async () => {
    const downlinks = configuredDownlinks(api(
      async function * () {
        for (let index = 0; index < 65; index++) yield muxFrame(`batch-${String(index)}`, `batch-${String(index)}`)
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true },
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)

    const messages = await readUpTo<unknown>(socket, 2)

    expect(messages).toHaveLength(2)
    const first = batchMessage(messages[0])
    const second = singleMessage(messages[1])
    expect(first.requests).toHaveLength(64)
    expect(first.requests.map(request => request.rpcId))
      .toEqual(Array.from({ length: 64 }, (_, index) => `batch-${String(index)}`))
    expect(second.rpcId).toBe('batch-64')
  })

  it('sends 65 frames as 65 physical messages when batching is disabled', async () => {
    const downlinks = configuredDownlinks(api(
      async function * () {
        for (let index = 0; index < 65; index++) yield muxFrame(`single-${String(index)}`, `single-${String(index)}`)
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)

    const messages = await readUpTo<unknown>(socket, 65)

    expect(messages).toHaveLength(65)
    expect(messages.every(message => (message as { type?: unknown }).type === 'server-request')).toBe(true)
    expect(messages.flatMap(physicalRequests).map(request => request.rpcId))
      .toEqual(Array.from({ length: 65 }, (_, index) => `single-${String(index)}`))
  })

  it('flushes a real one-request partial batch after its 16 ms deadline', async () => {
    let finished!: () => void
    const sourceFinished = new Promise<void>((resolve) => { finished = resolve })
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          yield muxFrame('timer-partial', 'timer-partial')
          await untilAbort(signal)
        } finally {
          finished()
        }
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true, flushMs: 16 },
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)

    const [message] = await readUpTo<unknown>(socket, 1)

    expect(singleMessage(message).rpcId).toBe('timer-partial')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await sourceFinished
  })

  it('flushes a clean-end partial batch as one raw batch message', async () => {
    const downlinks = configuredDownlinks(api(
      async function * () {
        yield muxFrame('clean-end-0', 'clean-end-0')
        yield muxFrame('clean-end-1', 'clean-end-1')
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true },
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)

    const [message] = await readUpTo<unknown>(socket, 1)
    const batch = batchMessage(message)

    expect(batch.requests.map(request => request.rpcId)).toEqual(['clean-end-0', 'clean-end-1'])
  })

  it('sends a wrapper-oversized request as one raw single message', async () => {
    const oversized = muxFrame('oversized-single', '会'.repeat(32))
    const text = serializedFrameText(oversized)
    const wrappedBytes = Buffer.byteLength(`${BATCH_PREFIX}${text}${BATCH_SUFFIX}`, 'utf8')
    const downlinks = configuredDownlinks(api(
      async function * () { yield oversized },
      idle,
    ), {
      batch: {
        ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch,
        enabled: true,
        maxBytes: wrappedBytes - 1,
      },
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)

    const [message] = await readUpTo<unknown>(socket, 1)

    expect(singleMessage(message).rpcId).toBe('oversized-single')
  })

  it('admits an exact batch byte fit through the socket fuse', async () => {
    const first = muxFrame('exact-batch-0', '会'.repeat(8))
    const second = muxFrame('exact-batch-1', '会'.repeat(9))
    const exactText = `${BATCH_PREFIX}${serializedFrameText(first)},${serializedFrameText(second)}${BATCH_SUFFIX}`
    const exactBytes = Buffer.byteLength(exactText, 'utf8')
    const downlinks = configuredDownlinks(api(
      async function * () {
        yield first
        yield second
      },
      idle,
    ), {
      batch: {
        ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch,
        enabled: true,
        maxBytes: exactBytes,
      },
      maxBufferedBytes: exactBytes,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)

    const [receivedText] = await readTextUpTo(socket, 1)
    expect(receivedText).toBe(exactText)
    const message = JSON.parse(receivedText ?? '') as unknown

    expect(batchMessage(message).requests.map(request => request.rpcId))
      .toEqual(['exact-batch-0', 'exact-batch-1'])
    expect(Buffer.byteLength(receivedText ?? '', 'utf8')).toBe(exactBytes)
  })

  it('keeps a batching-enabled healthy peer pumping after a slow peer crosses its byte fuse', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const aborted: boolean[] = []
    let peerIndex = 0
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        const index = peerIndex++
        aborted[index] = false
        try {
          await gate
          yield muxFrame(`peer-${String(index)}-0`, `session-${String(index)}`)
          yield muxFrame(`peer-${String(index)}-1`, `session-${String(index)}`)
          await untilAbort(signal)
        } finally {
          aborted[index] = true
        }
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true, maxFrames: 2 },
      maxBufferedBytes: 1_000,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const slow = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(slow, 'open')
    const accepted = await acceptedSocket(downlinks)
    const bufferedAmount = vi.spyOn(accepted, 'bufferedAmount', 'get').mockReturnValue(1_000)
    const healthy = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(healthy, 'open')
    const slowClosed = once(slow, 'close')
    const slowMessages = readUpTo(slow, 1)
    const healthyMessage = readUpTo<unknown>(healthy, 1)
    release()
    expect(batchMessage((await healthyMessage)[0]).requests.map(request => request.rpcId))
      .toEqual(['peer-1-0', 'peer-1-1'])
    const messages = await slowMessages
    if (messages.length > 0) {
      slow.close()
      await slowClosed
    } else {
      await slowClosed
    }
    expect(messages).toEqual([])
    await vi.waitFor(() => { expect(aborted[0]).toBe(true) })
    expect(aborted[1]).toBe(false)
    const healthyClosed = once(healthy, 'close')
    healthy.close()
    await healthyClosed
    await vi.waitFor(() => { expect(aborted[1]).toBe(true) })
    bufferedAmount.mockRestore()
  })

  it('carries mux and host over independent downstream sockets and cancels each source on close', async () => {
    let muxAborted = false
    let hostAborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          yield {
            rpcId: RpcId('mux-1'),
            payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 },
          }
          await untilAbort(signal)
        } finally {
          muxAborted = true
        }
      },
      async function * (signal) {
        try {
          yield { rpcId: RpcId('host-1'), payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
          await untilAbort(signal)
        } finally {
          hostAborted = true
        }
      },
    ))
    const host = await serve(downlinks)
    running.push(host.close)

    const mux = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = peer(`${host.origin}${HOST_EVENTS_PATH}`)
    const muxFrame = read(mux)
    const hostFrame = read(hostSocket)
    expect(await muxFrame).toEqual({
      type: 'server-request',
      rpcId: 'mux-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(await hostFrame).toEqual({
      type: 'server-request',
      rpcId: 'host-1',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })

    const muxClosed = once(mux, 'close')
    const hostClosed = once(hostSocket, 'close')
    mux.close()
    hostSocket.close()
    await Promise.all([muxClosed, hostClosed])
    await vi.waitFor(() => {
      expect(muxAborted).toBe(true)
      expect(hostAborted).toBe(true)
    })
  })

  it('rejects a one-kibibyte client message because upstream remains HTTP', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send(Buffer.alloc(1024))
    const [code, reason] = await closed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })

  it.each([
    ['uncompressed', false],
    ['compressed', true],
  ] as const)('rejects a %s client message above one kibibyte and accepts another peer', async (_label, compression) => {
    let connection = 0
    let offenderAborted = false
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        const index = connection++
        if (index === 0) {
          try {
            await untilAbort(signal)
          } finally {
            offenderAborted = signal.aborted
          }
          return
        }
        yield muxFrame('healthy-after-oversized-message', 'healthy-after-oversized-message')
        await untilAbort(signal)
      },
      idle,
    ), {
      compression,
      compressionConcurrency: TEST_COMPRESSION_CONCURRENCY,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const offender = peer(`${host.origin}${MUX_EVENTS_PATH}`, compression)
    await once(offender, 'open')
    const offenderClosed = once(offender, 'close')
    offender.send(Buffer.alloc(1025, 0x61), { compress: compression })
    const [code] = await offenderClosed as [number, Buffer]
    expect(code).toBe(1009)
    expect(offenderAborted).toBe(true)

    const healthy = peer(`${host.origin}${MUX_EVENTS_PATH}`, compression)
    expect((await read(healthy)).rpcId).toBe('healthy-after-oversized-message')
    const healthyClosed = once(healthy, 'close')
    healthy.close()
    await healthyClosed
  })

  it('abandons a pending batch and sends one single stream/error when its source fails', async () => {
    const downlinks = configuredDownlinks(api(
      async function * () {
        yield muxFrame('discarded-before-error', 'discarded-before-error')
        throw new Error('mux source failed')
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true },
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    const messages = await readUpTo<unknown>(socket, 2)
    expect(messages).toHaveLength(1)
    const failure = singleMessage(messages[0])
    expect(failure?.payload).toEqual({
      type: 'stream/error',
      error: { code: 'internal', message: 'Error: mux source failed', details: {} },
    })
  })

  it('aborts the source when an accepted socket reports a transport error', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const closed = once(socket, 'close')
    accepted.emit('error', new Error('transport failed'))
    await closed
    expect(aborted).toBe(true)
  })

  it('drops a source frame that races after the client has closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let sourceSignal: AbortSignal | undefined
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        sourceSignal = signal
        try {
          await gate
          yield {
            rpcId: RpcId('late'),
            payload: { type: 'session/subscribed', sessionId: 'session-late' as never, lastSeq: 0 },
          }
        } finally {
          finish()
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
    release()
    await finished
  })

  it('aborts a pending batched read before a send callback rejection settles', async () => {
    let finish!: () => void
    const sourceFinished = new Promise<void>((resolve) => { finish = resolve })
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          yield muxFrame('send-failure', 'session-send')
          await untilAbort(signal)
        } finally {
          finish()
        }
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true, flushMs: 16 },
    })
    const host = await serve(downlinks)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const send = vi.spyOn(accepted, 'send').mockImplementation(((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : callback
      done?.(new Error('socket send failed'))
    }) as WebSocket['send'])
    const closed = once(socket, 'close')
    const quiesced = Promise.all([closed, sourceFinished]).then(() => true)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let hostClosing: Promise<void> | undefined
    const closeHost = (): Promise<void> => {
      hostClosing ??= host.close()
      return hostClosing
    }
    const clearWatchdog = (): void => {
      if (watchdog !== undefined) clearTimeout(watchdog)
      watchdog = undefined
    }
    try {
      const completed = await Promise.race([
        quiesced,
        new Promise<false>((resolve) => {
          watchdog = setTimeout(() => { resolve(false) }, 500)
        }),
      ])
      clearWatchdog()
      if (!completed) accepted.terminate()
      await quiesced
      expect(completed).toBe(true)
      expect(send).toHaveBeenCalledOnce()
    } finally {
      clearWatchdog()
      if (accepted.readyState !== WebSocket.CLOSED) accepted.terminate()
      send.mockRestore()
      await closeHost()
    }
  })

  it('aborts the source before a synchronous send throw reaches iterator cleanup', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let abortedAtCleanup = false
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          await gate
          yield muxFrame('send-throw', 'send-throw')
        } finally {
          abortedAtCleanup = signal.aborted
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const send = vi.spyOn(accepted, 'send').mockImplementation(() => {
      throw new Error('synchronous send failure')
    })
    const closed = once(socket, 'close')

    release()
    await closed

    expect(abortedAtCleanup).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    send.mockRestore()
  })

  it('aborts the source before rejecting a send whose socket is not open', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const sourceFinished = new Promise<void>((resolve) => { finish = resolve })
    let abortedAtCleanup = false
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          await gate
          yield muxFrame('not-open', 'not-open')
        } finally {
          abortedAtCleanup = signal.aborted
          finish()
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const readyState = vi.spyOn(accepted, 'readyState', 'get').mockReturnValue(WebSocket.CLOSING)
    const send = vi.spyOn(accepted, 'send')

    release()
    await sourceFinished

    expect(abortedAtCleanup).toBe(true)
    expect(send).not.toHaveBeenCalled()
    readyState.mockRestore()
    send.mockRestore()
    const closed = once(socket, 'close')
    socket.close()
    await closed
  })

  it('rejects when its acceptor has already closed', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    await downlinks.close()
    await expect(downlinks.close()).rejects.toThrow('The server is not running')
  })

  it('waits for source cleanup before teardown resolves', async () => {
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleaned = false
    let awaitingAbort!: () => void
    const sourcePending = new Promise<void>((resolve) => { awaitingAbort = resolve })
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        try {
          yield muxFrame('teardown-partial', 'teardown-partial')
          awaitingAbort()
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      idle,
    ), {
      batch: { ...DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch, enabled: true },
    })
    const host = await serve(downlinks)
    const socket = peer(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    await sourcePending
    let closed = false
    const closing = host.close().then(() => { closed = true })
    try {
      await started
      expect(closed).toBe(false)
      releaseCleanup()
      await closing
      expect(cleaned).toBe(true)
    } finally {
      releaseCleanup()
      await closing
    }
  })
})
