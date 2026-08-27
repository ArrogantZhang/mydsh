import { once } from 'node:events'
import { createServer } from 'node:http'
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
  perMessageDeflate?: boolean | { threshold?: number; concurrencyLimit?: number }
} {
  return (downlinks as unknown as {
    server: { options: { perMessageDeflate?: boolean | { threshold?: number; concurrencyLimit?: number } } }
  }).server.options
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

function readUpTo(socket: WebSocket, count: number): Promise<ServerRequest[]> {
  return new Promise((resolve) => {
    const messages: ServerRequest[] = []
    const finish = (): void => {
      socket.off('message', onMessage)
      socket.off('close', finish)
      resolve(messages)
    }
    const onMessage = (data: WebSocket.RawData): void => {
      messages.push(JSON.parse(rawDataText(data)) as ServerRequest)
      if (messages.length === count) finish()
    }
    socket.on('message', onMessage)
    socket.once('close', finish)
  })
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

describe('WebSocket downlinks', () => {
  it('disables compression negotiation by default', async () => {
    const downlinks = configuredDownlinks(api(idle, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    expect(socket.extensions).toBe('')
    expect(serverOptions(downlinks).perMessageDeflate).toBe(false)
    socket.close()
    await once(socket, 'close')
  })

  it('negotiates configured per-message compression', async () => {
    const downlinks = configuredDownlinks(api(idle, idle), {
      compression: true,
      compressionThresholdBytes: 4096,
      compressionConcurrency: 7,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    expect(socket.extensions).toContain('permessage-deflate')
    expect(serverOptions(downlinks).perMessageDeflate).toEqual(expect.objectContaining({
      threshold: 4096,
      concurrencyLimit: 7,
    }))
    socket.close()
    await once(socket, 'close')
  })

  it('terminates a peer above the byte limit before sending and aborts its source', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let aborted = false
    const downlinks = configuredDownlinks(api(
      async function * () {
        try {
          await gate
          yield {
            rpcId: RpcId('private-frame-before'),
            payload: { type: 'session/subscribed', sessionId: 'private-session-before' as never, lastSeq: 0 },
          }
        } finally {
          aborted = true
        }
      },
      idle,
    ), { maxBufferedBytes: 8 })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const bufferedAmount = vi.spyOn(accepted, 'bufferedAmount', 'get').mockReturnValue(9)
    const terminate = vi.spyOn(accepted, 'terminate')
    const closed = once(socket, 'close')
    release()
    await closed
    expect(terminate).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(aborted).toBe(true) })
    bufferedAmount.mockRestore()
    terminate.mockRestore()
  })

  it('checks the byte limit after the send callback without exposing frame data', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let aborted = false
    const downlinks = configuredDownlinks(api(
      async function * () {
        try {
          await gate
          yield {
            rpcId: RpcId('private-frame-after'),
            payload: { type: 'session/subscribed', sessionId: 'private-session-after' as never, lastSeq: 0 },
          }
        } finally {
          aborted = true
        }
      },
      idle,
    ), { maxBufferedBytes: 8 })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const bufferedAmount = vi.spyOn(accepted, 'bufferedAmount', 'get')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(9)
      .mockReturnValue(0)
    const terminate = vi.spyOn(accepted, 'terminate').mockImplementation(() => {})
    const messages = readUpTo(socket, 2)
    const closed = once(socket, 'close')
    release()
    const [delivered, failure] = await messages
    await closed
    expect(delivered?.rpcId).toBe('private-frame-after')
    expect(failure?.payload).toEqual({
      type: 'stream/error',
      error: {
        code: 'internal',
        message: 'Error: websocket downlink buffer limit exceeded (8 bytes)',
        details: {},
      },
    })
    expect(JSON.stringify(failure ?? null)).not.toContain('private-frame-after')
    expect(JSON.stringify(failure ?? null)).not.toContain('private-session-after')
    expect(terminate).toHaveBeenCalledOnce()
    expect(aborted).toBe(true)
    bufferedAmount.mockRestore()
    terminate.mockRestore()
  })

  it('terminates a send whose callback never fires and ignores its late callback', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let aborted = false
    const downlinks = configuredDownlinks(api(
      async function * () {
        try {
          await gate
          yield {
            rpcId: RpcId('private-timeout-frame'),
            payload: { type: 'session/subscribed', sessionId: 'private-timeout-session' as never, lastSeq: 0 },
          }
        } finally {
          aborted = true
        }
      },
      idle,
    ), { sendTimeoutMs: 20 })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    let callback: ((error?: Error) => void) | undefined
    const originalSend = accepted.send.bind(accepted)
    let sendCount = 0
    const send = vi.spyOn(accepted, 'send').mockImplementation(((
      data: WebSocket.Data,
      optionsOrCallback?: unknown,
      done?: (error?: Error) => void,
    ) => {
      const currentCallback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : done
      sendCount++
      if (sendCount === 1) {
        callback = currentCallback
        return
      }
      originalSend(data, currentCallback)
    }) as WebSocket['send'])
    const terminate = vi.spyOn(accepted, 'terminate').mockImplementation(() => {})
    const messages = readUpTo(socket, 1)
    const closed = once(socket, 'close')
    release()
    const closedInTime = await Promise.race([
      closed.then(() => true),
      new Promise<false>(resolve => setTimeout(() => { resolve(false) }, 80)),
    ])
    if (!closedInTime) {
      callback?.()
      socket.terminate()
      await closed
    }
    expect(closedInTime).toBe(true)
    expect(terminate).toHaveBeenCalledOnce()
    const [failure] = await messages
    expect(failure?.payload).toEqual({
      type: 'stream/error',
      error: {
        code: 'internal',
        message: 'Error: websocket downlink send timeout (20 ms)',
        details: {},
      },
    })
    expect(JSON.stringify(failure ?? null)).not.toContain('private-timeout-frame')
    expect(JSON.stringify(failure ?? null)).not.toContain('private-timeout-session')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
    callback?.()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(terminate).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
    terminate.mockRestore()
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
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
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

  it('keeps a healthy peer pumping after a slow peer crosses its byte fuse', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const aborted: boolean[] = []
    let peer = 0
    const downlinks = configuredDownlinks(api(
      async function * (signal) {
        const index = peer++
        aborted[index] = false
        try {
          await gate
          yield {
            rpcId: RpcId(`peer-${String(index)}`),
            payload: { type: 'session/subscribed', sessionId: `session-${String(index)}` as never, lastSeq: index },
          }
          await untilAbort(signal)
        } finally {
          aborted[index] = true
        }
      },
      idle,
    ), { maxBufferedBytes: 8 })
    const host = await serve(downlinks)
    running.push(host.close)
    const slow = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(slow, 'open')
    const accepted = await acceptedSocket(downlinks)
    const bufferedAmount = vi.spyOn(accepted, 'bufferedAmount', 'get').mockReturnValue(9)
    const healthy = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(healthy, 'open')
    const slowClosed = once(slow, 'close')
    const healthyFrame = read(healthy)
    release()
    expect(await healthyFrame).toMatchObject({ rpcId: 'peer-1' })
    const slowFused = await Promise.race([
      slowClosed.then(() => true),
      new Promise<false>(resolve => setTimeout(() => { resolve(false) }, 80)),
    ])
    if (!slowFused) {
      slow.terminate()
      await slowClosed
    }
    expect(slowFused).toBe(true)
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

    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
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

  it('rejects client messages because upstream remains HTTP', async () => {
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
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('upstream payload')
    const [code, reason] = await closed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })

  it('sends stream/error before closing when a source fails', async () => {
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw new Error('mux source failed')
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    expect((await failure).payload).toEqual({
      type: 'stream/error',
      error: { code: 'internal', message: 'Error: mux source failed', details: {} },
    })
    await closed
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
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
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
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
    release()
    await finished
  })

  it('contains socket send callback failures and closes the downlink', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        await gate
        yield {
          rpcId: RpcId('send-failure'),
          payload: { type: 'session/subscribed', sessionId: 'session-send' as never, lastSeq: 0 },
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
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
    release()
    await closed
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
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
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
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
