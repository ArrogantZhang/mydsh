/** Host-only encoder for bounded physical WebSocket downlink messages. */

import type {
  HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'

type Frame = MuxFrame | HostFrame
type EncodedRequest = EncodedDownlinkMessage & { kind: 'single'; requestCount: 1 }
type ReadResult<F extends Frame> =
  | { kind: 'next'; result: IteratorResult<RpcRequest<F>> }
  | { kind: 'abort' }
type BatchReadResult<F extends Frame> = ReadResult<F> | { kind: 'timer' }

const BATCH_PREFIX = '{"type":"server-batch","requests":['
const BATCH_SUFFIX = ']}'
const BATCH_WRAPPER_BYTES = Buffer.byteLength(BATCH_PREFIX + BATCH_SUFFIX, 'utf8')

/** Batching controls resolved by the connection plugin before socket registration. */
export interface DownlinkBatchOptions {
  /** Whether several logical requests may share one physical WebSocket message. */
  enabled: boolean
  /** Maximum logical requests in one physical message. */
  maxFrames: number
  /** Maximum UTF-8 bytes in a complete batch wrapper. */
  maxBytes: number
  /** Maximum delay from the first buffered request to its physical send. */
  flushMs: number
}

/** Default batching policy used by the connection plugin and direct Host consumers. */
export const DEFAULT_DOWNLINK_BATCH_OPTIONS: Readonly<DownlinkBatchOptions> = {
  enabled: false,
  maxFrames: 64,
  maxBytes: 262_144,
  flushMs: 16,
}

/** One completely serialized physical WebSocket message. */
export interface EncodedDownlinkMessage {
  /** Text passed directly to `WebSocket.send()`. */
  text: string
  /** UTF-8 byte length of `text`. */
  utf8Bytes: number
  /** Number of logical requests represented by `text`. */
  requestCount: number
  /** Whether `text` is one request or a batch wrapper. */
  kind: 'single' | 'batch'
}

/**
 * Serialize one typed request for an unbatched physical send.
 * @param frame - Typed logical request.
 * @returns Complete `server-request` text and its UTF-8 byte count.
 */
export function encodeDownlinkRequest<F extends Frame>(frame: RpcRequest<F>): EncodedRequest {
  const request: ServerRequest = {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
  const text = JSON.stringify(request)
  return {
    text,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    requestCount: 1,
    kind: 'single',
  }
}

function flush(requests: EncodedRequest[], utf8Bytes: number): EncodedDownlinkMessage {
  const first = requests[0]
  if (first === undefined) throw new Error('cannot flush an empty websocket downlink batch')
  if (requests.length === 1) return first
  return {
    text: BATCH_PREFIX + requests.map(request => request.text).join(',') + BATCH_SUFFIX,
    utf8Bytes,
    requestCount: requests.length,
    kind: 'batch',
  }
}

/**
 * Encode a logical source into bounded physical messages without reading it concurrently.
 * An abort or source failure discards the unsent partial batch and closes the source iterator.
 * @param frames - Typed logical requests in wire order.
 * @param options - Resolved batch count, complete-message byte, and deadline limits.
 * @param signal - Downlink lifetime; abort abandons buffered requests.
 * @returns Physical messages in the source's exact request order.
 */
export async function * encodeDownlink<F extends Frame>(
  frames: AsyncIterable<RpcRequest<F>>,
  options: DownlinkBatchOptions,
  signal: AbortSignal,
): AsyncGenerator<EncodedDownlinkMessage> {
  const iterator = frames[Symbol.asyncIterator]()
  let pendingNext: Promise<IteratorResult<RpcRequest<F>>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerResult: Promise<{ kind: 'timer' }> | undefined
  let sourceDone = false
  let sourceFailed = false
  let abortListener: (() => void) | undefined
  const abortResult = new Promise<{ kind: 'abort' }>((resolve) => {
    abortListener = () => { resolve({ kind: 'abort' }) }
    signal.addEventListener('abort', abortListener, { once: true })
    if (signal.aborted) abortListener()
  })
  const clearBatchTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    timerResult = undefined
  }
  const startBatchTimer = (): void => {
    timerResult = new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = undefined
        timerResult = undefined
        resolve({ kind: 'timer' })
      }, options.flushMs)
    })
  }
  const read = async (): Promise<ReadResult<F>> => {
    pendingNext ??= iterator.next()
    const result = await Promise.race([
      pendingNext.then(value => ({ kind: 'next' as const, result: value })),
      abortResult,
    ])
    if (result.kind === 'next') pendingNext = undefined
    return result
  }
  const readUntilTimer = async (): Promise<BatchReadResult<F>> => {
    pendingNext ??= iterator.next()
    const deadline = timerResult
    if (deadline === undefined) throw new Error('websocket downlink batch is missing its flush timer')
    const result = await Promise.race([
      pendingNext.then(value => ({ kind: 'next' as const, result: value })),
      abortResult,
      deadline,
    ])
    if (result.kind === 'next') pendingNext = undefined
    return result
  }

  let buffered: EncodedRequest[] = []
  let batchBytes = BATCH_WRAPPER_BYTES
  try {
    while (true) {
      const outcome = buffered.length === 0 ? await read() : await readUntilTimer()
      if (outcome.kind === 'abort') return
      if (outcome.kind === 'timer') {
        const ready = flush(buffered, batchBytes)
        buffered = []
        batchBytes = BATCH_WRAPPER_BYTES
        yield ready
        continue
      }
      if (outcome.result.done) {
        sourceDone = true
        clearBatchTimer()
        if (buffered.length > 0) yield flush(buffered, batchBytes)
        return
      }

      const encoded = encodeDownlinkRequest(outcome.result.value)
      if (!options.enabled) {
        yield encoded
        continue
      }
      if (buffered.length === 0) {
        const singleBatchBytes = BATCH_WRAPPER_BYTES + encoded.utf8Bytes
        if (options.maxFrames === 1 || singleBatchBytes > options.maxBytes) {
          yield encoded
          continue
        }
        buffered = [encoded]
        batchBytes = singleBatchBytes
        startBatchTimer()
        continue
      }

      const addedBytes = batchBytes + 1 + encoded.utf8Bytes
      if (addedBytes > options.maxBytes) {
        clearBatchTimer()
        const ready = flush(buffered, batchBytes)
        const singleBatchBytes = BATCH_WRAPPER_BYTES + encoded.utf8Bytes
        buffered = []
        batchBytes = BATCH_WRAPPER_BYTES
        yield ready
        if (options.maxFrames === 1 || singleBatchBytes > options.maxBytes) {
          yield encoded
        } else {
          buffered = [encoded]
          batchBytes = singleBatchBytes
          startBatchTimer()
        }
        continue
      }

      buffered.push(encoded)
      batchBytes = addedBytes
      if (buffered.length === options.maxFrames) {
        clearBatchTimer()
        const ready = flush(buffered, batchBytes)
        buffered = []
        batchBytes = BATCH_WRAPPER_BYTES
        yield ready
      }
    }
  } catch (error) {
    sourceFailed = true
    throw error
  } finally {
    clearBatchTimer()
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener)
    if (!sourceDone && iterator.return !== undefined) {
      try {
        await iterator.return()
      } catch (error) {
        if (!sourceFailed) throw error
      }
    }
  }
}
