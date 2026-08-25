# DSH 邀请鉴权与阿里云部署实施计划

[English](2026-08-24-dsh-invite-auth-deployment.md) | 中文

> **供 agent 执行：** 必须使用子 skill：推荐用 superpowers:subagent-driven-development，或用 superpowers:executing-plans，逐任务实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 新增可选启用的 DSH 邀请码鉴权插件，提供强化的阿里云 Ubuntu Caddy/systemd 部署，并验证生产域名，且不提交 Kimi 或鉴权秘密。

**架构：** 新 Host 插件负责 `/__invite/*`、无状态 HMAC Cookie、请求校验及有容量限制的内存登录限流。发布的 Web 组合包保持不变；阿里云 systemd 单元传入显式 Cordis 覆盖层，Caddy 终止 TLS，并在代理其他全部 HTTP 或 WebSocket 请求前执行 `forward_auth`。

**技术栈：** TypeScript 6、Cordis、node:http、node:crypto、Schemastery、Vitest、Playwright、Caddy 2、systemd、Bash、Node.js 24、pnpm 11.7。

**设计：** [已批准设计](../specs/2026-08-24-dsh-invite-auth-deployment-design.zh.md)

---

## 文件映射

### 新包

- `packages/host/invite-auth/package.json`：包发布、运行时对等依赖和测试依赖。
- `packages/host/invite-auth/tsconfig.json`：Host 编译器引用。
- `packages/host/invite-auth/src/token.ts`：恒定时间邀请码比较与无状态 HMAC 会话 token。
- `packages/host/invite-auth/src/policy.ts`：安全跳转、代理/header 信任、Cookie 解析和有界失败记录。
- `packages/host/invite-auth/src/http.ts`：有界表单解析和 HTTP 响应辅助函数。
- `packages/host/invite-auth/src/page.ts`：静态中文登录 HTML 与安全 header。
- `packages/host/invite-auth/src/index.ts`：已校验插件配置、启动秘密解析和 route 分发。
- `packages/host/invite-auth/src/invariant.ts`：包 invariant 注册及生命周期测试理由。
- `packages/host/invite-auth/tests/token.spec.ts`：密码学行为。
- `packages/host/invite-auth/tests/policy.spec.ts`：请求与限流器行为。
- `packages/host/invite-auth/tests/http.spec.ts`：请求体限制、媒体类型和页面转义。
- `packages/host/invite-auth/tests/invite-auth.spec.ts`：真实 Loader 组装与 HTTP 生命周期。
- `packages/host/invite-auth/README.md`、`README.zh.md`、`README.i18n.yaml`：包约定。

### 组装与浏览器覆盖

- `deploy/alibaba-cloud/invite-auth.cordis.yml`：在发布的 Web 组合包后应用的可选插件配置项。
- `apps/web/tests/invite-auth.e2e.ts`：真实 Web 组装的登录页流程。
- `apps/web/tests/snapshots/invite-auth/login.expected.md`：面向产品用户的 ARIA golden。
- `apps/cli/package.json`：让覆盖层插件可从发布的 CLI 安装中解析。
- `apps/cli/tsconfig.json`：把 CLI 编译器图连接到可选 Host 包。
- `scripts/verify-cordis-config.ts`：把部署覆盖层归类为由 app 解析的配置。
- `tsconfig.host.json`：包含新的 Host 项目。
- `scripts/verify-package-readme-model-experience.ts`：记录鉴权不会改变模型请求。
- `pnpm-lock.yaml`：注册新包后的 workspace 依赖图。

### 部署资产与理由

- `deploy/alibaba-cloud/Caddyfile`：HTTPS、公开邀请 route、forward auth 和 DSH 反向代理。
- `deploy/alibaba-cloud/mydsh.service`：低权限 DSH 运行时。
- `deploy/alibaba-cloud/caddy-mydsh.conf`：仅为公共 Host 设置的 Caddy systemd drop-in。
- `deploy/alibaba-cloud/bootstrap-host.sh`：安装 Node/Caddy，创建用户与私密配置，并安装单元。
- `deploy/alibaba-cloud/package-release.sh`：在受限制的官方 Node 24 Linux 容器中打包精确的已评审 ref。
- `deploy/alibaba-cloud/deploy-release.sh`：验证预构建 Linux artifact、原子切换并回滚失败激活，且不运行候选代码。
- `deploy/alibaba-cloud/README.md`、`README.zh.md`、`README.i18n.yaml`：首次部署、升级、回滚与秘密获取流程。
- `.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md`、`.zh.md`、`.i18n.yaml`：决策、被否决替代方案与后果。

## 任务 1：搭建包并实现密码学原语

**文件：**

- 新建：`packages/host/invite-auth/package.json`
- 新建：`packages/host/invite-auth/tsconfig.json`
- 新建：`packages/host/invite-auth/tests/token.spec.ts`
- 新建：`packages/host/invite-auth/src/token.ts`
- 修改：`tsconfig.host.json:304`

- [ ] **步骤 1：编写失败的 token 测试**

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

- [ ] **步骤 2：运行测试并确认因模块缺失而失败**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/token.spec.ts`

预期：因为 `../src/token.ts` 不存在而失败。

- [ ] **步骤 3：创建 manifest、编译项目与 token 实现**

在 `package.json` 中使用当前根版本，把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-launch-environment` 和 `@deepseek-ai/dsh-invariants` 声明为 `workspace:^` peer 与 dev dependency，把 `@deepseek-ai/schemastery` 放入 dependencies，仅把 Loader/Include 放入 dev dependencies。发布 `.` 和 `./invariant`，`files` 必须正好包含 `lib/index.js`、`lib/invariant.js` 与 `lib/types/**/*.d.ts`。

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

在 `tsconfig.host.json` 的其他 Host 包旁加入 `{ "path": "./packages/host/invite-auth" }`。

- [ ] **步骤 4：运行聚焦测试与包编译器**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/token.spec.ts`

预期：通过，共 2 个测试。

运行：`corepack pnpm exec tsc -b packages/host/invite-auth`

预期：通过且无诊断。

- [ ] **步骤 5：提交密码学单元**

```bash
git add packages/host/invite-auth/package.json packages/host/invite-auth/tsconfig.json packages/host/invite-auth/src/token.ts packages/host/invite-auth/tests/token.spec.ts tsconfig.host.json
git commit -m "feat(invite-auth): add signed session tokens"
```

## 任务 2：实现跳转、代理信任、Cookie 与限流策略

**文件：**

- 新建：`packages/host/invite-auth/tests/policy.spec.ts`
- 新建：`packages/host/invite-auth/src/policy.ts`

- [ ] **步骤 1：编写失败的策略测试**

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

- [ ] **步骤 2：运行策略测试并确认失败**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/policy.spec.ts`

预期：因为 `../src/policy.ts` 不存在而失败。

- [ ] **步骤 3：实现精确的策略 API**

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

- [ ] **步骤 4：运行策略测试**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/policy.spec.ts`

预期：通过，共 5 个测试并包含每个表格行。

- [ ] **步骤 5：提交策略单元**

```bash
git add packages/host/invite-auth/src/policy.ts packages/host/invite-auth/tests/policy.spec.ts
git commit -m "feat(invite-auth): add request security policy"
```

## 任务 3：实现有界 HTTP 解析与登录页

**文件：**

- 新建：`packages/host/invite-auth/tests/http.spec.ts`
- 新建：`packages/host/invite-auth/src/http.ts`
- 新建：`packages/host/invite-auth/src/page.ts`

- [ ] **步骤 1：编写失败的解析器与渲染器测试**

测试必须构造 `Readable` 请求替身和最小 `ServerResponse` 记录器，然后精确断言以下结果：

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

- [ ] **步骤 2：运行测试并确认失败**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/http.spec.ts`

预期：因为 `http.ts` 与 `page.ts` 不存在而失败。

- [ ] **步骤 3：实现有界解析与响应辅助函数**

`http.ts` 必须导出 `HttpError`、`readUrlEncodedForm`、`redirect`、`writeEmpty` 和 `writeHtml`；`page.ts` 导出 `securityHeaders`。`readUrlEncodedForm` 只接受 `application/x-www-form-urlencoded`，按字节而不是 JavaScript 字符计数，超过配置限制后立即抛出 `413`，并让该响应路径设置 `Connection: close`。

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

`page.ts` 必须渲染一个响应式中文表单，标题为 `访问 DSH`、标签为 `邀请码`、提交文字为 `进入`，带 `autocomplete="current-password"`，且不含脚本并转义 `next`。只使用页面 CSP 允许的内联 CSS；绝不插入邀请码或 token。

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

- [ ] **步骤 4：运行 HTTP 测试**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/http.spec.ts`

预期：解析器、转义和 header 断言全部通过。

- [ ] **步骤 5：提交 HTTP/页面单元**

```bash
git add packages/host/invite-auth/src/http.ts packages/host/invite-auth/src/page.ts packages/host/invite-auth/tests/http.spec.ts
git commit -m "feat(invite-auth): add hardened login page"
```

## 任务 4：通过真实 Web server 组装 Cordis 插件

**文件：**

- 新建：`packages/host/invite-auth/src/index.ts`
- 新建：`packages/host/invite-auth/src/invariant.ts`
- 新建：`packages/host/invite-auth/tests/invite-auth.spec.ts`

- [ ] **步骤 1：编写失败的真实 Loader 组装测试**

创建临时 `cordis.yml`，其中包含端口 `0` 上的 `dsh-host-webserver` 和 `dsh-host-invite-auth`。Loader 启动前，提供一个启动快照，其 `process` 层含有 `DSH_INVITE_CODE_SECRET=shared-code-123` 和 32 字节的 `DSH_INVITE_SESSION_SECRET`。所有 HTTP 调用都通过已绑定端口，并断言：

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

还要证明以下情况会拒绝启动：缺少秘密、只有项目 `.env` 层秘密、邀请码少于 12 个字符、会话密钥少于 32 字节。一个转发地址连续错误 10 次后，断言下一次返回带 `Retry-After` 的 `429`；使用第二个地址证明 bucket 相互独立。dispose invite-auth Loader 配置项后，断言 `/__invite/login` 返回未认领 Web server 的 `404`。

- [ ] **步骤 2：运行组装测试并确认失败**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests/invite-auth.spec.ts`

预期：因为 `src/index.ts` 缺失而失败。

- [ ] **步骤 3：实现已校验配置与启动秘密解析**

只导出标准函数插件命名空间：`name`、`inject`、`Config` 和 `apply`；不要添加默认导出。`inject` 为 `['webServer']`。定义以下字段与默认值，然后通过一个显式的 `resolveConfig(config)` 函数投影：

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

通过 `launchEnvironmentOf(ctx).getFrom(name, ['process'])` 解析两个秘密。用 `Array.from(value).length >= 12` 校验邀请码，用 `Buffer.byteLength(value, 'utf8') >= 32` 校验签名密钥。错误只命名环境变量与修正方式，不包含变量值。

- [ ] **步骤 4：实现一个 prefix route 和完整方法分发**

通过 `ctx.effect()` 在 `/__invite` 注册一个 `prefix` route。仅分发设计中的四个路径，其他路径返回 `404`，错误方法返回 `405` 与 `Allow`。`X-DSH-Invite-Client-IP` 只能通过 `trustedClientAddress(req.socket.remoteAddress, headerValue)` 使用。

登录 POST 必须先检查 `validForwardedOrigin` 再读取表单；比较邀请码前执行限流；签发带 `Path=/; Max-Age=${resolved.sessionTtlSeconds}; Secure; HttpOnly; SameSite=Lax` 的 `__Host-dsh_invite`；且只通过 `safeNextPath` 跳转。check route 对有效 Cookie 返回 `204`；否则只在原始 `GET`/`HEAD` 页面导航且接受 HTML 时，根据 Caddy 的 `X-Forwarded-Method` 与 `X-Forwarded-Uri` 跳转，其他调用均返回 `401`。退出执行同样的来源检查并让 Cookie 过期。

仅在 route 内捕获 `HttpError`，让其精确状态抵达客户端；意外错误交由 `dsh-host-webserver` 的请求围护与 logger 处理。

完整分发器遵循以下结构；辅助函数可以保持私有，但名称和决策必须等价：

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

- [ ] **步骤 5：添加 invariant companion**

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

- [ ] **步骤 6：对每个源文件运行测试与覆盖率**

运行：`corepack pnpm exec vitest run packages/host/invite-auth/tests`

预期：通过。

运行：`corepack pnpm exec vitest run --coverage --coverage.include="packages/host/invite-auth/src/**/*.ts" packages/host/invite-auth/tests`

预期：通过，且每个 `packages/host/invite-auth/src/*.ts` 文件的 statements、branches、functions 和 lines 都达到 100%。

- [ ] **步骤 7：提交组装后的插件**

```bash
git add packages/host/invite-auth/src/index.ts packages/host/invite-auth/src/invariant.ts packages/host/invite-auth/tests/invite-auth.spec.ts
git commit -m "feat(invite-auth): protect DSH web access"
```

## 任务 5：连接可选部署覆盖层且不改变 Web 默认值

**文件：**

- 新建：`deploy/alibaba-cloud/invite-auth.cordis.yml`
- 修改：`apps/cli/package.json:55-105`
- 修改：`apps/cli/tsconfig.json:20-50`
- 修改：`scripts/verify-cordis-config.ts:28-37`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：添加部署覆盖层**

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

- [ ] **步骤 2：让覆盖层解析可机械检查**

把 `deploy/alibaba-cloud/invite-auth.cordis.yml` 加入 `appOverlayFiles`，把 `@deepseek-ai/dsh-host-invite-auth: workspace:^` 加入 `apps/cli/package.json` dependencies，在 `apps/cli/tsconfig.json` 的其他 Host 引用旁加入 `../../packages/host/invite-auth`，并运行 `corepack pnpm install --lockfile-only` 更新 lockfile。不要修改 `packages/bundle/web-app/cordis.patch.yml`。

- [ ] **步骤 3：验证配置发现、依赖解析与未改变的默认值**

运行：`corepack pnpm run verify-cordis-config`

预期：通过，且配置文件计数增加 1。

运行：`corepack pnpm dsh web --dump-default-config`

预期：通过；输出不含 `invite-auth`。

使用隔离的临时 `DSH_HOME` 运行：`corepack pnpm dsh web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config`

预期：通过；输出正好包含一个 `invite-auth` 配置项，且只包含环境变量名称，不含秘密值。

- [ ] **步骤 4：提交可选组装**

```bash
git add deploy/alibaba-cloud/invite-auth.cordis.yml apps/cli/package.json apps/cli/tsconfig.json scripts/verify-cordis-config.ts pnpm-lock.yaml
git commit -m "feat(invite-auth): add deployment overlay"
```

## 任务 6：记录包决策与公开约定

**文件：**

- 新建：`packages/host/invite-auth/README.md`
- 新建：`packages/host/invite-auth/README.zh.md`
- 新建：`packages/host/invite-auth/README.i18n.yaml`
- 新建：`.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md`
- 新建：`.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.zh.md`
- 新建：`.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.i18n.yaml`
- 修改：`scripts/verify-package-readme-model-experience.ts:113`

- [ ] **步骤 1：编写包 README 对**

记录配置默认值、仅继承进程层的秘密查找、全部四个 route、精确状态码、Cookie 轮换语义、Caddy 的必要职责、内存限流器重启重置和无多用户隔离。以以下内容结尾：

```markdown
## Model Experience

None, as the authentication plugin handles browser HTTP requests and never changes prompts, messages, tool schemas, model streams, or tool results.

#### KV Cache effect

None; the plugin never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **A reverse proxy must enforce the check** — the plugin owns authentication routes but does not intercept unrelated Web server routes; exposing port 3080 bypasses authentication.
- **Rate limits are process-local** — a restart clears buckets and multiple DSH processes do not share counters; the deployment runs exactly one DSH process.
```

把此包加入 `SENTENCE_MODEL_EXPERIENCE`，`kind` 设为 `'none'`，理由相同。

- [ ] **步骤 2：编写 implemented Agent Note 对**

使用强制标题 `## Problem`、`## Decision`、`## Alternatives considered` 和 `## Consequences`。记录原生插件加 Caddy forward-auth 设计，并否决独立鉴权进程、Caddy Basic Auth，以及把 `dsh-host-webserver` 改造成中间件栈。以现在时说明发布的 Web 组合包默认仍无鉴权，部署覆盖层负责启用。

- [ ] **步骤 3：记录并验证两个双语对**

```bash
corepack pnpm run verify-translation-pairing --write packages/host/invite-auth/README.md
corepack pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md
corepack pnpm run verify-translation-pairing packages/host/invite-auth/README.md .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md
corepack pnpm run verify-agent-note-format
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
```

预期：所有命令通过。

- [ ] **步骤 4：提交文档与理由**

```bash
git add packages/host/invite-auth/README.md packages/host/invite-auth/README.zh.md packages/host/invite-auth/README.i18n.yaml .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.zh.md .agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.i18n.yaml scripts/verify-package-readme-model-experience.ts
git commit -m "docs(invite-auth): define authentication contract"
```

## 任务 7：添加真实浏览器快照

**文件：**

- 新建：`apps/web/tests/invite-auth.e2e.ts`
- 新建：`apps/web/tests/snapshots/invite-auth/login.expected.md`

- [ ] **步骤 1：编写失败的 Web 场景**

使用 `launchWebScaffold({ extraOverlayPath: DEPLOYMENT_OVERLAY })`。只在 scaffold 启动期间设置 `DSH_INVITE_CODE_SECRET` 和 `DSH_INVITE_SESSION_SECRET`，启动快照捕获它们后立即恢复，然后在中文 locale 的 Chromium 页面打开 `/__invite/login?next=%2Fsessions`。

```ts ignore-check
expect(await page.getByRole('heading', { name: '访问 DSH' }).count()).toBe(1)
expect(await page.getByLabel('邀请码', { exact: true }).getAttribute('type')).toBe('password')
expect(await page.getByRole('button', { name: '进入', exact: true }).count()).toBe(1)
const aria = await captureStableAria(page, 'body', scaffold.workspaceCwd)
await compareOrRefreshGolden(LOGIN_EXPECTED, aria, MODE)
expect((await page.content()).includes(INVITE_CODE)).toBe(false)
expect((await page.content()).includes(SESSION_SECRET)).toBe(false)
```

添加 inventory 断言，只允许 `login.expected.md`。该场景不提交表单，因为 TLS 与 `forward_auth` 属于 Caddy；包的真实 Loader HTTP 测试已经负责成功 POST 和 Cookie 行为。

- [ ] **步骤 2：构建并运行 replay，以观察缺失 golden**

运行：`corepack pnpm run build`

在 PowerShell 中运行：

```powershell
$env:DSH_SNAPSHOT='replay'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
Remove-Item Env:DSH_SNAPSHOT
```

预期：因为缺少 `login.expected.md` 而失败。

- [ ] **步骤 3：刷新、审阅并 replay golden**

```powershell
$env:DSH_SNAPSHOT='refresh'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
$env:DSH_SNAPSHOT='replay'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
Remove-Item Env:DSH_SNAPSHOT
```

预期：refresh 写入一个 ARIA 快照；replay 通过。审阅 golden，确认其包含标题、密码输入框、说明文字和进入按钮，但不含秘密。

- [ ] **步骤 4：提交浏览器证据**

```bash
git add apps/web/tests/invite-auth.e2e.ts apps/web/tests/snapshots/invite-auth/login.expected.md
git commit -m "test(invite-auth): snapshot the login page"
```

## 任务 8：添加强化的 Ubuntu 部署资产

**文件：**

- 新建：`deploy/alibaba-cloud/Caddyfile`
- 新建：`deploy/alibaba-cloud/mydsh.service`
- 新建：`deploy/alibaba-cloud/caddy-mydsh.conf`
- 新建：`deploy/alibaba-cloud/bootstrap-host.sh`
- 新建：`deploy/alibaba-cloud/package-release.sh`
- 新建：`deploy/alibaba-cloud/deploy-release.sh`
- 新建：`deploy/alibaba-cloud/README.md`
- 新建：`deploy/alibaba-cloud/README.zh.md`
- 新建：`deploy/alibaba-cloud/README.i18n.yaml`

- [ ] **步骤 1：编写 Caddy 与 systemd 定义**

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

`mydsh.service` 必须使用 `User=mydsh`、`WorkingDirectory=/srv/mydsh/workspace`、两个环境文件、设计中的精确覆盖层命令、`Restart=on-failure`、`UMask=0077`、`NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=strict`、`ProtectHome=true` 和 `ReadWritePaths=/var/lib/mydsh /srv/mydsh/workspace`。不要加入会阻断 agent 工具的 syscall filter。`caddy-mydsh.conf` 只向 Caddy 提供 `EnvironmentFile=/etc/mydsh/public.env`。

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

- [ ] **步骤 2：实现幂等 Host bootstrap**

`bootstrap-host.sh` 正好接受一个小写 DNS hostname，拒绝非 root 执行，并在加锁、文件系统变更或网络访问前检查 `dpkg --print-architecture` 恰好为 `amd64`。它安装 NodeSource Node 24 运行时和官方 Caddy stable apt 仓库，创建不可登录的 `mydsh` 运行时用户和归属正确的数据目录，写入 `/etc/mydsh/public.env`，并仅在文件不存在时创建 `/etc/mydsh/mydsh.env`。它不安装 builder 账户、pnpm、源码 checkout 或构建缓存。release 存在后只允许逐字节一致的无操作；控制平面或 hostname 变更需要单独维护。

安装单元文件与 Caddyfile，运行 `systemctl daemon-reload`，加载公共环境后验证 Caddy，启用 Caddy，并在 release 存在前保持 `mydsh.service` 未启用。trap 只能移除本次运行创建的临时文件。

脚本命令序列必须完整且失败关闭：

```bash
#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID} -eq 0 ]] || { echo 'bootstrap-host: run as root' >&2; exit 1; }
[[ $# -eq 1 ]] || { echo 'usage: bootstrap-host.sh dsh.example.com' >&2; exit 2; }
public_host="$1"
[[ "$public_host" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] \
  || { echo 'bootstrap-host: invalid lowercase DNS hostname' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_setup="$(mktemp)"
public_tmp="$(mktemp)"
private_tmp="$(mktemp)"
caddy_key_tmp="$(mktemp)"
caddy_source_tmp="$(mktemp)"
trap 'rm -f -- "$node_setup" "$public_tmp" "$private_tmp" "$caddy_key_tmp" "$caddy_source_tmp"' EXIT
printf 'DSH_PUBLIC_HOST=%s\n' "$public_host" >"$public_tmp"
apt-get update
apt-get install -y ca-certificates curl gnupg gzip iproute2 openssl python3 tar debian-keyring debian-archive-keyring apt-transport-https
umask 077
printf '%s\n' \
  'DSH_HOME=/var/lib/mydsh' \
  "DSH_INVITE_CODE_SECRET=$(openssl rand -hex 16)" \
  "DSH_INVITE_SESSION_SECRET=$(openssl rand -hex 32)" >"$private_tmp"
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$node_setup"
apt-get install -y nodejs
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o "$caddy_key_tmp"
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$caddy_source_tmp"
install -o root -g root -m 0644 "$caddy_key_tmp" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
install -o root -g root -m 0644 "$caddy_source_tmp" /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
id mydsh >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mydsh --shell /usr/sbin/nologin mydsh
install -d -o root -g root -m 0755 /opt/mydsh /opt/mydsh/releases /etc/mydsh
install -d -o mydsh -g mydsh -m 0700 /var/lib/mydsh
install -d -o mydsh -g mydsh -m 0750 /srv/mydsh/workspace
install -o root -g root -m 0644 "$public_tmp" /etc/mydsh/public.env
if [[ ! -e /etc/mydsh/mydsh.env ]]; then
  install -o root -g root -m 0600 "$private_tmp" /etc/mydsh/mydsh.env
fi
install -o root -g root -m 0644 "$script_dir/Caddyfile" /etc/caddy/Caddyfile
install -o root -g root -m 0644 "$script_dir/mydsh.service" /etc/systemd/system/mydsh.service
install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
install -o root -g root -m 0644 "$script_dir/caddy-mydsh.conf" /etc/systemd/system/caddy.service.d/mydsh.conf
systemctl daemon-reload
set -a; source /etc/mydsh/public.env; set +a
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy.service
```

- [ ] **步骤 3：实现不可变 release 激活与回滚**

`package-release.sh` 接受具名的已评审 Git ref 和输出目录，只读取该 ref 的 Git 对象，并使用受资源限制的临时官方 Node 24 Linux 容器安装经过 integrity 固定的 pnpm 11.7.0 artifact、安装冻结依赖、运行 invite-auth 测试、构建并转储配置。容器只挂载不可预测、模式为 0700 的 artifact-set staging 目录，绝不挂载调用者输出目录。容器退出后，宿主验证并同步确定性的 Linux amd64 运行时 archive 与 SHA-256 sidecar，再通过一次原子重命名把两者发布到 `$OUTPUT_DIR/mydsh-release-$commit/`。Docker 是强制依赖，不存在宿主构建回退。

`deploy-release.sh` 只接受原子发布、以 commit 命名的 artifact-set 目录，并要求其中恰好只有 archive 与 sidecar。在共享锁下，它把两者复制到 root-private 新 inode，验证 SHA-256，拒绝不安全 archive 路径和链接，验证 manifest、helper journal 兼容版本、已构建 CLI、依赖、overlay、每个强化 systemd 值恰好一次和 Caddy 配置，再发布 root 所有的 commit 目录。它绝不会运行候选 Git、pnpm、hook、测试、构建、配置脚本或 helper。稳定的已安装 helper 不属于 release 事务。

使用原子符号链接切换并保留此前目标：

```bash
previous="$(readlink -f /opt/mydsh/current 2>/dev/null || true)"
ln -s "$release" /opt/mydsh/current.next
mv -Tf /opt/mydsh/current.next /opt/mydsh/current
systemctl enable mydsh.service
healthy=false
if systemctl restart mydsh.service; then
  for _attempt in $(seq 1 30); do
    if curl --fail --silent --show-error http://127.0.0.1:3080/__invite/login >/dev/null; then
      healthy=true
      break
    fi
    sleep 1
  done
fi
if [[ "$healthy" != true ]]; then
  if [[ -n "$previous" ]]; then
    ln -s "$previous" /opt/mydsh/current.previous
    mv -Tf /opt/mydsh/current.previous /opt/mydsh/current
    systemctl restart mydsh.service
  fi
  exit 1
fi
```

只在 DSH 应答后验证并 reload Caddy。永远不要自动删除旧 release，也不要打印任一秘密。

把两个上传文件复制到 root-private 新 inode 后，artifact 验证与发布使用以下命令族；不得执行候选命令：

```bash
extract="$(mktemp -d /opt/mydsh/releases/.extract.XXXXXX)"
sha256sum "$artifact"
python3 validate_archive_members.py "$artifact"
tar -xzf "$artifact" --no-same-owner -C "$extract"
commit="$(sed -n 's/^commit=//p' "$extract/.mydsh-release-manifest")"
release="/opt/mydsh/releases/$commit"
chown -R root:root "$extract"
chmod -R go-w "$extract"
mv "$extract" "$release"
```

- [ ] **步骤 4：编写双语部署教程**

记录前置条件、本地 Docker 打包、DNS、安全组端口 22/80/443、只用于初始化的 bootstrap、原子 artifact-set 上传、release 部署、直接通过 SSH 获取邀请码、通过设置 → 模型配置 Kimi、仅上传 artifact set 的升级、回滚、稳定 helper 维护限制、秘密轮换、journald 诊断和所有验收命令。链接 NodeSource Node 24 与 Caddy 包的官方说明。

- [ ] **步骤 5：验证脚本并记录 README 对**

在 Linux shell 运行：`bash -n deploy/alibaba-cloud/bootstrap-host.sh deploy/alibaba-cloud/package-release.sh deploy/alibaba-cloud/deploy-release.sh`

以 `DSH_PUBLIC_HOST=dsh.example.com` 运行：`caddy validate --config deploy/alibaba-cloud/Caddyfile --adapter caddyfile`

运行：`corepack pnpm run verify-translation-pairing --write deploy/alibaba-cloud/README.md`

预期：全部检查通过且不显示秘密。

- [ ] **步骤 6：提交部署资产**

```bash
git add deploy/alibaba-cloud/Caddyfile deploy/alibaba-cloud/mydsh.service deploy/alibaba-cloud/caddy-mydsh.conf deploy/alibaba-cloud/bootstrap-host.sh deploy/alibaba-cloud/package-release.sh deploy/alibaba-cloud/deploy-release.sh deploy/alibaba-cloud/README.md deploy/alibaba-cloud/README.zh.md deploy/alibaba-cloud/README.i18n.yaml
git commit -m "ops: add Alibaba Cloud deployment"
```

## 任务 9：运行仓库验证并审阅待发 diff

**文件：**

- 验证：相对 `master` 发生变化的全部文件

- [ ] **步骤 1：运行聚焦行为与包门禁**

```bash
corepack pnpm exec vitest run packages/host/invite-auth/tests
corepack pnpm run verify-cordis-config
corepack pnpm run verify-package-invariants
corepack pnpm run constraints
```

预期：全部通过。

- [ ] **步骤 2：运行编译、构建、lint 与 hygiene 门禁**

```bash
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm run lint
corepack pnpm run hygiene
```

预期：全部通过。

- [ ] **步骤 3：运行文档与浏览器门禁**

```bash
corepack pnpm run doc-sync
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/invite-auth.e2e.ts
git diff --check master...HEAD
```

预期：全部通过。在 Windows 上，若只有已知符号链接权限测试返回 `EPERM`，则在提升权限的 shell 或 Linux 中重跑 `doc-sync`，部署前必须得到完整通过结果。

- [ ] **步骤 4：审阅秘密与默认表层漂移**

```bash
git diff --stat master...HEAD
git diff --name-only master...HEAD
git grep -n -E 'DSH_INVITE_(CODE_SECRET|SESSION_SECRET)=' -- ':!deploy/alibaba-cloud/bootstrap-host.sh'
git grep -n 'invite-auth' packages/bundle/web-app/cordis.patch.yml
```

预期：第一条秘密搜索没有匹配；Web 组合包搜索没有匹配；仅预期的包、覆盖层、部署、测试、文档与元数据文件发生变化。

- [ ] **步骤 5：生产变更前请求代码审阅**

对 `master...HEAD` 使用仓库代码审阅工作流。解决所有发现，重跑受影响的最小检查，并在接触 ECS 实例前提交修复。

## 任务 10：部署到阿里云 ECS 并验证域名

**文件：**

- 本地新建：`.artifacts/` 下原子发布的 `mydsh-release-<commit>/` 目录，其中包含 Linux amd64 artifact 和 `.sha256` sidecar（被 gitignore，不提交）
- 远端新建：`/opt/mydsh/releases/` 下以 commit hash 命名的目录、`/opt/mydsh/current`、`/etc/mydsh/*`、`/etc/caddy/Caddyfile` 和 systemd 单元

- [ ] **步骤 1：只收集非秘密部署输入**

获取精确公网子域名、ECS 公网 IP 或 SSH hostname、SSH 用户名、非默认 SSH 端口及本地私钥路径。继续前确认 DNS A/AAAA 记录解析到 ECS 公网地址。不要让用户把邀请码、会话密钥、Kimi key 或私钥内容粘贴到对话中。

- [ ] **步骤 2：只读验证服务器与 DNS**

通过 `ssh` 检查 `/etc/os-release`、`dpkg --print-architecture`、磁盘空间、活动 listener，以及端口 80/443 是否已有 owner。在本地解析公网子域名。若 Host 不是 Linux amd64 Ubuntu 22.04/24.04、其他生产服务占用 80/443，或 DNS 指向别处，则停止。

- [ ] **步骤 3：在本地打包并上传 artifact 与初始化资产**

```bash
mkdir -p .artifacts
bash deploy/alibaba-cloud/package-release.sh "$DEPLOY_REF" .artifacts
scp -r .artifacts/mydsh-release-* deploy/alibaba-cloud/bootstrap-host.sh deploy/alibaba-cloud/deploy-release.sh deploy/alibaba-cloud/Caddyfile deploy/alibaba-cloud/mydsh.service deploy/alibaba-cloud/caddy-mydsh.conf "$SSH_TARGET:$REMOTE_STAGE/"
```

预期：受限制的官方 Node 24 容器通过安装、invite-auth 测试、完整构建和配置转储；artifact 与严格 checksum sidecar 上传成功。checksum 能发现损坏，但不能认证签名者。

- [ ] **步骤 4：通过 SSH bootstrap 并激活**

仅在首次设置时，用 `sudo` 和精确公网 Host 运行从 Git ref 提取的 `bootstrap-host.sh`。然后使用上传、以 commit 命名的 artifact-set 目录调用已安装的稳定 `/usr/local/sbin/mydsh-deploy-release`。升级只上传新的原子 artifact set，绝不自动替换 helper。这些命令会安装 OS 包，并写入 `/etc`、`/opt`、`/var/lib` 和 systemd 状态；只能在已检查的 ECS 目标上执行。

预期：两个脚本均以 0 退出，`systemctl is-active mydsh caddy` 打印两次 `active`，`ss -lntp` 显示 DSH 只监听 `127.0.0.1:3080`，Caddy 占有公网 80/443。

- [ ] **步骤 5：运行不暴露秘密的未登录与已登录 smoke test**

从外部运行：

```bash
curl -sS -H 'Accept: text/html' -o /dev/null -w '%{http_code}\n' "https://$PUBLIC_HOST/"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$PUBLIC_HOST/api/events.mux"
```

预期：页面导航为 `303`；API/WebSocket 路径为 `401`。

完全在服务器上运行已登录 smoke，并在 `sudo bash -c` 内 source 两个 root-only 文件，把 Cookie jar 写入 `mktemp`，通过 trap 删除。脚本用 `Origin: https://$DSH_PUBLIC_HOST` POST `inviteCode=$DSH_INVITE_CODE_SECRET`，要求 `303`，再带 Cookie 请求 `/` 并要求 `200`。跳转输出、header 与 Cookie 内容都必须保持不显示。

- [ ] **步骤 6：把仅浏览器使用的秘密获取交给管理员**

告诉管理员直接在自己的终端运行以下命令；不要通过会把输出写入对话的 agent 工具执行：

```bash
ssh "$SSH_TARGET" "sudo sed -n 's/^DSH_INVITE_CODE_SECRET=//p' /etc/mydsh/mydsh.env"
```

管理员打开 `https://$PUBLIC_HOST`，输入邀请码，确认 DSH 页面加载，关闭并重开浏览器以验证 30 天 Cookie，退出，并确认访问再次被拒绝。

- [ ] **步骤 7：配置 Kimi 并完成生产验收**

管理员打开设置 → 模型，把 Kimi 添加为自定义 OpenAI 兼容提供方，填写 Kimi endpoint、协议、模型 id 与 API key，并发送一次真实对话。确认 `journalctl -u mydsh` 与仓库都不含 Kimi key、邀请码、会话密钥或 Cookie。

- [ ] **步骤 8：记录部署结果**

报告已部署 Git commit、公网 URL、systemd/Caddy 状态、证书结果、未登录状态码、已登录 smoke 结果，以及任何阿里云安全组操作。永远不要报告邀请码、会话密钥、Kimi key、私钥路径内容或 Cookie。
