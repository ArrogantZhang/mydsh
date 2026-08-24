/**
 * REAL-composition coverage for invite authentication through the Loader and
 * the listening WebServer. Tests observe HTTP behavior and Loader-owned route
 * disposal; only workspace package resolution uses the Loader import map.
 */

import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentLayerInput,
} from '@deepseek-ai/dsh-launch-environment'
import * as InviteAuth from '../src/index.ts'
import * as InviteAuthInvariant from '../src/invariant.ts'
import { verifySessionToken } from '../src/token.ts'

const INVITE_CODE = 'shared-code-123'
const SESSION_SECRET = '0123456789abcdef0123456789abcdef'
const PUBLIC_ORIGIN = 'https://dsh.example'
const PROCESS_SECRETS: LaunchEnvironmentLayerInput = {
  source: 'process',
  values: {
    DSH_INVITE_CODE_SECRET: INVITE_CODE,
    DSH_INVITE_SESSION_SECRET: SESSION_SECRET,
  },
}
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

interface Composition {
  context: Context
  logs: string[]
  root: string
  port: number
}

interface LoadOptions {
  layers?: readonly LaunchEnvironmentLayerInput[]
  port?: number
  config?: Readonly<Record<string, string | number>>
  onFailure?: (error: unknown, logs: readonly string[]) => void
}

interface Result {
  status: number
  headers: Headers
  body: string
}

const compositions = new Set<Composition>()

afterEach(async () => {
  for (const composition of compositions) {
    await composition.context.fiber.dispose()
    await rm(composition.root, { recursive: true, force: true })
  }
  compositions.clear()
})

/** Boot a two-row test composition and retain every acquired resource for teardown. */
async function loadComposition(options: LoadOptions = {}): Promise<Composition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-invite-auth-'))
  const configPath = join(root, 'cordis.yml')
  const configLines = Object.entries(options.config ?? {}).map(([key, value]) =>
    `    ${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(options.port ?? 0)}`,
    '- id: invite-auth',
    "  name: '@deepseek-ai/dsh-host-invite-auth'",
    ...configLines.length === 0 ? [] : ['  config:', ...configLines],
    '',
  ].join('\n'))

  const context = new Context()
  const composition: Composition = { context, logs: [], root, port: 0 }
  compositions.add(composition)
  context.baseUrl = pathToFileURL(root).href + '/'
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(options.layers ?? [PROCESS_SECRETS]))
  context.logger.exporter({
    colors: false,
    levels: { default: 3 },
    export(message) {
      composition.logs.push(message.args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(' '))
    },
  })
  try {
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-host-invite-auth', InviteAuth],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    composition.port = context.webServer.port
    return composition
  } catch (error) {
    options.onFailure?.(error, composition.logs)
    compositions.delete(composition)
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/**
 * Send one incomplete request, then attempt a second request after the first
 * response. A request-aware early response must close before processing it.
 */
async function incompleteKeepAlive(
  composition: Composition,
  requestLine: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<string> {
  const socket = connect(composition.port, '127.0.0.1')
  const chunks: Buffer[] = []
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    chunks.push(chunk)
    if (chunks.length !== 1) return
    socket.write([
      'xGET /__invite/unknown HTTP/1.1',
      'Host: dsh.example',
      'Connection: close',
      '',
      '',
    ].join('\r\n'))
  })
  await once(socket, 'connect')
  socket.write([
    `${requestLine} HTTP/1.1`,
    'Host: dsh.example',
    'Connection: keep-alive',
    'Content-Length: 1',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n'))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<void>(resolve => socket.once('close', () => { resolve() })),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`socket did not close after ${requestLine}`)), 2_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    socket.destroy()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Assert one early response closes without processing a pipelined successor. */
function expectClosedEarly(raw: string, status: number): void {
  expect(raw).toMatch(new RegExp(`^HTTP/1\\.1 ${String(status)} `))
  expect(raw).toMatch(/\r\nConnection: close\r\n/i)
  expect(raw.match(/HTTP\/1\.1 \d{3}/g)).toHaveLength(1)
}

/** Send one request without automatic redirects or cookie persistence. */
async function request(composition: Composition, path: string, init: RequestInit = {}): Promise<Result> {
  const response = await fetch(`http://127.0.0.1:${String(composition.port)}${path}`, {
    redirect: 'manual',
    ...init,
  })
  return { status: response.status, headers: response.headers, body: await response.text() }
}

/** Send a same-origin URL-encoded login form through the trusted proxy headers. */
async function login(
  composition: Composition,
  inviteCode: string | undefined,
  options: { address?: string; next?: string; headers?: HeadersInit } = {},
): Promise<Result> {
  const form = new URLSearchParams()
  if (inviteCode !== undefined) form.set('inviteCode', inviteCode)
  if (options.next !== undefined) form.set('next', options.next)
  return request(composition, '/__invite/login', {
    method: 'POST',
    body: form,
    headers: {
      origin: PUBLIC_ORIGIN,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'dsh.example',
      'x-dsh-invite-client-ip': options.address ?? '203.0.113.10',
      ...options.headers,
    },
  })
}

/** Return the Cookie request field represented by a Set-Cookie response. */
function requestCookie(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

/** Reserve an ephemeral loopback port and release it before returning. */
async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return address.port
}

/** Assert the headers fixed on every response owned by invite-auth. */
function expectSecurityHeaders(result: Result): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(result.headers.get(name)).toBe(value)
}

describe('real Loader invite-auth composition', () => {
  it('serves the login, authorization, session, and logout lifecycle', { timeout: 60_000 }, async () => {
    const composition = await loadComposition()

    const page = await request(composition, '/__invite/login?next=%2Fsessions')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('name="next" value="/sessions"')
    expect(page.body).not.toContain(INVITE_CODE)
    expect(page.body).not.toContain(SESSION_SECRET)
    expectSecurityHeaders(page)

    const unauthenticated = await request(composition, '/__invite/check', {
      headers: { accept: 'application/json' },
    })
    expect(unauthenticated.status).toBe(401)
    expectSecurityHeaders(unauthenticated)

    const navigation = await request(composition, '/__invite/check', {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'x-forwarded-method': 'GET',
        'x-forwarded-uri': '/sessions?view=active',
      },
    })
    expect(navigation.status).toBe(303)
    expect(navigation.headers.get('location')).toBe('/__invite/login?next=%2Fsessions%3Fview%3Dactive')
    expectSecurityHeaders(navigation)

    const rejected = await login(composition, 'wrong-code-123', { next: '/sessions' })
    expect(rejected.status).toBe(401)
    expect(rejected.body).toContain('role="alert"')
    expect(rejected.body).not.toContain('wrong-code-123')

    const accepted = await login(composition, INVITE_CODE, { next: '/sessions' })
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('location')).toBe('/sessions')
    const setCookie = accepted.headers.get('set-cookie')
    expect(setCookie).toMatch(/^__Host-dsh_invite=[A-Za-z0-9_.-]+; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/)
    const cookie = requestCookie(setCookie!)

    const authenticated = await request(composition, '/__invite/check', { headers: { cookie } })
    expect(authenticated.status).toBe(204)
    expectSecurityHeaders(authenticated)

    const alreadyAuthenticated = await request(composition, '/__invite/login?next=%2Fsessions', {
      headers: { cookie },
    })
    expect(alreadyAuthenticated.status).toBe(303)
    expect(alreadyAuthenticated.headers.get('location')).toBe('/sessions')

    const loggedOut = await request(composition, '/__invite/logout', {
      method: 'POST',
      headers: {
        cookie,
        origin: PUBLIC_ORIGIN,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'dsh.example',
      },
    })
    expect(loggedOut.status).toBe(303)
    expect(loggedOut.headers.get('location')).toBe('/__invite/login')
    expect(loggedOut.headers.get('connection')).toBe('close')
    expect(loggedOut.headers.get('set-cookie')).toBe(
      '__Host-dsh_invite=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax',
    )
    expectSecurityHeaders(loggedOut)

    const clearedCookie = await request(composition, '/__invite/check', {
      headers: { cookie: requestCookie(loggedOut.headers.get('set-cookie')!) },
    })
    expect(clearedCookie.status).toBe(401)

    const serializedLogs = JSON.stringify(composition.context.logger.buffer)
    expect(serializedLogs).not.toContain(INVITE_CODE)
    expect(serializedLogs).not.toContain(SESSION_SECRET)
    expect(serializedLogs).not.toContain(cookie)
  })

  it('owns method dispatch, unknown paths, strict proxy headers, and bounded forms', { timeout: 60_000 }, async () => {
    const composition = await loadComposition({ config: { maxBodyBytes: 128 } })

    for (const [path, method, allow] of [
      ['/__invite/login', 'DELETE', 'GET, POST'],
      ['/__invite/check', 'POST', 'GET'],
      ['/__invite/logout', 'GET', 'POST'],
    ] as const) {
      const result = await request(composition, path, { method })
      expect(result.status).toBe(405)
      expect(result.headers.get('allow')).toBe(allow)
      expectSecurityHeaders(result)
    }
    const unknown = await request(composition, '/__invite/unknown')
    expect(unknown.status).toBe(404)
    expectSecurityHeaders(unknown)

    const badOrigin = await login(composition, INVITE_CODE, {
      headers: { origin: 'https://dsh.example, https://evil.example' },
    })
    expect(badOrigin.status).toBe(403)
    expect(badOrigin.headers.get('connection')).toBe('close')
    expectSecurityHeaders(badOrigin)

    const badHost = await login(composition, INVITE_CODE, {
      headers: { 'x-forwarded-host': 'dsh.example,evil.example' },
    })
    expect(badHost.status).toBe(403)

    const unsupported = await request(composition, '/__invite/login', {
      method: 'POST',
      body: '{}',
      headers: {
        origin: PUBLIC_ORIGIN,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'dsh.example',
        'content-type': 'application/json',
      },
    })
    expect(unsupported.status).toBe(415)
    expect(unsupported.headers.get('connection')).toBe('close')

    const oversized = await login(composition, 'x'.repeat(256))
    expect(oversized.status).toBe(413)
    expect(oversized.headers.get('connection')).toBe('close')

    const missing = await login(composition, undefined, { next: '/sessions' })
    expect(missing.status).toBe(400)
    expect(missing.headers.get('connection')).not.toBe('close')

    const ambiguousMethod = await request(composition, '/__invite/check', {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'x-forwarded-method': 'GET,HEAD',
        'x-forwarded-uri': '/sessions',
      },
    })
    expect(ambiguousMethod.status).toBe(401)

    const ambiguousAddress = await login(composition, INVITE_CODE, {
      headers: { 'x-dsh-invite-client-ip': '203.0.113.10,203.0.113.11' },
    })
    expect(ambiguousAddress.status).toBe(400)
    expect(ambiguousAddress.headers.get('connection')).toBe('close')

    const headNavigation = await request(composition, '/__invite/check', {
      headers: {
        accept: 'text/html',
        'x-forwarded-method': 'HEAD',
        'x-forwarded-uri': '/sessions',
      },
    })
    expect(headNavigation.status).toBe(303)
    const noAccept = await request(composition, '/__invite/check')
    expect(noAccept.status).toBe(401)
  })

  it('rethrows unexpected handler failures to WebServer containment', { timeout: 60_000 }, async () => {
    const composition = await loadComposition()
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (new Error().stack?.includes('invite-auth/src/index.ts')) throw new Error('synthetic unexpected failure')
      return realNow()
    })
    try {
      const response = await login(composition, 'wrong-code-123')
      expect(response.status).toBe(400)
      expect(composition.logs).toContain('Error: synthetic unexpected failure')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('closes incomplete early responses before a second keep-alive request', { timeout: 60_000 }, async () => {
    const composition = await loadComposition()
    const accepted = await login(composition, INVITE_CODE)
    const cookie = requestCookie(accepted.headers.get('set-cookie')!)

    const cases: Array<{ requestLine: string; status: number; headers?: Readonly<Record<string, string>> }> = [
      { requestLine: 'GET /__invite/login', status: 200 },
      { requestLine: 'GET /__invite/login?next=%2Fsessions', status: 303, headers: { Cookie: cookie } },
      { requestLine: 'GET /__invite/check', status: 204, headers: { Cookie: cookie } },
      { requestLine: 'GET /__invite/check', status: 401 },
      {
        requestLine: 'GET /__invite/check',
        status: 303,
        headers: { Accept: 'text/html,application/xhtml+xml', 'X-Forwarded-Method': 'GET', 'X-Forwarded-Uri': '/sessions' },
      },
      {
        requestLine: 'POST /__invite/logout',
        status: 303,
        headers: { Origin: PUBLIC_ORIGIN, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'dsh.example' },
      },
      { requestLine: 'GET /__invite/unknown', status: 404 },
      { requestLine: 'DELETE /__invite/check', status: 405 },
    ]
    for (const testCase of cases) {
      expectClosedEarly(
        await incompleteKeepAlive(composition, testCase.requestLine, testCase.headers),
        testCase.status,
      )
    }

    const blockedAddress = '198.51.100.30'
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await login(composition, 'incorrect-code', { address: blockedAddress })).status).toBe(401)
    }
    const blocked = await incompleteKeepAlive(composition, 'POST /__invite/login', {
      Origin: PUBLIC_ORIGIN,
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'dsh.example',
      'X-DSH-Invite-Client-IP': blockedAddress,
      'Content-Type': 'application/x-www-form-urlencoded',
    })
    expectClosedEarly(blocked, 429)
  })

  it('limits failures per trusted forwarded address and accepts encoded candidates', { timeout: 60_000 }, async () => {
    const composition = await loadComposition({
      layers: [{
        source: 'process',
        values: {
          DSH_INVITE_CODE_SECRET: 'shared+code=123',
          DSH_INVITE_SESSION_SECRET: SESSION_SECRET,
        },
      }],
      config: { failureWindowSeconds: 60 },
    })
    const blockedAddress = '198.51.100.20'
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await login(composition, 'incorrect-code', { address: blockedAddress })).status).toBe(401)
    }
    const blocked = await login(composition, 'shared+code=123', { address: blockedAddress })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(blocked.headers.get('connection')).toBe('close')

    const independent = await login(composition, 'shared+code=123', { address: '198.51.100.21' })
    expect(independent.status).toBe(303)
  })

  it('rejects invalid secret sources and lengths without retaining the WebServer port', { timeout: 60_000 }, async () => {
    const cases: Array<{ layers: readonly LaunchEnvironmentLayerInput[]; error: RegExp }> = [
      { layers: [], error: /DSH_INVITE_CODE_SECRET.*12 characters/ },
      {
        layers: [{ source: 'project-env', path: 'C:/project/.env', values: PROCESS_SECRETS.values }],
        error: /DSH_INVITE_CODE_SECRET.*12 characters/,
      },
      {
        layers: [{ source: 'process', values: { ...PROCESS_SECRETS.values, DSH_INVITE_CODE_SECRET: 'short' } }],
        error: /DSH_INVITE_CODE_SECRET.*12 characters/,
      },
      {
        layers: [{ source: 'process', values: { ...PROCESS_SECRETS.values, DSH_INVITE_SESSION_SECRET: 'too-short' } }],
        error: /DSH_INVITE_SESSION_SECRET.*32 bytes/,
      },
    ]
    for (const testCase of cases) {
      const port = await unusedPort()
      await expect(loadComposition({ layers: testCase.layers, port })).rejects.toThrow(testCase.error)
      const replacement = createServer()
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject)
        replacement.listen(port, '127.0.0.1', resolve)
      })
      await new Promise<void>((resolve, reject) => replacement.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('keeps each file-only secret out of startup failures and logs', { timeout: 60_000 }, async () => {
    const projectInvite = 'project-invite-secret-value'
    const projectSession = 'project-session-secret-value-0123456789'
    const userInvite = 'user-invite-secret-value'
    const userSession = 'user-session-secret-value-0123456789'
    const cases: readonly LaunchEnvironmentLayerInput[][] = [
      [
        { source: 'process', values: { DSH_INVITE_SESSION_SECRET: SESSION_SECRET } },
        { source: 'project-env', path: 'C:/project/.env', values: { DSH_INVITE_CODE_SECRET: projectInvite } },
      ],
      [
        { source: 'process', values: { DSH_INVITE_CODE_SECRET: INVITE_CODE } },
        { source: 'project-env', path: 'C:/project/.env', values: { DSH_INVITE_SESSION_SECRET: projectSession } },
      ],
      [
        { source: 'process', values: { DSH_INVITE_SESSION_SECRET: SESSION_SECRET } },
        { source: 'user-env', path: 'C:/user/.dsh/.env', values: { DSH_INVITE_CODE_SECRET: userInvite } },
      ],
      [
        { source: 'process', values: { DSH_INVITE_CODE_SECRET: INVITE_CODE } },
        { source: 'user-env', path: 'C:/user/.dsh/.env', values: { DSH_INVITE_SESSION_SECRET: userSession } },
      ],
    ]
    for (const layers of cases) {
      let capturedError = ''
      let capturedLogs: readonly string[] = []
      await expect(loadComposition({
        layers,
        onFailure(error, logs) {
          capturedError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          capturedLogs = logs
        },
      })).rejects.toThrow(/inherited process environment variable/)
      for (const secret of [projectInvite, projectSession, userInvite, userSession]) {
        expect(capturedError).not.toContain(secret)
        expect(JSON.stringify(capturedLogs)).not.toContain(secret)
      }
    }
  })

  it('rejects unsafe environment references before resolving secrets', { timeout: 60_000 }, async () => {
    for (const [field, reference] of [
      ['inviteCodeEnv', 'INVITE_CODE'],
      ['inviteCodeEnv', 'dsh_invite_code'],
      ['inviteCodeEnv', 'DSH_INVITE-CODE'],
      ['sessionSecretEnv', 'SESSION_SECRET'],
    ] as const) {
      await expect(loadComposition({ config: { [field]: reference } })).rejects.toThrow(
        new RegExp(field),
      )
    }
  })

  it('rejects unsafe numeric configuration during activation', { timeout: 60_000 }, async () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1
    for (const [field, value, error] of [
      ['failureWindowSeconds', Number.MAX_SAFE_INTEGER, /failureWindowSeconds.*milliseconds.*safe integer/],
      ['maxFailuresPerWindow', unsafe, /maxFailuresPerWindow/],
      ['maxTrackedAddresses', Number.MAX_VALUE, /maxTrackedAddresses/],
    ] as const) {
      await expect(loadComposition({ config: { [field]: value } })).rejects.toThrow(error)
    }
  })

  it('keeps the fixed session lifetime valid across later requests', { timeout: 60_000 }, async () => {
    const maximumTtl = 31_536_000
    const composition = await loadComposition({ config: { sessionTtlSeconds: maximumTtl } })
    const realNow = Date.now
    const advancedNow = realNow() + 1_000
    vi.spyOn(Date, 'now').mockReturnValue(advancedNow)
    try {
      const accepted = await login(composition, INVITE_CODE)
      expect(accepted.status).toBe(303)
      const cookie = requestCookie(accepted.headers.get('set-cookie')!)
      const token = cookie.slice('__Host-dsh_invite='.length)
      expect(verifySessionToken(token, SESSION_SECRET, advancedNow)).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
    await expect(loadComposition({ config: { sessionTtlSeconds: maximumTtl + 1 } })).rejects.toThrow(
      /sessionTtlSeconds/,
    )
  })

  it('validates defaults and numeric policy limits', () => {
    expect(InviteAuth.name).toBe('invite-auth')
    expect(InviteAuth.inject).toEqual(['webServer'])
    expect(InviteAuth.Config({})).toEqual({
      inviteCodeEnv: 'DSH_INVITE_CODE_SECRET',
      sessionSecretEnv: 'DSH_INVITE_SESSION_SECRET',
      sessionTtlSeconds: 2_592_000,
      failureWindowSeconds: 900,
      maxFailuresPerWindow: 10,
      maxTrackedAddresses: 10_000,
      maxBodyBytes: 4_096,
    })
    for (const invalid of [
      { inviteCodeEnv: 'INVITE_CODE' },
      { sessionSecretEnv: 'dsh_session_secret' },
      { sessionTtlSeconds: 59 },
      { sessionTtlSeconds: 31_536_001 },
      { sessionTtlSeconds: 60.5 },
      { failureWindowSeconds: 0 },
      { failureWindowSeconds: Number.MAX_SAFE_INTEGER + 1 },
      { maxFailuresPerWindow: 0 },
      { maxFailuresPerWindow: Number.MAX_VALUE },
      { maxTrackedAddresses: 0 },
      { maxTrackedAddresses: Number.MAX_SAFE_INTEGER + 1 },
      { maxBodyBytes: 127 },
      { maxBodyBytes: 65_537 },
    ]) expect(() => InviteAuth.Config(invalid)).toThrow()
  })

  it('releases and restores the sole prefix route across plugin disposal', { timeout: 60_000 }, async () => {
    const composition = await loadComposition()
    const entry = [...composition.context.loader.entries()].find(candidate => candidate.options.id === 'invite-auth')
    expect(entry).toBeDefined()
    await entry!.fiber?.dispose()
    expect((await request(composition, '/__invite/login')).status).toBe(404)

    const replacement = composition.context.plugin(InviteAuth, {})
    await expect(replacement.await()).resolves.toBeDefined()
    expect((await request(composition, '/__invite/login')).status).toBe(200)
    await replacement.dispose()
    expect((await request(composition, '/__invite/login')).status).toBe(404)
  })

  it('registers and disposes the package invariant companion', async () => {
    const context = new Context()
    await context.plugin(InvariantRegistry, { enabled: true })
    const fiber = context.plugin(InviteAuthInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(context.plugin(InviteAuthInvariant).await()).resolves.toBeDefined()
    await context.fiber.dispose()
  })
})
