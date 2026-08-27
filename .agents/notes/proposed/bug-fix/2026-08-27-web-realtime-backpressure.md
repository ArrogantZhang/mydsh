# Agent Note: Web realtime backpressure and submit feedback

Status: proposed

English | [中文](2026-08-27-web-realtime-backpressure.zh.md)

## Problem

A slow or stalled browser downlink can accumulate serialized realtime frames and pending socket writes without a clear resource limit. Bursty `assistant/chunk` traffic can therefore turn one observer's delivery failure into unbounded host memory growth, while the agent and model run producing the durable events remains valid. The composer also needs immediate feedback that the local submit call was accepted without presenting that transient fact as durable progress or remote delivery.

## Proposal

The durable session log remains authoritative for conversation content, ordering, completion, and replay. The composer exposes only a local submission receipt after its submit call succeeds; that receipt does not claim that the prompt is durable, that a model run has started or completed, or that any downlink has displayed the result.

Each realtime downlink has bounded delivery resources. `dsh-host-apiproxy` owns per-stream frame capacity. `dsh-client-connection` owns WebSocket compression and the socket byte and time budgets. Overflow or timeout is initiated by and attributed to one affected downlink. That downlink closes first; `ConnectionController` then fails its browser connection generation, closes the companion mux or host downlink, and reconnects both. The failure never aborts the agent or model run, mutates the durable log, or closes a downlink belonging to another browser or client connection.

This proposal extends the existing [WebSocket downlink carrier](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.md) without changing its two independent logical streams or its HTTP uplink.

## Resource ownership

`dsh-host-apiproxy` admits complete application frames to each logical stream and therefore applies that stream's frame-capacity limit before an unbounded frame backlog can form. The capacity belongs to the individual stream instance, so a stalled mux or host consumer cannot consume another downlink's allowance.

`dsh-client-connection` owns the physical WebSocket, so it enables compression and accounts for bytes awaiting socket completion and elapsed write time. Exceeding either socket budget closes the affected WebSocket. Existing generation-failure semantics then close the companion stream and reconnect both streams for that browser connection. The session, agent, and model lifecycles and other browser or client connections do not receive that transport abort.

The composer owns the transient receipt presentation. It does not append a receipt event or infer durable state from HTTP success; durable UI state continues to come from session history and realtime session frames.

## Reconnect semantics

Reconnect remains rebuild, as defined by the [Web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md). A new connection generation discards the closed downlink's in-memory backlog. For each open session, the client uses `session/subscribed.lastSeq` as the live-stream watermark and rebuilds from session history plus subsequent session frames. Events that the failed downlink did not deliver remain recoverable from the authoritative durable log rather than from a transport-owned resume buffer; the local receipt is not replay input.

An overflow or timeout follows the ordinary reconnect policy: the initiating downlink fails the browser connection generation, the companion stream closes, and mux and host reconnect together. It does not create a special agent cancellation, retry the model request, or convert the local submission receipt into a durable acknowledgement.

## Alternatives considered

**Batch frames before WebSocket writes.** Batching is deferred while WebSocket compression passes the deterministic byte/RSS benchmark. `scripts/websocket-downlink-benchmark.ts` launches compression-disabled and compression-enabled modes in separate fresh Node child processes. In each mode, `scripts/websocket-downlink-benchmark-worker.ts` opens five browser peers and ten real WebSocket downlinks. Each browser's mux stream receives exactly 24,000 synthetic session frames, and each host stream receives exactly 256 fixed host frames. Session-frame payloads deterministically cycle fixed `reasoning-delta`, `text-delta`, and `tool-call-delta` constructors owned by the worker; the parent asserts that both modes report identical serialized application bytes. Producers push batches of 64 and yield with `setImmediate`, and each source uses the 4,096-frame `FrameQueue`. After all ten sockets open, the worker records per-client TCP `bytesRead` baselines. Transport bytes are the sum of final-minus-baseline `bytesRead` after all expected frames arrive and before sockets close. The worker samples `process.memoryUsage().rss` every 5 ms from a baseline taken after all sockets open; RSS delta is peak minus baseline. Compression must reduce WebSocket transport bytes by at least 60% relative to the compression-disabled mode while the compressed-run RSS delta remains no greater than 64 MiB. Any miss blocks production compression and requires a separate batching revision.

**Lossily coalesce `assistant/chunk` frames.** Rejected: chunk sequence, timing, partial output, replay, and UI fidelity remain observable. The transport must not invent a second, lossy account of an authoritative session log.

**Abort the agent or model run when a downlink stalls.** Rejected: a browser connection is an observer of durable work, not the owner of that work. Ending the producer would make one slow or disconnected client change the conversation's durable result.

**Persist the composer's submission receipt.** Rejected: accepted prompts and their later lifecycle events already provide durable evidence. A separate receipt event would elevate local HTTP acceptance into session semantics and could still be mistaken for model or delivery completion.

## Acceptance criteria

- A stalled mux or host consumer cannot exceed its configured per-stream frame capacity. Overflow is attributed to that stream, fails only its browser connection generation, closes the companion stream, and reconnects both; other browser or client connections and the agent or model run continue, and the run's events remain durable.
- WebSocket compression is active, pending socket bytes and write time are bounded, and either socket-budget violation starts on the affected downlink before the same browser connection generation closes its companion stream and reconnects both.
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

Closing a persistently slow downlink can create reconnect churn and temporarily hide live progress until history rebuild completes. Compression consumes CPU, while poorly selected frame or socket budgets can still allow excess memory or disconnect healthy high-throughput clients. The local receipt may be misunderstood unless its wording and lifetime remain visibly distinct from durable progress. Deferring batching retains per-frame scheduling overhead; measurements may require a later batching proposal, but not lossy event semantics.
