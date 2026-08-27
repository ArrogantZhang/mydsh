# Agent Note: Web realtime backpressure and submit feedback

Status: proposed

English | [中文](2026-08-27-web-realtime-backpressure.zh.md)

## Problem

A slow or stalled browser downlink can accumulate serialized realtime frames and pending socket writes without a clear resource limit. Bursty `assistant/chunk` traffic can therefore turn one observer's delivery failure into unbounded host memory growth, while the agent and model run producing the durable events remains valid. The composer also needs immediate feedback that the local submit call was accepted without presenting that transient fact as durable progress or remote delivery.

## Proposal

The durable session log remains authoritative for conversation content, ordering, completion, and replay. The composer exposes only a local submission receipt after its submit call succeeds; that receipt does not claim that the prompt is durable, that a model run has started or completed, or that any downlink has displayed the result.

Each realtime downlink has bounded delivery resources. `dsh-host-apiproxy` owns per-stream frame capacity. `dsh-client-connection` owns lossless physical-message batching, WebSocket compression, serialized queued-byte accounting, the send timeout, and the fixed inbound protocol limit. Overflow or timeout is initiated by and attributed to one affected downlink. That downlink closes first; `ConnectionController` then fails its browser connection generation, closes the companion mux or host downlink, and reconnects both. The failure never aborts the agent or model run, mutates the durable log, or closes a downlink belonging to another browser or client connection.

This proposal extends the existing [WebSocket downlink carrier](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.md) without changing its two independent logical streams or its HTTP uplink.

## Resource ownership

`dsh-host-apiproxy` admits complete application frames to each logical stream and therefore applies that stream's frame-capacity limit before an unbounded frame backlog can form. The capacity belongs to the individual stream instance, so a stalled mux or host consumer cannot consume another downlink's allowance.

`dsh-client-connection` owns the physical WebSocket. It serializes each `ServerRequest` once and measures the serialized UTF-8 bytes. Before `send()`, the carrier rejects a frame when `bufferedAmount` plus those bytes exceeds the configured limit; an exact fit is admitted. This is deliberately conservative application-byte accounting before compression. The carrier checks `bufferedAmount` again immediately after `send()` returns and after its callback. A byte violation or send timeout terminates the affected WebSocket, aborts its source, and produces only an internal category-and-limit diagnostic; the terminated peer is not promised a `stream/error` frame. Existing generation-failure semantics then close the companion stream and reconnect both streams for that browser connection. The session, agent, and model lifecycles and other browser or client connections do not receive that transport abort.

Compression uses `permessage-deflate` with both server and client context takeover disabled. This bounds per-connection zlib state and makes `downlinkCompressionThresholdBytes` effective. The `ws` concurrency limiter is process-global and uses its first value, so `downlinkCompressionConcurrency` accepts 1 through 16, the first compression-enabled instance claims the value until process restart, and a different later value fails the plugin load. `dsh-client-connection` is the sole production owner of `ws`.

The compressed per-frame benchmark filled each producer's 4,096-frame queue before delivery completed, so compression alone did not bound scheduling and write overhead under the measured burst. This revision therefore selects explicit, lossless Host batching. The production candidates are 64 logical requests, 262,144 complete-message UTF-8 bytes, and 16 milliseconds from the first buffered request; the plugin default remains disabled until a deployment opts in. The Host sends when count, complete wrapper bytes, the first-item deadline, or clean source end requires it. It emits a multi-request message as the exact `server-batch` wrapper and preserves every inner request's order, `rpcId`, and payload. A one-request flush and a request too large for the batch wrapper remain ordinary `server-request` messages. An enabled batch byte limit greater than the socket byte limit fails plugin load before route or socket registration.

Inbound application messages remain forbidden. A fixed 1 KiB `maxPayload` bounds the decompressed message size: messages within the limit reach the protocol rejection and close with code 1008, while larger compressed or uncompressed messages are rejected by `ws` with code 1009 before application delivery and without unbounded decompressed growth. The limit is a protocol invariant rather than deployment configuration.

The composer owns the transient receipt presentation. It does not append a receipt event or infer durable state from HTTP success; durable UI state continues to come from session history and realtime session frames.

## Reconnect semantics

Reconnect remains rebuild, as defined by the [Web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md). A new connection generation discards the closed downlink's in-memory backlog. For each open session, the client uses `session/subscribed.lastSeq` as the live-stream watermark and rebuilds from session history plus subsequent session frames. Events that the failed downlink did not deliver remain recoverable from the authoritative durable log rather than from a transport-owned resume buffer; the local receipt is not replay input.

An overflow, timeout, or malformed batch follows the ordinary reconnect policy: the initiating downlink fails the browser connection generation, the companion stream closes, and mux and host reconnect together. A source rejection abandons its unsent partial batch and attempts one separate `stream/error` only while the socket remains open. Batch decoding validates every inner envelope and payload before publishing any member. Requests lost with a failed physical batch remain recoverable through the same `session/subscribed.lastSeq` and durable-history rebuild; transport batching neither creates a resume buffer nor changes session-event semantics. None of these paths creates a special agent cancellation, retries the model request, or converts the local submission receipt into a durable acknowledgement.

## Alternatives considered

**Rely on per-message compression without batching.** Rejected: the compressed per-frame benchmark filled the bounded producer queue before delivery completed. Compression reduces transport bytes but does not amortize physical-message scheduling and write work.

**Send a raw JSON array.** Rejected: a discriminated `server-batch` wrapper makes the physical-message type explicit, supports strict wrapper diagnostics, and avoids treating an arbitrary array as a protocol message.

**Lossily coalesce `assistant/chunk` frames.** Rejected: chunk sequence, timing, partial output, replay, and UI fidelity remain observable. The transport must not invent a second, lossy account of an authoritative session log.

**Abort the agent or model run when a downlink stalls.** Rejected: a browser connection is an observer of durable work, not the owner of that work. Ending the producer would make one slow or disconnected client change the conversation's durable result.

**Persist the composer's submission receipt.** Rejected: accepted prompts and their later lifecycle events already provide durable evidence. A separate receipt event would elevate local HTTP acceptance into session semantics and could still be mistaken for model or delivery completion.

**Retain compression context across messages.** Rejected: context takeover keeps per-connection zlib state and prevents the configured threshold from deciding compression independently for each message. Disabling it trades some compression ratio for bounded state and effective threshold behavior.

**Treat compression concurrency as independently reloadable per instance.** Rejected: `ws` owns one process-global first-instantiation limiter. Accepting a different later value would claim a reconfiguration that did not occur, so the carrier fails loud and requires process restart.

## Acceptance criteria

- A stalled mux or host consumer cannot exceed its configured per-stream frame capacity. Overflow is attributed to that stream, fails only its browser connection generation, closes the companion stream, and reconnects both; other browser or client connections and the agent or model run continue, and the run's events remain durable.
- WebSocket compression negotiates dual no-context-takeover. Its threshold controls per-message compression, and its process-wide concurrency is bounded from 1 through 16 and cannot change without restart after the first enabled instance.
- Optional Host batching uses production candidates of 64 requests, 262,144 complete-message UTF-8 bytes, and 16 milliseconds, while retaining a disabled plugin default. Count, exact wrapper bytes including commas, the first-item deadline, and clean source end each flush; a one-item or wrapper-oversized request uses its original single text. Every inner request retains order, `rpcId`, payload, and individual validation, and no lossy event path exists.
- Each `ServerRequest` is serialized once. An exact queued-byte fit is admitted; a serialized UTF-8 physical message that would exceed the limit is rejected before send and compression, and `bufferedAmount` is checked again after `send()` returns and after its callback. A byte or time violation starts on the affected downlink before the same browser connection generation closes its companion stream and reconnects both.
- Inbound application messages at or below 1 KiB close with protocol code 1008; larger compressed and uncompressed messages close with code 1009 without preventing a later peer from connecting.
- Reconnect rebuilds every open session from `session/subscribed.lastSeq` and session history, including events not received before the downlink failed, without relying on a transport resume buffer.
- The composer displays a local submission receipt only after local submit success and does not represent it as persistence, model progress, completion, or remote delivery.
- `scripts/websocket-downlink-benchmark.ts` launches compression-disabled and compression-enabled modes in separate fresh Node child processes, and `scripts/websocket-downlink-benchmark-worker.ts` opens five browser peers and ten real WebSocket downlinks in each mode.
- Each browser's mux stream receives exactly 24,000 synthetic session frames, and each host stream receives exactly 256 fixed host frames. Session-frame payloads deterministically cycle worker-owned fixed `reasoning-delta`, `text-delta`, and `tool-call-delta` constructors, and the parent rejects reports whose serialized application bytes differ between modes.
- Producers push batches of 64 and yield with `setImmediate`; every source uses the 4,096-frame `FrameQueue`.
- After all ten sockets open, the benchmark records per-client TCP `bytesRead` baselines. It sums final-minus-baseline `bytesRead` after all expected frames arrive and before sockets close to obtain transport bytes.
- The worker samples `process.memoryUsage().rss` every 5 ms from a baseline taken after all sockets open. Compressed-run RSS delta is peak minus baseline.
- Relative to the compression-disabled mode, compression reduces WebSocket transport bytes by at least 60%, and compressed-run RSS delta is no greater than 64 MiB. Any miss blocks production compression and requires a separate batching revision.
- Realtime delivery preserves every `assistant/chunk` frame; no lossy coalescing path is introduced.

## Risks

Closing a persistently slow downlink can create reconnect churn and temporarily hide live progress until history rebuild completes. Compression consumes CPU, and disabling context takeover can reduce its ratio; the process-wide concurrency value also requires restart to change. Batching adds up to the configured first-item delay and makes one malformed inner request reject the whole physical message, while history rebuild remains the recovery path. Poorly selected frame, batch, or socket budgets can still allow excess memory or disconnect healthy high-throughput clients. The local receipt may be misunderstood unless its wording and lifetime remain visibly distinct from durable progress.
