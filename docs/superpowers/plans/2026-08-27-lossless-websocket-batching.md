# Lossless WebSocket Batching Implementation Plan

English | [中文](2026-08-27-lossless-websocket-batching.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch unchanged realtime `ServerRequest` values into bounded WebSocket messages so five browsers can receive lossless compressed streams without overflowing the 4,096-frame source queues.

**Architecture:** A connection-local codec adds an explicit `server-batch` wrapper while preserving every inner rpc id, payload, event sequence, and session-log record. Each socket accumulates at most 64 requests or 256 KiB for at most 16 ms, then the browser atomically validates the wrapper and publishes its requests to the existing sinks in order.

**Tech Stack:** TypeScript 6, Cordis, Zod, `ws` 8.21, Vitest 4, Node.js 24, Playwright/Chromium, pnpm 11.7, Caddy, systemd, Bash.

**Design:** [Approved amended design](../specs/2026-08-27-web-realtime-backpressure-design.md)

---

## File map

### Connection-local wire and browser decoder

- `packages/client/connection/src/` + `downlink-message.ts` — browser-safe `server-batch` type, schema, and atomic decoding.
- `packages/client/connection/tests/` + `downlink-message.client.spec.ts` — single/batch decoding, bounds, malformed-batch rejection, and atomicity.
- `packages/client/connection/src/client/web-api-client.ts` — maps one physical WebSocket message to one or more validated stream frames and closes malformed transports.

### Host accumulator and configuration

- `packages/client/connection/src/` + `downlink-batch.ts` — frame/byte/deadline accumulator with one pending iterator read.
- `packages/client/connection/tests/` + `downlink-batch.host.spec.ts` — count, bytes, deadline, end, abort, large-frame, order, and pending-read races.
- `packages/client/connection/src/websocket-downlink.ts` — encodes singles or batches before the existing send fuse.
- `packages/client/connection/src/index.ts` — validates and passes batching configuration.
- `packages/client/connection/tests/websocket-downlink.host.spec.ts` — real WebSocket batch delivery, failure, and teardown integration.
- `packages/client/connection/tests/node-half.host.spec.ts` — batching defaults, ranges, and cross-field validation.
- `packages/client/connection/README.md`, `README.zh.md`, `README.i18n.yaml` — batching, ordering, timing, and recovery contract.
- `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`, `.zh.md`, `.i18n.yaml` — selected batching decision and measured prerequisite.
- `docs/config-catalog.md`, `config-catalog.zh.md`, `config-catalog.i18n.yaml` — regenerated configuration reference.

### Benchmark and deployment

- `scripts/websocket-downlink-benchmark-worker.ts` — fixed batched workload and per-mode transport metrics.
- `scripts/websocket-downlink-benchmark.ts` — two-mode gate and failure diagnostics.
- `scripts/websocket-downlink-benchmark.spec.ts` — report parser and threshold tests.
- `package.json` — benchmark command.
- `deploy/alibaba-cloud/invite-auth.cordis.yml` — explicit queue, batching, compression, and fuse values.
- `deploy/alibaba-cloud/package-release.sh` — focused tests and two benchmark runs before build publication.
- `scripts/alibaba-cloud-deployment.spec.ts` — overlay and packager ordering assertions.
- `deploy/alibaba-cloud/README.md`, `README.zh.md`, `README.i18n.yaml` — operational values and reconnect diagnosis.

## Task 1: Add the explicit batch wire and atomic browser decoder

**Files:**

- Create under `packages/client/connection/src/`: `downlink-message.ts`
- Create under `packages/client/connection/tests/`: `downlink-message.client.spec.ts`
- Modify: `packages/client/connection/src/client/web-api-client.ts`

- [ ] **Step 1: Write failing codec tests**

Cover one valid `ServerRequest`, a valid non-empty batch, 256 requests, 257 requests, an empty batch, an invalid inner envelope, and an invalid stream payload. Assert an invalid batch publishes zero prefixes.

```text
const batch = {
  type: 'server-batch',
  requests: [firstRequest, secondRequest],
}
expect(decodeDownlinkMessage(JSON.stringify(batch), muxFrameSchema))
  .toEqual([firstEnvelope, secondEnvelope])
expect(() => decodeDownlinkMessage(JSON.stringify({
  type: 'server-batch',
  requests: [firstRequest, malformedRequest],
}), muxFrameSchema)).toThrow()
```

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run packages/client/connection/tests -t "downlink message"`

Expected: FAIL because the batch codec module and decoder do not exist.

- [ ] **Step 3: Implement the browser-safe wire type and decoder**

Define the connection-local types and schema without exporting them from the package root:

```text
export const MAX_SERVER_BATCH_REQUESTS = 256

export interface ServerBatch {
  type: 'server-batch'
  requests: ServerRequest[]
}

export type DownlinkMessage = ServerRequest | ServerBatch
```

Use `serverRequestSchema` for every member and `z.array(...).min(1).max(256)` for the wrapper. Keep this module free of Node imports such as `Buffer`: the browser bundle consumes it. The decoder parses the complete physical message, validates all inner requests and their mux/host payloads into a temporary array, and returns only after the whole message succeeds.

- [ ] **Step 4: Wire atomic browser delivery**

In `WebApiClient.readWebSocket`, decode one physical message into validated envelopes, then call `onEnvelope` and enqueue each member in order. On any JSON, wrapper, envelope, or stream-payload error, log only the path/category, close the socket with code `1002`, and enqueue no batch prefix. The existing `ConnectionController` then rebuilds the generation.

- [ ] **Step 5: Run GREEN and commit**

Run: `pnpm exec vitest run packages/client/connection/tests -t "downlink message|malformed WebSocket"`

Expected: PASS.

Run: `pnpm exec tsc -b packages/client/connection`

Expected: PASS.

```bash
git add packages/client/connection/src packages/client/connection/tests
git commit -m "feat(connection): add lossless downlink batches"
```

## Task 2: Add the bounded host accumulator and deployment-varying config

**Files:**

- Create under `packages/client/connection/src/`: `downlink-batch.ts`
- Create under `packages/client/connection/tests/`: `downlink-batch.host.spec.ts`
- Modify: `packages/client/connection/src/websocket-downlink.ts`
- Modify: `packages/client/connection/src/index.ts`
- Modify: `packages/client/connection/tests/websocket-downlink.host.spec.ts`
- Modify: `packages/client/connection/tests/node-half.host.spec.ts`
- Modify: `packages/client/connection/README.md`
- Modify: `packages/client/connection/README.zh.md`
- Modify: `packages/client/connection/README.i18n.yaml`
- Modify: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`
- Modify: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.zh.md`
- Modify: `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml`
- Regenerate: `docs/config-catalog.md`
- Modify: `docs/config-catalog.zh.md`
- Modify: `docs/config-catalog.i18n.yaml`

- [ ] **Step 1: Write failing accumulator tests**

Use fake timers and an async source whose `next()` calls are counted. Cover:

- 64 requests flush immediately in order;
- a 65th request starts the next batch;
- the exact byte limit fits and the next request flushes the current batch;
- one request larger than 256 KiB sends alone;
- 16 ms flushes a partial batch;
- clean end flushes the remainder;
- abort releases the timer and iterator;
- a timer winning a `next()` race leaves exactly one pending read and reuses it;
- source failure abandons the local partial batch and propagates to the pump.

```text
const batches = collectEncodedDownlinkMessages(source, {
  enabled: true,
  maxFrames: 64,
  maxBytes: 262_144,
  flushMs: 16,
}, signal)
```

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run packages/client/connection/tests -t "downlink batch"`

Expected: FAIL because the accumulator and batching options are absent.

- [ ] **Step 3: Implement the accumulator**

Define an internal options object:

```text
export interface DownlinkBatchOptions {
  enabled: boolean
  maxFrames: number
  maxBytes: number
  flushMs: number
}
```

This Host-only module serializes each `ServerRequest` once, calculates UTF-8 bytes with `Buffer.byteLength`, and builds batch text from a fixed prefix, comma-separated encoded requests, and suffix:

```text
const BATCH_PREFIX = '{"type":"server-batch","requests":['
const BATCH_SUFFIX = ']}'
```

When disabled, yield one encoded `ServerRequest` per physical message. When enabled, hold encoded requests until count, exact wrapper bytes, deadline, or clean end. Keep one stored `Promise<IteratorResult<...>>`; if the deadline wins, send the partial batch and await that same promise for the next batch. Never call `next()` concurrently.

- [ ] **Step 4: Add validated plugin config**

Add fields with these package defaults and ranges:

```text
downlinkBatching: false
downlinkBatchMaxFrames: 64       // 1..256
downlinkBatchMaxBytes: 262144    // 1..1048576
downlinkBatchFlushMs: 16         // 1..100
```

Fail plugin load when batching is enabled and `downlinkBatchMaxBytes > downlinkMaxBufferedBytes`. Pass a complete batch options object to `WebSocketDownlinks`.

- [ ] **Step 5: Integrate host pumping**

Refactor the send helper to accept already encoded text. `pump` selects single or batched encoding, then applies the existing serialized-byte fuse and send timeout to each physical message. A clean end sends the final partial batch. `stream/error` remains one encoded `ServerRequest` and is never inserted into a normal batch.

- [ ] **Step 6: Add real WebSocket integration tests**

With batching enabled, assert 65 source frames arrive as two physical messages containing 64 and 1 ordered requests. Assert a timer flush, clean-end flush, oversized single, byte-fuse rejection, source failure, malformed client message, peer isolation, and quiescent `close()`. With batching disabled, retain one physical message per request.

- [ ] **Step 7: Update contracts and generated config**

Update README and the proposed Agent Note with exact wrapper, defaults/ranges, one-pending-read rule, failure/reconnect semantics, and the measured reason batching is required. Run `pnpm run gen-config-catalog`, update only corresponding Chinese rows, and re-record all three pairs.

- [ ] **Step 8: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/client/connection/tests -t "downlink batch|downlink message|WebSocket downlinks|connection node half|ConnectionController"
pnpm exec tsc -b packages/client/connection
pnpm run verify-config-catalog
pnpm run verify-agent-note-format
git diff --check
```

Expected: all pass.

```bash
git add packages/client/connection .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.* docs/config-catalog.md docs/config-catalog.zh.md docs/config-catalog.i18n.yaml
git commit -m "feat(connection): batch websocket downlinks"
```

## Task 3: Update the fixed benchmark and pass it twice

**Files:**

- Modify: `scripts/websocket-downlink-benchmark-worker.ts`
- Modify: `scripts/websocket-downlink-benchmark.ts`
- Modify: `scripts/websocket-downlink-benchmark.spec.ts`
- Modify: `package.json`

- [ ] **Step 1: Extend failing report tests**

Add exact fields to each report:

```text
webSocketMessages: number
maxBatchFrames: number
maxBatchBytes: number
```

The summary carries `plainMessageReduction` and `compressedMessageReduction`. Reject unknown/missing fields, a batch over 64 frames or 262,144 bytes, either message reduction below 90 percent, serialized-byte mismatch, queue overflow, compressed byte reduction below 60 percent, and compressed RSS above 64 MiB.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run scripts/websocket-downlink-benchmark.spec.ts`

Expected: FAIL because batching metrics and thresholds are absent.

- [ ] **Step 3: Measure batched physical messages**

Enable identical batching in plain and compressed workers with `true`, 64, 262,144, and 16 ms. Client peers parse singles or batch wrappers, count every inner request, count physical `message` events, and record maximum batch request count and raw message bytes. Preserve the start barrier, fixed application frames, TCP `bytesRead`, 5 ms RSS sampling, queue observation, and secret-free output.

The application-frame denominator is exact:

```text
5 * (24_000 + 256) = 121_280 frames
messageReduction = 1 - webSocketMessages / 121_280
```

- [ ] **Step 4: Improve failed-run diagnostics**

If compressed mode fails after plain succeeds, include the validated plain metrics in the final non-secret diagnostic. Keep child stdout at exactly one JSON line on success and bounded stderr on failure.

- [ ] **Step 5: Run GREEN unit tests and the real gate twice**

Run:

```bash
pnpm exec vitest run scripts/websocket-downlink-benchmark.spec.ts
pnpm run benchmark:websocket-downlinks
pnpm run benchmark:websocket-downlinks
```

Expected for both real runs:

- no source overflow and queue peak at most 4,096;
- both message reductions at least 0.90;
- compressed transport-byte reduction at least 0.60;
- compressed RSS delta at most 67,108,864 bytes;
- exact application counts and identical serialized bytes.

If either run fails, stop before Task 4 and report the fixed metrics; do not alter payloads or thresholds to pass.

- [ ] **Step 6: Commit the proven gate**

```bash
git add package.json scripts/websocket-downlink-benchmark-worker.ts scripts/websocket-downlink-benchmark.ts scripts/websocket-downlink-benchmark.spec.ts
git commit -m "test(connection): gate batched websocket compression"
```

## Task 4: Enable batching and compression in the Alibaba Cloud artifact

**Files:**

- Modify: `deploy/alibaba-cloud/invite-auth.cordis.yml`
- Modify: `deploy/alibaba-cloud/package-release.sh`
- Modify: `scripts/alibaba-cloud-deployment.spec.ts`
- Modify: `deploy/alibaba-cloud/README.md`
- Modify: `deploy/alibaba-cloud/README.zh.md`
- Modify: `deploy/alibaba-cloud/README.i18n.yaml`

- [ ] **Step 1: Write failing deployment assertions**

Require `api-gateway.maxEventStreamQueueFrames: 4096`. Require the connection row to preserve dynamic trusted hosts and set:

```yaml
downlinkBatching: true
downlinkBatchMaxFrames: 64
downlinkBatchMaxBytes: 262144
downlinkBatchFlushMs: 16
downlinkCompression: true
downlinkCompressionThresholdBytes: 0
downlinkCompressionConcurrency: 4
downlinkMaxBufferedBytes: 1048576
downlinkSendTimeoutMs: 5000
```

Require focused ApiProxy/connection/deployment tests, then two benchmark commands, all before build in `package-release.sh`.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts`

Expected: FAIL because batching production values and double benchmark ordering are absent.

- [ ] **Step 3: Apply and resolve the overlay**

Patch the existing `api-gateway` and `connection` rows, preserving `inject: [webRuntime]` and `trustedHosts: !!js ctx.webRuntime.trustedHosts`. Build and run:

```bash
node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config
```

Expected: every explicit production value resolves and plugin load succeeds.

- [ ] **Step 4: Update packaging and operations docs**

Run focused tests and the benchmark twice inside the pinned Linux build container before `pnpm run build`. Document 64/256 KiB/16 ms, process-restart concurrency, fuse recovery, and the rule that repeated disconnects require network diagnosis rather than larger unbounded buffers. Re-record the README pair.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts
pnpm run verify-cordis-config
git diff --check
```

Expected: PASS.

```bash
git add deploy/alibaba-cloud scripts/alibaba-cloud-deployment.spec.ts
git commit -m "deploy: enable batched compressed downlinks"
```

## Task 5: Finalize documentation, package, deploy, and canary

**Files:**

- Move the active Agent Note triplet from `.agents/notes/proposed/bug-fix/` to `.agents/notes/implemented/bug-fix/`.
- Modify: `docs/superpowers/plans/2026-08-27-web-realtime-backpressure.md`
- Modify: `docs/superpowers/plans/2026-08-27-web-realtime-backpressure.zh.md`
- Modify: `docs/superpowers/plans/2026-08-27-web-realtime-backpressure.i18n.yaml`

- [ ] **Step 1: Record shipped reality**

Move the complete Agent Note pair/sidecar with `git mv`, set `Status: implemented`, replace proposal/acceptance/risks headings with decision/consequences/current verification, preserve alternatives, and record the two real benchmark reports and shipped defaults without payload text. Update the earlier implementation plan so its compression-only Task 6 no longer contradicts the batching continuation; link this plan as the remaining-work owner. Re-record both pairs.

- [ ] **Step 2: Run the complete relevant evidence once**

```bash
pnpm exec vitest run packages/host/apiproxy/tests/frame-queue.spec.ts packages/host/apiproxy/tests/event-stream-backpressure.spec.ts packages/client/connection/tests packages/client/runtime/tests/session.client.spec.ts packages/client/ui-conversation/tests/input-bar.client.spec.tsx scripts/websocket-downlink-benchmark.spec.ts scripts/alibaba-cloud-deployment.spec.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts
pnpm run benchmark:websocket-downlinks
pnpm run benchmark:websocket-downlinks
pnpm run typecheck
pnpm run build
pnpm run verify-cordis-config
pnpm run doc-sync
pnpm run lint
git diff --check
```

Expected: all behavior/build/config gates pass. The known Windows symlink-permission failure, if unchanged and isolated, is reported accurately rather than called a passing `doc-sync`; Linux packaging supplies the platform-owned signal.

- [ ] **Step 3: Commit final records**

```bash
git add .agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.* docs/superpowers/plans/2026-08-27-web-realtime-backpressure.*
git commit -m "docs: finalize batched downlink contract"
```

- [ ] **Step 4: Package and activate the exact branch**

Use the existing WSL/Linux packager with `DEPLOY_REF=refs/heads/fix/web-realtime-backpressure`, upload the one commit-named artifact set to `root@120.24.146.133` with `C:\Users\a8798\.ssh\person.pem`, and invoke the installed `/usr/local/sbin/mydsh-deploy-release`. Never print invite or Kimi secrets. The helper must report public and authenticated acceptance or roll back automatically.

- [ ] **Step 5: Run the production canary**

Verify Caddy/mydsh active, `current` at the new commit, and only `127.0.0.1:3080` for DSH. Open two to five authenticated browsers, throttle one, and send from a healthy browser. Require under-100-ms receipt, progressive healthy output, bounded queue/socket metadata, throttled reconnect with exactly-once complete conversation, and an uninterrupted model run. Record only counts, sizes, close reasons, RSS, and socket queues.

- [ ] **Step 6: Final review and handoff**

Dispatch whole-range specification and code-quality reviews, fix every Critical/Important issue, rerun invalidated evidence, and report deployed commit, both benchmark summaries, canary results, commands actually run, and the known Windows documentation exception if present.
