# DSH Web 实时传输背压与发送反馈设计

[English](2026-08-27-web-realtime-backpressure-design.md) | 中文

## 状态与范围

本设计修复已启用邀请码鉴权的阿里云 Web 部署中的对话反馈延迟。当前提交提示词后可能长时间看不到变化，随后用户消息与大量助手、工具卡片一起出现。服务器能及时接受提示词并产生首个事件；延迟发生在未压缩、每个事件对应一条消息的 WebSocket 流堆积于较慢公网连接时。

该部署支持 2 至 5 个浏览器同时使用。每个浏览器打开 mux 和 host 两条下行流，因此验收最多覆盖 10 条 WebSocket 连接。改动落在通用 Web 传输与输入框，并由阿里云组合覆盖层显式配置生产参数。

## 目标

- 不等待会话事件经网络返回，在浏览器下一次绘制前显示可见且无障碍可感知的提交反馈。
- 对一段包含 24,000 个事件的代表性对话，把公网下行字节数至少降低 60%。
- 限制每条慢速下行流保留的帧与 socket 积压，避免单个浏览器无限增加宿主内存或阻塞模型运行。
- 保留所有持久会话事件，并在重连后重建相同对话，不产生重复或缺失的可见消息。
- 在 5 个浏览器、10 条下行流的代表性负载下，新增常驻内存不超过 64 MiB。

## 非目标

- 不修改模型提供方、Kimi 请求行为、token 生成、agent loop 或会话持久化。
- 不丢弃、合并、重排或重写 `assistant/chunk` 或其他会话事件。
- 不在宿主记录 `user/message` 前添加乐观用户消息事件或气泡。
- 不以 SSE 替换 WebSocket，不增加消息代理，也不重构 RPC envelope。
- 不调整 Caddy 缓冲；公网事件载体是 WebSocket，观察到的积压属于下游流量控制，而非 HTTP 响应缓冲设置。

## 方案选择

修复由三项相互独立的保护共同组成：即时输入框反馈、协商式 WebSocket 压缩，以及带来源队列上限的慢消费者熔断。三者缺一不可。只做视觉反馈会掩盖传输故障，只做压缩仍会在足够慢的客户端上留下无限队列，只做熔断则会在正常传输时继续浪费带宽。

曾考虑 wire 批处理，因为它既能减少字节，也能减少浏览器 `message` 事件，但它会改动下行协议、校验器、fixture 与各载体实现。丢失式合并 reasoning delta 的方案被否决，因为实时与回放的事件序列会产生差异。所选方案保留每条 WebSocket 消息承载一个 envelope 的既有协议，并依靠对话投影现有的 animation-frame 发布机制避免每个 token 触发一次 React 渲染。

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
                       `-- compressed WebSocket send with byte/time fuse
                              |-- healthy client: ordinary live projection
                              `-- slow client: close only this downlink
                                                   |
                                                   `-- reconnect + history resync
```

提示词请求和模型运行不依赖下行流持续连接。关闭慢速下行流只会中止该流的 iterator 并释放其事件订阅；会话继续记录事件，供后续 history 读取。

## 即时提交反馈

对话输入框把输入状态机同步进入 `adjudicating` 或 `submitting` 的阶段作为本地回执，Enter 与鼠标提交都遵循这一规则。回执生效时，主发送按钮用现有动画 pending 标记替换箭头，暴露 `aria-busy="true"`，并通过本地化的 `role="status"` 文本表达“发送中…”。输入框保持只读并显示已提交的草稿，直到既有状态机完成请求，或在失败后恢复草稿。

该回执不是合成对话项。用户气泡仍只来源于持久的 `user/message` 事件，从而维持日志状态的权威性，并避免请求被拒绝或重连后出现协调逻辑与重复气泡。产品验收测试会在键盘与按钮触发后的第一次 `requestAnimationFrame` 测量 pending 状态，并要求其在 100 ms 内出现。

## WebSocket 压缩

`client-connection` 通过 `ws` 协商 RFC 7692 `permessage-deflate`。包默认关闭压缩；基准门槛通过后，由阿里云覆盖层显式启用。部署把压缩阈值设为 0 字节，使较小且重复度高的 JSON delta 帧参与压缩；zlib 并发限制为 4，并保留 context takeover，以便在事件流中获得有效压缩率。

插件提供经过验证的 `downlinkCompression`、`downlinkCompressionThresholdBytes` 和 `downlinkCompressionConcurrency` 字段，不把部署调优值硬编码在载体中。任何压缩日志或测量都不包含邀请码、Cookie、模型凭据、消息文本或工具输出；基准使用事件类别与大小分布相同的确定性合成 payload。

只有代表性基准把 WebSocket 写入字节至少降低 60%，并把 10 条下行流的 RSS 增量保持在 64 MiB 以内时，生产覆盖层才允许启用压缩。任一门槛失败都会停止部署并返回设计阶段制定批处理修订；不能仅因协商成功就启用压缩。

## 有界队列与慢消费者熔断

`host-apiproxy` 为每个 mux 或 host `FrameQueue` 增加经过验证的 `maxEventStreamQueueFrames` 容量；包默认值和生产值都是 4,096。超过容量的 push 会原子地把该流标记为失败、唤醒其 iterator、拒绝后续 push，并释放全部已排队帧引用。iterator 随后释放所有已注册 listener，并把 overflow 报告给载体；错误不会穿过产生该帧的 Cordis 事件 emitter 抛出。

`client-connection` 增加经过验证的 `downlinkMaxBufferedBytes` 与 `downlinkSendTimeoutMs`。生产值分别为 1,048,576 字节和 5,000 ms。载体在每次序列化发送前后检查 `WebSocket.bufferedAmount`，并让每次发送与计时器竞争。超过字节上限或计时上限时，载体终止该 socket 并中止来源 iterator。同一时间最多发送一个已序列化帧；API 队列另外限制该发送阻塞期间产生的帧数。

客户端正常关闭、插件 teardown、队列 overflow、发送 timeout 与 socket error 汇入同一条幂等 cleanup 路径。计时器会清除，iterator 会收到 abort，订阅会释放，pump 会从所有者集合移除。服务器可以记录原因类别和计数，但绝不记录帧正文或请求 header。

## 重连与一致性

浏览器现有的 `ConnectionController` 把流关闭视为当前 generation 失败，关闭配对流、报告 `reconnecting`，并按有界指数退避重新打开两条流。新的 mux 以各会话的 `session/subscribed.lastSeq` 开始；`onConnected` 会让所有已打开对话重新加载 history window。既有序列处理会丢弃重放重复项，并补齐最后可见事件与新持久基线之间的空缺。

测试会在用户消息之后、助手完成之前分别强制触发 overflow 与发送 timeout，然后重连，并要求只出现一条用户消息、完整助手结果、最新 projection 值、仍待处理的 approval 或 question 重放，同时废弃 generation 不残留 listener。传输断线不能中止 agent，也不能追加模型可见错误。

## 配置归属

`host-apiproxy` 拥有 `maxEventStreamQueueFrames`，因为它拥有供所有载体使用的 callback-to-async-iterator 队列。`client-connection` 拥有压缩、缓冲字节与发送 timeout，因为它负责 WebSocket 协商与 pump。阿里云覆盖层显式写出全部生产值，使资源策略无需修改源码即可评审。

所有数字字段只接受安全运行范围内的整数，并在 0、负数、非有限值或越界时让插件加载失败。README 与 JSDoc 会说明默认值、失败行为，以及慢客户端断线可通过 history resync 恢复这一事实。

## 测试与验收

实现先增加失败测试，覆盖输入框 pending 反馈、队列 overflow、发送 timeout、压缩协商、cleanup 与重连 history 修复。聚焦包测试覆盖每种失败竞争，包括压缩期间 close、阻塞发送期间 abort、waiter 建立前队列 overflow，以及多条活动 pump 存在时 teardown。

确定性宿主基准产生 24,000 个代表性会话帧，并运行 5 个浏览器 peer，每个包含 mux 与 host 下行流。基准比较关闭和开启压缩的结果，报告序列化总字节、传输写入字节、耗时、队列峰值与 RSS 增量，并在 60% 字节或 64 MiB 内存门槛不满足时失败。暂停读取的客户端必须在 6 秒内触发熔断，来源队列不得超过 4,096 帧，流必须释放，健康 peer 必须继续接收帧。

一个无需模型 key 的真实 Web 组合浏览器测试会分别通过 Enter 与按钮提交，在任何 mock 会话事件到达前捕获 pending 状态，再验证持久用户气泡与流式助手结果。打包前运行相关单元测试、typecheck、build、Web 配置验证、文档 gate 与 `git diff --check`。

生产验收使用既有不可变 release 与回滚路径。在 2 至 5 个浏览器同时在线时，一台主动限速的浏览器必须完成重连，且不能中断健康浏览器中的对话。canary 只记录连接数、队列大小、字节总量、关闭原因、进程 RSS 与操作系统 socket 队列大小。验收要求即时提交反馈、健康客户端逐步显示助手输出、限速客户端队列有界，以及该客户端重连后对话完整。

## 发布与回滚

release 先在本地运行基准门槛，再运行浏览器与聚焦包检查，最后从同一个已评审 commit 打包并部署。生产覆盖层只在通过门槛的 artifact 中启用压缩。部署后检查覆盖已鉴权 WebSocket 协商、一次短 Kimi 对话、一次较长的合成或受控对话，以及限速客户端恢复。

回滚通过既有部署 helper 把 `/opt/mydsh/current` 切换到上一个不可变 release。该改动不引入会话日志或数据库格式迁移，因此先前 release 仍能读取持久对话。回滚还会随旧 artifact 恢复旧覆盖层参数，不轮换邀请码或 Kimi 秘密。
