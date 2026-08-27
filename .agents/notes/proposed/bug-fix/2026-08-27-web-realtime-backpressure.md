# Agent Note: Web realtime backpressure and submit feedback

Status: proposed

English | [中文](2026-08-27-web-realtime-backpressure.zh.md)

## Problem

A slow or stalled browser downlink can accumulate serialized realtime frames and pending socket writes without a clear resource limit. Bursty `assistant/chunk` traffic can therefore turn one observer's delivery failure into unbounded host memory growth, while the agent and model run producing the durable events remains valid. The composer also needs immediate feedback that the local submit call was accepted without presenting that transient fact as durable progress or remote delivery.

## Proposal

The durable session log remains authoritative for conversation content, ordering, completion, and replay. The composer exposes only a local submission receipt after its submit call succeeds; that receipt does not claim that the prompt is durable, that a model run has started or completed, or that any downlink has displayed the result.

Each realtime downlink has bounded delivery resources. `dsh-host-apiproxy` owns per-stream frame capacity. `dsh-client-connection` owns WebSocket compression and the socket byte and time budgets. Overflow or timeout closes only the affected downlink and never aborts the agent or model run, mutates the durable log, or closes another downlink.

This proposal extends the existing [WebSocket downlink carrier](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.md) without changing its two independent logical streams or its HTTP uplink.

## Resource ownership

`dsh-host-apiproxy` admits complete application frames to each logical stream and therefore applies that stream's frame-capacity limit before an unbounded frame backlog can form. The capacity belongs to the individual stream instance, so a stalled mux or host consumer cannot consume another downlink's allowance.

`dsh-client-connection` owns the physical WebSocket, so it enables compression and accounts for bytes awaiting socket completion and elapsed write time. Exceeding either socket budget closes that WebSocket and disposes only its delivery path. The session, agent, and model lifecycles do not receive a transport abort from frame overflow or socket timeout.

The composer owns the transient receipt presentation. It does not append a receipt event or infer durable state from HTTP success; durable UI state continues to come from session history and realtime session frames.

## Reconnect semantics

Reconnect remains rebuild, as defined by the [Web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md). A new connection generation discards the closed downlink's in-memory backlog. For each open session, the client uses `session/subscribed.lastSeq` as the live-stream watermark and rebuilds from session history plus subsequent session frames. Events that the failed downlink did not deliver remain recoverable from the authoritative durable log rather than from a transport-owned resume buffer; the local receipt is not replay input.

An overflow or timeout follows the ordinary reconnect policy. It does not create a special agent cancellation, retry the model request, or convert the local submission receipt into a durable acknowledgement.

## Alternatives considered

**Batch frames before WebSocket writes.** Batching is deferred unless WebSocket compression misses the measured byte/RSS gate. Adding a batching scheduler before that evidence would increase latency and ordering complexity without proving that compression and bounded queues are insufficient.

**Lossily coalesce `assistant/chunk` frames.** Rejected: chunk sequence, timing, partial output, replay, and UI fidelity remain observable. The transport must not invent a second, lossy account of an authoritative session log.

**Abort the agent or model run when a downlink stalls.** Rejected: a browser connection is an observer of durable work, not the owner of that work. Ending the producer would make one slow or disconnected client change the conversation's durable result.

**Persist the composer's submission receipt.** Rejected: accepted prompts and their later lifecycle events already provide durable evidence. A separate receipt event would elevate local HTTP acceptance into session semantics and could still be mistaken for model or delivery completion.

## Acceptance criteria

- A stalled mux or host consumer cannot exceed its configured per-stream frame capacity, and overflow closes only that downlink while the agent or model run continues and its events remain durable.
- WebSocket compression is active, pending socket bytes and write time are bounded, and either socket-budget violation closes only the affected downlink.
- Reconnect rebuilds every open session from `session/subscribed.lastSeq` and session history, including events not received before the downlink failed, without relying on a transport resume buffer.
- The composer displays a local submission receipt only after local submit success and does not represent it as persistence, model progress, completion, or remote delivery.
- Stress measurements record encoded bytes and host RSS. Frame batching remains absent when compression satisfies the measured gate and is reconsidered only when compression misses it.
- Realtime delivery preserves every `assistant/chunk` frame; no lossy coalescing path is introduced.

## Risks

Closing a persistently slow downlink can create reconnect churn and temporarily hide live progress until history rebuild completes. Compression consumes CPU, while poorly selected frame or socket budgets can still allow excess memory or disconnect healthy high-throughput clients. The local receipt may be misunderstood unless its wording and lifetime remain visibly distinct from durable progress. Deferring batching retains per-frame scheduling overhead; measurements may require a later batching proposal, but not lossy event semantics.
