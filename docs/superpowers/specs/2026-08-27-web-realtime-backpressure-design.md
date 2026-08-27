# DSH Web Realtime Backpressure and Submit Feedback Design

English | [中文](2026-08-27-web-realtime-backpressure-design.zh.md)

## Status and scope

This design fixes delayed conversation feedback in the authenticated Alibaba Cloud Web deployment. A submitted prompt can currently appear to do nothing and then arrive together with a large group of assistant and tool cards. The server accepts the prompt and produces its first event promptly; the delay occurs while an uncompressed, one-message-per-event WebSocket stream accumulates behind a slow public connection.

The deployment serves two to five simultaneous browsers. Each browser opens a mux and host downlink, so acceptance covers at most ten WebSocket connections. The change applies to the generic Web transport and composer, with explicit production values in the Alibaba Cloud composition overlay.

## Goals

- Show visible and accessible submission feedback by the next browser paint, without waiting for a session event to return over the network.
- Reduce the public downlink bytes for a representative 24,000-event conversation by at least 60 percent.
- Bound retained frames and socket backlog for each slow downlink so one browser cannot grow host memory without limit or stall a model run.
- Preserve every durable session event and reconstruct the same conversation after reconnect, without duplicate or missing visible messages.
- Keep the added resident-set memory below 64 MiB for five browsers and ten downlinks under the representative load.

## Non-goals

- Do not change model providers, Kimi request behavior, token generation, the agent loop, or session persistence.
- Do not drop, merge, reorder, or rewrite `assistant/chunk` or any other session event.
- Do not add an optimistic user-message event or bubble before the host records `user/message`.
- Do not replace WebSocket with SSE, add a message broker, or redesign the RPC envelope.
- Do not tune Caddy buffering; the public event carrier is a WebSocket and the observed backlog is downstream flow control, not an HTTP response-buffer setting.

## Selected approach

The fix combines three independent safeguards: immediate composer feedback, negotiated WebSocket compression, and a slow-consumer fuse with bounded source queues. All three are required. Visual feedback alone hides the transport failure, compression alone leaves an unlimited queue under sufficiently slow clients, and a fuse alone still spends unnecessary bandwidth during healthy operation.

Wire batching was considered because it would reduce browser `message` events as well as bytes, but it changes the downlink protocol, validators, fixtures, and carrier implementations. Lossy coalescing of reasoning deltas was rejected because live and replayed event sequences would diverge. The selected approach preserves the current one-envelope-per-WebSocket-message protocol and relies on the existing animation-frame publication in the conversation projection to prevent a React render per token.

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
                       `-- compressed WebSocket send with byte/time fuse
                              |-- healthy client: ordinary live projection
                              `-- slow client: close only this downlink
                                                   |
                                                   `-- reconnect + history resync
```

The prompt request and model run do not depend on a downlink remaining connected. Closing a slow downlink aborts only that stream's iterator and disposes its event subscriptions. The session continues recording events for later history reads.

## Immediate submission feedback

The conversation composer treats its synchronous `adjudicating` or `submitting` input-machine phase as the local receipt for both Enter and pointer submission. While that receipt is active, the primary send control replaces the arrow with the existing animated pending mark, exposes `aria-busy="true"`, and uses a localized `role="status"` label equivalent to “Sending…”. The textarea remains read-only with its submitted draft visible until the existing machine completes or restores it after failure.

The receipt is not a synthetic conversation item. The user bubble continues to originate only from the durable `user/message` event, preserving the logged-state authority and avoiding reconciliation or duplicate bubbles after a rejected request. The product acceptance test measures the pending state by the first `requestAnimationFrame` after both keyboard and button activation and requires it within 100 ms.

## WebSocket compression

`client-connection` negotiates RFC 7692 `permessage-deflate` through `ws`. Compression is disabled by the package default and enabled explicitly by the Alibaba Cloud overlay after the benchmark gate passes. The deployment configuration sets a zero-byte compression threshold so the small, repetitive JSON delta frames participate, limits zlib concurrency to four, and retains context takeover to obtain useful compression across the event stream.

The plugin exposes validated `downlinkCompression`, `downlinkCompressionThresholdBytes`, and `downlinkCompressionConcurrency` fields instead of embedding deployment tunables in the carrier. No compression settings or measurements include invite codes, cookies, model credentials, message text, or tool output in logs; benchmarks use deterministic synthetic payloads with the same event categories and size distribution.

Compression may ship enabled in the production overlay only if the representative benchmark reduces written WebSocket bytes by at least 60 percent and keeps the ten-downlink RSS increase at or below 64 MiB. If either gate fails, deployment stops and the design returns for a batching revision; compression is never enabled merely because negotiation succeeds.

## Bounded queues and slow-consumer fuse

`host-apiproxy` gives each mux or host `FrameQueue` a validated `maxEventStreamQueueFrames` capacity, with a package default and production value of 4,096. Pushing beyond capacity atomically marks that one stream failed, wakes its iterator, rejects further pushes, and releases all queued frame references. The iterator then disposes every registered listener and reports the overflow to its carrier. It does not throw through the Cordis event emitter that produced the frame.

`client-connection` adds validated `downlinkMaxBufferedBytes` and `downlinkSendTimeoutMs` values. Production uses 1,048,576 buffered bytes and 5,000 ms. Before and after each serialized send, the carrier checks `WebSocket.bufferedAmount`; each send also races a timer. Exceeding the byte limit or timer terminates that socket and aborts the source iterator. Only one serialized frame is in flight, and the API queue separately bounds frames generated while that send is blocked.

Normal client closure, plugin teardown, queue overflow, send timeout, and socket error converge on one idempotent cleanup path. Timers are cleared, the iterator receives abort, subscriptions are disposed, and the pump is removed from the owned set. The server may record a reason category and counters, but never frame bodies or request headers.

## Reconnect and consistency

The browser's existing `ConnectionController` treats a closed stream as a failed generation, closes the companion stream, reports `reconnecting`, and opens both streams again with bounded exponential backoff. A fresh mux begins with each session's `session/subscribed.lastSeq`; `onConnected` makes every opened conversation reload its history window. Existing sequence handling discards replayed duplicates and fills the gap between the last visible event and the new durable baseline.

Tests force an overflow and a send timeout after a user message but before its assistant completion. They then reconnect and require exactly one visible user message, the complete assistant result, current projection values, pending approval or question replay, and no retained listeners from the abandoned generation. A transport disconnect must not abort the agent or append a model-visible error.

## Configuration ownership

`host-apiproxy` owns `maxEventStreamQueueFrames` because it owns the callback-to-async-iterator queue for every carrier. `client-connection` owns compression, buffered bytes, and send timeout because it owns WebSocket negotiation and pumping. The Alibaba Cloud overlay names every production value explicitly, making the resource policy reviewable without changing source.

All numeric fields accept integers in safe operational ranges and fail plugin load on zero, negative, non-finite, or out-of-range values. README and JSDoc updates document defaults, failure behavior, and the fact that a slow-client disconnect is recoverable through history resync.

## Testing and acceptance

Implementation begins with failing tests for composer pending feedback, queue overflow, send timeout, compression negotiation, cleanup, and reconnect history repair. Focused package tests cover each failure race, including close during compression, abort during a blocked send, queue overflow before a waiter exists, and teardown with multiple active pumps.

A deterministic host benchmark emits 24,000 representative session frames and runs five browser peers, each with mux and host downlinks. It compares compression off and on, reports total serialized bytes, transport bytes written, wall time, peak queue depth, and RSS delta, and fails the 60-percent byte and 64-MiB memory gates. A paused-reader case must trip the fuse within 6 seconds, keep the source queue at or below 4,096 frames, release the stream, and leave healthy peers receiving frames.

A keyless real Web composition browser test submits through both Enter and the button, captures the pending state before any mocked session event is delivered, then verifies the durable user bubble and streamed assistant result. The relevant unit tests, typecheck, build, Web configuration verification, documentation gates, and `git diff --check` run before packaging.

Production acceptance uses the normal immutable release and rollback path. With two to five browsers, one intentionally throttled browser must reconnect without interrupting a conversation in a healthy browser. The canary records only connection counts, queue sizes, byte totals, close reasons, process RSS, and operating-system socket queue sizes. Acceptance requires immediate submit feedback, progressive assistant rendering for healthy clients, bounded queues for the throttled client, and a complete conversation after its reconnect.

## Rollout and rollback

The release first runs the benchmark gate locally, then the browser and focused package checks, then packages and deploys the same reviewed commit. The production overlay enables compression only in the artifact that passed the gate. Post-deploy checks cover authenticated WebSocket negotiation, one short Kimi conversation, one long synthetic or controlled conversation, and the throttled-client recovery case.

Rollback switches `/opt/mydsh/current` to the previous immutable release through the existing deployment helper. The change introduces no session-log or database format migration, so persisted conversations remain readable by the previous release. Rollback also restores the prior overlay values with the prior artifact and does not rotate invite or Kimi secrets.
