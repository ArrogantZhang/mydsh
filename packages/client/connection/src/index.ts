/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the webServer Context merge used below.
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { HostConnectionService } from './rpc-host.ts'
import {
  DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS,
  rejectWebSocketUpgrade,
  WebSocketDownlinks,
  type WebSocketDownlinkOptions,
} from './websocket-downlink.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024
const MAX_DOWNLINK_COMPRESSION_THRESHOLD_BYTES = 1_048_576
const MAX_DOWNLINK_COMPRESSION_CONCURRENCY = 16
const MAX_DOWNLINK_BATCH_FRAMES = 256
const MAX_DOWNLINK_BATCH_BYTES = 1_048_576
const MAX_DOWNLINK_BATCH_FLUSH_MS = 100
const MAX_DOWNLINK_BUFFERED_BYTES = 67_108_864
const MAX_DOWNLINK_SEND_TIMEOUT_MS = 60_000

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
  /** Whether WebSocket downlinks negotiate per-message deflate. Default: false. */
  downlinkCompression?: boolean
  /** Compression threshold in bytes, from 0 through 1,048,576. Default: 0. */
  downlinkCompressionThresholdBytes?: number
  /**
   * Process-wide compression concurrency, from 1 through 16. The first
   * compression-enabled instance fixes it until process restart. Default: 4.
   */
  downlinkCompressionConcurrency?: number
  /** Whether logical downlink requests share bounded physical messages. Default: false. */
  downlinkBatch?: boolean
  /** Maximum requests per physical batch, from 1 through 256. Default: 64. */
  downlinkBatchMaxFrames?: number
  /** Maximum complete batch size, from 1 through 1,048,576 UTF-8 bytes. Default: 262,144. */
  downlinkBatchMaxBytes?: number
  /** Batch deadline from its first request, from 1 through 100 milliseconds. Default: 16. */
  downlinkBatchFlushMs?: number
  /** Per-socket buffered-byte limit, from 1 through 67,108,864. Default: 1,048,576. */
  downlinkMaxBufferedBytes?: number
  /** Per-frame send timeout in milliseconds, from 1 through 60,000. Default: 5,000. */
  downlinkSendTimeoutMs?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  downlinkCompression: z.boolean().default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.compression),
  downlinkCompressionThresholdBytes: z.natural()
    .max(MAX_DOWNLINK_COMPRESSION_THRESHOLD_BYTES)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.compressionThresholdBytes),
  downlinkCompressionConcurrency: z.natural()
    .min(1)
    .max(MAX_DOWNLINK_COMPRESSION_CONCURRENCY)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.compressionConcurrency),
  downlinkBatch: z.boolean().default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.enabled),
  downlinkBatchMaxFrames: z.natural()
    .min(1)
    .max(MAX_DOWNLINK_BATCH_FRAMES)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.maxFrames),
  downlinkBatchMaxBytes: z.natural()
    .min(1)
    .max(MAX_DOWNLINK_BATCH_BYTES)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.maxBytes),
  downlinkBatchFlushMs: z.natural()
    .min(1)
    .max(MAX_DOWNLINK_BATCH_FLUSH_MS)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.flushMs),
  downlinkMaxBufferedBytes: z.natural()
    .min(1)
    .max(MAX_DOWNLINK_BUFFERED_BYTES)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.maxBufferedBytes),
  downlinkSendTimeoutMs: z.natural()
    .min(1)
    .max(MAX_DOWNLINK_SEND_TIMEOUT_MS)
    .default(DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.sendTimeoutMs),
})

/**
 * Methods gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. `trustedHosts` is a
 * DNS-rebinding fence, explicitly not authentication, so the whole
 * configuration plane stays loopback-same-origin until a real authentication
 * layer exists. `llm.discoverModels` belongs to that plane on both counts: it
 * carries a draft credential, and it makes the HOST issue a GET to a URL the
 * caller chose and reports back the status or the parsed body — an anonymous
 * LAN caller would have a probe for whatever the host can reach and the
 * browser cannot.
 *
 * The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
 * it carries provider ids, display names, and model lists — no endpoints,
 * keys, or key state — and a LAN client's model picker legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
  // A preset composition names the plugins a session runs, so reading one is
  // reconnaissance; copy and remove rearrange what the deployment offers, and
  // openDocument drives the host desktop — all more than the roster beside
  // them. (Authoring is copy-only, so no method here accepts composition text
  // or a path; the pin is about who may manage the roster at all.)
  //
  // CHOOSING one is not pinned, and `agentPreset.list` is not either. Picking a
  // preset looks like escalation — one of them mounts the toolset that edits the
  // live runtime — but `session.create` already takes an `agentPreset`, so
  // pinning only the switch would leave the same capability one method over.
  // The deeper reason is that the capability is not the preset's to grant: the
  // deployment's own default already carries `bash` and the filesystem tools, so
  // any caller that may start a session at all can already run commands as this
  // process. Pinning the switch would be a fence beside an open gate.
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts));
 * privileged methods additionally pass it with an empty trust list, which
 * pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const downlinkOptions: WebSocketDownlinkOptions = {
    compression: config?.downlinkCompression ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.compression,
    compressionThresholdBytes: config?.downlinkCompressionThresholdBytes
      ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.compressionThresholdBytes,
    compressionConcurrency: config?.downlinkCompressionConcurrency
      ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.compressionConcurrency,
    batch: {
      enabled: config?.downlinkBatch ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.enabled,
      maxFrames: config?.downlinkBatchMaxFrames ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.maxFrames,
      maxBytes: config?.downlinkBatchMaxBytes ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.maxBytes,
      flushMs: config?.downlinkBatchFlushMs ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.batch.flushMs,
    },
    maxBufferedBytes: config?.downlinkMaxBufferedBytes
      ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.maxBufferedBytes,
    sendTimeoutMs: config?.downlinkSendTimeoutMs
      ?? DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS.sendTimeoutMs,
  }
  if (downlinkOptions.batch.enabled
    && downlinkOptions.batch.maxBytes > downlinkOptions.maxBufferedBytes) {
    throw new Error(
      `client-connection downlinkBatchMaxBytes (${String(downlinkOptions.batch.maxBytes)}) `
      + `must not exceed downlinkMaxBufferedBytes (${String(downlinkOptions.maxBufferedBytes)})`,
    )
  }
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH, {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined
      if (method !== undefined
        && PRIVILEGED_METHODS.has(method)
        && !isTrustedApiRequest(request, [])) {
        return new Response('forbidden', { status: 403 })
      }
      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      return toFetchHandler(apiProxy).fetch(request)
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy, downlinkOptions)
    const registerDownlink = (
      path: string,
      handle: WebUpgradeRoute['handler'],
    ): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          return handle(req, socket, head)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })
  })
}
