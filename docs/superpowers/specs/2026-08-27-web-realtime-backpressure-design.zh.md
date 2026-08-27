# DSH Web 实时传输背压与发送反馈设计

[English](2026-08-27-web-realtime-backpressure-design.md) | 中文

## 状态与范围

本设计修复已启用邀请码鉴权的阿里云 Web 部署中的对话反馈延迟。当前提交提示词后可能长时间看不到变化，随后用户消息与大量助手、工具卡片一起出现。服务器能及时接受提示词并产生首个事件；延迟发生在未压缩、每个事件对应一条消息的 WebSocket 流堆积于较慢公网连接时。

该部署支持 2 至 5 个浏览器同时使用。每个浏览器打开 mux 和 host 两条下行流，因此验收最多覆盖 10 条 WebSocket 连接。改动落在通用 Web 传输与输入框，并由阿里云组合覆盖层显式配置生产参数。

## 目标

- 不等待会话事件经网络返回，在浏览器下一次绘制前显示可见且无障碍可感知的提交反馈。
- 对代表性负载，把公网下行字节数至少降低 60%，并把 WebSocket 消息数至少降低 90%。
- 限制每条慢速下行流保留的帧与 socket 积压，避免单个浏览器无限增加宿主内存或阻塞模型运行。
- 保留所有持久会话事件，并在重连后重建相同对话，不产生重复或缺失的可见消息。
- 在 5 个浏览器、10 条下行流的代表性负载下，新增常驻内存不超过 64 MiB。

## 非目标

- 不修改模型提供方、Kimi 请求行为、token 生成、agent loop 或会话持久化。
- 不丢弃、合并、重排或重写 `assistant/chunk` 或其他会话事件。
- 不在宿主记录 `user/message` 前添加乐观用户消息事件或气泡。
- 不以 SSE 替换 WebSocket，不增加消息代理，也不修改内部 `ServerRequest` RPC envelope。
- 不调整 Caddy 缓冲；公网事件载体是 WebSocket，观察到的积压属于下游流量控制，而非 HTTP 响应缓冲设置。

## 方案选择

修复由四项保护共同组成：即时输入框反馈、有界无损 WebSocket 批处理、协商式压缩，以及带来源队列上限的慢消费者熔断。四者缺一不可。确定性的逐帧压缩运行在生成报告前填满了 4,096 帧 mux 队列，因此批处理是生产环境启用压缩的前提，而不是可选优化。

所选传输使用显式 `server-batch` 消息包装不变的 `ServerRequest` 值。直接使用原始 JSON 数组只能省下少量 wrapper，却会让传输消息种类与诊断含义不清晰。仍然否决有损合并 reasoning delta，因为它会改变实时与回放事件序列。

## 数据流

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

提示词请求和模型运行不依赖下行流持续连接。慢速流会发起其浏览器连接代际失败；`ConnectionController` 关闭配套流并重连两者，其他浏览器与 agent 继续运行。会话继续记录持久事件，供后续 history 读取。

## 即时提交反馈

对话输入框把输入状态机同步进入 `adjudicating` 或 `submitting` 的阶段作为本地回执，Enter 与鼠标提交都遵循这一规则。一个永久挂载且初始为空的 `role="status"` 区域会在回执生效时变为本地化的“发送中…”文本。空闲 Send 控件保持稳定的无障碍名称，用有对比度且尊重 reduced-motion 的 pending 标记替换箭头，并暴露 `aria-busy="true"`；普通运行中会话保留 Stop 操作。输入框保持只读并显示已提交的草稿，直到既有状态机完成请求，或在失败后恢复草稿。

该回执不是合成对话项。用户气泡仍只来源于人类来源的持久 `user/message` 事件，从而维持日志状态的权威性，并避免请求被拒绝或重连后出现协调逻辑与重复气泡。产品验收测试会在键盘与按钮触发后至少一次浏览器绘制机会之后测量 pending 状态，并要求其在 100 ms 内出现。

## WebSocket 压缩

`client-connection` 通过 `ws` 协商 RFC 7692 `permessage-deflate`。包默认关闭压缩；基准连续通过两次后，由阿里云覆盖层显式启用。生产环境使用 0 字节阈值与进程级并发 4。服务端与客户端 context takeover 均关闭，使 threshold 真正生效，并限制每条连接的 zlib 状态；由于 `ws` 拥有唯一的进程级 limiter，修改并发需要重启进程。

插件提供经过验证的 `downlinkCompression`、`downlinkCompressionThresholdBytes` 和 `downlinkCompressionConcurrency` 字段，不把部署调优值硬编码在载体中。仅下行服务器在拒绝客户端应用消息前，把上行 `maxPayload` 固定为 1 KiB。任何压缩日志或测量都不包含邀请码、Cookie、模型凭据、消息文本或工具输出；基准使用类别与大小固定的确定性合成 payload。

只有代表性基准连续两次把传输字节至少降低 60%、把 WebSocket 消息数至少降低 90%、避免来源 overflow，并把压缩模式下 10 条下行流的 RSS 增量保持在 64 MiB 以内时，生产覆盖层才会同时启用压缩与批处理。

## 无损 WebSocket 批处理

传输接受单个 `ServerRequest` 或以下 connection-local wrapper；批处理绝不改变内部 RPC envelope、事件序列或会话日志：

```text
{"type":"server-batch","requests":[/* unchanged ServerRequest values */]}
```

每条 mux 与 host socket 拥有一个 accumulator。自保留第一条 request 起，达到 64 条 request、262,144 个序列化字节或等待 16 ms 时，任一条件先到就发送。单条 request 超过 batch 字节上限时独立发送。当 timer 胜出时，accumulator 最多保留一个未完成的 iterator `next()`，并在定时 flush 后复用该 promise，不会并发读取。

每个 `ServerRequest` 只序列化一次。服务器用经过验证的已编码 request 片段组装显式 wrapper，再对精确 batch 字节应用既有字节/时间熔断。来源正常结束时 flush 最后一个未满 batch；`stream/error` 保持单条消息。来源 overflow、timeout 或 socket failure 可以放弃尚未发送的未满 batch，因为同一浏览器连接代际会重连并重建持久状态。

浏览器会在发布任何成员前验证 wrapper 与每条内部 request。格式错误的 batch 会关闭该 socket 并触发普通连接代际重连，不会只应用有效前缀。通过验证的成员按原顺序逐条进入既有 mux 或 host sink。connection 插件提供 `downlinkBatching`、`downlinkBatchMaxFrames`、`downlinkBatchMaxBytes` 和 `downlinkBatchFlushMs`；包默认关闭 batching，生产值分别为 `true`、64、262,144 与 16 ms。验证上限分别为 256 帧、1,048,576 字节与 100 ms。

## 有界队列与慢消费者熔断

`host-apiproxy` 为每个 mux 或 host `FrameQueue` 增加经过验证的 `maxEventStreamQueueFrames` 容量；包默认值和生产值都是 4,096。超过容量的 push 会原子地把该流标记为失败、唤醒其 iterator、拒绝后续 push，并释放全部已排队帧引用。iterator 随后释放所有已注册 listener，并把 overflow 报告给载体；错误不会穿过产生该帧的 Cordis 事件 emitter 抛出。

`client-connection` 增加经过验证的 `downlinkMaxBufferedBytes` 与 `downlinkSendTimeoutMs`。生产值分别为 1,048,576 字节和 5,000 ms。每次发送前，载体限制已有 `WebSocket.bufferedAmount` 加当前已序列化的单条或 batch 消息，并在 `send()` 返回后及其 callback 中再次检查；每次发送还与计时器竞争。超过任一限制时，载体终止该 socket 并中止来源 iterator。同一时间最多发送一条 WebSocket 消息；API 队列另外限制该发送阻塞期间产生的帧数。

客户端正常关闭、插件 teardown、队列 overflow、发送 timeout 与 socket error 汇入同一条幂等 cleanup 路径。计时器会清除，iterator 会收到 abort，订阅会释放，pump 会从所有者集合移除。服务器可以记录原因类别和计数，但绝不记录帧正文或请求 header。

## 重连与一致性

浏览器现有的 `ConnectionController` 把流关闭视为当前 generation 失败，关闭配对流、报告 `reconnecting`，并按有界指数退避重新打开两条流。新的 mux 以各会话的 `session/subscribed.lastSeq` 开始；`onConnected` 会让所有已打开对话重新加载 history window。既有序列处理会丢弃重放重复项，并补齐最后可见事件与新持久基线之间的空缺。

测试会在用户消息之后、助手完成之前分别强制触发 overflow 与发送 timeout，然后重连，并要求只出现一条用户消息、完整助手结果、最新 projection 值、仍待处理的 approval 或 question 重放，同时废弃 generation 不残留 listener。传输断线不能中止 agent，也不能追加模型可见错误。

## 配置归属

`host-apiproxy` 拥有 `maxEventStreamQueueFrames`，因为它拥有供所有载体使用的 callback-to-async-iterator 队列。`client-connection` 拥有批处理、压缩、缓冲字节与发送 timeout，因为它负责 WebSocket 编码、协商与 pump。阿里云覆盖层显式写出全部生产值，使资源策略无需修改源码即可评审。

所有数字字段只接受安全运行范围内的整数，并在 0、负数、非有限值或越界时让插件加载失败。README 与 JSDoc 会说明默认值、失败行为，以及慢客户端断线可通过 history resync 恢复这一事实。

## 测试与验收

实现先增加失败测试，覆盖输入框 pending 反馈、队列 overflow、发送 timeout、压缩协商、cleanup 与重连 history 修复。聚焦包测试覆盖每种失败竞争，包括压缩期间 close、阻塞发送期间 abort、waiter 建立前队列 overflow，以及多条活动 pump 存在时 teardown。

确定性宿主基准运行 5 个浏览器 peer，每个包含 mux 与 host 下行流。每条 mux 接收 24,000 个固定会话帧，每条 host 接收 256 个固定 host 帧。plain 与 compressed 模式使用完全相同的 batching 和应用字节；除序列化字节、传输字节、耗时、队列峰值与 RSS 增量外，报告还包含 WebSocket 消息数与最大 batch 大小。连续两次运行都必须避免 overflow、保持队列峰值不超过 4,096、把消息数至少降低 90%、把压缩传输字节至少降低 60%，并把压缩 RSS 增量保持在 64 MiB 以内。暂停读取的客户端必须在 6 秒内触发熔断、释放流，并让健康 peer 继续接收帧。

一个无需模型 key 的真实 Web 组合浏览器测试会分别通过 Enter 与按钮提交，在任何 mock 会话事件到达前捕获 pending 状态，再验证持久用户气泡与流式助手结果。打包前运行相关单元测试、typecheck、build、Web 配置验证、文档 gate 与 `git diff --check`。

生产验收使用既有不可变 release 与回滚路径。在 2 至 5 个浏览器同时在线时，一台主动限速的浏览器必须完成重连，且不能中断健康浏览器中的对话。canary 只记录连接数、队列大小、字节总量、关闭原因、进程 RSS 与操作系统 socket 队列大小。验收要求即时提交反馈、健康客户端逐步显示助手输出、限速客户端队列有界，以及该客户端重连后对话完整。

## 发布与回滚

release 先在本地连续运行两次基准，再运行浏览器与聚焦包检查，最后从同一个已评审 commit 打包并部署。生产覆盖层只在连续两次通过全部门槛的 artifact 中启用批处理与压缩。部署后检查覆盖已鉴权 WebSocket 协商、一次短 Kimi 对话、一次较长的合成或受控对话，以及限速客户端恢复。

回滚通过既有部署 helper 把 `/opt/mydsh/current` 切换到上一个不可变 release。该改动不引入会话日志或数据库格式迁移，因此先前 release 仍能读取持久对话。回滚还会随旧 artifact 恢复旧覆盖层参数，不轮换邀请码或 Kimi 秘密。
