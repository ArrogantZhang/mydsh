# DSH Web 实时传输背压实施计划

[English](2026-08-27-web-realtime-backpressure.md) | 中文

> **面向智能体执行者：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让 Web 提示词提交即时可见，并使 2 至 5 个公网浏览器同时使用时的实时对话保持响应且内存有界。

**架构：** 输入框在任何宿主事件返回前渲染输入状态机的同步提交状态。`host-apiproxy` 限制每条事件流队列，`client-connection` 协商可选的 `permessage-deflate`，并只终止超过 socket 字节或发送时间预算的下行流；既有连接 generation 与会话 history resync 在重连后恢复持久事件。

**技术栈：** TypeScript 6、React 18、Cordis、Schemastery、`ws` 8.21、Vitest 4、Playwright/Chromium、Node.js 24、pnpm 11.7、Caddy、systemd、Bash。

**设计：** [已批准设计](../specs/2026-08-27-web-realtime-backpressure-design.zh.md)

---

## 文件映射

### 宿主事件队列

- `packages/host/apiproxy/src/` + `frame-queue.ts` — 有界 callback-to-async-iterator 队列与 overflow 错误。
- `packages/host/apiproxy/src/api-proxy.ts` — 使用解析后的容量创建 mux 与 host 队列。
- `packages/host/apiproxy/src/index.ts` — 验证并传递 `maxEventStreamQueueFrames`。
- `packages/host/apiproxy/tests/` + `frame-queue.spec.ts` — 容量、overflow、abort 与 cleanup 竞争。
- `packages/host/apiproxy/tests/session-export.spec.ts` — 完整网关配置默认值与非法边界。
- `packages/host/apiproxy/README.md`、`README.zh.md`、`README.i18n.yaml` — 事件流资源约定。

### WebSocket 下行流

- `packages/client/connection/src/websocket-downlink.ts` — 压缩协商、串行发送期限、缓冲字节熔断与幂等 cleanup。
- `packages/client/connection/src/index.ts` — 验证部署调优值，并把解析结果传给载体。
- `packages/client/connection/tests/websocket-downlink.host.spec.ts` — 协商、慢读取方、timeout、peer 隔离与 teardown。
- `packages/client/connection/tests/node-half.host.spec.ts` — 配置默认值、非法范围与插件接线。
- `packages/client/connection/README.md`、`README.zh.md`、`README.i18n.yaml` — 下行配置与恢复行为。

### 产品反馈与恢复

- `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` — 可见 pending 标记、busy 语义与实时状态文本。
- `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` — pending 与仅无障碍可见的状态样式。
- `packages/client/ui-conversation/src/client/locales.ts` — 中英文发送状态文本。
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx` — 键盘/按钮即时反馈与结束状态清理。
- `packages/client/ui-conversation/README.md`、`README.zh.md`、`README.i18n.yaml` — 本地回执语义与持久气泡归属。
- `packages/client/runtime/tests/session.client.spec.ts` — 传输 generation resync 后可见 history 恰好一次。
- `apps/web/tests/submit-feedback.e2e.ts` — 在宿主 admission 前挂起 `session.prompt` 的真实 HTTP/Web 组合。
- `apps/web/tests/snapshots/submit-feedback/pending.expected.md` — 无 key、产品可见的 ARIA golden。

### 基准与部署

- `scripts/websocket-downlink-benchmark-worker.ts` — 包含 5 条 mux 和 5 条 host socket 的单个隔离压缩模式。
- `scripts/websocket-downlink-benchmark.ts` — 比较子进程报告并执行字节/RSS 门槛。
- `package.json` — `benchmark:websocket-downlinks` 命令。
- `deploy/alibaba-cloud/invite-auth.cordis.yml` — 显式生产队列、压缩、字节与时间值。
- `scripts/alibaba-cloud-deployment.spec.ts` — 部署覆盖层与打包门槛断言。
- `deploy/alibaba-cloud/package-release.sh` — 发布 artifact 前运行确定性下行基准。
- `deploy/alibaba-cloud/README.md`、`README.zh.md`、`README.i18n.yaml` — 生产值与慢客户端恢复操作。

### 决策记录

- `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`、`.zh.md`、`.i18n.yaml` — proposal 阶段决策记录。
- `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.md`、`.zh.md`、`.i18n.yaml` — 所有验收通过后的最终现状决策。

## 任务 1：记录传输与 UI 决策

**文件：**

- 新建：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`
- 新建：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.zh.md`
- 新建：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml`

- [ ] **步骤 1：编写 proposed Agent Note 配对**

按以下精确顺序使用 proposed note 必需标题：

```md
# Agent Note: Web realtime backpressure and submit feedback

Status: proposed

## Problem
## Proposal
## Resource ownership
## Reconnect semantics
## Alternatives considered
## Acceptance criteria
## Risks
```

记录必须在不叙述实施过程的情况下说明这些决策：持久日志继续作为权威来源；输入框只暴露本地回执；`host-apiproxy` 拥有帧容量；`client-connection` 拥有压缩与 socket 预算；overflow 只关闭一条流，不中止 agent；重连通过 `session/subscribed.lastSeq` 与 history 重建；只有压缩未达到测量门槛时才重新考虑批处理；拒绝丢失式 chunk 合并。

- [ ] **步骤 2：记录并验证双语配对**

运行：`pnpm run verify-translation-pairing --write .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`

预期：写入一条记录。

运行：`pnpm run verify-translation-pairing -- .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`

预期：`1 named pair(s) consistent`。

运行：`pnpm run verify-agent-note-format && pnpm run verify-agent-note-classification`

预期：两个命令都通过。

- [ ] **步骤 3：提交 proposed 决策**

```bash
git add .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.*
git commit -m "docs: record web backpressure decision"
```

## 任务 2：限制 ApiProxy 事件流队列

**文件：**

- 在 `packages/host/apiproxy/src/` 下新建：`frame-queue.ts`
- 在 `packages/host/apiproxy/tests/` 下新建：`frame-queue.spec.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/host/apiproxy/src/index.ts`
- 修改：`packages/host/apiproxy/tests/session-export.spec.ts`
- 修改：`packages/host/apiproxy/README.md`
- 修改：`packages/host/apiproxy/README.zh.md`
- 修改：`packages/host/apiproxy/README.i18n.yaml`

- [ ] **步骤 1：编写失败的有界队列测试**

```text
import { describe, expect, it, vi } from 'vitest'
import { FrameQueue, FrameQueueOverflowError } from '../src/frame-queue.ts'

describe('FrameQueue', () => {
  it('fails one stream atomically when a push exceeds capacity', async () => {
    const cleanup = vi.fn()
    const queue = new FrameQueue<number>(2)
    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    expect(queue.push(3)).toBe(false)
    expect(queue.size).toBe(0)
    await expect(async () => {
      for await (const _ of queue.iterate(new AbortController().signal, cleanup)) { /* drain */ }
    }).rejects.toEqual(new FrameQueueOverflowError(2))
    expect(cleanup).toHaveBeenCalledOnce()
    expect(queue.push(4)).toBe(false)
  })

  it('drains an exact-capacity queue and cleans up once on abort', async () => {
    const cleanup = vi.fn()
    const abort = new AbortController()
    const queue = new FrameQueue<number>(2)
    queue.push(1)
    queue.push(2)
    const seen: number[] = []
    const consuming = (async () => {
      for await (const value of queue.iterate(abort.signal, cleanup)) {
        seen.push(value)
        if (seen.length === 2) abort.abort()
      }
    })()
    await consuming
    expect(seen).toEqual([1, 2])
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
```

- [ ] **步骤 2：运行新测试并验证因缺少模块而失败**

运行：`pnpm exec vitest run packages/host/apiproxy/tests -t "FrameQueue"`

预期：FAIL，因为 `../src/frame-queue.ts` 不存在。

- [ ] **步骤 3：实现有界队列**

```ts
/** Raised when one event stream outruns its configured retained-frame capacity. */
export class FrameQueueOverflowError extends Error {
  /** @param capacity - Maximum retained frames for the failed stream. */
  constructor(readonly capacity: number) {
    super(`event stream exceeded its ${String(capacity)}-frame queue capacity`)
    this.name = 'FrameQueueOverflowError'
  }
}

/** Bounded callback-to-AsyncIterable queue with one cleanup settlement. */
export class FrameQueue<F> {
  private buffer: F[] = []
  private waiter: (() => void) | undefined
  private done = false
  private failure: Error | undefined

  /** @param capacity - Positive maximum number of retained frames. */
  constructor(private readonly capacity: number) {}

  /** Number of frames currently retained for the consumer. */
  get size(): number { return this.buffer.length }

  /** @returns whether the frame was accepted. */
  push(item: F): boolean {
    if (this.done) return false
    if (this.buffer.length >= this.capacity) {
      this.failure = new FrameQueueOverflowError(this.capacity)
      this.buffer = []
      this.done = true
      this.wake()
      return false
    }
    this.buffer.push(item)
    this.wake()
    return true
  }

  /** Finish without an error. */
  end(): void {
    if (this.done) return
    this.done = true
    this.wake()
  }

  /** Iterate until completion, abort, or overflow. */
  async * iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        if (this.failure !== undefined) throw this.failure
        while (this.buffer.length > 0) yield this.buffer.shift() as F
        if (this.failure !== undefined) throw this.failure
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.buffer = []
      cleanup()
    }
  }

  private wake(): void {
    this.waiter?.()
    this.waiter = undefined
  }
}
```

- [ ] **步骤 4：通过 ApiProxy 配置接入容量**

把旧的私有 `FrameQueue` 移出 `api-proxy.ts`，导入新类，并增加这个解析默认值：

```ts
export const DEFAULT_MAX_EVENT_STREAM_QUEUE_FRAMES = 4096
```

在 `ApiProxyDefaults` 与 `Config` 中增加 `maxEventStreamQueueFrames?: number`，使用 `z.natural().min(1).default(DEFAULT_MAX_EVENT_STREAM_QUEUE_FRAMES)` 验证，从 `ApiProxyService` 传入，在 `createApiProxy` 中只解析一次，并按以下方式构造两条流的队列：

```text
const queue = new FrameQueue<RpcRequest<MuxFrame>>(maxEventStreamQueueFrames)
const queue = new FrameQueue<RpcRequest<HostFrame>>(maxEventStreamQueueFrames)
```

更新 `session-export.spec.ts`，使完整默认对象包含 `maxEventStreamQueueFrames: 4096`，接受 `1` 与 `8192`，拒绝 `0`、`-1`、`1.5` 与 `Number.POSITIVE_INFINITY`。

- [ ] **步骤 5：运行聚焦队列与配置测试**

运行：`pnpm exec vitest run packages/host/apiproxy/tests/session-export.spec.ts packages/host/apiproxy/tests -t "FrameQueue|session export compression config|cold blank probe config"`

预期：PASS。

运行：`pnpm exec tsc -b packages/host/apiproxy`

预期：PASS，且无诊断。

- [ ] **步骤 6：记录并提交宿主队列约定**

同步更新两个 README 语言版本，说明配置默认值、overflow 行为、listener 释放与持久 history 恢复；重新记录配对后提交：

```bash
pnpm run verify-translation-pairing --write packages/host/apiproxy/README.md
git add packages/host/apiproxy
git commit -m "fix(apiproxy): bound event stream queues"
```

## 任务 3：增加 WebSocket 压缩与慢消费者熔断

**文件：**

- 修改：`packages/client/connection/src/websocket-downlink.ts`
- 修改：`packages/client/connection/src/index.ts`
- 修改：`packages/client/connection/tests/websocket-downlink.host.spec.ts`
- 修改：`packages/client/connection/tests/node-half.host.spec.ts`
- 修改：`packages/client/connection/README.md`
- 修改：`packages/client/connection/README.zh.md`
- 修改：`packages/client/connection/README.i18n.yaml`

- [ ] **步骤 1：编写失败的配置与协商测试**

在 `node-half.host.spec.ts` 中增加以下期望默认值：

```text
expect(Config({})).toEqual({
  trustedHosts: [],
  maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
  downlinkCompression: false,
  downlinkCompressionThresholdBytes: 0,
  downlinkCompressionConcurrency: 4,
  downlinkMaxBufferedBytes: 1024 * 1024,
  downlinkSendTimeoutMs: 5_000,
})
```

拒绝为零或负数的发送预算、零并发、非整数以及超过 64 的并发。在 `websocket-downlink.host.spec.ts` 中分别增加关闭和开启压缩的服务器；`open` 后断言第一个客户端的 `extensions` 为空，第二个包含 `permessage-deflate`。

- [ ] **步骤 2：编写失败的字节熔断、timeout 与 peer 隔离测试**

使用测试 helper 已暴露的服务端 accepted socket。字节场景把 `bufferedAmount` stub 到配置上限之上；timeout 场景 stub `send` 且不调用 callback，并使用 20 ms 期限。两个场景都断言客户端关闭与来源 abort。在 timeout 测试中再打开一个健康客户端，向其 yield 一条 `session/subscribed` 帧，并断言慢 peer 关闭后它仍收到该帧。

```text
const downlinks = new WebSocketDownlinks(api(muxSource, idle), {
  compression: false,
  compressionThresholdBytes: 0,
  compressionConcurrency: 1,
  maxBufferedBytes: 1024,
  sendTimeoutMs: 20,
})
```

- [ ] **步骤 3：运行聚焦测试并验证失败**

运行：`pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/websocket-downlink.host.spec.ts`

预期：FAIL，因为新配置字段/选项与熔断行为尚不存在。

- [ ] **步骤 4：实现解析后的下行选项与压缩协商**

```ts
export interface WebSocketDownlinkOptions {
  compression: boolean
  compressionThresholdBytes: number
  compressionConcurrency: number
  maxBufferedBytes: number
  sendTimeoutMs: number
}

export const DEFAULT_WEBSOCKET_DOWNLINK_OPTIONS: Readonly<WebSocketDownlinkOptions> = {
  compression: false,
  compressionThresholdBytes: 0,
  compressionConcurrency: 4,
  maxBufferedBytes: 1024 * 1024,
  sendTimeoutMs: 5_000,
}
```

在 `WebSocketDownlinks` 构造函数中创建 `WebSocketServer`，设置 `noServer: true`，并按配置选择 `perMessageDeflate: false` 或以下对象：

```text
{
  threshold: options.compressionThresholdBytes,
  concurrencyLimit: options.compressionConcurrency,
}
```

不要禁用 context takeover；基准必须测量选定的流策略。

- [ ] **步骤 5：实现带字节/时间失败的串行发送**

用新 helper 替换无限制的 `send`：只序列化一次，在 `socket.send` 前后检查 `bufferedAmount`，设置一个计时器，在所有 settle 路径清除它，并在字节或 timeout 失败 rejection 前调用 `socket.terminate()`。使用只包含配置限制与类别的稳定诊断：

```text
throw new Error(`websocket downlink buffered bytes exceeded ${String(options.maxBufferedBytes)}`)
throw new Error(`websocket downlink send exceeded ${String(options.sendTimeoutMs)} ms`)
```

每轮 pump 继续只 await 一次 send。既有 pump catch 可以尝试发送一次 `stream/error`；已 terminate 的 socket 会让这次尝试无害失败，然后共享 `finally` 中止来源。确保 `close()` 仍等待每个来源 iterator。

- [ ] **步骤 6：验证并传入插件配置**

把上述字段加入 `ConnectionConfig` 与 `Config`，使用给定默认值。threshold 验证为自然整数，并发验证为 1 至 64 的整数，字节/时间预算验证为正自然整数。从 `apply()` 向 `new WebSocketDownlinks(...)` 传入完整 `WebSocketDownlinkOptions` 对象。

- [ ] **步骤 7：运行聚焦测试并记录载体约定**

运行：`pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/websocket-downlink.host.spec.ts packages/client/connection/tests/connection.client.spec.ts`

预期：PASS，包括不变的重连 generation 测试集。

运行：`pnpm exec tsc -b packages/client/connection`

预期：PASS，且无诊断。

同步更新两个 README 语言版本，说明协商、所有默认值、失败 cleanup 与 history 恢复；重新记录并提交：

```bash
pnpm run verify-translation-pairing --write packages/client/connection/README.md
git add packages/client/connection
git commit -m "fix(connection): fuse slow websocket downlinks"
```

## 任务 4：渲染即时且无障碍可感知的提交反馈

**文件：**

- 修改：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`
- 修改：`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css`
- 修改：`packages/client/ui-conversation/src/client/locales.ts`
- 修改：`packages/client/ui-conversation/tests/input-bar.client.spec.tsx`
- 修改：`packages/client/ui-conversation/README.md`
- 修改：`packages/client/ui-conversation/README.zh.md`
- 修改：`packages/client/ui-conversation/README.i18n.yaml`

- [ ] **步骤 1：强化失败的 pending 状态测试**

向 `BenchOptions` 增加可选 `submit` sink，并让 `bench()` 在提供它时使用。通过生产 locale map 向测试字典增加 `input.sending`，然后使用 deferred sink 扩展既有 `machine pending lock` 测试集，使 settlement 无法抢先于断言：

```text
it.each([
  ['Enter', (result: ReturnType<typeof bench>) => fireEvent.keyDown(result.textarea, { key: 'Enter' })],
  ['button', (result: ReturnType<typeof bench>) => fireEvent.click(result.button)],
])('%s submission exposes feedback synchronously', async (_name, submit) => {
  const pending = Promise.withResolvers<SubmitOutcome>()
  const result = bench({ draft: 'hello', submit: () => pending.promise })
  submit(result)
  expect(result.shell.snapshot.phase).toBe('submitting')
  expect(result.view.getByRole('status').textContent).toBe('发送中…')
  const button = result.view.getByRole('button', { name: '发送中…' })
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.querySelector('[data-submit-pending]')).not.toBeNull()
  expect(result.textarea.readOnly).toBe(true)
  await act(async () => { pending.resolve({ kind: 'success' }) })
})
```

增加一个显式 resolve sink 的成功结束测试，并断言状态消失、按钮恢复为 `发送消息`、`aria-busy` 不存在且草稿清空。增加失败场景，断言状态消失且草稿仍可重试。

- [ ] **步骤 2：运行测试并验证因缺少状态而失败**

运行：`pnpm exec vitest run packages/client/ui-conversation/tests/input-bar.client.spec.tsx -t "machine pending lock"`

预期：FAIL，因为尚未渲染 status 或 pending 标记。

- [ ] **步骤 3：实现本地化 pending 呈现**

在两个 locale map 中加入 `'input.sending': '发送中…'` 与 `'input.sending': 'Sending…'`。在 `InputBar.tsx` 中使 submitting 优先决定 `primaryLabel`，渲染一个同级实时 status，并在 `machineBusy` 时替换发送箭头：

```text
const pendingPrimary = machineBusy && !primaryStops
const primaryLabel = primaryStops ? t('input.stop') : pendingPrimary ? t('input.sending') : t('input.send')

{machineBusy && <span className={css.visuallyHidden} role="status">{t('input.sending')}</span>}

<button
  type="button"
  className={css.primary}
  aria-label={primaryLabel}
  aria-busy={pendingPrimary || undefined}
  disabled={primaryStops ? stop === undefined : empty || disabled || machineBusy}
  onMouseDown={keepFocus}
  onClick={onPrimary}
>
  {pendingPrimary
    ? <span aria-hidden className={css.pending} data-submit-pending />
    : primaryStops ? (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
      </svg>
    ) : (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
      </svg>
    )}
</button>
```

为 `.visuallyHidden` 增加标准裁剪规则：绝对定位 1 px box、零 margin、隐藏 overflow、`clip-path: inset(50%)` 与 `white-space: nowrap`。保持 `.pending` 为 8 px，并在 `prefers-reduced-motion: reduce` 下禁用动画。

- [ ] **步骤 4：运行 UI 测试并提交**

运行：`pnpm exec vitest run packages/client/ui-conversation/tests/input-bar.client.spec.tsx scripts/locale-dictionary-parity.spec.ts`

预期：PASS。

运行：`pnpm exec tsc -b packages/client/ui-conversation`

预期：PASS，且无诊断。

记录 pending 状态属于本地传输回执，而可见用户气泡仍要求持久 `user/message` 事件。重新记录 README 配对。

```bash
pnpm run verify-translation-pairing --write packages/client/ui-conversation/README.md
git add packages/client/ui-conversation
git commit -m "fix(conversation): show immediate send feedback"
```

## 任务 5：固定真实浏览器反馈与重连一致性

**文件：**

- 新建：`apps/web/tests/submit-feedback.e2e.ts`
- 新建：`apps/web/tests/snapshots/submit-feedback/pending.expected.md`
- 修改：`packages/client/runtime/tests/session.client.spec.ts`

- [ ] **步骤 1：增加恰好一次 resync 回归测试**

在既有 `describe('resync')` 中加载一个完整 turn，只注入下一 turn 的实时用户事件，把 history response 替换为两个完整 turn，再调用 `resync()`：

```text
it('replaces a partial live generation with exactly-once durable messages', async () => {
  const { api, session } = makeSession()
  const first = plainTurn(0, 0, 'first user', 'first assistant')
  const second = plainTurn(6, 1, 'second user', 'second assistant')
  api.onHistory = () => histResponse(first)
  await session.open()
  const liveUser = second.find(event => event.type === 'user/message')!
  session.handleMuxEnvelope('live-user' as never, { type: 'session/event', sessionId: SID, event: liveUser })
  api.onHistory = () => histResponse([...first, ...second])
  await session.resync()
  const messages = chatEvents(session.getSnapshot()).flatMap(({ event }) =>
    event.type === 'user/message'
      ? [`user:${event.data.content.map(block => block.type === 'text' ? block.text : '').join('')}`]
      : event.type === 'assistant/message'
        ? [`assistant:${event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')}`]
        : [])
  expect(messages).toEqual([
    'user:first user', 'assistant:first assistant',
    'user:second user', 'assistant:second assistant',
  ])
})
```

- [ ] **步骤 2：增加挂起宿主 admission 的真实浏览器测试**

创建 `submit-feedback.e2e.ts`，使用 `launchWebScaffold`、Chromium、`connectFreshWorkspace`，以及 `apps/web/tests/snapshots/live-interactions/session.jsonl` 中的已录制 fixture。按 Enter 前安装 `page.route('**/api/session.prompt', ...)` handler，捕获 `Route` 并保持 pending。预先设置 `whenTurnSettled`，提交 fixture 的精确提示词，等待一次 `requestAnimationFrame`，并在调用 `route.continue()` 前断言以下全部事实：

```text
await expect(page.getByRole('status').filter({ hasText: 'Sending…' })).toBeVisible()
await expect(page.getByRole('button', { name: 'Sending…' })).toHaveAttribute('aria-busy', 'true')
expect(sessionEvents).toEqual([])
```

通过 `captureStableAria` 与 `compareOrRefreshGolden` 捕获 `[class*="centerCol"]`，继续被挂起的请求，等待 turn settlement，并要求出现一条用户气泡与 replay 助手文本。断言不存在 page error 或意外 warning，并通过既有 aggregate teardown 模式关闭 browser/scaffold。

- [ ] **步骤 3：记录并重放产品 golden**

运行：`pnpm run build`

预期：PASS。

在 PowerShell 中运行：`$env:DSH_SNAPSHOT='refresh'; pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts; Remove-Item Env:DSH_SNAPSHOT`

预期：PASS，并创建 `pending.expected.md`；其中包含已提交草稿与 `Sending…` 状态，但不包含用户或助手消息。

运行：`pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts`

预期：replay 模式对照已提交 golden 通过。

运行：`pnpm exec vitest run packages/client/runtime/tests/session.client.spec.ts -t "replaces a partial live generation"`

预期：PASS。

- [ ] **步骤 4：提交浏览器与恢复证据**

```bash
git add apps/web/tests/submit-feedback.e2e.ts apps/web/tests/snapshots/submit-feedback/pending.expected.md packages/client/runtime/tests/session.client.spec.ts
git commit -m "test(web): pin send feedback and reconnect recovery"
```

## 任务 6：增加并通过五浏览器下行基准

**文件：**

- 新建：`scripts/websocket-downlink-benchmark-worker.ts`
- 新建：`scripts/websocket-downlink-benchmark.ts`
- 修改：`package.json`

- [ ] **步骤 1：定义隔离 worker 报告与代表性负载**

worker 只接受 `--compression=on` 或 `--compression=off`，并输出一行符合以下 interface 的 JSON：

```ts
interface DownlinkBenchmarkReport {
  compression: boolean
  browsers: 5
  downlinks: 10
  muxFramesPerBrowser: 24000
  hostFramesPerBrowser: 256
  serializedBytes: number
  transportBytes: number
  wallMs: number
  peakQueueFrames: number
  rssDeltaBytes: number
}
```

启动一个真实 `node:http` upgrade server 与一个 `WebSocketDownlinks`。打开 5 个 mux `ws` 客户端和 5 个 host 客户端。每个 mux 来源使用真实 `FrameQueue<RpcRequest<MuxFrame>>(4096)`，以 `setImmediate` 调度的每批 64 条方式产生 24,000 个确定性 `session/event` 帧；使用固定非秘密文本循环生成 `reasoning-delta`、`text-delta` 与 `tool-call-delta` payload。每个 host 来源发送 256 个确定性 `host/remote-event` 帧。每次接受 push 后跟踪 `queue.size`，每 5 ms 采样 `process.memoryUsage().rss`，汇总每个客户端底层 socket 的 `bytesRead`，并在打印报告前关闭全部 socket、来源、downlink、timer 与 HTTP server。

- [ ] **步骤 2：实现父级门槛**

每个模式都使用 `--import tsx` 启动新的 Node 进程，使 RSS 基线不共享 zlib 状态。每个子进程只解析一份 JSON 报告，并执行以下门槛：

```text
const byteReduction = 1 - compressed.transportBytes / plain.transportBytes
const RSS_LIMIT_BYTES = 64 * 1024 * 1024
if (compressed.serializedBytes !== plain.serializedBytes) {
  throw new Error('websocket benchmark modes did not carry identical application payloads')
}
if (byteReduction < 0.60) {
  throw new Error(`websocket compression reduced transport bytes by only ${(byteReduction * 100).toFixed(1)}%`)
}
if (compressed.rssDeltaBytes > RSS_LIMIT_BYTES) {
  throw new Error(`websocket compression added ${String(compressed.rssDeltaBytes)} RSS bytes`)
}
if (compressed.peakQueueFrames > 4096 || plain.peakQueueFrames > 4096) {
  throw new Error('websocket benchmark exceeded the configured source queue capacity')
}
process.stdout.write(`${JSON.stringify({ plain, compressed, byteReduction })}\n`)
```

增加这个根脚本：

```json
"benchmark:websocket-downlinks": "tsx scripts/websocket-downlink-benchmark.ts"
```

- [ ] **步骤 3：运行基准门槛**

运行：`pnpm run benchmark:websocket-downlinks`

预期：PASS，且 `browsers: 5`、`downlinks: 10`、字节降低至少 `0.60`、`rssDeltaBytes` 不超过 `67108864`，两个模式的 `peakQueueFrames` 都不超过 `4096`。

如果门槛失败，在编辑生产覆盖层前停止实施。保留报告，保持压缩关闭，并返回已批准设计，明确制定批处理修订。

- [ ] **步骤 4：提交可复现基准**

```bash
git add package.json scripts/websocket-downlink-benchmark.ts scripts/websocket-downlink-benchmark-worker.ts
git commit -m "test(connection): gate websocket compression cost"
```

## 任务 7：在阿里云覆盖层启用经过测量的策略

**文件：**

- 修改：`deploy/alibaba-cloud/invite-auth.cordis.yml`
- 修改：`scripts/alibaba-cloud-deployment.spec.ts`
- 修改：`deploy/alibaba-cloud/package-release.sh`
- 修改：`deploy/alibaba-cloud/README.md`
- 修改：`deploy/alibaba-cloud/README.zh.md`
- 修改：`deploy/alibaba-cloud/README.i18n.yaml`

- [ ] **步骤 1：编写失败的部署断言**

解析或检查部署覆盖层，要求 `api-gateway` row 设置 `maxEventStreamQueueFrames: 4096`。要求 `connection` row 保留 `inject: [webRuntime]` 与动态 `trustedHosts` 表达式，同时设置 compression true、threshold 0、concurrency 4、buffered bytes 1,048,576 和 send timeout 5,000。要求 `package-release.sh` 在 `pnpm run build` 前运行聚焦 ApiProxy/connection/deployment 测试与 `pnpm run benchmark:websocket-downlinks`。

```text
expect(overlay).toContain('maxEventStreamQueueFrames: 4096')
expect(overlay).toContain('downlinkCompression: true')
expect(overlay).toContain('downlinkCompressionThresholdBytes: 0')
expect(overlay).toContain('downlinkCompressionConcurrency: 4')
expect(overlay).toContain('downlinkMaxBufferedBytes: 1048576')
expect(overlay).toContain('downlinkSendTimeoutMs: 5000')
expect(packager.indexOf('pnpm run benchmark:websocket-downlinks'))
  .toBeLessThan(packager.indexOf('pnpm run build'))
```

- [ ] **步骤 2：运行部署测试并验证失败**

运行：`pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts`

预期：FAIL，因为生产策略不存在。

- [ ] **步骤 3：显式 patch 生产 row**

```yaml
- id: api-gateway
  config:
    maxEventStreamQueueFrames: 4096
- id: connection
  inject: [webRuntime]
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    downlinkCompression: true
    downlinkCompressionThresholdBytes: 0
    downlinkCompressionConcurrency: 4
    downlinkMaxBufferedBytes: 1048576
    downlinkSendTimeoutMs: 5000
```

保持既有 invite-auth insertion 与 web-runtime patch 不变。在 packager container 内运行既有 invite 测试以及 `frame-queue.spec.ts`、`websocket-downlink.host.spec.ts`、`node-half.host.spec.ts` 和 `alibaba-cloud-deployment.spec.ts`，再在 `pnpm run build` 前运行基准，使精确的 Linux artifact 环境拥有 release 门槛。

- [ ] **步骤 4：测试解析配置与部署资产**

运行：`pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts packages/client/connection/tests/node-half.host.spec.ts`

运行：`pnpm exec vitest run packages/host/apiproxy/tests -t "FrameQueue"`

预期：PASS。

运行：`pnpm run verify-cordis-config`

预期：PASS。

build 后运行：`node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config`

预期：解析后的 `api-gateway` 与 `connection` row 显示全部生产值，命令以 0 退出。

- [ ] **步骤 5：记录操作并提交**

记录显式限制、可恢复的 `reconnecting` 状态、基准命令，以及重复慢客户端关闭时应诊断网络而非扩大无限缓冲的规则。重新记录部署 README 配对并提交：

```bash
pnpm run verify-translation-pairing --write deploy/alibaba-cloud/README.md
git add deploy/alibaba-cloud scripts/alibaba-cloud-deployment.spec.ts
git commit -m "deploy: enable bounded compressed downlinks"
```

## 任务 8：完成理由记录、验证、打包、部署与 canary

**文件：**

- 移动：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md` 到 `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.md`
- 移动：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.zh.md` 到 `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.zh.md`
- 移动：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml` 到 `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml`
- 重新生成：`docs/config-catalog.md`
- 修改：`docs/config-catalog.zh.md`
- 修改：`docs/config-catalog.i18n.yaml`

- [ ] **步骤 1：把 Agent Note 推进为当前已发布事实**

对三份配对文件都使用 `git mv`。把 `Status: proposed` 改成 `Status: implemented`，把 `## Proposal` 改成 `## Decision`，用 `## Consequences` 取代未来时态的 acceptance/risk section，并以现在时记录测量得到的字节/RSS 结果和精确已发布默认值。保留 `## Alternatives considered`。重新记录新配对路径。

- [ ] **步骤 2：重新生成并配对配置参考**

运行：`pnpm run gen-config-catalog`

预期：英文目录包含 6 个新字段及其默认值。

只更新 `docs/config-catalog.zh.md` 中对应的生成 row，保留其生成结构，然后运行：

```bash
pnpm run verify-translation-pairing --write .agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.md
pnpm run verify-translation-pairing --write docs/config-catalog.md
```

- [ ] **步骤 3：运行最小但完整的本地证据集**

按顺序各运行一次：

```bash
pnpm exec vitest run packages/host/apiproxy/tests/session-export.spec.ts packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/websocket-downlink.host.spec.ts packages/client/connection/tests/connection.client.spec.ts packages/client/runtime/tests/session.client.spec.ts packages/client/ui-conversation/tests/input-bar.client.spec.tsx scripts/alibaba-cloud-deployment.spec.ts
pnpm exec vitest run packages/host/apiproxy/tests -t "FrameQueue"
pnpm run benchmark:websocket-downlinks
pnpm run typecheck
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts
pnpm run verify-cordis-config
pnpm run doc-sync
pnpm run lint
git diff --check
```

预期：所有行为/build/config 命令通过。在 Windows 上，如果只有 `doc-sync` 在创建 `project-doc-site.spec.ts` 越界 symlink fixture 时报告 `EPERM`，保留精确输出，要求其他所有文档 gate 通过，并显式报告该平台例外；不得把 `doc-sync` 本身描述为通过。

- [ ] **步骤 4：提交 implemented 决策与生成文档**

```bash
git add .agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.* docs/config-catalog.md docs/config-catalog.zh.md docs/config-catalog.i18n.yaml
git commit -m "docs: finalize web backpressure contract"
git status --short
```

预期：提交成功且 worktree 干净。

- [ ] **步骤 5：在 WSL/Linux 中打包精确已评审分支**

只有上述全部提交都能从既有具名部署分支到达时才使用它：

```bash
set -euo pipefail
cd /mnt/d/Code/mydsh
DEPLOY_REF=refs/heads/feat/invite-auth-deployment
LOCAL_STAGE=$(mktemp -d)
PACKAGER_STAGE=$(mktemp -d)
trap 'rm -rf -- "$LOCAL_STAGE" "$PACKAGER_STAGE"' EXIT
git archive "$DEPLOY_REF" deploy/alibaba-cloud/package-release.sh | tar -x -C "$PACKAGER_STAGE"
bash "$PACKAGER_STAGE/deploy/alibaba-cloud/package-release.sh" "$DEPLOY_REF" "$LOCAL_STAGE"
ARTIFACT_SET=$(find "$LOCAL_STAGE" -maxdepth 1 -type d -name 'mydsh-release-*')
[[ -d $ARTIFACT_SET ]]
printf '%s\n' "$ARTIFACT_SET"
```

预期：Linux container 通过聚焦测试、基准、build、config 与 artifact 验证，然后打印一个以 commit 命名的 artifact-set 目录。它不得打印邀请码或 Kimi 秘密。

- [ ] **步骤 6：通过已安装 helper 上传并激活**

在同一 WSL shell 中保持 `ARTIFACT_SET` 已设置：

```bash
REMOTE=root@120.24.146.133
KEY=/mnt/c/Users/a8798/.ssh/person.pem
REMOTE_STAGE=$(ssh -i "$KEY" -p 22 "$REMOTE" 'mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
[[ $REMOTE_STAGE =~ ^/[A-Za-z0-9._/-]+/mydsh-deploy\.[A-Za-z0-9]{6}$ ]]
scp -i "$KEY" -P 22 -r "$ARTIFACT_SET" "$REMOTE:$REMOTE_STAGE/"
ssh -i "$KEY" -p 22 -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release './${ARTIFACT_SET##*/}'; status=\$?; if [[ \$status == 0 ]]; then rm -rf -- '$REMOTE_STAGE'; else printf 'Upgrade failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; fi; exit \$status"
```

预期：helper 在公开与已认证验收后报告新的完整 commit；失败时自动回滚。

- [ ] **步骤 7：运行生产 canary 检查**

验证公开健康状态与非秘密服务器状态：

```bash
curl --fail --silent --show-error --output /dev/null https://www.jingjunmai.com/__invite/login
ssh -i /mnt/c/Users/a8798/.ssh/person.pem -p 22 root@120.24.146.133 'systemctl is-active caddy mydsh; readlink -f /opt/mydsh/current; ss -ltnp "( sport = :80 or sport = :443 or sport = :3080 )"'
```

预期：两个服务都为 active，`current` 指向新 commit，DSH 只监听 `127.0.0.1:3080`。

打开 2 至 5 个已认证浏览器。把一个浏览器置于限速连接，从健康浏览器提交，并验证：健康输入框在下一次绘制前显示 `Sending…`；用户气泡与助手输出逐步出现，不存在数秒空白；限速浏览器报告 reconnecting，随后显示一条完整用户消息与一条完整助手结果；模型运行不因该浏览器断线而停止。运行期间只通过 `ss -tinp` 与服务 RSS 检查队列/socket metadata；不得记录提示词、响应、Cookie、邀请码或凭据内容。

- [ ] **步骤 8：记录最终证据**

报告已部署 commit、基准字节降幅、压缩 RSS 增量、实际运行的聚焦命令、公开服务/listener 状态与多浏览器 canary 结果。如果 canary 失败，使用已安装 helper 对上一个已知良好的 40 字符 release commit 执行回滚，并保留失败 release 供诊断。
