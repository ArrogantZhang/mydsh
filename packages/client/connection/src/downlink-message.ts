/** Browser-safe decoding for physical WebSocket downlink messages. */

import type { RpcRequest, ServerRequest } from './client/api.ts'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { z } from 'zod'

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

/** One validated full request aligned with its stream-specific envelope. */
export interface DecodedDownlinkRequest<F> {
  full: ServerRequest
  envelope: RpcRequest<F>
}

/** Atomic result of decoding one physical downlink message. */
export type DownlinkDecodeResult<F> =
  | { ok: true; requests: DecodedDownlinkRequest<F>[] }
  | { ok: false; category: DownlinkDecodeCategory; requests: [] }

type Parser<T> = { parse(value: unknown): T }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Zod schema for the bounded `server-batch` wrapper and every full request inside it. */
export const serverBatchSchema: z.ZodType<ServerBatch> = z.object({
  type: z.literal('server-batch'),
  requests: z.array(serverRequestSchema).min(1).max(MAX_SERVER_BATCH_REQUESTS),
})

function hasBoundedBatchRequests(value: unknown): value is { type: 'server-batch'; requests: unknown[] } {
  if (!isRecord(value) || value.type !== 'server-batch' || !Array.isArray(value.requests)) return false
  return value.requests.length >= 1 && value.requests.length <= MAX_SERVER_BATCH_REQUESTS
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
    if (!hasBoundedBatchRequests(raw)) {
      return { ok: false, category: 'wrapper', requests: [] }
    }
    const parsed = serverBatchSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, category: 'envelope', requests: [] }
    }
    envelopes = parsed.data.requests
  } else if (isRecord(raw) && raw.type === 'server-request') {
    const parsed = serverRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, category: 'envelope', requests: [] }
    }
    envelopes = [parsed.data]
  } else {
    return { ok: false, category: 'wrapper', requests: [] }
  }

  const requests: DecodedDownlinkRequest<F>[] = []
  try {
    for (const full of envelopes) {
      requests.push({
        full,
        envelope: { rpcId: full.rpcId, payload: payloadSchema.parse(full.payload) },
      })
    }
  } catch {
    return { ok: false, category: 'payload', requests: [] }
  }
  return { ok: true, requests }
}
