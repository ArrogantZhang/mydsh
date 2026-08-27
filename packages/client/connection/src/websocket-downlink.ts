/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

type Frame = MuxFrame | HostFrame

/** Operational settings for the host-side WebSocket event streams. */
export interface WebSocketDownlinkOptions {
  /** Whether the server negotiates per-message deflate. */
  compression: boolean
  /** Minimum frame size eligible for compression, in bytes. */
  compressionThresholdBytes: number
  /** Maximum concurrent compression operations. */
  compressionConcurrency: number
  /** Maximum bytes queued by one socket before it is terminated. */
  maxBufferedBytes: number
  /** Maximum time to wait for one send callback, in milliseconds. */
  sendTimeoutMs: number
}

/** Package defaults for direct source consumers and hand-built test contexts. */
export const DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS: Readonly<WebSocketDownlinkOptions> = {
  compression: false,
  compressionThresholdBytes: 0,
  compressionConcurrency: 4,
  maxBufferedBytes: 1_048_576,
  sendTimeoutMs: 5_000,
}

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function bufferLimitError(maxBufferedBytes: number): Error {
  return new Error(`websocket downlink buffer limit exceeded (${String(maxBufferedBytes)} bytes)`)
}

function sendTimeoutError(sendTimeoutMs: number): Error {
  return new Error(`websocket downlink send timeout (${String(sendTimeoutMs)} ms)`)
}

function send(
  socket: WebSocket,
  request: ServerRequest,
  options: WebSocketDownlinkOptions,
): Promise<void> {
  const data = JSON.stringify(request)
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    if (socket.bufferedAmount > options.maxBufferedBytes) {
      socket.terminate()
      reject(bufferLimitError(options.maxBufferedBytes))
      return
    }

    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fuse = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.terminate()
      reject(error)
    }
    const onClose = (): void => {
      fail(new Error('websocket downlink closed before frame delivery'))
    }
    const onError = (error: Error): void => { fail(error) }

    socket.once('close', onClose)
    socket.once('error', onError)
    const timer = setTimeout(() => {
      fuse(sendTimeoutError(options.sendTimeoutMs))
    }, options.sendTimeoutMs)
    try {
      socket.send(data, (error) => {
        if (settled) return
        if (error) {
          fail(error)
          return
        }
        if (socket.bufferedAmount > options.maxBufferedBytes) {
          fuse(bufferLimitError(options.maxBufferedBytes))
          return
        }
        succeed()
      })
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server: WebSocketServer
  private readonly pumps = new Set<Promise<void>>()

  /**
   * @param api - Host API supplying the typed event streams.
   * @param options - Compression and per-socket delivery limits.
   */
  constructor(
    private readonly api: ApiProxy,
    private readonly options: WebSocketDownlinkOptions = DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS,
  ) {
    this.server = new WebSocketServer({
      noServer: true,
      perMessageDeflate: options.compression
        ? {
          threshold: options.compressionThresholdBytes,
          concurrencyLimit: options.compressionConcurrency,
        }
        : false,
    })
  }

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      websocket.once('close', () => { abort.abort() })
      websocket.once('error', () => { abort.abort() })
      websocket.once('message', () => {
        websocket.close(1008, 'downlink only')
      })
      const pump = this.pump(websocket, open(abort.signal), abort)
      this.pumps.add(pump)
      void pump.then(() => { this.pumps.delete(pump) })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) {
        await send(socket, serverRequest(frame), this.options)
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, serverRequest(failureFrame(error)), this.options)
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}
