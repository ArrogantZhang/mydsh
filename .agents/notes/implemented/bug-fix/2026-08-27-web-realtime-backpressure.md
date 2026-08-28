# Agent Note: Web realtime backpressure and submit feedback

Status: implemented

English | [中文](2026-08-27-web-realtime-backpressure.zh.md)

## Problem

A slow or stalled browser downlink can accumulate serialized realtime frames and pending socket writes without a clear resource limit. Bursty `assistant/chunk` traffic can therefore turn one observer's delivery failure into unbounded host memory growth, while the agent and model run producing the durable events remains valid. The composer also needs immediate feedback that a local submission attempt has begun without presenting that transient pre-admission state as durable progress or remote delivery.

## Decision

The durable session log remains authoritative for conversation content, ordering, completion, and replay. A submission attempt begins in the input machine's `adjudicating` or `submitting` phase, and the composer renders the corresponding local pending state immediately. That state may appear before sink or claim execution and before Host admission; it does not claim that the prompt is durable, that a model run has started or completed, or that any downlink has displayed the result. Durable UI state continues to come from session history and realtime session frames, and a reconnect rebuild produces an exactly-once visible transcript from those durable events.

Each realtime downlink has bounded delivery resources. `dsh-host-apiproxy` owns per-stream frame capacity. `dsh-client-connection` owns lossless physical-message batching, WebSocket compression, serialized queued-byte accounting, the send timeout, and the fixed inbound protocol limit. Overflow or timeout is initiated by and attributed to one affected downlink. That downlink closes first; `ConnectionController` then fails its browser connection generation, closes the companion mux or host downlink, and reconnects both. The failure never aborts the agent or model run, mutates the durable log, or closes a downlink belonging to another browser or client connection.

This decision extends the existing [WebSocket downlink carrier](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.md) without changing its two independent logical streams or HTTP uplink.

## Resource ownership

`dsh-host-apiproxy` admits complete application frames to each logical stream and applies that stream's frame-capacity limit before an unbounded frame backlog can form. Each stream owns its own 4,096-frame queue, so a stalled mux or host consumer cannot consume another downlink's allowance.

`dsh-client-connection` owns the physical WebSocket. It serializes each logical `ServerRequest` once and measures each complete physical message in UTF-8 bytes. Lossless batching sends when the accumulated request count, exact wrapper bytes, first-item deadline, or clean source end reaches its configured bound. At most one source `next()` remains pending; when the deadline wins, the accumulator flushes the current requests and retains that outstanding promise for the next batch instead of reading the source concurrently. A multi-request message uses the exact `server-batch` wrapper and preserves every inner request's order, `rpcId`, and payload. A one-request flush and a request too large for the batch wrapper remain ordinary `server-request` messages. The wire schema accepts at most 256 requests in one server batch, and an enabled batch byte limit greater than the socket byte limit fails plugin load before route or socket registration.

The browser validates the complete `server-batch` wrapper, every inner `ServerRequest`, and every stream payload before publishing any member. A malformed physical message publishes no prefix, closes the socket with code 1002, and enters the ordinary reconnect path.

Before `send()`, the carrier rejects a physical message when `bufferedAmount` plus its serialized bytes exceeds the configured limit; an exact fit is admitted. This is conservative application-byte accounting before compression. The carrier checks `bufferedAmount` again immediately after `send()` returns and after its callback. A byte violation, send callback failure, or per-physical-message timeout terminates the affected WebSocket and aborts its source. The diagnostic contains only the category and configured limit, and the terminated peer is not promised a `stream/error` frame. A source rejection abandons its unsent partial batch and attempts one separately encoded `stream/error` only while the socket remains open.

Compression uses `permessage-deflate` with server and client context takeover disabled. This bounds per-connection zlib state and makes `downlinkCompressionThresholdBytes` effective. The `ws` concurrency limiter is process-global and uses its first value, so `downlinkCompressionConcurrency` accepts 1 through 16, the first compression-enabled instance claims the value until process restart, and a different later value fails plugin load. `dsh-client-connection` is the sole production owner of `ws`.

Inbound application messages remain forbidden. A fixed 1 KiB `maxPayload` bounds the decompressed message size: messages within the limit reach the protocol rejection and close with code 1008, while larger compressed or uncompressed messages are rejected by `ws` with code 1009 before application delivery and without unbounded decompressed growth. The limit is a protocol invariant rather than deployment configuration.

## Reconnect semantics

Reconnect remains rebuild, as defined by the [Web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md). A new connection generation discards the closed downlink's in-memory backlog. For each open session, the client uses `session/subscribed.lastSeq` as the live-stream watermark and rebuilds from session history plus subsequent session frames. Session events that the failed downlink did not deliver remain recoverable from the authoritative durable log rather than from a transport-owned resume buffer; the local submission feedback is not replay input.

An overflow, timeout, send failure, or malformed batch follows the ordinary reconnect policy: the initiating downlink fails the browser connection generation, the companion stream closes, and mux and host reconnect together. A failed physical batch receives no transport retry. Undelivered session events rebuild through the same `session/subscribed.lastSeq` and durable history; Host state follows the existing companion-generation rebuild, whose authoritative baseline pulls, including the session-list refresh, establish the replacement state before subsequent Host frames advance it. Transport batching creates no resume buffer and changes no session-event semantics, and none of these paths creates a special agent cancellation, retries the model request, or converts local submission feedback into a durable acknowledgement.

## Production configuration

The Alibaba production overlay sets `maxEventStreamQueueFrames: 4096`; `downlinkBatching: true`, `downlinkBatchMaxFrames: 64`, `downlinkBatchMaxBytes: 262144`, and `downlinkBatchFlushMs: 16`; `downlinkCompression: true`, `downlinkCompressionThresholdBytes: 0`, and `downlinkCompressionConcurrency: 4`; and `downlinkMaxBufferedBytes: 1048576` with `downlinkSendTimeoutMs: 5000`. The package defaults keep batching and compression disabled for compositions that do not opt in.

The release packager runs the focused ApiProxy, connection, and deployment tests followed by two fixed downlink benchmark runs before `pnpm run build`. A benchmark or focused-test failure therefore prevents artifact construction with the production batching and compression policy.

## Alternatives considered

**Rely on per-message compression without batching.** Rejected: the compressed per-frame benchmark filled the bounded producer queue before delivery completed. Compression reduces transport bytes but does not amortize physical-message scheduling and write work.

**Send a raw JSON array.** Rejected: a discriminated `server-batch` wrapper makes the physical-message type explicit, supports strict wrapper diagnostics, and avoids treating an arbitrary array as a protocol message.

**Lossily coalesce `assistant/chunk` frames.** Rejected: chunk sequence, timing, partial output, replay, and UI fidelity remain observable. The transport must not invent a second, lossy account of an authoritative session log.

**Abort the agent or model run when a downlink stalls.** Rejected: a browser connection is an observer of durable work, not the owner of that work. Ending the producer would make one slow or disconnected client change the conversation's durable result.

**Persist the composer's submission feedback.** Rejected: durable `user/message` events and their later lifecycle events already provide evidence. A separate feedback event would elevate local pending state into session semantics and could still be mistaken for model or delivery completion.

**Retain compression context across messages.** Rejected: context takeover keeps per-connection zlib state and prevents the configured threshold from deciding compression independently for each message. Disabling it trades some compression ratio for bounded state and effective threshold behavior.

**Treat compression concurrency as independently reloadable per instance.** Rejected: `ws` owns one process-global first-instantiation limiter. Accepting a different later value would claim a reconfiguration that did not occur, so the carrier fails loud and requires process restart.

## Verification

Focused tests pin per-stream queue overflow and isolation; lossless count, byte, deadline, and source-end batching; the single-pending-read invariant; the 256-request wire maximum; atomic browser validation and code-1002 reconnect; byte, send-failure, and timeout source abort; peer isolation; immediate accessible submission feedback; exactly-once transcript rebuild; and deployment-gate ordering before build. The artifact builder's anchored deployment filter selects the production policy, `forward_auth` header isolation, and non-root authenticated WebSocket helper tests. Those helper tests require both mux and host probes to receive `101` and end only through curl timeout; `502`, `401`, another exit status, or one missing accepted path fails. Root- and systemd-dependent deployment-helper integration remains in Linux CI.

The fixed benchmark uses five browsers and ten real WebSocket downlinks. Every source produces 24 frames every 16 milliseconds, each mux source delivers 24,000 session frames, each host source delivers 256 host frames, and the plain and compressed modes carry identical serialized application bytes without reporting payload content.

- Run 1 plain: `serializedBytes=125884600`, `transportBytes=126107080`, `webSocketMessages=2530`, `wallMs=25948.5768`, `peakQueueFrames=24`, `rssDeltaBytes=163749888`, `maxBatchFrames=48`, `maxBatchBytes=50324`.
- Run 1 compressed: `serializedBytes=125884600`, `transportBytes=5432380`, `webSocketMessages=2530`, `wallMs=25331.873`, `peakQueueFrames=24`, `rssDeltaBytes=209920000`, `maxBatchFrames=48`, `maxBatchBytes=50324`.
- Run 1 summary: `byteReduction=0.9569224820684136`, `plainMessageReduction=0.9791391820580475`, `compressedMessageReduction=0.9791391820580475`, `compressionRssOverheadBytes=46170112`.
- Run 2 plain: `serializedBytes=125884600`, `transportBytes=126107080`, `webSocketMessages=2530`, `wallMs=24515.4427`, `peakQueueFrames=24`, `rssDeltaBytes=196530176`, `maxBatchFrames=48`, `maxBatchBytes=50324`.
- Run 2 compressed: `serializedBytes=125884600`, `transportBytes=5432390`, `webSocketMessages=2530`, `wallMs=24943.6563`, `peakQueueFrames=47`, `rssDeltaBytes=170762240`, `maxBatchFrames=64`, `maxBatchBytes=67037`.
- Run 2 summary: `byteReduction=0.9569224027707247`, `plainMessageReduction=0.9791391820580475`, `compressedMessageReduction=0.9791391820580475`, `compressionRssOverheadBytes=0`.

Both runs preserve all application frames, remain below the 4,096-frame source capacity, reduce physical WebSocket messages by more than 97%, reduce compressed transport bytes by more than 95%, and keep compression RSS overhead below 64 MiB.

## Consequences

One stalled browser can lose live progress and reconnect, but it cannot grow another stream's queue, abort the model run, alter the durable result, or affect a healthy peer. History rebuild is the recovery mechanism, so persistent network failure can create reconnect churn and temporarily hide live progress.

Lossless batching amortizes physical-message scheduling and write work while adding up to the configured 16-millisecond first-item delay. One malformed inner request rejects the whole physical message, and the durable history rather than a transport retry restores any missing session events.

Compression consumes CPU, disabling context takeover can reduce its ratio, and changing its process-wide concurrency requires restart. The measured deployment bounds these costs without weakening the byte fuse or introducing lossy coalescing.

The frame, batch, and socket budgets remain deployment tunables. Values that are too loose permit excessive aggregate memory across streams and sockets; values that are too tight disconnect healthy high-throughput clients. The measured production values are the current choice, not proof that this tuning trade-off has disappeared.

Immediate pending feedback makes the pre-admission submission attempt visible, while the absence of a feedback event keeps persistence, model progress, completion, and remote delivery distinct. Its wording and lifetime must remain visibly different from durable conversation content.
