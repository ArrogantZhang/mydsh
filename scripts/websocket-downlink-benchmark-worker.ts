import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type WebSocketType from '../packages/client/connection/node_modules/@types/ws/index.d.ts'
import type { StreamChunk } from '../packages/llm/llm/src/types.ts'
import type { CallId } from '../packages/llm/llm/src/brand.ts'
import type { SessionEvent, SessionId } from '../packages/core/session/src/types.ts'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
} from '../packages/host/apiproxy/src/api/index.ts'
import type {
  RpcId,
  RpcRequest,
  ServerRequest,
} from '../packages/host/apiproxy/src/api/rpc.ts'
import {
  hostFrameSchema,
  muxFrameSchema,
} from '../packages/host/apiproxy/src/api/events.schema.ts'
import { FrameQueue } from '../packages/host/apiproxy/src/frame-queue.ts'
import {
  HOST_EVENTS_PATH,
  MUX_EVENTS_PATH,
} from '../packages/client/connection/src/api-path.ts'
import { WebSocketDownlinks } from '../packages/client/connection/src/websocket-downlink.ts'
import {
  observeOwnedPromise,
  settleWorkerTeardown,
  type WebSocketDownlinkBenchmarkReport,
} from './websocket-downlink-benchmark.ts'

const require = createRequire(new URL('../packages/client/connection/package.json', import.meta.url))
const WebSocket = require('ws') as typeof WebSocketType

const BROWSERS = 5
const DOWNLINKS = 10 as const
const MUX_FRAMES_PER_BROWSER = 24_000
const HOST_FRAMES_PER_BROWSER = 256
const QUEUE_CAPACITY = 4_096
const PRODUCER_BURST_FRAMES = 24
const PRODUCER_INTERVAL_MS = 16
const COMPRESSION_CONCURRENCY = 4
const BATCH_MAX_FRAMES = 64
const BATCH_MAX_BYTES = 262_144
const BATCH_FLUSH_MS = 16
const MAX_BUFFERED_BYTES = 1_048_576
const SEND_TIMEOUT_MS = 5_000
const WATCHDOG_MS = 120_000
// The Host-owned worker loads the real Client codec at runtime without merging the two compiler faces.
const DOWNLINK_DECODER_URL = new URL(
  '../packages/client/connection/src/downlink-message.ts',
  import.meta.url,
).href

const REASONING_DELTA_TEXT = [
  'I am checking the request against the active session state before selecting the next operation.',
  'The current evidence includes ordered event records, a bounded queue observation, and the latest tool response.',
  'The next step is to compare the identifiers, preserve the established ordering, and describe only the result that the evidence supports.',
  'If the record is incomplete, the response should retain the unresolved status instead of inventing a successful outcome.',
  'This deterministic benchmark paragraph represents a substantial streamed reasoning delta without containing credentials or user data.',
  'It intentionally uses ordinary technical prose, punctuation, and repeated protocol terms found in realtime agent transcripts.',
  'The benchmark keeps the exact text fixed so compression modes receive identical application bytes.',
].join(' ')

const TEXT_DELTA_TEXT = [
  'The operation completed with a stable result. Five browser sessions receive their own ordered event streams, while the host stream remains independent.',
  'Each record carries a correlation identifier, a method tag, and a typed payload so the browser can validate and route it without transport-specific assumptions.',
  'Queue capacity remains bounded per downlink, and a stalled browser cannot consume unbounded process memory.',
  'This fixed response fragment models the explanatory text and structured terminology commonly present in a realtime assistant message.',
  'It contains no environment values, filesystem paths, credentials, or captured user content.',
  'The same bytes are generated for compression-disabled and compression-enabled workers.',
].join(' ')

const TOOL_ARGUMENTS_DELTA = JSON.stringify({
  path: 'src/realtime/example.ts',
  operation: 'replace',
  expectedRevision: 17,
  oldText: [
    'const delivery = await openDownlink(sessionId)',
    'await delivery.send(frame)',
    'await delivery.close()',
  ].join('\n'),
  newText: [
    'const delivery = await openDownlink(sessionId)',
    'for (const frame of frames) {',
    '  await delivery.send(frame)',
    '}',
    'await delivery.close()',
  ].join('\n'),
  metadata: {
    reason: 'keep ordered realtime delivery bounded and observable',
    checks: ['frame count', 'serialized bytes', 'transport bytes', 'queue peak', 'rss delta'],
    note: 'deterministic synthetic tool arguments; no external payload is sampled',
  },
})

type ChunkEvent = SessionEvent<'assistant/chunk'>
type Source<F> = { label: string; queue: FrameQueue<RpcRequest<F>> }
type PayloadParser<F> = { parse: (value: unknown) => F }
type DecodeDownlinkMessage = <F>(
  text: string,
  payloadSchema: PayloadParser<F>,
) => {
  ok: boolean
  requests: Array<{ full: ServerRequest; envelope: RpcRequest<F> }>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface PeerState {
  label: string
  socket: WebSocketType
  expectedCount: number
  received: number
  webSocketMessages: number
  maxBatchFrames: number
  maxBatchBytes: number
  extensionHeader: string
  opened: Promise<void>
  receivedAll: Promise<void>
  closed: Promise<void>
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: Error) => void
  const promise = observeOwnedPromise(new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  }))
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function compressionArgument(argv: string[]): boolean {
  if (argv.length !== 1) {
    throw new Error('usage: websocket-downlink-benchmark-worker.ts --compression=on|--compression=off')
  }
  if (argv[0] === '--compression=on') return true
  if (argv[0] === '--compression=off') return false
  throw new Error('invalid arguments: expected exactly --compression=on or --compression=off')
}

function chunkEvent(seq: number, chunk: StreamChunk): ChunkEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1_800_000_000_000 + seq,
    data: { turn: 1, step: 1, chunk },
  }
}

const CHUNK_CONSTRUCTORS: readonly ((seq: number) => ChunkEvent)[] = [
  seq => chunkEvent(seq, { type: 'reasoning-delta', index: 0, text: REASONING_DELTA_TEXT }),
  seq => chunkEvent(seq, { type: 'text-delta', index: 1, text: TEXT_DELTA_TEXT }),
  seq => chunkEvent(seq, {
    type: 'tool-call-delta',
    index: 2,
    id: 'benchmark-call-0001' as CallId,
    name: 'apply_patch',
    argumentsDelta: TOOL_ARGUMENTS_DELTA,
  }),
]

function muxFrame(browser: number, index: number): RpcRequest<MuxFrame> {
  const constructor = CHUNK_CONSTRUCTORS[index % CHUNK_CONSTRUCTORS.length]
  if (constructor === undefined) throw new Error('mux constructor cycle is empty')
  return {
    rpcId: `benchmark-mux-${String(browser)}-${String(index)}` as RpcId,
    payload: {
      type: 'session/event',
      sessionId: `benchmark-session-${String(browser)}` as SessionId,
      event: constructor(index),
    },
  }
}

function hostFrame(browser: number, index: number): RpcRequest<HostFrame> {
  return {
    rpcId: `benchmark-host-${String(browser)}-${String(index)}` as RpcId,
    payload: {
      type: 'host/remote-event',
      event: 'settings/document-updated',
      args: [
        'benchmark-settings',
        {
          revision: index,
          source: 'deterministic-websocket-downlink-benchmark',
          changed: ['provider', 'model', 'reasoningEffort'],
        },
      ],
    },
  }
}

function serializedFrameBytes(frame: RpcRequest<MuxFrame | HostFrame>): number {
  const request: ServerRequest = {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
  return Buffer.byteLength(JSON.stringify(request), 'utf8')
}

async function produce<F>(
  source: Source<F>,
  count: number,
  frame: (index: number) => RpcRequest<F>,
  start: Promise<void>,
  observeQueue: (size: number) => void,
): Promise<number> {
  await start
  let serializedBytes = 0
  for (let index = 0; index < count; index++) {
    const item = frame(index)
    serializedBytes += serializedFrameBytes(item as RpcRequest<MuxFrame | HostFrame>)
    if (!source.queue.push(item)) {
      throw new Error(
        `${source.label}.peakQueueFrames actual=>${String(QUEUE_CAPACITY)} `
        + `threshold=<=${String(QUEUE_CAPACITY)}`,
      )
    }
    observeQueue(source.queue.size)
    if ((index + 1) % PRODUCER_BURST_FRAMES === 0 && index + 1 < count) {
      await delay(PRODUCER_INTERVAL_MS)
    }
  }
  return serializedBytes
}

function rawDataBuffer(data: WebSocketType.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return data
}

async function loadDownlinkDecoder(): Promise<DecodeDownlinkMessage> {
  const loaded = await import(DOWNLINK_DECODER_URL) as { decodeDownlinkMessage?: unknown }
  if (typeof loaded.decodeDownlinkMessage !== 'function') {
    throw new Error('browser downlink decoder export is unavailable')
  }
  return loaded.decodeDownlinkMessage as DecodeDownlinkMessage
}

function decodePeerMessage(
  data: WebSocketType.RawData,
  method: 'session/event' | 'host/remote-event',
  decodeDownlinkMessage: DecodeDownlinkMessage,
): { requestCount: number; utf8Bytes: number } | undefined {
  const raw = rawDataBuffer(data)
  const decoded = method === 'session/event'
    ? decodeDownlinkMessage(raw.toString('utf8'), muxFrameSchema)
    : decodeDownlinkMessage(raw.toString('utf8'), hostFrameSchema)
  if (!decoded.ok) return undefined
  if (decoded.requests.some(request => request.full.method !== method
    || request.envelope.payload.type !== method)) return undefined
  return { requestCount: decoded.requests.length, utf8Bytes: raw.byteLength }
}

function openPeer(
  url: string,
  label: string,
  method: 'session/event' | 'host/remote-event',
  expectedCount: number,
  compression: boolean,
  decodeDownlinkMessage: DecodeDownlinkMessage,
  active: () => boolean,
  failRun: (error: Error) => void,
): PeerState {
  const socket = new WebSocket(url, {
    perMessageDeflate: compression
      ? {
        threshold: 0,
        concurrencyLimit: COMPRESSION_CONCURRENCY,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      }
      : false,
  })
  const opened = deferred<void>()
  const receivedAll = deferred<void>()
  const state: PeerState = {
    label,
    socket,
    expectedCount,
    received: 0,
    webSocketMessages: 0,
    maxBatchFrames: 0,
    maxBatchBytes: 0,
    extensionHeader: '',
    opened: opened.promise,
    receivedAll: receivedAll.promise,
    closed: new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) }),
  }
  socket.once('upgrade', (response) => {
    const extension = response.headers['sec-websocket-extensions']
    state.extensionHeader = Array.isArray(extension) ? extension.join(', ') : extension ?? ''
  })
  socket.once('open', () => { opened.resolve() })
  socket.on('message', (data, isBinary) => {
    const decoded = isBinary ? undefined : decodePeerMessage(data, method, decodeDownlinkMessage)
    if (decoded === undefined) {
      failRun(new Error(`${label} received an unexpected WebSocket frame`))
      return
    }
    state.webSocketMessages++
    state.maxBatchFrames = Math.max(state.maxBatchFrames, decoded.requestCount)
    state.maxBatchBytes = Math.max(state.maxBatchBytes, decoded.utf8Bytes)
    state.received += decoded.requestCount
    if (state.received > expectedCount) {
      failRun(new Error(`${label}.received actual=${String(state.received)} expected=${String(expectedCount)}`))
      return
    }
    if (state.received === expectedCount) receivedAll.resolve()
  })
  socket.on('error', (error) => {
    opened.reject(new Error(`${label} open failed: ${error.message}`))
    receivedAll.reject(new Error(`${label} stream failed: ${error.message}`))
    if (active()) failRun(new Error(`${label} WebSocket failed: ${error.message}`))
  })
  socket.once('close', () => {
    if (state.received < expectedCount) {
      receivedAll.reject(
        new Error(`${label}.received actual=${String(state.received)} expected=${String(expectedCount)}`),
      )
    }
    if (active()) failRun(new Error(`${label} closed before transport measurement`))
  })
  return state
}

function tcpBytesRead(peer: PeerState): number {
  // Measurement-only access to ws's underlying TCP socket; no behavior depends on private ws state.
  const socket = (peer.socket as unknown as { _socket?: Pick<Socket, 'bytesRead'> })._socket
  if (socket === undefined || !Number.isSafeInteger(socket.bytesRead) || socket.bytesRead < 0) {
    throw new Error(`${peer.label} TCP bytesRead is unavailable`)
  }
  return socket.bytesRead
}

function validateNegotiation(peers: PeerState[], compression: boolean): void {
  for (const peer of peers) {
    if (!compression) {
      if (peer.socket.extensions !== '' || peer.extensionHeader !== '') {
        throw new Error(`${peer.label} compression actual=enabled expected=disabled`)
      }
      continue
    }
    if (peer.socket.extensions !== 'permessage-deflate') {
      throw new Error(`${peer.label} compression actual=${peer.socket.extensions} expected=permessage-deflate`)
    }
    if (!peer.extensionHeader.includes('server_no_context_takeover')) {
      throw new Error(`${peer.label} server_no_context_takeover actual=absent expected=present`)
    }
    if (!peer.extensionHeader.includes('client_no_context_takeover')) {
      throw new Error(`${peer.label} client_no_context_takeover actual=absent expected=present`)
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else reject(error)
    })
  })
}

async function run(compression: boolean): Promise<WebSocketDownlinkBenchmarkReport> {
  const decodeDownlinkMessage = await loadDownlinkDecoder()
  const muxSources = Array.from({ length: BROWSERS }, (_, index): Source<MuxFrame> => ({
    label: `mux-${String(index)}`,
    queue: new FrameQueue<RpcRequest<MuxFrame>>(QUEUE_CAPACITY),
  }))
  const hostSources = Array.from({ length: BROWSERS }, (_, index): Source<HostFrame> => ({
    label: `host-${String(index)}`,
    queue: new FrameQueue<RpcRequest<HostFrame>>(QUEUE_CAPACITY),
  }))
  const allSources: Array<Source<MuxFrame> | Source<HostFrame>> = [...muxSources, ...hostSources]
  const failure = deferred<never>()
  let failed = false
  let active = true
  const failRun = (error: Error): void => {
    if (failed) return
    failed = true
    failure.reject(error)
  }
  let muxOpens = 0
  let hostOpens = 0
  const source = <F>(sources: Source<F>[], index: number, signal: AbortSignal): AsyncIterable<RpcRequest<F>> => {
    const selected = sources[index]
    if (selected === undefined) throw new Error('more WebSocket sources opened than configured')
    return selected.queue.iterate(signal, () => {
      if (active) failRun(new Error(`${selected.label} source stopped before benchmark completion`))
    })
  }
  const api = {
    events: {
      mux: (_request: RpcRequest<{ since?: Record<SessionId, number> }>, signal: AbortSignal) =>
        source(muxSources, muxOpens++, signal),
      host: (_request: RpcRequest<{}>, signal: AbortSignal) =>
        source(hostSources, hostOpens++, signal),
    },
  } as ApiProxy
  const downlinks = new WebSocketDownlinks(api, {
    compression,
    compressionThresholdBytes: 0,
    compressionConcurrency: COMPRESSION_CONCURRENCY,
    batch: {
      enabled: true,
      maxFrames: BATCH_MAX_FRAMES,
      maxBytes: BATCH_MAX_BYTES,
      flushMs: BATCH_FLUSH_MS,
    },
    maxBufferedBytes: MAX_BUFFERED_BYTES,
    sendTimeoutMs: SEND_TIMEOUT_MS,
  })
  const server = createServer()
  const peers: PeerState[] = []
  const start = deferred<void>()
  let peakQueueFrames = 0
  const observeQueue = (size: number): void => { peakQueueFrames = Math.max(peakQueueFrames, size) }
  const producers = [
    ...muxSources.map((item, browser) => observeOwnedPromise(produce(
      item,
      MUX_FRAMES_PER_BROWSER,
      index => muxFrame(browser, index),
      start.promise,
      observeQueue,
    ))),
    ...hostSources.map((item, browser) => observeOwnedPromise(produce(
      item,
      HOST_FRAMES_PER_BROWSER,
      index => hostFrame(browser, index),
      start.promise,
      observeQueue,
    ))),
  ]
  let rssTimer: NodeJS.Timeout | undefined
  let watchdog: NodeJS.Timeout | undefined
  try {
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://benchmark.invalid').pathname
      if (pathname === MUX_EVENTS_PATH) downlinks.handleMux(request, socket, head)
      else if (pathname === HOST_EVENTS_PATH) downlinks.handleHost(request, socket, head)
      else socket.destroy()
    })
    server.on('error', (error) => { failRun(error) })
    const port = await listen(server)
    const origin = `ws://127.0.0.1:${String(port)}`
    for (let browser = 0; browser < BROWSERS; browser++) {
      peers.push(openPeer(
        `${origin}${MUX_EVENTS_PATH}`,
        `mux-peer-${String(browser)}`,
        'session/event',
        MUX_FRAMES_PER_BROWSER,
        compression,
        decodeDownlinkMessage,
        () => active,
        failRun,
      ))
      peers.push(openPeer(
        `${origin}${HOST_EVENTS_PATH}`,
        `host-peer-${String(browser)}`,
        'host/remote-event',
        HOST_FRAMES_PER_BROWSER,
        compression,
        decodeDownlinkMessage,
        () => active,
        failRun,
      ))
    }
    await Promise.race([Promise.all(peers.map(peer => peer.opened)), failure.promise])
    if (muxOpens !== BROWSERS) throw new Error(`mux source count actual=${String(muxOpens)} expected=${String(BROWSERS)}`)
    if (hostOpens !== BROWSERS) throw new Error(`host source count actual=${String(hostOpens)} expected=${String(BROWSERS)}`)
    validateNegotiation(peers, compression)
    const byteBaselines = peers.map(tcpBytesRead)
    const rssBaseline = process.memoryUsage().rss
    let peakRss = rssBaseline
    rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 5)
    watchdog = setTimeout(() => {
      failRun(new Error(`benchmark wallMs actual=>${String(WATCHDOG_MS)} threshold=<=${String(WATCHDOG_MS)}`))
    }, WATCHDOG_MS)
    const startedAt = performance.now()
    start.resolve()
    let receivedAt: number | undefined
    const receipts = Promise.all(peers.map(peer => peer.receivedAll)).then(() => {
      receivedAt = performance.now()
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    })
    await Promise.race([
      Promise.all([...producers, receipts]),
      failure.promise,
    ])
    for (const peer of peers) {
      if (peer.received !== peer.expectedCount) {
        throw new Error(`${peer.label}.received actual=${String(peer.received)} expected=${String(peer.expectedCount)}`)
      }
      if (peer.socket.readyState !== WebSocket.OPEN) {
        throw new Error(`${peer.label} readyState actual=${String(peer.socket.readyState)} expected=${String(WebSocket.OPEN)}`)
      }
    }
    if (receivedAt === undefined) throw new Error('receipt completion time is unavailable')
    const wallMs = receivedAt - startedAt
    const serializedBytes = (await Promise.all(producers)).reduce((sum, bytes) => sum + bytes, 0)
    const transportBytes = peers.reduce((sum, peer, index) => {
      const baseline = byteBaselines[index]
      if (baseline === undefined) throw new Error(`${peer.label} TCP baseline is unavailable`)
      const delta = tcpBytesRead(peer) - baseline
      if (delta <= 0) throw new Error(`${peer.label}.transportBytes actual=${String(delta)} threshold=>0`)
      return sum + delta
    }, 0)
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const rssDeltaBytes = Math.max(0, peakRss - rssBaseline)
    const webSocketMessages = peers.reduce((sum, peer) => sum + peer.webSocketMessages, 0)
    const maxBatchFrames = peers.reduce((maximum, peer) => Math.max(maximum, peer.maxBatchFrames), 0)
    const maxBatchBytes = peers.reduce((maximum, peer) => Math.max(maximum, peer.maxBatchBytes), 0)
    active = false
    return {
      compression,
      browsers: BROWSERS,
      downlinks: DOWNLINKS,
      muxFramesPerBrowser: MUX_FRAMES_PER_BROWSER,
      hostFramesPerBrowser: HOST_FRAMES_PER_BROWSER,
      serializedBytes,
      transportBytes,
      wallMs,
      peakQueueFrames,
      rssDeltaBytes,
      webSocketMessages,
      maxBatchFrames,
      maxBatchBytes,
      producerBurstFrames: PRODUCER_BURST_FRAMES,
      producerIntervalMs: PRODUCER_INTERVAL_MS,
    }
  } finally {
    active = false
    if (rssTimer !== undefined) clearInterval(rssTimer)
    if (watchdog !== undefined) clearTimeout(watchdog)
    for (const peer of peers) {
      if (peer.socket.readyState !== WebSocket.CLOSED) peer.socket.terminate()
    }
    await settleWorkerTeardown(
      () => { start.resolve() },
      () => {
        for (const item of allSources) item.queue.end()
      },
      producers,
      [
        () => downlinks.close(),
        async () => { await Promise.all(peers.map(peer => peer.closed)) },
        () => closeServer(server),
      ],
    )
  }
}

async function main(): Promise<void> {
  const compression = compressionArgument(process.argv.slice(2))
  const report = await run(compression)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
