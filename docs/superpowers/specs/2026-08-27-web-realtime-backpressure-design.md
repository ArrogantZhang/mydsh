# DSH Web Realtime Backpressure and Submit Feedback Design

English | [中文](2026-08-27-web-realtime-backpressure-design.zh.md)

## Status and scope

This design fixes delayed conversation feedback in the authenticated Alibaba Cloud Web deployment. A submitted prompt can currently appear to do nothing and then arrive together with a large group of assistant and tool cards. The server accepts the prompt and produces its first event promptly; the delay occurs while an uncompressed, one-message-per-event WebSocket stream accumulates behind a slow public connection.

The deployment serves two to five simultaneous browsers. Each browser opens a mux and host downlink, so acceptance covers at most ten WebSocket connections. The change applies to the generic Web transport and composer, with explicit production values in the Alibaba Cloud composition overlay.

## Goals

- Show visible and accessible submission feedback by the next browser paint, without waiting for a session event to return over the network.
- Reduce public downlink bytes for the representative workload by at least 60 percent and WebSocket message count by at least 90 percent.
- Bound retained frames and socket backlog for each slow downlink so one browser cannot grow host memory without limit or stall a model run.
- Preserve every durable session event and reconstruct the same conversation after reconnect, without duplicate or missing visible messages.
- Keep compression-attributable resident-set memory below 64 MiB, measured as the compressed run's RSS delta minus the identical plain run's RSS delta.

## Non-goals

- Do not change model providers, Kimi request behavior, token generation, the agent loop, or session persistence.
- Do not drop, merge, reorder, or rewrite `assistant/chunk` or any other session event.
- Do not add an optimistic user-message event or bubble before the host records `user/message`.
- Do not replace WebSocket with SSE, add a message broker, or change the inner `ServerRequest` RPC envelope.
- Do not tune Caddy buffering; the public event carrier is a WebSocket and the observed backlog is downstream flow control, not an HTTP response-buffer setting.

## Selected approach

The fix combines four safeguards: immediate composer feedback, bounded lossless WebSocket batching, negotiated compression, and a slow-consumer fuse with bounded source queues. All four are required. The deterministic per-frame compression run fills a 4,096-frame mux queue before it can produce a report, so batching is a prerequisite for production compression rather than an optional optimization.

The selected transport wraps unchanged `ServerRequest` values in an explicit `server-batch` message. A raw JSON array would save a small wrapper but obscure the transport message kind and diagnostics. Lossy coalescing of reasoning deltas remains rejected because it would change live and replayed event sequences.

## Data flow

```text
submit gesture
  |-- composer enters submitting state immediately
  |-- next paint shows pending control and announces status
  `-- HTTP prompt request
         |
         `-- durable session events
                |
                `-- bounded ApiProxy FrameQueue
                       |
                       `-- 64 frames / 256 KiB / 16 ms batch accumulator
                              |
                              `-- compressed WebSocket send with byte/time fuse
                                     |-- healthy client: ordered frame delivery
                                     `-- slow client: fail this browser generation
                                                          |
                                                          `-- reconnect + history resync
```

The prompt request and model run do not depend on a downlink remaining connected. A slow stream initiates failure for its browser connection generation; `ConnectionController` closes the companion stream and reconnects both, while other browsers and the agent continue. The session records durable events for later history reads.

## Immediate submission feedback

The conversation composer treats its synchronous `adjudicating` or `submitting` input-machine phase as the local receipt for both Enter and pointer submission. A permanently mounted empty `role="status"` region changes to the localized “Sending…” text while the receipt is active. An idle Send control keeps its stable accessible name, replaces the arrow with a contrasting motion-safe pending mark, and exposes `aria-busy="true"`; an ordinary running session retains its Stop action. The textarea remains read-only with its submitted draft visible until the existing machine completes or restores it after failure.

The receipt is not a synthetic conversation item. The user bubble continues to originate only from the durable human-source `user/message` event, preserving the logged-state authority and avoiding reconciliation or duplicate bubbles after a rejected request. The product acceptance test measures the pending state after one browser paint opportunity for both keyboard and button activation and requires it within 100 ms.

## WebSocket compression

`client-connection` negotiates RFC 7692 `permessage-deflate` through `ws`. Compression is disabled by the package default and enabled explicitly by the Alibaba Cloud overlay after the benchmark passes twice. Production uses a zero-byte threshold and process-wide concurrency four. Both server and client context takeover are disabled, which makes the threshold effective and bounds per-connection zlib state; changing concurrency requires a process restart because `ws` owns one process-wide limiter.

The plugin exposes validated `downlinkCompression`, `downlinkCompressionThresholdBytes`, and `downlinkCompressionConcurrency` fields instead of embedding deployment tunables in the carrier. The downlink-only server fixes inbound `maxPayload` at 1 KiB before rejecting client application messages. No compression settings or measurements include invite codes, cookies, model credentials, message text, or tool output in logs; benchmarks use deterministic synthetic payloads with fixed event categories and sizes.

Compression and batching ship together in the production overlay only if two consecutive representative runs reduce transport bytes by at least 60 percent, reduce WebSocket message count by at least 90 percent, avoid source overflow, and keep compression RSS overhead at or below 64 MiB. RSS overhead is `max(0, compressed.rssDeltaBytes - plain.rssDeltaBytes)`; both per-run deltas remain in the report.

## Lossless WebSocket batching

The transport accepts either one `ServerRequest` or this connection-local wrapper; batching never changes the inner RPC envelope, event sequence, or session log:

```text
{"type":"server-batch","requests":[/* unchanged ServerRequest values */]}
```

Each mux and host socket owns one accumulator. It sends when it reaches 64 requests, 262,144 serialized bytes, or 16 ms since the first retained request, whichever occurs first. A single request larger than the batch-byte limit sends alone. The accumulator keeps at most one pending iterator `next()` while a timer wins, reusing that promise after the timed flush instead of issuing concurrent reads.

Each `ServerRequest` is serialized once. The server assembles the explicit wrapper from encoded request fragments and applies the existing byte/time fuse to the exact batch bytes. Clean source completion flushes the final partial batch; `stream/error` remains a single message. Source overflow, timeout, or socket failure may abandon an unsent partial batch because the same browser generation reconnects and rebuilds durable state.

The browser validates the wrapper and every inner request before publishing any member. A malformed batch closes that socket and triggers the ordinary generation reconnect rather than partially applying valid prefixes. Accepted members reach the existing mux or host sink individually and in original order. The connection plugin exposes `downlinkBatching`, `downlinkBatchMaxFrames`, `downlinkBatchMaxBytes`, and `downlinkBatchFlushMs`; package batching defaults off, while production uses `true`, 64, 262,144, and 16 ms. Validated maxima are 256 frames, 1,048,576 bytes, and 100 ms.

## Bounded queues and slow-consumer fuse

`host-apiproxy` gives each mux or host `FrameQueue` a validated `maxEventStreamQueueFrames` capacity, with a package default and production value of 4,096. Pushing beyond capacity atomically marks that one stream failed, wakes its iterator, rejects further pushes, and releases all queued frame references. The iterator then disposes every registered listener and reports the overflow to its carrier. It does not throw through the Cordis event emitter that produced the frame.

`client-connection` adds validated `downlinkMaxBufferedBytes` and `downlinkSendTimeoutMs` values. Production uses 1,048,576 buffered bytes and 5,000 ms. Before each send, the carrier bounds existing `WebSocket.bufferedAmount` plus the current serialized single or batch message, then rechecks immediately after `send()` and in its callback; each send also races a timer. Exceeding either limit terminates that socket and aborts the source iterator. Only one WebSocket message is in flight, and the API queue separately bounds frames generated while that send is blocked.

Normal client closure, plugin teardown, queue overflow, send timeout, and socket error converge on one idempotent cleanup path. Timers are cleared, the iterator receives abort, subscriptions are disposed, and the pump is removed from the owned set. The server may record a reason category and counters, but never frame bodies or request headers.

## Reconnect and consistency

The browser's existing `ConnectionController` treats a closed stream as a failed generation, closes the companion stream, reports `reconnecting`, and opens both streams again with bounded exponential backoff. A fresh mux begins with each session's `session/subscribed.lastSeq`; `onConnected` makes every opened conversation reload its history window. Existing sequence handling discards replayed duplicates and fills the gap between the last visible event and the new durable baseline.

Tests force an overflow and a send timeout after a user message but before its assistant completion. They then reconnect and require exactly one visible user message, the complete assistant result, current projection values, pending approval or question replay, and no retained listeners from the abandoned generation. A transport disconnect must not abort the agent or append a model-visible error.

## Configuration ownership

`host-apiproxy` owns `maxEventStreamQueueFrames` because it owns the callback-to-async-iterator queue for every carrier. `client-connection` owns batching, compression, buffered bytes, and send timeout because it owns WebSocket encoding, negotiation, and pumping. The Alibaba Cloud overlay names every production value explicitly, making the resource policy reviewable without changing source.

All numeric fields accept integers in safe operational ranges and fail plugin load on zero, negative, non-finite, or out-of-range values. README and JSDoc updates document defaults, failure behavior, and the fact that a slow-client disconnect is recoverable through history resync.

## Testing and acceptance

Implementation begins with failing tests for composer pending feedback, queue overflow, send timeout, compression negotiation, cleanup, and reconnect history repair. Focused package tests cover each failure race, including close during compression, abort during a blocked send, queue overflow before a waiter exists, and teardown with multiple active pumps.

A deterministic host benchmark runs five browser peers with mux and host downlinks. Each mux receives 24,000 fixed session frames and each host receives 256 fixed host frames. Producers sustain 24 frames every 16 ms per source: this preserves the observed production burst peak while sustaining more than ten times the observed per-second peak. Both plain and compressed modes use identical batching and application bytes; reports add WebSocket message count, maximum batch size, producer cadence, and compression RSS overhead to serialized bytes, transport bytes, wall time, peak queue depth, and both per-run RSS deltas. Two consecutive runs must avoid overflow, keep queue peak at or below 4,096, reduce message count by at least 90 percent, reduce compressed transport bytes by at least 60 percent, and keep compression RSS overhead at or below 64 MiB. A paused-reader case must trip the fuse within 6 seconds, release the stream, and leave healthy peers receiving frames.

A keyless real Web composition browser test submits through both Enter and the button, captures the pending state before any mocked session event is delivered, then verifies the durable user bubble and streamed assistant result. The relevant unit tests, typecheck, build, Web configuration verification, documentation gates, and `git diff --check` run before packaging.

Production acceptance uses the normal immutable release and rollback path. With two to five browsers, one intentionally throttled browser must reconnect without interrupting a conversation in a healthy browser. The canary records only connection counts, queue sizes, byte totals, close reasons, process RSS, and operating-system socket queue sizes. Acceptance requires immediate submit feedback, progressive assistant rendering for healthy clients, bounded queues for the throttled client, and a complete conversation after its reconnect.

## Rollout and rollback

The release first runs the benchmark twice locally, then the browser and focused package checks, then packages and deploys the same reviewed commit. The production overlay enables batching and compression only in the artifact that passed every threshold twice. Post-deploy checks cover authenticated WebSocket negotiation, one short Kimi conversation, one long synthetic or controlled conversation, and the throttled-client recovery case.

Rollback switches `/opt/mydsh/current` to the previous immutable release through the existing deployment helper. The change introduces no session-log or database format migration, so persisted conversations remain readable by the previous release. Rollback also restores the prior overlay values with the prior artifact and does not rotate invite or Kimi secrets.
