# DSH Invite Authentication and Alibaba Cloud Deployment Implementation Plan

English | [中文](2026-08-24-dsh-invite-auth-deployment.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in DSH invite-code authentication plugin, package a hardened Caddy/systemd deployment for Alibaba Cloud Ubuntu, and verify the production domain without committing Kimi or authentication secrets.

**Architecture:** A new Host plugin owns `/__invite/*`, stateless HMAC cookies, request validation, and bounded in-memory login throttling. The shipped Web bundle stays unchanged; the Alibaba Cloud systemd unit supplies an explicit Cordis overlay, while Caddy terminates TLS and uses `forward_auth` before proxying every other HTTP or WebSocket request.

**Tech Stack:** TypeScript 6, Cordis, node:http, node:crypto, Schemastery, Vitest, Playwright, Caddy 2, systemd, Bash, Node.js 24, pnpm 11.7.

**Design:** [Approved design](../specs/2026-08-24-dsh-invite-auth-deployment-design.md)

---

## File map

### New package

- `packages/host/invite-auth/package.json` — package publication, runtime peers, and test dependencies.
- `packages/host/invite-auth/tsconfig.json` — Host compiler references.
- `packages/host/invite-auth/src/token.ts` — constant-time invite comparison and stateless HMAC session tokens.
- `packages/host/invite-auth/src/policy.ts` — safe redirects, proxy/header trust, cookie parsing, and bounded failure tracking.
- `packages/host/invite-auth/src/http.ts` — bounded form parsing and HTTP response helpers.
- `packages/host/invite-auth/src/page.ts` — static Chinese login HTML and security headers.
- `packages/host/invite-auth/src/index.ts` — validated plugin config, launch-secret resolution, and route dispatch.
- `packages/host/invite-auth/src/invariant.ts` — package invariant registration with the lifecycle-test justification.
- `packages/host/invite-auth/tests/token.spec.ts` — cryptographic behavior.
- `packages/host/invite-auth/tests/policy.spec.ts` — request and limiter behavior.
- `packages/host/invite-auth/tests/http.spec.ts` — body bounds, media type, and page escaping.
- `packages/host/invite-auth/tests/invite-auth.spec.ts` — real Loader composition and HTTP lifecycle.
- `packages/host/invite-auth/README.md`, `README.zh.md`, `README.i18n.yaml` — package contract.

### Composition and browser coverage

- `deploy/alibaba-cloud/invite-auth.cordis.yml` — opt-in plugin row applied after the shipped Web bundles.
- `apps/web/tests/invite-auth.e2e.ts` — real Web composition login-page journey.
- `apps/web/tests/snapshots/invite-auth/login.expected.md` — product-visible ARIA golden.
- `apps/cli/package.json` — makes the overlay plugin resolvable from the shipped CLI installation.
- `apps/cli/tsconfig.json` — links the CLI compiler graph to the opt-in Host package.
- `scripts/verify-cordis-config.ts` — classifies the deployment overlay as app-resolved configuration.
- `tsconfig.host.json` — includes the new Host project.
- `scripts/verify-package-readme-model-experience.ts` — records that authentication changes no model request.
- `pnpm-lock.yaml` — workspace dependency graph after the new package is registered.

### Deployment assets and rationale

- `deploy/alibaba-cloud/Caddyfile` — HTTPS, public invite routes, forward auth, and DSH reverse proxy.
- `deploy/alibaba-cloud/mydsh.service` — low-privilege DSH runtime.
- `deploy/alibaba-cloud/caddy-mydsh.conf` — Caddy systemd drop-in for the public host only.
- `deploy/alibaba-cloud/bootstrap-host.sh` — installs Node/Caddy, creates users and private configuration, and installs units.
- `deploy/alibaba-cloud/package-release.sh` — self-checks against an exact reviewed ref, runs the digest-pinned Node 24 Linux build, verifies static provenance, and atomically publishes the artifact set.
- `deploy/alibaba-cloud/deploy-release.sh` — bounds and validates a prebuilt Linux artifact, rejects frozen control-plane drift, switches code atomically, and rolls back failed activation without running candidate code.
- `deploy/alibaba-cloud/README.md`, `README.zh.md`, `README.i18n.yaml` — initial deploy, upgrade, rollback, and secret retrieval procedure.
- `.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md`, `.zh.md`, `.i18n.yaml` — decision, rejected alternatives, and consequences.

## Task 1: Scaffold the package and implement cryptographic primitives

**Files:**

- Create: `packages/host/invite-auth/package.json`
- Create: `packages/host/invite-auth/tsconfig.json`
- Create: `packages/host/invite-auth/tests/token.spec.ts`
- Create: `packages/host/invite-auth/src/token.ts`
- Modify: `tsconfig.host.json:304`

- [ ] **Step 1: Write the failing token tests**

```ts ignore-check
import { describe, expect, it } from 'vitest'
import {
  inviteCodeMatches,
  issueSessionToken,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from '../src/token.ts'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('invite session token', () => {
  it('compares invite-code digests without a length branch', () => {
    expect(inviteCodeMatches('shared-code-123', 'shared-code-123')).toBe(true)
    expect(inviteCodeMatches('shared-code-124', 'shared-code-123')).toBe(false)
    expect(inviteCodeMatches('', 'shared-code-123')).toBe(false)
  })

  it('issues, expires, and rejects tampered or unknown tokens', () => {
    const token = issueSessionToken(SECRET, 60, 1_000, Buffer.alloc(16, 7))
    expect(SESSION_COOKIE_NAME).toBe('__Host-dsh_invite')
    expect(verifySessionToken(token, SECRET, 60_999)).toBe(true)
    expect(verifySessionToken(token, SECRET, 61_000)).toBe(false)
    expect(verifySessionToken(`${token}x`, SECRET, 1_000)).toBe(false)
    expect(verifySessionToken(token.replace(/^v1\./, 'v2.'), SECRET, 1_000)).toBe(false)
    expect(verifySessionToken('malformed', SECRET, 1_000)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the missing module fails**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/token.spec.ts`

Expected: FAIL because `../src/token.ts` does not exist.

- [ ] **Step 3: Create the manifest, compiler project, and token implementation**

Use the current root version in `package.json`, declare `@deepseek-ai/cordis`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-launch-environment`, and `@deepseek-ai/dsh-invariants` as `workspace:^` peers plus dev dependencies, put `@deepseek-ai/schemastery` in dependencies, and add Loader/Include only as dev dependencies. Publish `.` and `./invariant`, with exactly `lib/index.js`, `lib/invariant.js`, and `lib/types/**/*.d.ts` in `files`.

```ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = '__Host-dsh_invite'
const TOKEN_VERSION = 'v1'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function inviteCodeMatches(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected))
}

export function issueSessionToken(
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
  nonce: Uint8Array = randomBytes(16),
): string {
  const expires = Math.floor(nowMs / 1_000) + ttlSeconds
  const payload = `${TOKEN_VERSION}.${String(expires)}.${Buffer.from(nonce).toString('base64url')}`
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifySessionToken(token: string | undefined, secret: string, nowMs = Date.now()): boolean {
  if (token === undefined) return false
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false
  const expires = Number(parts[1])
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(nowMs / 1_000)) return false
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]!) || !/^[A-Za-z0-9_-]+$/.test(parts[3]!)) return false
  const payload = parts.slice(0, 3).join('.')
  const expected = createHmac('sha256', secret).update(payload).digest()
  const supplied = Buffer.from(parts[3]!, 'base64url')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
```

Add `{ "path": "./packages/host/invite-auth" }` beside the other Host packages in `tsconfig.host.json`.

- [ ] **Step 4: Run focused tests and the package compiler**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/token.spec.ts`

Expected: PASS, 2 tests.

Run: `corepack pnpm exec tsc -b packages/host/invite-auth`

Expected: PASS with no diagnostics.

- [ ] **Step 5: Commit the cryptographic unit**

```bash
git add packages/host/invite-auth/package.json packages/host/invite-auth/tsconfig.json packages/host/invite-auth/src/token.ts packages/host/invite-auth/tests/token.spec.ts tsconfig.host.json
git commit -m "feat(invite-auth): add signed session tokens"
```

## Task 2: Implement redirect, proxy trust, cookie, and rate-limit policy

**Files:**

- Create: `packages/host/invite-auth/tests/policy.spec.ts`
- Create: `packages/host/invite-auth/src/policy.ts`

- [ ] **Step 1: Write failing policy tests**

```ts ignore-check
import { describe, expect, it } from 'vitest'
import {
  FailureLimiter,
  cookieValue,
  safeNextPath,
  trustedClientAddress,
  validForwardedOrigin,
} from '../src/policy.ts'

describe('invite request policy', () => {
  it.each([
    ['/sessions?id=1', '/sessions?id=1'],
    ['https://evil.example/', '/'],
    ['//evil.example/', '/'],
    ['/\\evil', '/'],
    ['', '/'],
  ])('sanitizes next=%s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected)
  })

  it('accepts one cookie value and rejects duplicates', () => {
    expect(cookieValue('a=1; __Host-dsh_invite=token; b=2', '__Host-dsh_invite')).toBe('token')
    expect(cookieValue('__Host-dsh_invite=a; __Host-dsh_invite=b', '__Host-dsh_invite')).toBeUndefined()
  })

  it('trusts the Caddy client header only from loopback', () => {
    expect(trustedClientAddress('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9')
    expect(trustedClientAddress('198.51.100.2', '203.0.113.9')).toBe('198.51.100.2')
    expect(trustedClientAddress('::1', 'not-an-ip')).toBe('::1')
  })

  it('requires an HTTPS origin matching the forwarded host', () => {
    expect(validForwardedOrigin('https://dsh.example.com', 'https', 'dsh.example.com')).toBe(true)
    expect(validForwardedOrigin('http://dsh.example.com', 'https', 'dsh.example.com')).toBe(false)
    expect(validForwardedOrigin('https://evil.example', 'https', 'dsh.example.com')).toBe(false)
  })

  it('allows ten failures, blocks the next attempt, expires, clears, and bounds entries', () => {
    const limiter = new FailureLimiter({ windowMs: 900_000, maxFailures: 10, maxEntries: 2 })
    for (let index = 0; index < 10; index++) limiter.recordFailure('a', 0)
    expect(limiter.retryAfterSeconds('a', 1)).toBe(900)
    limiter.clear('a')
    expect(limiter.retryAfterSeconds('a', 1)).toBeUndefined()
    limiter.recordFailure('a', 0)
    limiter.recordFailure('b', 0)
    limiter.recordFailure('c', 0)
    expect(limiter.size).toBe(2)
    expect(limiter.retryAfterSeconds('c', 900_001)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/policy.spec.ts`

Expected: FAIL because `../src/policy.ts` does not exist.

- [ ] **Step 3: Implement the exact policy API**

```ts
import { isIP } from 'node:net'

export function safeNextPath(raw: string | null | undefined): string {
  if (raw === undefined || raw === null || raw === '' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  try {
    const parsed = new URL(raw, 'https://dsh.invalid')
    return parsed.origin === 'https://dsh.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/'
  } catch {
    return '/'
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (values.length !== 1) return undefined
  return values[0]!.slice(name.length + 1)
}

function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function trustedClientAddress(peer: string | undefined, forwarded: string | undefined): string {
  if (loopback(peer) && forwarded !== undefined && isIP(forwarded) !== 0) return forwarded
  return peer ?? 'unknown'
}

export function validForwardedOrigin(origin: string | undefined, proto: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || proto !== 'https' || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return parsed.protocol === 'https:' && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

interface FailureLimiterConfig { windowMs: number; maxFailures: number; maxEntries: number }
interface Bucket { startedAt: number; failures: number }

export class FailureLimiter {
  private readonly buckets = new Map<string, Bucket>()
  constructor(private readonly config: FailureLimiterConfig) {}
  get size(): number { return this.buckets.size }
  retryAfterSeconds(address: string, nowMs: number): number | undefined {
    const bucket = this.current(address, nowMs)
    if (bucket === undefined || bucket.failures < this.config.maxFailures) return undefined
    return Math.max(1, Math.ceil((bucket.startedAt + this.config.windowMs - nowMs) / 1_000))
  }
  recordFailure(address: string, nowMs: number): void {
    const bucket = this.current(address, nowMs)
    if (bucket !== undefined) { bucket.failures += 1; return }
    this.makeRoom(nowMs)
    this.buckets.set(address, { startedAt: nowMs, failures: 1 })
  }
  clear(address: string): void { this.buckets.delete(address) }
  private current(address: string, nowMs: number): Bucket | undefined {
    const bucket = this.buckets.get(address)
    if (bucket !== undefined && nowMs - bucket.startedAt >= this.config.windowMs) {
      this.buckets.delete(address)
      return undefined
    }
    return bucket
  }
  private makeRoom(nowMs: number): void {
    if (this.buckets.size < this.config.maxEntries) return
    for (const [address, bucket] of this.buckets) {
      if (nowMs - bucket.startedAt >= this.config.windowMs) this.buckets.delete(address)
    }
    if (this.buckets.size < this.config.maxEntries) return
    const oldest = this.buckets.keys().next().value as string | undefined
    if (oldest !== undefined) this.buckets.delete(oldest)
  }
}
```

- [ ] **Step 4: Run the policy tests**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/policy.spec.ts`

Expected: PASS, 5 tests including every table row.

- [ ] **Step 5: Commit the policy unit**

```bash
git add packages/host/invite-auth/src/policy.ts packages/host/invite-auth/tests/policy.spec.ts
git commit -m "feat(invite-auth): add request security policy"
```

## Task 3: Implement bounded HTTP parsing and the login page

**Files:**

- Create: `packages/host/invite-auth/tests/http.spec.ts`
- Create: `packages/host/invite-auth/src/http.ts`
- Create: `packages/host/invite-auth/src/page.ts`

- [ ] **Step 1: Write failing parser and renderer tests**

The tests must construct a `Readable` request double and a minimal `ServerResponse` recorder, then assert all of these exact results:

```ts ignore-check
expect((await readUrlEncodedForm(formRequest('inviteCode=abc'), 4096)).get('inviteCode')).toBe('abc')
await expect(readUrlEncodedForm(formRequest('x'.repeat(4097)), 4096)).rejects.toMatchObject({ status: 413 })
await expect(readUrlEncodedForm(formRequest('{}', 'application/json'), 4096)).rejects.toMatchObject({ status: 415 })
expect(renderLoginPage('/safe?x=1', true)).toContain('role="alert"')
expect(renderLoginPage('/&quot;', false)).not.toContain('value="/&quot;"')
expect(securityHeaders()).toMatchObject({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/http.spec.ts`

Expected: FAIL because `http.ts` and `page.ts` do not exist.

- [ ] **Step 3: Implement bounded parsing and response helpers**

`http.ts` must export `HttpError`, `readUrlEncodedForm`, `redirect`, `writeEmpty`, and `writeHtml`; `page.ts` exports `securityHeaders`. `readUrlEncodedForm` accepts only `application/x-www-form-urlencoded`, counts bytes rather than JavaScript characters, throws `413` as soon as the configured bound is exceeded, and sets `Connection: close` on that response path.

```ts ignore-check
import type { IncomingMessage, ServerResponse } from 'node:http'
import { securityHeaders } from './page.ts'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export async function readUrlEncodedForm(req: IncomingMessage, maxBytes: number): Promise<URLSearchParams> {
  const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'unsupported media type')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += chunk.length
    if (bytes > maxBytes) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export function writeEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...securityHeaders(), ...headers })
  res.end()
}

export function writeHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  writeEmpty(res, 303, { location, ...headers })
}
```

`page.ts` must render one responsive Chinese form with heading `访问 DSH`, label `邀请码`, submit label `进入`, `autocomplete="current-password"`, no scripts, and escaped `next`. Use only inline CSS allowed by the page CSP; never interpolate the invite code or token.

```ts
const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

export function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

export function renderLoginPage(next: string, invalid: boolean): string {
  const alert = invalid ? '<p role="alert">邀请码无效，请重试。</p>' : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问 DSH</title><style>html{color-scheme:light dark}body{font:16px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#eef2ff}.card{width:min(28rem,calc(100% - 2rem));padding:2rem;border:1px solid #334155;border-radius:1rem;background:#111827}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{margin-top:.5rem;padding:.8rem;border-radius:.6rem;border:1px solid #475569}button{margin-top:1rem;background:#2563eb;color:white;font-weight:700}p{color:#fca5a5}</style></head><body><main class="card"><h1>访问 DSH</h1><p>请输入共享邀请码后继续。</p>${alert}<form method="post" action="/__invite/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label for="inviteCode">邀请码</label><input id="inviteCode" name="inviteCode" type="password" autocomplete="current-password" required autofocus><button type="submit">进入</button></form></main></body></html>`
}
```

- [ ] **Step 4: Run the HTTP tests**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/http.spec.ts`

Expected: PASS with parser, escaping, and header assertions.

- [ ] **Step 5: Commit the HTTP/page unit**

```bash
git add packages/host/invite-auth/src/http.ts packages/host/invite-auth/src/page.ts packages/host/invite-auth/tests/http.spec.ts
git commit -m "feat(invite-auth): add hardened login page"
```

## Task 4: Assemble the Cordis plugin through the real Web server

**Files:**

- Create: `packages/host/invite-auth/src/index.ts`
- Create: `packages/host/invite-auth/src/invariant.ts`
- Create: `packages/host/invite-auth/tests/invite-auth.spec.ts`

- [ ] **Step 1: Write a failing real-Loader composition test**

Create a temporary `cordis.yml` containing `dsh-host-webserver` on port `0` and `dsh-host-invite-auth`. Before Loader boot, provide a launch snapshot whose `process` layer contains `DSH_INVITE_CODE_SECRET=shared-code-123` and a 32-byte `DSH_INVITE_SESSION_SECRET`. Route all HTTP calls through the bound port and assert:

```ts ignore-check
expect(await request('/__invite/login?next=%2Fsessions')).toMatchObject({ status: 200 })
expect(await request('/__invite/check', { headers: { accept: 'application/json' } })).toMatchObject({ status: 401 })
expect(await login('wrong-code-123')).toMatchObject({ status: 401 })
const accepted = await login('shared-code-123')
expect(accepted.status).toBe(303)
expect(accepted.headers.get('set-cookie')).toMatch(/^__Host-dsh_invite=.*Secure; HttpOnly; SameSite=Lax/)
expect(await checkWithCookie(accepted.headers.get('set-cookie')!)).toMatchObject({ status: 204 })
expect(await logoutWithCookie(accepted.headers.get('set-cookie')!)).toMatchObject({ status: 303 })
```

Also prove startup rejection for a missing secret, a project-`.env`-only secret, an invite code shorter than 12 characters, and a session secret shorter than 32 bytes. After ten incorrect attempts from one forwarded address, assert that the next attempt is `429` with `Retry-After`; use a second address to prove independent buckets. Dispose the invite-auth Loader entry and assert `/__invite/login` returns the unclaimed Web server `404`.

- [ ] **Step 2: Run the composition test and verify it fails**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests/invite-auth.spec.ts`

Expected: FAIL because `src/index.ts` is missing.

- [ ] **Step 3: Implement validated config and launch-secret resolution**

Export the standard function-plugin namespace only: `name`, `inject`, `Config`, and `apply`; do not add a default export. `inject` is `['webServer']`. Define these fields and defaults, then project them through one explicit `resolveConfig(config)` function:

```ts
import z from '@deepseek-ai/schemastery'

export interface Config {
  inviteCodeEnv?: string
  sessionSecretEnv?: string
  sessionTtlSeconds?: number
  failureWindowSeconds?: number
  maxFailuresPerWindow?: number
  maxTrackedAddresses?: number
  maxBodyBytes?: number
}

export const Config: z<Config> = z.object({
  inviteCodeEnv: z.string().default('DSH_INVITE_CODE_SECRET'),
  sessionSecretEnv: z.string().default('DSH_INVITE_SESSION_SECRET'),
  sessionTtlSeconds: z.number().step(1).min(60).default(2_592_000),
  failureWindowSeconds: z.number().step(1).min(1).default(900),
  maxFailuresPerWindow: z.number().step(1).min(1).default(10),
  maxTrackedAddresses: z.number().step(1).min(1).default(10_000),
  maxBodyBytes: z.number().step(1).min(128).max(65_536).default(4_096),
})
```

Resolve both secrets with `launchEnvironmentOf(ctx).getFrom(name, ['process'])`. Validate the invite with `Array.from(value).length >= 12` and the signing secret with `Buffer.byteLength(value, 'utf8') >= 32`. Errors name only the environment variable and correction, never its value.

- [ ] **Step 4: Implement one prefix route and complete method dispatch**

Register one `prefix` route at `/__invite` through `ctx.effect()`. Dispatch only the four designed paths, return `404` for other paths, and return `405` plus `Allow` for wrong methods. Use `X-DSH-Invite-Client-IP` only through `trustedClientAddress(req.socket.remoteAddress, headerValue)`.

The login POST must check `validForwardedOrigin` before reading the form, enforce the limiter before comparing the code, issue `__Host-dsh_invite` with `Path=/; Max-Age=${resolved.sessionTtlSeconds}; Secure; HttpOnly; SameSite=Lax`, and redirect only through `safeNextPath`. The check route returns `204` for a valid cookie; otherwise it redirects only an original `GET`/`HEAD` navigation accepting HTML, using Caddy's `X-Forwarded-Method` and `X-Forwarded-Uri`, and returns `401` for all other callers. Logout requires the same origin check and expires the cookie.

Catch only `HttpError` inside the route so its exact status reaches the client; let unexpected errors reach `dsh-host-webserver`'s request containment and logger.

The completed dispatcher follows this structure; helper functions may be private but their names and decisions must remain equivalent:

```ts ignore-check
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

function resolveConfig(config: Config): ResolvedConfig {
  return {
    inviteCodeEnv: config.inviteCodeEnv ?? 'DSH_INVITE_CODE_SECRET',
    sessionSecretEnv: config.sessionSecretEnv ?? 'DSH_INVITE_SESSION_SECRET',
    sessionTtlSeconds: config.sessionTtlSeconds ?? 2_592_000,
    failureWindowSeconds: config.failureWindowSeconds ?? 900,
    maxFailuresPerWindow: config.maxFailuresPerWindow ?? 10,
    maxTrackedAddresses: config.maxTrackedAddresses ?? 10_000,
    maxBodyBytes: config.maxBodyBytes ?? 4_096,
  }
}

function oneHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' && !value.includes(',') ? value : undefined
}

function requiredSecret(
  value: string | undefined,
  name: string,
  minimum: number,
  unit: 'characters' | 'bytes',
): string {
  const length = value === undefined ? 0 : unit === 'bytes' ? Buffer.byteLength(value, 'utf8') : Array.from(value).length
  if (value === undefined || length < minimum) {
    throw new Error(`invite-auth: inherited process environment variable ${name} must contain at least ${String(minimum)} ${unit}`)
  }
  return value
}

function validSession(req: IncomingMessage, secret: string): boolean {
  return verifySessionToken(cookieValue(req.headers.cookie, SESSION_COOKIE_NAME), secret)
}

function setCookie(token: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${String(ttlSeconds)}; Secure; HttpOnly; SameSite=Lax`
}

function clearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`
}

async function dispatch(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://invite-auth.invalid')
  if (url.pathname === '/__invite/login' && req.method === 'GET') {
    const next = safeNextPath(url.searchParams.get('next'))
    if (validSession(req, runtime.sessionSecret)) { redirect(res, next); return }
    writeHtml(res, 200, renderLoginPage(next, false)); return
  }
  if (url.pathname === '/__invite/login' && req.method === 'POST') {
    const origin = oneHeader(req, 'origin')
    const proto = oneHeader(req, 'x-forwarded-proto')
    const host = oneHeader(req, 'x-forwarded-host') ?? req.headers.host
    if (!validForwardedOrigin(origin, proto, host)) throw new HttpError(403, 'origin rejected')
    const address = trustedClientAddress(req.socket.remoteAddress, oneHeader(req, 'x-dsh-invite-client-ip'))
    const retry = runtime.limiter.retryAfterSeconds(address, Date.now())
    if (retry !== undefined) { writeEmpty(res, 429, { 'retry-after': String(retry) }); return }
    const form = await readUrlEncodedForm(req, runtime.config.maxBodyBytes)
    const next = safeNextPath(form.get('next'))
    const candidate = form.get('inviteCode')
    if (candidate === null) throw new HttpError(400, 'missing inviteCode')
    if (!inviteCodeMatches(candidate, runtime.inviteCode)) {
      runtime.limiter.recordFailure(address, Date.now())
      writeHtml(res, 401, renderLoginPage(next, true)); return
    }
    runtime.limiter.clear(address)
    const token = issueSessionToken(runtime.sessionSecret, runtime.config.sessionTtlSeconds)
    redirect(res, next, { 'set-cookie': setCookie(token, runtime.config.sessionTtlSeconds) }); return
  }
  if (url.pathname === '/__invite/check' && req.method === 'GET') {
    if (validSession(req, runtime.sessionSecret)) { writeEmpty(res, 204); return }
    const method = oneHeader(req, 'x-forwarded-method') ?? 'GET'
    const accept = oneHeader(req, 'accept') ?? ''
    if ((method === 'GET' || method === 'HEAD') && accept.includes('text/html')) {
      const next = safeNextPath(oneHeader(req, 'x-forwarded-uri'))
      redirect(res, `/__invite/login?next=${encodeURIComponent(next)}`); return
    }
    writeEmpty(res, 401); return
  }
  if (url.pathname === '/__invite/logout' && req.method === 'POST') {
    const origin = oneHeader(req, 'origin')
    const proto = oneHeader(req, 'x-forwarded-proto')
    const host = oneHeader(req, 'x-forwarded-host') ?? req.headers.host
    if (!validForwardedOrigin(origin, proto, host)) throw new HttpError(403, 'origin rejected')
    redirect(res, '/__invite/login', { 'set-cookie': clearCookie() }); return
  }
  if (url.pathname === '/__invite/login') { writeEmpty(res, 405, { allow: 'GET, POST' }); return }
  if (url.pathname === '/__invite/check') { writeEmpty(res, 405, { allow: 'GET' }); return }
  if (url.pathname === '/__invite/logout') { writeEmpty(res, 405, { allow: 'POST' }); return }
  writeEmpty(res, 404)
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const environment = launchEnvironmentOf(ctx)
  const inviteCode = requiredSecret(environment.getFrom(resolved.inviteCodeEnv, ['process'])?.value, resolved.inviteCodeEnv, 12, 'characters')
  const sessionSecret = requiredSecret(environment.getFrom(resolved.sessionSecretEnv, ['process'])?.value, resolved.sessionSecretEnv, 32, 'bytes')
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
      try { await dispatch(req, res, runtime) }
      catch (error) {
        if (!(error instanceof HttpError)) throw error
        writeEmpty(res, error.status, error.status === 413 ? { connection: 'close' } : undefined)
      }
    },
  }), 'invite-auth: HTTP routes')
}
```

- [ ] **Step 5: Add the invariant companion**

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-invite-auth'
export const name = 'host-invite-auth-invariant'
export const inject = ['invariants']

/** No runtime invariant: request authorization is derived from each signed cookie and the route registration has no durable or cross-event state; real-composition tests own route disposal and limiter lifecycle. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
```

- [ ] **Step 6: Run tests and coverage for every source file**

Run: `corepack pnpm exec vitest run packages/host/invite-auth/tests`

Expected: PASS.

Run: `corepack pnpm exec vitest run --coverage --coverage.include="packages/host/invite-auth/src/**/*.ts" packages/host/invite-auth/tests`

Expected: PASS with 100% statements, branches, functions, and lines for every `packages/host/invite-auth/src/*.ts` file.

- [ ] **Step 7: Commit the assembled plugin**

```bash
git add packages/host/invite-auth/src/index.ts packages/host/invite-auth/src/invariant.ts packages/host/invite-auth/tests/invite-auth.spec.ts
git commit -m "feat(invite-auth): protect DSH web access"
```

## Task 5: Wire the opt-in deployment overlay without changing Web defaults

**Files:**

- Create: `deploy/alibaba-cloud/invite-auth.cordis.yml`
- Modify: `apps/cli/package.json:55-105`
- Modify: `apps/cli/tsconfig.json:20-50`
- Modify: `scripts/verify-cordis-config.ts:28-37`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the deployment overlay**

```yaml
- insert:
    - id: invite-auth
      name: '@deepseek-ai/dsh-host-invite-auth'
      config:
        inviteCodeEnv: DSH_INVITE_CODE_SECRET
        sessionSecretEnv: DSH_INVITE_SESSION_SECRET
        sessionTtlSeconds: 2592000
        failureWindowSeconds: 900
        maxFailuresPerWindow: 10
        maxTrackedAddresses: 10000
        maxBodyBytes: 4096
```

- [ ] **Step 2: Make overlay resolution mechanically checkable**

Add `deploy/alibaba-cloud/invite-auth.cordis.yml` to `appOverlayFiles`, add `@deepseek-ai/dsh-host-invite-auth: workspace:^` to `apps/cli/package.json` dependencies, add `../../packages/host/invite-auth` beside the other Host references in `apps/cli/tsconfig.json`, and run `corepack pnpm install --lockfile-only` to update the lockfile. Do not modify `packages/bundle/web-app/cordis.patch.yml`.

- [ ] **Step 3: Verify config discovery, dependency resolution, and unchanged defaults**

Run: `corepack pnpm run verify-cordis-config`

Expected: PASS and the config-file count increases by one.

Run: `corepack pnpm dsh web --dump-default-config`

Expected: PASS; output does not contain `invite-auth`.

Run with an isolated temporary `DSH_HOME`: `corepack pnpm dsh web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config`

Expected: PASS; output contains exactly one `invite-auth` row and contains only environment-variable names, never secret values.

- [ ] **Step 4: Commit opt-in composition**

```bash
git add deploy/alibaba-cloud/invite-auth.cordis.yml apps/cli/package.json apps/cli/tsconfig.json scripts/verify-cordis-config.ts pnpm-lock.yaml
git commit -m "feat(invite-auth): add deployment overlay"
```

## Task 6: Document the package decision and public contract

**Files:**

- Create: `packages/host/invite-auth/README.md`
- Create: `packages/host/invite-auth/README.zh.md`
- Create: `packages/host/invite-auth/README.i18n.yaml`
- Create: `.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md`
- Create: `.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.i18n.yaml`
- Modify: `scripts/verify-package-readme-model-experience.ts:113`

- [ ] **Step 1: Write the package README pair**

Document config defaults, inherited-process-only secret lookup, all four routes, exact status codes, cookie rotation semantics, Caddy's required role, in-memory limiter reset, and the absence of multi-user isolation. End with:

```markdown
## Model Experience

None, as the authentication plugin handles browser HTTP requests and never changes prompts, messages, tool schemas, model streams, or tool results.

#### KV Cache effect

None; the plugin never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **A reverse proxy must enforce the check** — the plugin owns authentication routes but does not intercept unrelated Web server routes; exposing port 3080 bypasses authentication.
- **Rate limits are process-local** — a restart clears buckets and multiple DSH processes do not share counters; the deployment runs exactly one DSH process.
```

Add the package to `SENTENCE_MODEL_EXPERIENCE` with `kind: 'none'` and the same reason.

- [ ] **Step 2: Write the implemented Agent Note pair**

Use the mandatory headings `## Problem`, `## Decision`, `## Alternatives considered`, and `## Consequences`. Record the chosen native plugin plus Caddy forward-auth design, and reject a standalone auth process, Caddy Basic Auth, and changing `dsh-host-webserver` into a middleware stack. State in present tense that the shipped Web bundle remains unauthenticated by default and the deployment overlay opts in.

- [ ] **Step 3: Record and validate both bilingual pairs**

```bash
corepack pnpm run verify-translation-pairing --write packages/host/invite-auth/README.md
corepack pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md
corepack pnpm run verify-translation-pairing packages/host/invite-auth/README.md .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md
corepack pnpm run verify-agent-note-format
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
```

Expected: every command passes.

- [ ] **Step 4: Commit documentation and rationale**

```bash
git add packages/host/invite-auth/README.md packages/host/invite-auth/README.zh.md packages/host/invite-auth/README.i18n.yaml .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.zh.md .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.i18n.yaml scripts/verify-package-readme-model-experience.ts
git commit -m "docs(invite-auth): define authentication contract"
```

## Task 7: Add the real browser snapshot

**Files:**

- Create: `apps/web/tests/invite-auth.e2e.ts`
- Create: `apps/web/tests/snapshots/invite-auth/login.expected.md`

- [ ] **Step 1: Write the failing Web scenario**

Use `launchWebScaffold({ extraOverlayPath: DEPLOYMENT_OVERLAY })`. Set `DSH_INVITE_CODE_SECRET` and `DSH_INVITE_SESSION_SECRET` only for scaffold boot, restore both immediately after the launch snapshot is captured, then open `/__invite/login?next=%2Fsessions` in a Chinese-locale Chromium page.

```ts ignore-check
expect(await page.getByRole('heading', { name: '访问 DSH' }).count()).toBe(1)
expect(await page.getByLabel('邀请码', { exact: true }).getAttribute('type')).toBe('password')
expect(await page.getByRole('button', { name: '进入', exact: true }).count()).toBe(1)
const aria = await captureStableAria(page, 'body', scaffold.workspaceCwd)
await compareOrRefreshGolden(LOGIN_EXPECTED, aria, MODE)
expect((await page.content()).includes(INVITE_CODE)).toBe(false)
expect((await page.content()).includes(SESSION_SECRET)).toBe(false)
```

Add an inventory assertion allowing only `login.expected.md`. The scenario must not submit the form because TLS and `forward_auth` belong to Caddy; the package's real-Loader HTTP test already owns successful POST and Cookie behavior.

- [ ] **Step 2: Build and run replay to observe the missing golden**

Run: `corepack pnpm run build`

Run in PowerShell:

```powershell
$env:DSH_SNAPSHOT='replay'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
Remove-Item Env:DSH_SNAPSHOT
```

Expected: FAIL because `login.expected.md` is absent.

- [ ] **Step 3: Refresh, review, and replay the golden**

```powershell
$env:DSH_SNAPSHOT='refresh'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
$env:DSH_SNAPSHOT='replay'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
Remove-Item Env:DSH_SNAPSHOT
```

Expected: refresh writes one ARIA snapshot; replay passes. Review the golden and confirm it contains the heading, password textbox, explanatory text, and Enter button but no secret.

- [ ] **Step 4: Commit browser evidence**

```bash
git add apps/web/tests/invite-auth.e2e.ts apps/web/tests/snapshots/invite-auth/login.expected.md
git commit -m "test(invite-auth): snapshot the login page"
```

## Task 8: Add hardened Ubuntu deployment assets

**Files:**

- Create: `deploy/alibaba-cloud/Caddyfile`
- Create: `deploy/alibaba-cloud/mydsh.service`
- Create: `deploy/alibaba-cloud/caddy-mydsh.conf`
- Create: `deploy/alibaba-cloud/bootstrap-host.sh`
- Create: `deploy/alibaba-cloud/package-release.sh`
- Create: `deploy/alibaba-cloud/deploy-release.sh`
- Create: `deploy/alibaba-cloud/README.md`
- Create: `deploy/alibaba-cloud/README.zh.md`
- Create: `deploy/alibaba-cloud/README.i18n.yaml`

- [ ] **Step 1: Write the Caddy and systemd definitions**

```caddyfile
{$DSH_PUBLIC_HOST} {
  header Strict-Transport-Security "max-age=15552000"

  @invite path /__invite /__invite/*
  handle @invite {
    reverse_proxy 127.0.0.1:3080 {
      header_up X-DSH-Invite-Client-IP {remote_host}
      header_up X-Forwarded-Proto {scheme}
      header_up X-Forwarded-Host {host}
    }
  }

  handle {
    forward_auth 127.0.0.1:3080 {
      uri /__invite/check
      header_up X-DSH-Invite-Client-IP {remote_host}
      header_up X-Forwarded-Proto {scheme}
      header_up X-Forwarded-Host {host}
    }
    reverse_proxy 127.0.0.1:3080
  }
}
```

`mydsh.service` must use `User=mydsh`, `WorkingDirectory=/srv/mydsh/workspace`, both environment files, the exact overlay command from the design, `Restart=on-failure`, `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, and `ReadWritePaths=/var/lib/mydsh /srv/mydsh/workspace`. Do not add a syscall filter that would block agent tools. `caddy-mydsh.conf` supplies only `EnvironmentFile=/etc/mydsh/public.env` to Caddy.

```ini
[Unit]
Description=DeepSeek Harness with invite authentication
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=mydsh
Group=mydsh
WorkingDirectory=/srv/mydsh/workspace
Environment=NODE_ENV=production
EnvironmentFile=/etc/mydsh/public.env
EnvironmentFile=/etc/mydsh/mydsh.env
ExecStart=/usr/bin/node /opt/mydsh/current/apps/cli/lib/bin.js web --patch /opt/mydsh/current/deploy/alibaba-cloud/invite-auth.cordis.yml --no-open --trusted-host ${DSH_PUBLIC_HOST}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mydsh /srv/mydsh/workspace

[Install]
WantedBy=multi-user.target
```

```ini
[Service]
EnvironmentFile=/etc/mydsh/public.env
```

- [ ] **Step 2: Implement idempotent host bootstrap**

`bootstrap-host.sh` accepts exactly one lowercase DNS hostname, refuses non-root execution, and checks `dpkg --print-architecture` is exactly `amd64` before locking, filesystem mutation, or network access. It installs the NodeSource Node 24 runtime and official Caddy stable apt repository, creates the non-login `mydsh` runtime user and owned data directories, writes `/etc/mydsh/public.env`, and creates `/etc/mydsh/mydsh.env` only when absent. It installs no Git, builder account, pnpm, source checkout, or build cache. Once a release exists, only a byte-identical no-op is allowed; control-plane or hostname changes require separate maintenance.

Install the unit files and Caddyfile, run `systemctl daemon-reload`, validate Caddy with the public environment loaded, enable Caddy, and leave `mydsh.service` disabled until a release exists. Trap and remove only temporary files created by this run.

The owning implementation is `deploy/alibaba-cloud/bootstrap-host.sh`; keep this plan at the required behavior level so repository-key verification, managed-path defenses, temp cleanup, and initialization-only policy cannot drift into a second executable recipe.

- [ ] **Step 3: Implement immutable release activation and rollback**

`package-release.sh` accepts a named reviewed Git ref and output directory, verifies that the running script came from that ref, and creates a trusted Git extraction before Docker starts. It pins the exact Node 24 Bookworm image digest and pnpm 11.7.0 integrity, bounds CPU, memory, process count, and elapsed time, and runs frozen install, invite-auth tests, build, and config dump with fresh state; network and disk use remain unbounded. Docker mounts only the private source copy, never the caller output directory. After it exits, the host rejects any unit, Caddyfile, drop-in, or overlay mutation, creates the manifest and SHA-256 sidecar, and publishes the complete artifact-set directory with one atomic rename to `$OUTPUT_DIR/mydsh-release-$commit/`.

`deploy-release.sh` accepts only the atomic commit-named artifact-set directory and requires exactly its archive and sidecar. Under the shared lock it reserves the compressed cap plus fixed upload margin before copying either file, copies both into persistent root-private new inodes, verifies SHA-256, enforces the documented compressed, member-count, per-member, expanded-size, and free-space caps, rejects unsafe archive entries, and validates the manifest, image digest, helper-journal compatibility, built CLI, dependencies, and overlay. Its pure-Bash ref validator accepts the ordinary subset emitted by the packager without installing or running Git on production. Candidate copies of the systemd unit, Caddyfile, and drop-in must be byte-identical to the installed managed control plane. The helper publishes and activates code only; it never runs candidate commands or updates the stable helper, unit, or Caddy files.

The owning implementation is `deploy/alibaba-cloud/deploy-release.sh`; it serializes deployment, rollback, recovery, and pruning, journals the previous link and enablement before mutation, switches the symlink atomically, verifies the runtime identity, loopback listener, public denial, and authenticated access, and durably commits or restores the previous code state. Normal release activation never reloads the frozen Caddy or systemd configuration. Never delete old releases automatically or print either secret.

- [ ] **Step 4: Write the bilingual deployment tutorial**

Document prerequisites, local Docker packaging, DNS, security-group ports 22/80/443, initialization-only bootstrap, atomic artifact-set upload, release deployment, retrieving the invite code directly over SSH, Kimi setup through Settings → Models, artifact-set-only upgrades, rollback, stable-helper maintenance limits, secret rotation, journald diagnosis, and all acceptance commands. Link the official NodeSource Node 24 and Caddy package instructions.

- [ ] **Step 5: Validate scripts and record the README pair**

Run on a Linux shell: `bash -n deploy/alibaba-cloud/bootstrap-host.sh deploy/alibaba-cloud/package-release.sh deploy/alibaba-cloud/deploy-release.sh`

Run with `DSH_PUBLIC_HOST=dsh.example.com`: `caddy validate --config deploy/alibaba-cloud/Caddyfile --adapter caddyfile`

Run: `corepack pnpm run verify-translation-pairing --write deploy/alibaba-cloud/README.md`

Expected: all checks pass without displaying a secret.

- [ ] **Step 6: Commit deployment assets**

```bash
git add deploy/alibaba-cloud/Caddyfile deploy/alibaba-cloud/mydsh.service deploy/alibaba-cloud/caddy-mydsh.conf deploy/alibaba-cloud/bootstrap-host.sh deploy/alibaba-cloud/package-release.sh deploy/alibaba-cloud/deploy-release.sh deploy/alibaba-cloud/README.md deploy/alibaba-cloud/README.zh.md deploy/alibaba-cloud/README.i18n.yaml
git commit -m "ops: add Alibaba Cloud deployment"
```

## Task 9: Run repository verification and review the outgoing diff

**Files:**

- Verify: all files changed since `master`

- [ ] **Step 1: Run focused behavior and package gates**

```bash
corepack pnpm exec vitest run packages/host/invite-auth/tests
corepack pnpm run verify-cordis-config
corepack pnpm run verify-package-invariants
corepack pnpm run constraints
```

Expected: all pass.

- [ ] **Step 2: Run compile, build, lint, and hygiene gates**

```bash
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm run lint
corepack pnpm run hygiene
```

Expected: all pass.

- [ ] **Step 3: Run documentation and browser gates**

```bash
corepack pnpm run doc-sync
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
git diff --check master...HEAD
```

Expected: all pass. On Windows, if the known symlink-permission test alone returns `EPERM`, rerun `doc-sync` in an elevated shell or Linux and require a clean pass before deployment.

- [ ] **Step 4: Review for secrets and default-surface drift**

```bash
git diff --stat master...HEAD
git diff --name-only master...HEAD
git grep -n -E 'DSH_INVITE_(CODE_SECRET|SESSION_SECRET)=' -- ':!deploy/alibaba-cloud/bootstrap-host.sh'
git grep -n 'invite-auth' packages/bundle/web-app/cordis.patch.yml
```

Expected: the first secret search has no matches; the Web bundle search has no matches; only intended package, overlay, deployment, tests, docs, and metadata files changed.

- [ ] **Step 5: Request code review before production mutation**

Use the repository code-review workflow on `master...HEAD`. Resolve all findings, rerun the narrow affected checks, and commit fixes before touching the ECS instance.

## Task 10: Deploy to the Alibaba Cloud ECS and verify the domain

**Files:**

- Create locally: an atomically published `mydsh-release-<commit>/` directory containing the Linux amd64 artifact and `.sha256` sidecar under `.artifacts/` (gitignored, not committed)
- Create remotely: a commit-hash-named directory under `/opt/mydsh/releases/`, `/opt/mydsh/current`, `/etc/mydsh/*`, `/etc/caddy/Caddyfile`, and systemd units

- [ ] **Step 1: Collect only non-secret deployment inputs**

Obtain the exact public subdomain, ECS public IP or SSH hostname, SSH username, SSH port if non-default, and local private-key path. Confirm the DNS A/AAAA record resolves to the ECS public address before continuing. Do not ask the user to paste an invite code, session secret, Kimi key, or private-key contents into the conversation.

- [ ] **Step 2: Verify the server and DNS without mutation**

Run `ssh` to inspect `/etc/os-release`, `dpkg --print-architecture`, disk space, active listeners, and whether ports 80/443 are already owned. Run local DNS resolution for the public subdomain. Stop unless the host is Linux amd64 Ubuntu 22.04/24.04, if another production service owns 80/443, or if DNS points elsewhere.

- [ ] **Step 3: Package locally and upload the artifact plus initialization assets**

```bash
mkdir -p .artifacts
PACKAGER_STAGE=$(mktemp -d)
INIT_STAGE=$(mktemp -d)
trap 'rm -rf -- "$PACKAGER_STAGE" "$INIT_STAGE"' EXIT
git archive "$DEPLOY_REF" deploy/alibaba-cloud/package-release.sh | tar -x -C "$PACKAGER_STAGE"
bash "$PACKAGER_STAGE/deploy/alibaba-cloud/package-release.sh" "$DEPLOY_REF" .artifacts
ARTIFACT_SET=$(find .artifacts -maxdepth 1 -type d -name 'mydsh-release-*')
git archive "$DEPLOY_REF" deploy/alibaba-cloud/{bootstrap-host.sh,deploy-release.sh,Caddyfile,mydsh.service,caddy-mydsh.conf} | tar -x -C "$INIT_STAGE"
REMOTE_STAGE=$(ssh "$SSH_TARGET" 'mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
scp "$INIT_STAGE"/deploy/alibaba-cloud/{bootstrap-host.sh,deploy-release.sh,Caddyfile,mydsh.service,caddy-mydsh.conf} "$SSH_TARGET:$REMOTE_STAGE/"
scp -r "$ARTIFACT_SET" "$SSH_TARGET:$REMOTE_STAGE/"
```

Expected: the CPU-, memory-, PID-, and time-bounded digest-pinned Node 24 container passes install, invite-auth tests, full build, and config dump; static security inputs match the trusted extraction, and the complete atomic artifact set uploads. Network and disk use remain unbounded. The checksum detects corruption but does not authenticate the signer.

- [ ] **Step 4: Bootstrap and activate over SSH**

For initial setup only, run the Git-ref-extracted `bootstrap-host.sh` with `sudo` and the exact public host. Then invoke the installed stable `/usr/local/sbin/mydsh-deploy-release` with the uploaded commit-named artifact-set directory. Upgrades upload only a new atomic artifact set and never replace the helper or installed Caddy/systemd control plane. Candidate control-plane drift is rejected and requires separate reviewed maintenance. These commands install OS packages and write `/etc`, `/opt`, `/var/lib`, and systemd state; execute them only on the inspected ECS target.

Expected: both scripts exit 0, `systemctl is-active mydsh caddy` prints `active` twice, and `ss -lntp` shows DSH only on `127.0.0.1:3080` while Caddy owns public 80/443.

- [ ] **Step 5: Run unauthenticated and authenticated smoke tests without revealing secrets**

Run externally:

```bash
curl -sS -H 'Accept: text/html' -o /dev/null -w '%{http_code}\n' "https://$PUBLIC_HOST/"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$PUBLIC_HOST/api/events.mux"
```

Expected: the page navigation is `303`; the API/WebSocket path is `401`.

Run the authenticated smoke entirely on the server, sourcing both root-only files inside `sudo bash -c`, writing the cookie jar to `mktemp`, and deleting it through a trap. The script posts `inviteCode=$DSH_INVITE_CODE_SECRET` with `Origin: https://$DSH_PUBLIC_HOST`, requires `303`, then requests `/` with the cookie and requires `200`. Redirect output, headers, and cookie contents must stay suppressed.

- [ ] **Step 6: Hand the browser-only secret retrieval to the administrator**

Tell the administrator to run this command directly in their own terminal; do not run it through an agent tool whose output enters the conversation:

```bash
ssh "$SSH_TARGET" "sudo sed -n 's/^DSH_INVITE_CODE_SECRET=//p' /etc/mydsh/mydsh.env"
```

The administrator opens `https://$PUBLIC_HOST`, enters the code, confirms a DSH page loads, closes and reopens the browser to verify the 30-day Cookie, logs out, and confirms access is denied again.

- [ ] **Step 7: Configure Kimi and finish production acceptance**

The administrator opens Settings → Models, adds Kimi as a custom OpenAI-compatible provider, supplies the Kimi endpoint, protocol, model id, and API key, and sends one real conversation. Verify that neither `journalctl -u mydsh` nor the repository contains the Kimi key, invite code, session secret, or Cookie.

- [ ] **Step 8: Record the deployment result**

Report the deployed Git commit, public URL, systemd/Caddy status, certificate result, unauthenticated status codes, authenticated smoke result, and any Alibaba Cloud security-group action. Never report the invite code, session secret, Kimi key, private-key path contents, or Cookie.
