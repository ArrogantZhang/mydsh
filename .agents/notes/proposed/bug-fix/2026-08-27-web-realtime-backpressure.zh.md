# Agent Note: Web 实时背压与提交反馈

Status: proposed

[English](2026-08-27-web-realtime-backpressure.md) | 中文

## 问题

缓慢或停滞的浏览器下行可能在没有明确资源上限的情况下积累已序列化的实时帧与待完成的 socket 写入。突发的 `assistant/chunk` 流量因此可能把单个观察方的交付失败转化为无界的宿主内存增长，而产生持久事件的 agent（智能体）与模型运行仍然有效。composer 还需立即反馈本地提交调用已被接受，但不得把这项瞬时事实表述为持久进度或远程交付。

## 提案

持久会话日志仍是会话内容、顺序、完成状态与回放的真源。composer 仅在提交调用成功后显示本地提交回执；该回执不声明提示词已持久化、模型运行已开始或完成，也不声明任何下行已显示结果。

每条实时下行都具有有界交付资源。`dsh-host-apiproxy` 拥有按流计算的帧容量；`dsh-client-connection` 拥有无损物理消息 batching、WebSocket 压缩、已序列化的排队字节核算、发送超时与固定入站协议上限。溢出或超时由单条受影响下行发起并归因于它。该下行首先关闭；`ConnectionController` 随后判定其浏览器连接代际失败，关闭配套 mux 或 host 下行，并重连两者。该失败绝不中止 agent 或模型运行、修改持久日志，也不会关闭属于其他浏览器或客户端连接的下行。

本提案扩展既有 [WebSocket 下行载体](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.zh.md)，不改变其两条独立逻辑流或 HTTP 上行。

## 资源归属

`dsh-host-apiproxy` 把完整应用帧接纳到各条逻辑流中，因此由它在无界帧积压形成前应用该流的帧容量限制。容量属于单个流实例，因此停滞的 mux 或 host 消费方无法占用其他下行的限额。

`dsh-client-connection` 拥有物理 WebSocket。它会把每个逻辑 `ServerRequest` 只序列化一次，并以 UTF-8 字节计量每条完整物理消息。调用 `send()` 前，当 `bufferedAmount` 加上这些字节后超过配置上限时，载体会拒绝该物理消息；恰好达到上限则允许发送。这是在压缩前对应用字节进行的刻意保守核算。载体会在 `send()` 返回后立即再次检查 `bufferedAmount`，并在其回调后再检查一次。字节限制或按物理消息计算的发送超时会终止受影响的 WebSocket、中止其 source，并且只产生内部的类别与上限诊断；不保证已终止的 peer 会收到 `stream/error` frame。既有代际失败语义随后会关闭配套流，并为该浏览器连接重连两条流。会话、agent 与模型生命周期以及其他浏览器或客户端连接不会收到该传输中止。

压缩使用 `permessage-deflate`，并同时禁用服务端与客户端 context takeover。这会限制每条连接的 zlib 状态，并使 `downlinkCompressionThresholdBytes` 生效。`ws` 并发 limiter 位于进程全局且使用首个值，因此 `downlinkCompressionConcurrency` 接受 1 至 16，第一个启用压缩的实例会在进程重启前占有该值，之后的不同值会使插件加载失败。`dsh-client-connection` 是生产环境中 `ws` 的唯一所有方。

压缩后的逐帧基准测试在交付完成前填满了每个生产方的 4,096 帧队列，因此仅靠压缩并未限制测得突发流量下的调度与写入开销。此修订因此选择显式、无损的 Host batching。生产候选值是 64 个逻辑请求、262,144 个完整消息 UTF-8 字节，以及从首个已缓冲请求起算的 16 毫秒；插件默认仍为禁用，直至部署选择启用。Host 会在计数、完整 wrapper 字节、首项 deadline 或 source 正常结束要求发送时发出消息。同时最多只有一个 source `next()` 处于 pending；deadline 先完成时，accumulator 会 flush 当前请求，并为下一 batch 保留该 outstanding promise，而不会并发读取 source。它把多请求消息编码为严格的 `server-batch` wrapper，并保留每个内部请求的顺序、`rpcId` 与 payload。单请求 flush 与对 batch wrapper 而言过大的请求仍使用普通 `server-request` 消息。启用的 batch 字节上限若大于 socket 字节上限，插件会在注册 route 或 socket 之前加载失败。

入站业务消息仍然被禁止。固定的 1 KiB `maxPayload` 限制解压后的消息大小：上限内的消息会进入协议拒绝逻辑并以状态码 1008 关闭，较大的压缩或未压缩消息则由 `ws` 在交付给业务之前以状态码 1009 拒绝，且解压后的数据不会无界增长。该限制是协议不变量，而不是部署配置。

composer 仅拥有瞬时回执的展示。它不追加回执事件，也不从 HTTP 成功推断持久状态；持久 UI 状态继续来自会话历史与实时会话帧。

## 重连语义

重连仍是重建，与 [Web 客户端架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)的定义一致。新的连接代际会丢弃已关闭下行的内存积压。对每个已打开会话，客户端使用 `session/subscribed.lastSeq` 作为实时流水位，并从会话历史加后续会话帧重建。失败下行未交付的事件从权威持久日志恢复，而不是从传输层拥有的恢复缓冲区恢复；本地回执不是回放输入。

溢出、超时或畸形 batch 遵循普通重连策略：发起故障的下行使浏览器连接代际失败，配套流关闭，mux 与 host 随后一同重连。source 拒绝时会放弃其尚未发送的部分 batch，并且仅在 socket 仍打开时尝试发送一个单独的 `stream/error`。Batch 解码会先验证每个内部 envelope 与 payload，再发布任何成员。随失败物理 batch 一同丢失的请求仍可通过同一套 `session/subscribed.lastSeq` 与持久 history 重建恢复；传输 batching 既不创建恢复缓冲区，也不改变会话事件语义。这些路径都不会为 agent 创建特殊取消、重试模型请求，或把本地提交回执转换为持久确认。

## 考虑过的替代方案

**只依赖逐消息压缩而不 batching。** 否决：压缩后的逐帧基准测试在交付完成前填满了有界生产方队列。压缩会减少传输字节，但不会摊薄物理消息调度与写入工作。

**发送原始 JSON 数组。** 否决：带判别字段的 `server-batch` wrapper 会明确物理消息类型、支持严格的 wrapper 诊断，并避免把任意数组视为协议消息。

**有损合并 `assistant/chunk` 帧。** 否决：分片顺序、时序、部分输出、回放与 UI 保真度仍然可观测。传输层不得为权威会话日志另外编造一份有损记录。

**下行停滞时中止 agent 或模型运行。** 否决：浏览器连接是持久工作的观察方，而不是工作归属方。结束生产方会让一个缓慢或断开的客户端改变会话的持久结果。

**持久化 composer 的提交回执。** 否决：已接受的提示词与其后续生命周期事件已提供持久证据。单独的回执事件会把本地 HTTP 接受提升为会话语义，但它仍可能被误认为模型完成或交付完成。

**在消息之间保留压缩 context。** 否决：context takeover 会保留每条连接的 zlib 状态，并使配置的阈值无法独立决定每条消息是否压缩。禁用 context takeover 用一部分压缩比交换了有界状态与有效的阈值语义。

**把压缩并发视为可按实例独立重载。** 否决：`ws` 拥有一个进程级、首次实例化生效的 limiter。接受之后的不同值会声称一次并未发生的重配置，因此载体会明确失败并要求进程重启。

## 接受标准

- 停滞的 mux 或 host 消费方无法超过其配置的按流帧容量。溢出归因于该流，仅使其浏览器连接代际失败，关闭配套流并重连两者；其他浏览器或客户端连接以及 agent 或模型运行继续，且该运行的事件仍会持久化。
- WebSocket 压缩会协商双向 no-context-takeover。其阈值会控制单条消息的压缩，进程级并发值限于 1 至 16，且在第一个启用压缩的实例后无法不经重启而修改。
- 可选 Host batching 使用 64 个请求、262,144 个完整消息 UTF-8 字节与 16 毫秒的生产候选值，同时保留禁用的插件默认值。计数、包括逗号在内的严格 wrapper 字节数、首项 deadline 与 source 正常结束都会触发 flush；单项请求或对 wrapper 而言过大的请求使用其原始单条文本。每个内部请求都保留顺序、`rpcId`、payload 与逐项验证，且不存在有损事件路径。
- 每个 `ServerRequest` 只序列化一次。排队字节恰好达到上限时允许发送；会超过上限的序列化 UTF-8 物理消息会在发送与压缩前被拒绝，且 `bufferedAmount` 会在 `send()` 返回后及其回调后再次检查。字节或时间限制故障会在受影响下行上发起，然后同一浏览器连接代际关闭配套流并重连两者。
- 1 KiB 及以下的入站业务消息以协议状态码 1008 关闭；更大的压缩与未压缩消息以状态码 1009 关闭，且不会阻止之后的 peer 连接。
- 重连从 `session/subscribed.lastSeq` 与会话历史重建每个已打开会话，包括下行失败前尚未接收的事件，且不依赖传输层恢复缓冲区。
- composer 仅在本地提交成功后显示本地提交回执，不把它表述为持久化、模型进度、完成状态或远程交付。
- `scripts/websocket-downlink-benchmark.ts` 在独立的全新 Node 子进程中分别启动关闭压缩与启用压缩两种模式，`scripts/websocket-downlink-benchmark-worker.ts` 在每种模式中打开五个浏览器对端与十条真实 WebSocket 下行。
- 每个浏览器的 mux 流恰好接收 24,000 个合成会话帧，每条 host 流恰好接收 256 个固定 host 帧。会话帧载荷按确定性顺序循环使用 worker 拥有的固定 `reasoning-delta`、`text-delta` 与 `tool-call-delta` 构造器，两种模式报告的序列化应用字节数不同时，父进程会拒绝结果。
- 生产方每 16 ms 推送 24 帧；该节奏保留已观测到的生产峰值 24 帧/16 ms，同时为每个来源持续提供 1,500 帧/s，超过已观测 141/s 峰值的十倍。每个源都使用容量为 4,096 帧的 `FrameQueue`。
- 十条 socket 全部打开后，基准测试记录每个客户端的 TCP `bytesRead` 基线。所有预期帧到达后、socket 关闭前，它汇总各客户端最终值减基线值所得的 `bytesRead`，以得出传输字节数。
- worker 从十条 socket 全部打开后取得的基线开始，每 5 ms 采样一次 `process.memoryUsage().rss`。每个模式都报告峰值减基线的 RSS 增量；压缩 RSS 开销是 `max(0, compressed.rssDeltaBytes - plain.rssDeltaBytes)`。
- 相较关闭压缩模式，压缩使 WebSocket 传输字节数至少降低 60%，且压缩 RSS 开销不超过 64 MiB。任一指标未达标都会阻止生产环境启用压缩。
- 实时交付保留每个 `assistant/chunk` 帧，不引入有损合并路径。

## 风险

关闭持续缓慢的下行可能导致重连风暴，并在历史重建完成前暂时隐藏实时进度。压缩会消耗 CPU，禁用 context takeover 也可能降低压缩比；进程级并发值也必须重启后才能修改。Batching 会增加最长为配置首项时限的延迟，并让单个畸形内部请求拒绝整条物理消息，而 history 重建仍是恢复路径。选择不当的帧、batch 或 socket 预算仍可能允许过多内存占用，或使健康的高吞吐客户端断开。如果回执的措辞与存续时间未明显区别于持久进度，它可能被误解。
