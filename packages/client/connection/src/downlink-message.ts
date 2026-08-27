/** Browser-safe decoding for physical WebSocket downlink messages. */

import type { RpcRequest, ServerRequest } from './client/api.ts'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

/** Maximum number of logical server requests carried by one physical message. */
export const MAX_SERVER_BATCH_REQUESTS = 256

/** Bounded physical-message wrapper for several logical server requests. */
export interface ServerBatch {
  type: 'server-batch'
  requests: ServerRequest[]
}

/** Physical server-to-browser WebSocket message. */
export type DownlinkMessage = ServerRequest | ServerBatch

/** Safe classification for a rejected physical downlink message. */
export type DownlinkDecodeCategory = 'json' | 'wrapper' | 'envelope' | 'payload'

/** Atomic result of decoding one physical downlink message. */
export type DownlinkDecodeResult<F> =
  | { ok: true; envelopes: ServerRequest[]; requests: RpcRequest<F>[] }
  | { ok: false; category: DownlinkDecodeCategory; requests: [] }

type Parser<T> = { parse(value: unknown): T }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function batchMembers(value: unknown): unknown[] {
  if (!isRecord(value) || value.type !== 'server-batch' || !Array.isArray(value.requests)) {
    throw new TypeError('invalid server batch wrapper')
  }
  if (value.requests.length === 0 || value.requests.length > MAX_SERVER_BATCH_REQUESTS) {
    throw new RangeError('invalid server batch size')
  }
  return value.requests
}

/** Schema-compatible parser for the bounded `server-batch` wrapper. */
export const serverBatchSchema: Parser<ServerBatch> = {
  parse(value: unknown): ServerBatch {
    return {
      type: 'server-batch',
      requests: batchMembers(value).map(member => serverRequestSchema.parse(member)),
    }
  },
}

/**
 * Decode and validate every logical request before returning any of them.
 * @param text - complete text from one physical WebSocket message.
 * @param payloadSchema - parser for the selected mux or host stream payload.
 * @returns every individual validated request in wire order, or an empty categorized failure.
 */
export function decodeDownlinkMessage<F>(
  text: string,
  payloadSchema: Parser<F>,
): DownlinkDecodeResult<F> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, category: 'json', requests: [] }
  }

  let envelopes: ServerRequest[]
  if (isRecord(raw) && raw.type === 'server-batch') {
    let members: unknown[]
    try {
      members = batchMembers(raw)
    } catch {
      return { ok: false, category: 'wrapper', requests: [] }
    }
    try {
      envelopes = members.map(member => serverRequestSchema.parse(member))
    } catch {
      return { ok: false, category: 'envelope', requests: [] }
    }
  } else if (isRecord(raw) && raw.type === 'server-request') {
    try {
      envelopes = [serverRequestSchema.parse(raw)]
    } catch {
      return { ok: false, category: 'envelope', requests: [] }
    }
  } else {
    return { ok: false, category: 'wrapper', requests: [] }
  }

  const requests: RpcRequest<F>[] = []
  try {
    for (const envelope of envelopes) {
      requests.push({ rpcId: envelope.rpcId, payload: payloadSchema.parse(envelope.payload) })
    }
  } catch {
    return { ok: false, category: 'payload', requests: [] }
  }
  return { ok: true, envelopes, requests }
}
