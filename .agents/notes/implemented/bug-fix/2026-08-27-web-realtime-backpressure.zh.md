# Agent Note: Web 实时背压与提交反馈

Status: implemented

[English](2026-08-27-web-realtime-backpressure.md) | 中文

## 问题

缓慢或停滞的浏览器下行可能在没有明确资源上限的情况下积累已序列化的实时帧与待完成的 socket 写入。突发的 `assistant/chunk` 流量因此可能把单个观察方的交付失败转化为无界的宿主内存增长，而产生持久事件的 agent（智能体）与模型运行仍然有效。composer 还需立即反馈本地提交尝试已经开始，但不得把这项 admission 前的瞬时状态表述为持久进度或远程交付。

## 决策

持久会话日志仍是会话内容、顺序、完成状态与回放的真源。提交尝试从输入状态机的 `adjudicating` 或 `submitting` 阶段开始，composer 会立即渲染相应的本地 pending 状态。该状态可能早于 sink 或 claim 执行，也可能早于 Host admission；它不声明提示词已持久化、模型运行已开始或完成，也不声明任何下行已显示结果。持久 UI 状态继续来自会话历史与实时会话帧，重连重建则从这些持久事件生成恰好一次的可见 transcript（文本记录）。

每条实时下行都具有有界交付资源。`dsh-host-apiproxy` 拥有按流计算的帧容量；`dsh-client-connection` 拥有无损物理消息 batching、WebSocket 压缩、已序列化的排队字节核算、发送超时与固定入站协议上限。溢出或超时由单条受影响下行发起并归因于它。该下行首先关闭；`ConnectionController` 随后判定其浏览器连接代际失败，关闭配套 mux 或 host 下行，并重连两者。该失败绝不中止 agent 或模型运行、修改持久日志，也不会关闭属于其他浏览器或客户端连接的下行。

本决策扩展既有 [WebSocket 下行载体](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.zh.md)，不改变其两条独立逻辑流或 HTTP 上行。

## 资源归属

`dsh-host-apiproxy` 把完整应用帧接纳到各条逻辑流中，并在无界帧积压形成前应用该流的帧容量限制。每条流拥有自己的 4,096 帧队列，因此停滞的 mux 或 host 消费方无法占用其他下行的限额。

`dsh-client-connection` 拥有物理 WebSocket。它会把每个逻辑 `ServerRequest` 只序列化一次，并以 UTF-8 字节计量每条完整物理消息。无损 batching 会在累积请求数、严格 wrapper 字节、首项 deadline、source 正常结束达到配置上限时发送。同时最多只有一个 source `next()` 处于 pending；deadline 先完成时，accumulator 会 flush 当前请求，并为下一 batch 保留该 outstanding promise，而不会并发读取 source。多请求消息使用严格的 `server-batch` wrapper，并保留每个内部请求的顺序、`rpcId` 与 payload。单请求 flush 与对 batch wrapper 而言过大的请求仍使用普通 `server-request` 消息。wire schema 允许一条 server batch 最多包含 256 个请求，启用的 batch 字节上限若大于 socket 字节上限，插件会在注册 route 或 socket 之前加载失败。

浏览器会在发布任何成员之前校验完整的 `server-batch` wrapper、每个内部 `ServerRequest` 与每个流 payload。畸形物理消息不会发布任何前缀，会以状态码 1002 关闭 socket，并进入普通重连路径。

调用 `send()` 前，当 `bufferedAmount` 加上物理消息的已序列化字节后超过配置上限时，载体会拒绝该物理消息；恰好达到上限则允许发送。这是在压缩前对应用字节进行的保守核算。载体会在 `send()` 返回后立即再次检查 `bufferedAmount`，并在其回调后再检查一次。字节限制、发送回调失败或按物理消息计算的超时会终止受影响的 WebSocket 并中止其 source。诊断只包含类别与配置上限，不保证已终止的 peer 会收到 `stream/error` frame。source 拒绝时会放弃其尚未发送的部分 batch，并且仅在 socket 仍打开时尝试发送一个单独编码的 `stream/error`。

压缩使用 `permessage-deflate`，并同时禁用服务端与客户端 context takeover。这会限制每条连接的 zlib 状态，并使 `downlinkCompressionThresholdBytes` 生效。`ws` 并发 limiter 位于进程全局且使用首个值，因此 `downlinkCompressionConcurrency` 接受 1 至 16，第一个启用压缩的实例会在进程重启前占有该值，之后的不同值会使插件加载失败。`dsh-client-connection` 是生产环境中 `ws` 的唯一所有方。

入站业务消息仍然被禁止。固定的 1 KiB `maxPayload` 限制解压后的消息大小：上限内的消息会进入协议拒绝逻辑并以状态码 1008 关闭，较大的压缩或未压缩消息则由 `ws` 在交付给业务之前以状态码 1009 拒绝，且解压后的数据不会无界增长。该限制是协议不变量，而不是部署配置。

## 重连语义

重连仍是重建，与 [Web 客户端架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)的定义一致。新的连接代际会丢弃已关闭下行的内存积压。对每个已打开会话，客户端使用 `session/subscribed.lastSeq` 作为实时流水位，并从会话历史加后续会话帧重建。失败下行未交付的会话事件从权威持久日志恢复，而不是从传输层拥有的恢复缓冲区恢复；本地提交反馈不是回放输入。

溢出、超时、发送失败或畸形 batch 遵循普通重连策略：发起故障的下行使浏览器连接代际失败，配套流关闭，mux 与 host 随后一同重连。失败的物理 batch 不会获得传输层重试。未交付的会话事件通过同一套 `session/subscribed.lastSeq` 与持久 history 重建；Host 状态遵循现有配套连接代际重建，包括会话列表 refresh 在内的权威 baseline 拉取会建立替代状态，后续 Host frame 再推进该状态。传输 batching 不创建恢复缓冲区，也不改变会话事件语义；这些路径都不会为 agent 创建特殊取消、重试模型请求，或把本地提交反馈转换为持久确认。

## 生产配置

阿里云生产覆盖层设置 `maxEventStreamQueueFrames: 4096`；`downlinkBatching: true`、`downlinkBatchMaxFrames: 64`、`downlinkBatchMaxBytes: 262144` 与 `downlinkBatchFlushMs: 16`；`downlinkCompression: true`、`downlinkCompressionThresholdBytes: 0` 与 `downlinkCompressionConcurrency: 4`；以及 `downlinkMaxBufferedBytes: 1048576` 与 `downlinkSendTimeoutMs: 5000`。对于未主动启用这些功能的其他组合，包默认仍禁用 batching 与压缩。

release packager 会在 `pnpm run build` 前运行 ApiProxy、connection 与部署的聚焦测试，再运行两次固定下行基准。基准或聚焦测试失败因而会在采用生产 batching 与压缩策略构建产物之前阻止流程。

## 考虑过的替代方案

**只依赖逐消息压缩而不 batching。** 否决：压缩后的逐帧基准测试在交付完成前填满了有界生产方队列。压缩会减少传输字节，但不会摊薄物理消息调度与写入工作。

**发送原始 JSON 数组。** 否决：带判别字段的 `server-batch` wrapper 会明确物理消息类型、支持严格的 wrapper 诊断，并避免把任意数组视为协议消息。

**有损合并 `assistant/chunk` 帧。** 否决：分片顺序、时序、部分输出、回放与 UI 保真度仍然可观测。传输层不得为权威会话日志另外编造一份有损记录。

**下行停滞时中止 agent 或模型运行。** 否决：浏览器连接是持久工作的观察方，而不是工作归属方。结束生产方会让一个缓慢或断开的客户端改变会话的持久结果。

**持久化 composer 的提交反馈。** 否决：持久的 `user/message` 事件及其后续生命周期事件已提供证据。单独的反馈事件会把本地 pending 状态提升为会话语义，但它仍可能被误认为模型完成或交付完成。

**在消息之间保留压缩 context。** 否决：context takeover 会保留每条连接的 zlib 状态，并使配置的阈值无法独立决定每条消息是否压缩。禁用 context takeover 用一部分压缩比交换了有界状态与有效的阈值语义。

**把压缩并发视为可按实例独立重载。** 否决：`ws` 拥有一个进程级、首次实例化生效的 limiter。接受之后的不同值会声称一次并未发生的重配置，因此载体会明确失败并要求进程重启。

## 验证

聚焦测试钉住按流队列溢出与隔离；按数量、字节、deadline 与 source 正常结束进行的无损 batching；单 pending-read 不变量；256 请求的 wire 上限；浏览器原子校验与状态码 1002 重连；字节、发送失败与超时导致的 source 中止；peer 隔离；即时且无障碍的提交反馈；恰好一次的 transcript 重建；以及 build 前的部署门禁顺序。产物构建器采用锚定的部署筛选，精确选择生产策略、`forward_auth` header 隔离与非 root 的已认证 WebSocket helper 测试。helper 测试要求 mux 与 host 探测都收到 `101` 且只能以 curl 超时结束；`502`、`401`、其他退出状态或缺少一条已接受路径都会失败。依赖 root 和 systemd 工具的部署 helper 集成测试仍由 Linux CI 运行。

固定基准使用五个浏览器与十条真实 WebSocket 下行。每个 source 每 16 毫秒产生 24 帧，每个 mux source 交付 24,000 个会话帧，每个 host source 交付 256 个 host 帧；plain 与 compressed 模式携带完全相同的已序列化应用字节，且不报告 payload 内容。

- 第 1 次 plain：`serializedBytes=125884600`、`transportBytes=126107080`、`webSocketMessages=2530`、`wallMs=25948.5768`、`peakQueueFrames=24`、`rssDeltaBytes=163749888`、`maxBatchFrames=48`、`maxBatchBytes=50324`。
- 第 1 次 compressed：`serializedBytes=125884600`、`transportBytes=5432380`、`webSocketMessages=2530`、`wallMs=25331.873`、`peakQueueFrames=24`、`rssDeltaBytes=209920000`、`maxBatchFrames=48`、`maxBatchBytes=50324`。
- 第 1 次概述：`byteReduction=0.9569224820684136`、`plainMessageReduction=0.9791391820580475`、`compressedMessageReduction=0.9791391820580475`、`compressionRssOverheadBytes=46170112`。
- 第 2 次 plain：`serializedBytes=125884600`、`transportBytes=126107080`、`webSocketMessages=2530`、`wallMs=24515.4427`、`peakQueueFrames=24`、`rssDeltaBytes=196530176`、`maxBatchFrames=48`、`maxBatchBytes=50324`。
- 第 2 次 compressed：`serializedBytes=125884600`、`transportBytes=5432390`、`webSocketMessages=2530`、`wallMs=24943.6563`、`peakQueueFrames=47`、`rssDeltaBytes=170762240`、`maxBatchFrames=64`、`maxBatchBytes=67037`。
- 第 2 次概述：`byteReduction=0.9569224027707247`、`plainMessageReduction=0.9791391820580475`、`compressedMessageReduction=0.9791391820580475`、`compressionRssOverheadBytes=0`。

两次运行都保留全部应用帧、保持在 4,096 帧 source 容量以内、使物理 WebSocket 消息减少 97% 以上、使压缩传输字节减少 95% 以上，并把压缩 RSS 开销保持在 64 MiB 以下。

## 后果

单个停滞浏览器可能丢失实时进度并重连，但无法增长其他流的队列、中止模型运行、改变持久结果或影响健康 peer。history 重建是恢复机制，因此持续的网络故障可能造成重连风暴，并在实时进度重建完成前暂时隐藏它。

无损 batching 会摊薄物理消息调度与写入工作，同时增加最长为配置首项时限 16 毫秒的延迟。一个畸形内部请求会拒绝整条物理消息，持久 history 而不是传输重试会恢复缺失的会话事件。

压缩会消耗 CPU，禁用 context takeover 可能降低压缩比，修改进程级并发值还要求重启。测得的部署值限制这些成本，同时不削弱字节熔断或引入有损合并。

帧、batch 与 socket 预算仍是部署调优值。过松的取值会让跨流和 socket 的聚合内存占用过多；过紧的取值会断开健康的高吞吐客户端。测得的生产值是当前选择，并不表示这项调优权衡已经消失。

即时 pending 反馈让 admission 前的提交尝试可见；不增加反馈事件则让持久化、模型进度、完成状态与远程交付保持彼此独立。其措辞与存续时间必须始终明显区别于持久会话内容。
