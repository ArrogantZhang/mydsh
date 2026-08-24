/**
 * Invite-code authentication for WebServer compositions. The plugin resolves
 * secrets only from the inherited process environment, owns one reversible
 * `/__invite` prefix route, and keeps session verification stateless.
 * @module @deepseek-ai/dsh-host-invite-auth
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { HttpError, readUrlEncodedForm, redirect, writeEmpty, writeHtml } from './http.ts'
import { renderLoginPage } from './page.ts'
import {
  cookieValue,
  FailureLimiter,
  safeNextPath,
  trustedClientAddress,
  validForwardedOrigin,
} from './policy.ts'
import {
  inviteCodeMatches,
  issueSessionToken,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from './token.ts'

/** Stable Cordis plugin name. */
export const name = 'invite-auth'

/** Service required before the authentication route can be registered. */
export const inject = ['webServer']

/** Invite-authentication policy and launch-secret references. */
export interface Config {
  /** Inherited process-environment variable containing the invite code. */
  inviteCodeEnv?: string
  /** Inherited process-environment variable containing the session signing secret. */
  sessionSecretEnv?: string
  /** Signed session lifetime in seconds. */
  sessionTtlSeconds?: number
  /** Fixed authentication-failure window in seconds. */
  failureWindowSeconds?: number
  /** Failed attempts allowed per address during one window. */
  maxFailuresPerWindow?: number
  /** Maximum retained address buckets. */
  maxTrackedAddresses?: number
  /** Maximum URL-encoded login body size in bytes. */
  maxBodyBytes?: number
}

/** Validated invite-authentication configuration with deployment defaults. */
export const Config: z<Config> = z.object({
  inviteCodeEnv: z.string().default('DSH_INVITE_CODE_SECRET'),
  sessionSecretEnv: z.string().default('DSH_INVITE_SESSION_SECRET'),
  sessionTtlSeconds: z.number().step(1).min(60).default(2_592_000),
  failureWindowSeconds: z.number().step(1).min(1).default(900),
  maxFailuresPerWindow: z.number().step(1).min(1).default(10),
  maxTrackedAddresses: z.number().step(1).min(1).default(10_000),
  maxBodyBytes: z.number().step(1).min(128).max(65_536).default(4_096),
})

interface ResolvedConfig {
  inviteCodeEnv: string
  sessionSecretEnv: string
  sessionTtlSeconds: number
  failureWindowSeconds: number
  maxFailuresPerWindow: number
  maxTrackedAddresses: number
  maxBodyBytes: number
}

interface Runtime {
  config: ResolvedConfig
  inviteCode: string
  sessionSecret: string
  limiter: FailureLimiter
}

interface SingleHeader {
  ambiguous: boolean
  value: string | undefined
}

const ENVIRONMENT_REFERENCE = /^DSH_[A-Z0-9_]+$/
const INTEGER_CONFIG_FIELDS = [
  'sessionTtlSeconds',
  'failureWindowSeconds',
  'maxFailuresPerWindow',
  'maxTrackedAddresses',
  'maxBodyBytes',
] as const satisfies readonly (keyof ResolvedConfig)[]

/** Project the optional public input into one fully resolved runtime value. */
function resolveConfig(config: Config): ResolvedConfig {
  const resolved = Config(config) as ResolvedConfig
  requireEnvironmentReference(resolved.inviteCodeEnv, 'inviteCodeEnv')
  requireEnvironmentReference(resolved.sessionSecretEnv, 'sessionSecretEnv')
  for (const field of INTEGER_CONFIG_FIELDS) {
    if (!Number.isSafeInteger(resolved[field])) {
      throw new Error(`invite-auth: ${field} must be a safe integer`)
    }
  }
  if (!Number.isSafeInteger(resolved.failureWindowSeconds * 1_000)) {
    throw new Error('invite-auth: failureWindowSeconds must produce milliseconds as a safe integer')
  }
  const currentSeconds = Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(currentSeconds + resolved.sessionTtlSeconds)) {
    throw new Error('invite-auth: sessionTtlSeconds must produce an expiry representable as a safe integer')
  }
  return resolved
}

/** Require an uppercase DSH namespace reference covered by subprocess scrubbing. */
function requireEnvironmentReference(value: string, field: 'inviteCodeEnv' | 'sessionSecretEnv'): void {
  if (!ENVIRONMENT_REFERENCE.test(value)) {
    throw new Error(`invite-auth: ${field} must name an uppercase DSH_ environment variable`)
  }
}

/** Read a security-sensitive header only when it has one unambiguous value. */
function singleHeader(req: IncomingMessage, name: string): SingleHeader {
  const value = req.headers[name]
  if (typeof value !== 'string') return { ambiguous: Array.isArray(value), value: undefined }
  if (value.includes(',')) return { ambiguous: true, value: undefined }
  return { ambiguous: false, value }
}

/** Read a normal HTTP list header without treating its commas as ambiguity. */
function listHeader(req: IncomingMessage, name: string): string {
  return String(req.headers[name])
}

/** Require one launch secret without including its value in diagnostics. */
function requiredSecret(
  value: string | undefined,
  variableName: string,
  minimum: number,
  unit: 'characters' | 'bytes',
): string {
  const length = value === undefined
    ? 0
    : unit === 'bytes'
      ? Buffer.byteLength(value, 'utf8')
      : Array.from(value).length
  if (value === undefined || length < minimum) {
    throw new Error(
      `invite-auth: inherited process environment variable ${variableName} must contain at least ${String(minimum)} ${unit}`,
    )
  }
  return value
}

/** Return whether the request contains one valid, uniquely named session cookie. */
function validSession(req: IncomingMessage, secret: string): boolean {
  return verifySessionToken(cookieValue(req.headers.cookie, SESSION_COOKIE_NAME), secret)
}

/** Serialize the host-only authenticated-session cookie. */
function sessionCookie(token: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${String(ttlSeconds)}; Secure; HttpOnly; SameSite=Lax`
}

/** Serialize immediate expiry for the host-only authenticated-session cookie. */
function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`
}

/** Require the three proxy headers that prove a same-origin HTTPS form request. */
function requireValidOrigin(req: IncomingMessage): void {
  const origin = singleHeader(req, 'origin')
  const proto = singleHeader(req, 'x-forwarded-proto')
  const host = singleHeader(req, 'x-forwarded-host')
  if (
    origin.ambiguous || proto.ambiguous || host.ambiguous ||
    !validForwardedOrigin(origin.value, proto.value, host.value)
  ) throw new HttpError(403, 'origin rejected', true)
}

/** Select the limiter address after rejecting ambiguous proxy input. */
function clientAddress(req: IncomingMessage): string {
  const forwarded = singleHeader(req, 'x-dsh-invite-client-ip')
  if (forwarded.ambiguous) throw new HttpError(400, 'client address header is ambiguous', true)
  return trustedClientAddress(req.socket.remoteAddress, forwarded.value)
}

/** Add connection closure when a response precedes the complete request body. */
function responseHeaders(
  req: IncomingMessage,
  headers: OutgoingHttpHeaders = {},
  forceClose = false,
): OutgoingHttpHeaders {
  return forceClose || !req.complete ? { ...headers, connection: 'close' } : headers
}

/** Write one request-aware empty response. */
function respondEmpty(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders = {},
  forceClose = false,
): void {
  writeEmpty(res, status, responseHeaders(req, headers, forceClose))
}

/** Write one request-aware HTML response. */
function respondHtml(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  writeHtml(res, status, body, responseHeaders(req))
}

/** Write one request-aware redirect response. */
function respondRedirect(
  req: IncomingMessage,
  res: ServerResponse,
  location: string,
  headers: OutgoingHttpHeaders = {},
  forceClose = false,
): void {
  redirect(res, location, responseHeaders(req, headers, forceClose))
}

/** Serve one request claimed by the `/__invite` prefix route. */
async function dispatch(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  /* v8 ignore next -- node:http always supplies url for server requests. */
  const url = new URL(req.url ?? '/', 'http://invite-auth.invalid')
  if (url.pathname === '/__invite/login' && req.method === 'GET') {
    const next = safeNextPath(url.searchParams.get('next'))
    if (validSession(req, runtime.sessionSecret)) {
      respondRedirect(req, res, next)
      return
    }
    respondHtml(req, res, 200, renderLoginPage(next, false))
    return
  }

  if (url.pathname === '/__invite/login' && req.method === 'POST') {
    requireValidOrigin(req)
    const address = clientAddress(req)
    const retryAfter = runtime.limiter.retryAfterSeconds(address, Date.now())
    if (retryAfter !== undefined) {
      respondEmpty(req, res, 429, { 'retry-after': String(retryAfter) }, true)
      return
    }
    const form = await readUrlEncodedForm(req, runtime.config.maxBodyBytes)
    const next = safeNextPath(form.get('next'))
    const candidate = form.get('inviteCode')
    if (candidate === null) throw new HttpError(400, 'missing inviteCode', false)
    if (!inviteCodeMatches(candidate, runtime.inviteCode)) {
      runtime.limiter.recordFailure(address, Date.now())
      respondHtml(req, res, 401, renderLoginPage(next, true))
      return
    }
    runtime.limiter.clear(address)
    const token = issueSessionToken(runtime.sessionSecret, runtime.config.sessionTtlSeconds)
    respondRedirect(req, res, next, { 'set-cookie': sessionCookie(token, runtime.config.sessionTtlSeconds) })
    return
  }

  if (url.pathname === '/__invite/check' && req.method === 'GET') {
    if (validSession(req, runtime.sessionSecret)) {
      respondEmpty(req, res, 204)
      return
    }
    const method = singleHeader(req, 'x-forwarded-method')
    const uri = singleHeader(req, 'x-forwarded-uri')
    if (method.ambiguous || uri.ambiguous) {
      respondEmpty(req, res, 401)
      return
    }
    const originalMethod = method.value ?? 'GET'
    if (
      (originalMethod === 'GET' || originalMethod === 'HEAD') &&
      listHeader(req, 'accept').toLowerCase().includes('text/html')
    ) {
      const next = safeNextPath(uri.value)
      respondRedirect(req, res, `/__invite/login?next=${encodeURIComponent(next)}`)
      return
    }
    respondEmpty(req, res, 401)
    return
  }

  if (url.pathname === '/__invite/logout' && req.method === 'POST') {
    requireValidOrigin(req)
    respondRedirect(req, res, '/__invite/login', {
      'set-cookie': clearedSessionCookie(),
    }, true)
    return
  }

  if (url.pathname === '/__invite/login') {
    respondEmpty(req, res, 405, { allow: 'GET, POST' })
    return
  }
  if (url.pathname === '/__invite/check') {
    respondEmpty(req, res, 405, { allow: 'GET' })
    return
  }
  if (url.pathname === '/__invite/logout') {
    respondEmpty(req, res, 405, { allow: 'POST' })
    return
  }
  respondEmpty(req, res, 404)
}

/**
 * Resolve launch secrets and register the invite-authentication HTTP route.
 * Activation fails when either required inherited process variable is absent
 * or too short; disposing the plugin removes the complete route prefix.
 * @param ctx Cordis context carrying the WebServer and launch snapshot.
 * @param config Validated invite-authentication configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const environment = launchEnvironmentOf(ctx)
  const inviteCode = requiredSecret(
    environment.getFrom(resolved.inviteCodeEnv, ['process'])?.value,
    resolved.inviteCodeEnv,
    12,
    'characters',
  )
  const sessionSecret = requiredSecret(
    environment.getFrom(resolved.sessionSecretEnv, ['process'])?.value,
    resolved.sessionSecretEnv,
    32,
    'bytes',
  )
  const runtime: Runtime = {
    config: resolved,
    inviteCode,
    sessionSecret,
    limiter: new FailureLimiter({
      windowMs: resolved.failureWindowSeconds * 1_000,
      maxFailures: resolved.maxFailuresPerWindow,
      maxEntries: resolved.maxTrackedAddresses,
    }),
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/__invite',
    handler: async (req, res) => {
      try {
        await dispatch(req, res, runtime)
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        respondEmpty(
          req,
          res,
          error.status,
          {},
          error.closeConnection,
        )
      }
    },
  }), 'invite-auth: HTTP routes')
}
