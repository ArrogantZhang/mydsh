# DSH Web Realtime Backpressure Implementation Plan

English | [中文](2026-08-27-web-realtime-backpressure.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Web prompt submission visibly immediate and keep live conversations responsive and memory-bounded for two to five simultaneous public browsers.

**Architecture:** The composer renders its synchronous input-machine submission state before any host event returns. `host-apiproxy` bounds each event-stream queue, while `client-connection` negotiates optional `permessage-deflate` and terminates only a downlink that exceeds its socket-byte or send-time budget; the existing connection generation and session-history resync restore durable events after reconnect.

**Tech Stack:** TypeScript 6, React 18, Cordis, Schemastery, `ws` 8.21, Vitest 4, Playwright/Chromium, Node.js 24, pnpm 11.7, Caddy, systemd, Bash.

**Design:** [Approved design](../specs/2026-08-27-web-realtime-backpressure-design.md)

---

## File map

### Host event queue

- `packages/host/apiproxy/src/` + `frame-queue.ts` — bounded callback-to-async-iterator queue and overflow error.
- `packages/host/apiproxy/src/api-proxy.ts` — constructs mux and host queues with the resolved capacity.
- `packages/host/apiproxy/src/index.ts` — validates and forwards `maxEventStreamQueueFrames`.
- `packages/host/apiproxy/tests/` + `frame-queue.spec.ts` — capacity, overflow, abort, and cleanup races.
- `packages/host/apiproxy/tests/session-export.spec.ts` — complete gateway config defaults and invalid bounds.
- `packages/host/apiproxy/README.md`, `README.zh.md`, `README.i18n.yaml` — event-stream resource contract.

### WebSocket downlinks

- `packages/client/connection/src/websocket-downlink.ts` — compression negotiation, serialized send deadline, buffered-byte fuse, and idempotent cleanup.
- `packages/client/connection/src/index.ts` — validates deployment tunables and passes resolved values to the carrier.
- `packages/client/connection/tests/websocket-downlink.host.spec.ts` — negotiation, slow reader, timeout, peer isolation, and teardown.
- `packages/client/connection/tests/node-half.host.spec.ts` — config defaults, invalid ranges, and plugin wiring.
- `packages/client/connection/README.md`, `README.zh.md`, `README.i18n.yaml` — downlink configuration and recovery behavior.

### Product feedback and recovery

- `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` — visible pending mark, busy semantics, and live status text.
- `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` — pending and visually-hidden status styles.
- `packages/client/ui-conversation/src/client/locales.ts` — Chinese and English sending labels.
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx` — immediate keyboard/button feedback and settled-state cleanup.
- `packages/client/ui-conversation/README.md`, `README.zh.md`, `README.i18n.yaml` — local-receipt semantics and durable-bubble ownership.
- `packages/client/runtime/tests/session.client.spec.ts` — exactly-once visible history after a transport-generation resync.
- `apps/web/tests/submit-feedback.e2e.ts` — real HTTP/Web composition with `session.prompt` held before host admission.
- `apps/web/tests/snapshots/submit-feedback/pending.expected.md` — keyless product-visible ARIA golden.

### Benchmark and deployment

- `scripts/websocket-downlink-benchmark-worker.ts` — one isolated compression mode with five mux and five host sockets.
- `scripts/websocket-downlink-benchmark.ts` — compares child reports and enforces byte/RSS gates.
- `package.json` — `benchmark:websocket-downlinks` command.
- `deploy/alibaba-cloud/invite-auth.cordis.yml` — explicit production queue, compression, byte, and time values.
- `scripts/alibaba-cloud-deployment.spec.ts` — deployment overlay and packager-gate assertions.
- `deploy/alibaba-cloud/package-release.sh` — runs the deterministic downlink benchmark before artifact publication.
- `deploy/alibaba-cloud/README.md`, `README.zh.md`, `README.i18n.yaml` — production values and slow-client recovery operations.

### Decision record

- `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`, `.zh.md`, `.i18n.yaml` — proposal-era decision record.
- `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.md`, `.zh.md`, `.i18n.yaml` — final current-state decision after all acceptance checks pass.

## Task 1: Record the transport and UI decision

**Files:**

- Create: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`
- Create: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.zh.md`
- Create: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml`

- [ ] **Step 1: Write the proposed Agent Note pair**

Use the mandatory proposed-note headings in this exact order:

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

The note must state these decisions without implementation chronology: the durable log remains authoritative; the composer exposes only a local receipt; `host-apiproxy` owns frame capacity; `client-connection` owns compression and socket budgets; overflow closes one stream without aborting the agent; reconnect rebuilds from `session/subscribed.lastSeq` and history; batching is deferred unless compression misses its measured gate; lossy chunk coalescing is rejected.

- [ ] **Step 2: Record and validate the bilingual pair**

Run: `pnpm run verify-translation-pairing --write .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`

Expected: one record written.

Run: `pnpm run verify-translation-pairing -- .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`

Expected: `1 named pair(s) consistent`.

Run: `pnpm run verify-agent-note-format && pnpm run verify-agent-note-classification`

Expected: both commands pass.

- [ ] **Step 3: Commit the proposed decision**

```bash
git add .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.*
git commit -m "docs: record web backpressure decision"
```

## Task 2: Bound ApiProxy event-stream queues

**Files:**

- Create under `packages/host/apiproxy/src/`: `frame-queue.ts`
- Create under `packages/host/apiproxy/tests/`: `frame-queue.spec.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/src/index.ts`
- Modify: `packages/host/apiproxy/tests/session-export.spec.ts`
- Modify: `packages/host/apiproxy/README.md`
- Modify: `packages/host/apiproxy/README.zh.md`
- Modify: `packages/host/apiproxy/README.i18n.yaml`

- [ ] **Step 1: Write failing bounded-queue tests**

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

- [ ] **Step 2: Run the new test and verify the missing module fails**

Run: `pnpm exec vitest run packages/host/apiproxy/tests -t "FrameQueue"`

Expected: FAIL because `../src/frame-queue.ts` does not exist.

- [ ] **Step 3: Implement the bounded queue**

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

- [ ] **Step 4: Wire the capacity through ApiProxy config**

Move the old private `FrameQueue` out of `api-proxy.ts`, import the new class, and add this resolved default:

```ts
export const DEFAULT_MAX_EVENT_STREAM_QUEUE_FRAMES = 4096
```

Add `maxEventStreamQueueFrames?: number` to `ApiProxyDefaults` and `Config`, validate it with `z.natural().min(1).default(DEFAULT_MAX_EVENT_STREAM_QUEUE_FRAMES)`, forward it from `ApiProxyService`, resolve it once in `createApiProxy`, and construct both stream queues as follows:

```text
const queue = new FrameQueue<RpcRequest<MuxFrame>>(maxEventStreamQueueFrames)
const queue = new FrameQueue<RpcRequest<HostFrame>>(maxEventStreamQueueFrames)
```

Update `session-export.spec.ts` so the complete default object contains `maxEventStreamQueueFrames: 4096`, accepts `1` and `8192`, and rejects `0`, `-1`, `1.5`, and `Number.POSITIVE_INFINITY`.

- [ ] **Step 5: Run focused queue and config tests**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/session-export.spec.ts packages/host/apiproxy/tests -t "FrameQueue|session export compression config|cold blank probe config"`

Expected: PASS.

Run: `pnpm exec tsc -b packages/host/apiproxy`

Expected: PASS with no diagnostics.

- [ ] **Step 6: Document and commit the Host queue contract**

Update both README languages with the config default, overflow behavior, listener disposal, and durable-history recovery. Re-record the pair, then commit:

```bash
pnpm run verify-translation-pairing --write packages/host/apiproxy/README.md
git add packages/host/apiproxy
git commit -m "fix(apiproxy): bound event stream queues"
```

## Task 3: Add WebSocket compression and a slow-consumer fuse

**Files:**

- Modify: `packages/client/connection/src/websocket-downlink.ts`
- Modify: `packages/client/connection/src/index.ts`
- Modify: `packages/client/connection/tests/websocket-downlink.host.spec.ts`
- Modify: `packages/client/connection/tests/node-half.host.spec.ts`
- Modify: `packages/client/connection/README.md`
- Modify: `packages/client/connection/README.zh.md`
- Modify: `packages/client/connection/README.i18n.yaml`

- [ ] **Step 1: Write failing config and negotiation tests**

Add these expected defaults to `node-half.host.spec.ts`:

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

Reject zero/negative send budgets, zero concurrency, fractional integers, and concurrency above 64. In `websocket-downlink.host.spec.ts`, add one server with compression disabled and one enabled; after `open`, assert the first client's `extensions` is empty and the second contains `permessage-deflate`.

- [ ] **Step 2: Write failing byte-fuse, timeout, and peer-isolation tests**

Use the accepted server socket already exposed by the test helper. Stub `bufferedAmount` above the configured maximum for the byte case. For the timeout case, stub `send` without invoking its callback and use a 20 ms deadline. In both cases assert client closure and source abort. Open a second healthy client in the timeout test, yield one `session/subscribed` frame to it, and assert it receives the frame after the slow peer closes.

```text
const downlinks = new WebSocketDownlinks(api(muxSource, idle), {
  compression: false,
  compressionThresholdBytes: 0,
  compressionConcurrency: 1,
  maxBufferedBytes: 1024,
  sendTimeoutMs: 20,
})
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/websocket-downlink.host.spec.ts`

Expected: FAIL because the new config fields/options and fuse behavior are absent.

- [ ] **Step 4: Implement resolved downlink options and compression negotiation**

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

Construct `WebSocketServer` in `WebSocketDownlinks`' constructor with `noServer: true` and either `perMessageDeflate: false` or this object:

```text
{
  threshold: options.compressionThresholdBytes,
  concurrencyLimit: options.compressionConcurrency,
}
```

Do not disable context takeover; the benchmark must measure the selected stream policy.

- [ ] **Step 5: Implement serialized sends with byte/time failure**

Replace the unbounded `send` helper with a helper that serializes once, checks `bufferedAmount` before and after `socket.send`, arms one timer, clears it on every settlement, and calls `socket.terminate()` before rejecting a byte or timeout failure. Use stable diagnostics that contain only the configured limit and category:

```text
throw new Error(`websocket downlink buffered bytes exceeded ${String(options.maxBufferedBytes)}`)
throw new Error(`websocket downlink send exceeded ${String(options.sendTimeoutMs)} ms`)
```

Keep one awaited send per pump iteration. The existing pump catch may attempt one `stream/error`; a terminated socket makes that attempt fail harmlessly before the shared `finally` aborts the source. Ensure `close()` still awaits every source iterator.

- [ ] **Step 6: Validate and pass plugin config**

Add these fields to `ConnectionConfig` and `Config`, using the defaults above. Validate threshold as a natural integer, concurrency as an integer from 1 through 64, and byte/time budgets as positive natural integers. Pass a complete `WebSocketDownlinkOptions` object from `apply()` to `new WebSocketDownlinks(...)`.

- [ ] **Step 7: Run focused tests and document the carrier**

Run: `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/websocket-downlink.host.spec.ts packages/client/connection/tests/connection.client.spec.ts`

Expected: PASS, including the unchanged reconnect-generation suite.

Run: `pnpm exec tsc -b packages/client/connection`

Expected: PASS with no diagnostics.

Update both README languages with negotiation, all defaults, failure cleanup, and history recovery; re-record and commit:

```bash
pnpm run verify-translation-pairing --write packages/client/connection/README.md
git add packages/client/connection
git commit -m "fix(connection): fuse slow websocket downlinks"
```

## Task 4: Render immediate and accessible submission feedback

**Files:**

- Modify: `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`
- Modify: `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css`
- Modify: `packages/client/ui-conversation/src/client/locales.ts`
- Modify: `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`
- Modify: `packages/client/ui-conversation/README.md`
- Modify: `packages/client/ui-conversation/README.zh.md`
- Modify: `packages/client/ui-conversation/README.i18n.yaml`

- [ ] **Step 1: Strengthen the failing pending-state tests**

Add an optional `submit` sink to `BenchOptions` and make `bench()` use it when supplied. Add `input.sending` to the test dictionary through the production locale map, then extend the existing `machine pending lock` suite with a deferred sink so settlement cannot race the assertion:

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

Add a settled-success test whose sink is resolved explicitly and assert that the status disappears, the button returns to `发送消息`, `aria-busy` is absent, and the draft clears. Add a failure case asserting the status disappears and the draft remains available for retry.

- [ ] **Step 2: Run the test and verify the missing status fails**

Run: `pnpm exec vitest run packages/client/ui-conversation/tests/input-bar.client.spec.tsx -t "machine pending lock"`

Expected: FAIL because no status or pending mark is rendered.

- [ ] **Step 3: Implement the localized pending presentation**

Add `'input.sending': '发送中…'` and `'input.sending': 'Sending…'` to the two locale maps. In `InputBar.tsx`, derive `primaryLabel` with submitting priority, render a sibling live status, and replace the send arrow while `machineBusy`:

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

Add the standard clipping rule for `.visuallyHidden`: absolute 1 px box, zero margin, hidden overflow, `clip-path: inset(50%)`, and `white-space: nowrap`. Keep `.pending` at 8 px and add `prefers-reduced-motion: reduce` to disable its animation.

- [ ] **Step 4: Run UI tests and commit**

Run: `pnpm exec vitest run packages/client/ui-conversation/tests/input-bar.client.spec.tsx scripts/locale-dictionary-parity.spec.ts`

Expected: PASS.

Run: `pnpm exec tsc -b packages/client/ui-conversation`

Expected: PASS with no diagnostics.

Document that the pending status is a local transport receipt and that the visible user bubble still requires the durable `user/message` event. Re-record the README pair.

```bash
pnpm run verify-translation-pairing --write packages/client/ui-conversation/README.md
git add packages/client/ui-conversation
git commit -m "fix(conversation): show immediate send feedback"
```

## Task 5: Pin real-browser feedback and reconnect consistency

**Files:**

- Create: `apps/web/tests/submit-feedback.e2e.ts`
- Create: `apps/web/tests/snapshots/submit-feedback/pending.expected.md`
- Modify: `packages/client/runtime/tests/session.client.spec.ts`

- [ ] **Step 1: Add an exactly-once resync regression test**

Inside the existing `describe('resync')`, load one complete turn, inject only the next turn's live user event, replace the history response with both complete turns, and call `resync()`:

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

- [ ] **Step 2: Add a real browser test that holds host admission**

Create `submit-feedback.e2e.ts` using `launchWebScaffold`, Chromium, `connectFreshWorkspace`, and the recorded fixture at `apps/web/tests/snapshots/live-interactions/session.jsonl`. Before pressing Enter, install a `page.route('**/api/session.prompt', ...)` handler that captures the `Route` and leaves it pending. Arm `whenTurnSettled`, submit the fixture's exact prompt, wait one `requestAnimationFrame`, and assert all of these before calling `route.continue()`:

```text
await expect(page.getByRole('status').filter({ hasText: 'Sending…' })).toBeVisible()
await expect(page.getByRole('button', { name: 'Sending…' })).toHaveAttribute('aria-busy', 'true')
expect(sessionEvents).toEqual([])
```

Capture `[class*="centerCol"]` through `captureStableAria` and `compareOrRefreshGolden`, continue the held request, await turn settlement, and require one user bubble plus the replayed assistant text. Assert no page errors or unexpected warnings and close browser/scaffold through the existing aggregate teardown pattern.

- [ ] **Step 3: Record and replay the product golden**

Run: `pnpm run build`

Expected: PASS.

Run in PowerShell: `$env:DSH_SNAPSHOT='refresh'; pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts; Remove-Item Env:DSH_SNAPSHOT`

Expected: PASS and `pending.expected.md` is created with the submitted draft and `Sending…` status, but no user or assistant message.

Run: `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts`

Expected: PASS in replay mode against the committed golden.

Run: `pnpm exec vitest run packages/client/runtime/tests/session.client.spec.ts -t "replaces a partial live generation"`

Expected: PASS.

- [ ] **Step 4: Commit browser and recovery evidence**

```bash
git add apps/web/tests/submit-feedback.e2e.ts apps/web/tests/snapshots/submit-feedback/pending.expected.md packages/client/runtime/tests/session.client.spec.ts
git commit -m "test(web): pin send feedback and reconnect recovery"
```

## Task 6: Add and pass the five-browser downlink benchmark

**Files:**

- Create: `scripts/websocket-downlink-benchmark-worker.ts`
- Create: `scripts/websocket-downlink-benchmark.ts`
- Modify: `package.json`

- [ ] **Step 1: Define the isolated worker report and representative load**

The worker accepts exactly `--compression=on` or `--compression=off` and emits one JSON line matching this interface:

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

Start one real `node:http` upgrade server and one `WebSocketDownlinks`. Open five `ws` clients for mux and five for host. Each mux source uses the real `FrameQueue<RpcRequest<MuxFrame>>(4096)` and produces 24,000 deterministic `session/event` frames in batches of 64 scheduled with `setImmediate`; cycle through `reasoning-delta`, `text-delta`, and `tool-call-delta` payloads with fixed non-secret text. Each host source sends 256 deterministic `host/remote-event` frames. Track `queue.size` after each accepted push, sample `process.memoryUsage().rss` every 5 ms, sum each client's underlying socket `bytesRead`, and close every socket, source, downlink, timer, and HTTP server before printing the report.

- [ ] **Step 2: Implement the parent gate**

Spawn a fresh Node process with `--import tsx` for each mode so RSS baselines do not share zlib state. Parse exactly one JSON report from each child and enforce:

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

Add this root script:

```json
"benchmark:websocket-downlinks": "tsx scripts/websocket-downlink-benchmark.ts"
```

- [ ] **Step 3: Run the benchmark gate**

Run: `pnpm run benchmark:websocket-downlinks`

Expected: PASS with `browsers: 5`, `downlinks: 10`, byte reduction at least `0.60`, `rssDeltaBytes` at most `67108864`, and `peakQueueFrames` at most `4096` for both modes.

If the gate fails, stop implementation before editing the production overlay. Preserve the report, leave compression disabled, and return to the approved design for an explicit batching revision.

- [ ] **Step 4: Commit the reproducible benchmark**

```bash
git add package.json scripts/websocket-downlink-benchmark.ts scripts/websocket-downlink-benchmark-worker.ts
git commit -m "test(connection): gate websocket compression cost"
```

## Task 7: Enable the measured policy in the Alibaba Cloud overlay

**Files:**

- Modify: `deploy/alibaba-cloud/invite-auth.cordis.yml`
- Modify: `scripts/alibaba-cloud-deployment.spec.ts`
- Modify: `deploy/alibaba-cloud/package-release.sh`
- Modify: `deploy/alibaba-cloud/README.md`
- Modify: `deploy/alibaba-cloud/README.zh.md`
- Modify: `deploy/alibaba-cloud/README.i18n.yaml`

- [ ] **Step 1: Write failing deployment assertions**

Parse or inspect the deployment overlay and require the `api-gateway` row to set `maxEventStreamQueueFrames: 4096`. Require the `connection` row to preserve `inject: [webRuntime]` and the dynamic `trustedHosts` expression while setting compression true, threshold 0, concurrency 4, buffered bytes 1,048,576, and send timeout 5,000. Require `package-release.sh` to run the focused ApiProxy/connection/deployment tests and `pnpm run benchmark:websocket-downlinks` before `pnpm run build`.

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

- [ ] **Step 2: Run the deployment test and verify it fails**

Run: `pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts`

Expected: FAIL because the production policy is not present.

- [ ] **Step 3: Patch the production rows explicitly**

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

Keep the existing invite-auth insertion and web-runtime patch unchanged. Inside the packager container, run the existing invite tests plus `frame-queue.spec.ts`, `websocket-downlink.host.spec.ts`, `node-half.host.spec.ts`, and `alibaba-cloud-deployment.spec.ts`, then run the benchmark before `pnpm run build`, so the exact Linux artifact environment owns the release gate.

- [ ] **Step 4: Test resolved configuration and deployment assets**

Run: `pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts packages/client/connection/tests/node-half.host.spec.ts`

Run: `pnpm exec vitest run packages/host/apiproxy/tests -t "FrameQueue"`

Expected: PASS.

Run: `pnpm run verify-cordis-config`

Expected: PASS.

Run after a build: `node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config`

Expected: the resolved `api-gateway` and `connection` rows show all production values and the command exits 0.

- [ ] **Step 5: Document operations and commit**

Document the explicit limits, recoverable `reconnecting` state, the benchmark command, and the rule that repeated slow-client closures call for network diagnosis rather than a larger unlimited buffer. Re-record the deployment README pair and commit:

```bash
pnpm run verify-translation-pairing --write deploy/alibaba-cloud/README.md
git add deploy/alibaba-cloud scripts/alibaba-cloud-deployment.spec.ts
git commit -m "deploy: enable bounded compressed downlinks"
```

## Task 8: Finalize rationale, verify, package, deploy, and canary

**Files:**

- Move: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md` to `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.md`
- Move: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.zh.md` to `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.zh.md`
- Move: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml` to `.agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml`
- Regenerate: `docs/config-catalog.md`
- Modify: `docs/config-catalog.zh.md`
- Modify: `docs/config-catalog.i18n.yaml`

- [ ] **Step 1: Promote the Agent Note to current shipped reality**

Use `git mv` for all three pair files. Change `Status: proposed` to `Status: implemented`, rename `## Proposal` to `## Decision`, replace future-tense acceptance/risk sections with `## Consequences`, and describe the measured byte/RSS result plus the exact shipped defaults in present tense. Preserve `## Alternatives considered`. Re-record the new pair path.

- [ ] **Step 2: Regenerate and pair configuration reference**

Run: `pnpm run gen-config-catalog`

Expected: the English catalog contains the six new fields and their defaults.

Update only the corresponding generated rows in `docs/config-catalog.zh.md`, preserve its generated structure, then run:

```bash
pnpm run verify-translation-pairing --write .agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.md
pnpm run verify-translation-pairing --write docs/config-catalog.md
```

- [ ] **Step 3: Run the smallest complete local evidence set**

Run these once, in order:

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

Expected: every behavior/build/config command passes. On Windows, if `doc-sync` alone reports `EPERM` while creating the `project-doc-site.spec.ts` escape-symlink fixture, retain the exact output, require all other documentation gates to pass, and report the platform-only exception explicitly; do not describe `doc-sync` itself as passing.

- [ ] **Step 4: Commit the implemented decision and generated docs**

```bash
git add .agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.* docs/config-catalog.md docs/config-catalog.zh.md docs/config-catalog.i18n.yaml
git commit -m "docs: finalize web backpressure contract"
git status --short
```

Expected: the commit succeeds and the worktree is clean.

- [ ] **Step 5: Package the exact reviewed branch in WSL/Linux**

Use the existing named deployment branch only after all commits above are reachable from it:

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

Expected: the Linux container passes the focused tests, benchmark, build, config, and artifact validations, then prints one commit-named artifact-set directory. It must not print invite or Kimi secrets.

- [ ] **Step 6: Upload and activate through the installed helper**

From the same WSL shell, with `ARTIFACT_SET` still set:

```bash
REMOTE=root@120.24.146.133
KEY=/mnt/c/Users/a8798/.ssh/person.pem
REMOTE_STAGE=$(ssh -i "$KEY" -p 22 "$REMOTE" 'mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
[[ $REMOTE_STAGE =~ ^/[A-Za-z0-9._/-]+/mydsh-deploy\.[A-Za-z0-9]{6}$ ]]
scp -i "$KEY" -P 22 -r "$ARTIFACT_SET" "$REMOTE:$REMOTE_STAGE/"
ssh -i "$KEY" -p 22 -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release './${ARTIFACT_SET##*/}'; status=\$?; if [[ \$status == 0 ]]; then rm -rf -- '$REMOTE_STAGE'; else printf 'Upgrade failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; fi; exit \$status"
```

Expected: the helper reports the new full commit after public and authenticated acceptance; rollback occurs automatically on failure.

- [ ] **Step 7: Run production canary checks**

Verify public health and non-secret server state:

```bash
curl --fail --silent --show-error --output /dev/null https://www.jingjunmai.com/__invite/login
ssh -i /mnt/c/Users/a8798/.ssh/person.pem -p 22 root@120.24.146.133 'systemctl is-active caddy mydsh; readlink -f /opt/mydsh/current; ss -ltnp "( sport = :80 or sport = :443 or sport = :3080 )"'
```

Expected: both services are active, `current` names the new commit, and DSH listens only on `127.0.0.1:3080`.

Open two to five authenticated browsers. Hold one browser on a throttled connection, submit from a healthy browser, and verify: the healthy composer shows `Sending…` by the next paint; its user bubble and assistant output progress without a multi-second blank interval; the throttled browser reports reconnecting and later shows one complete user message and one complete assistant result; the model run never stops because that browser disconnected. During this run, inspect only queue/socket metadata with `ss -tinp` and service RSS; no prompt, response, Cookie, invite code, or credential content may be logged.

- [ ] **Step 8: Record final evidence**

Report the deployed commit, benchmark byte reduction, compressed RSS delta, focused commands actually run, public service/listener state, and the multi-browser canary result. If the canary fails, invoke the installed helper's rollback against the previous known-good 40-character release commit and retain the failed release for diagnosis.
