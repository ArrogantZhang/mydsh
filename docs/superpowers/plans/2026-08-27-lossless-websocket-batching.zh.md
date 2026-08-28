# 无损 WebSocket 批处理实施计划

[English](2026-08-27-lossless-websocket-batching.md) | 中文

> **面向智能体执行者：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 把不变的实时 `ServerRequest` 批量封装为有界 WebSocket 消息，使 5 个浏览器能接收无损压缩流而不溢出 4,096 帧来源队列。

**架构：** connection-local codec 增加显式 `server-batch` wrapper，同时保留每个内部 rpc id、payload、事件序列与会话日志记录。每条 socket 最多积累 64 条 request 或 256 KiB，最长 16 ms；浏览器随后原子验证 wrapper，并按原顺序把 request 发布到既有 sink。

**技术栈：** TypeScript 6、Cordis、Zod、`ws` 8.21、Vitest 4、Node.js 24、Playwright/Chromium、pnpm 11.7、Caddy、systemd、Bash。

**设计：** [已批准的修订设计](../specs/2026-08-27-web-realtime-backpressure-design.zh.md)

---

## 文件映射

### Connection-local wire 与浏览器 decoder

- `packages/client/connection/src/` + `downlink-message.ts` — 浏览器安全的 `server-batch` 类型、schema 与原子解码。
- `packages/client/connection/tests/` + `downlink-message.client.spec.ts` — 单条/batch 解码、边界、格式错误 batch 拒绝与原子性。
- `packages/client/connection/src/client/web-api-client.ts` — 把一条物理 WebSocket 消息映射为一条或多条已验证 stream frame，并关闭格式错误的传输。

### 宿主 accumulator 与配置

- `packages/client/connection/src/` + `downlink-batch.ts` — 帧数/字节/deadline accumulator，最多保留一个未完成 iterator read。
- `packages/client/connection/tests/` + `downlink-batch.host.spec.ts` — 数量、字节、deadline、end、abort、大帧、顺序与 pending-read 竞争。
- `packages/client/connection/src/websocket-downlink.ts` — 在既有发送熔断前编码单条或 batch。
- `packages/client/connection/src/index.ts` — 验证并传入批处理配置。
- `packages/client/connection/tests/websocket-downlink.host.spec.ts` — 真实 WebSocket batch 交付、失败与 teardown 集成。
- `packages/client/connection/tests/node-half.host.spec.ts` — 批处理默认值、范围与跨字段验证。
- `packages/client/connection/README.md`、`README.zh.md`、`README.i18n.yaml` — 批处理、顺序、时序与恢复约定。
- `.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`、`.zh.md`、`.i18n.yaml` — 所选批处理决策与测量得到的前提。
- `docs/config-catalog.md`、`config-catalog.zh.md`、`config-catalog.i18n.yaml` — 重新生成的配置参考。

### 基准与部署

- `scripts/websocket-downlink-benchmark-worker.ts` — 固定批处理负载与单模式传输指标。
- `scripts/websocket-downlink-benchmark.ts` — 双模式门槛与失败诊断。
- `scripts/websocket-downlink-benchmark.spec.ts` — 报告 parser 与阈值测试。
- `package.json` — 基准命令。
- `deploy/alibaba-cloud/invite-auth.cordis.yml` — 显式队列、批处理、压缩与熔断值。
- `deploy/alibaba-cloud/package-release.sh` — build 发布前的聚焦测试与两次基准。
- `scripts/alibaba-cloud-deployment.spec.ts` — 覆盖层与 packager 顺序断言。
- `deploy/alibaba-cloud/README.md`、`README.zh.md`、`README.i18n.yaml` — 运行值与重连诊断。

## 任务 1：增加显式 batch wire 与原子浏览器 decoder

**文件：**

- 在 `packages/client/connection/src/` 下新建：`downlink-message.ts`
- 在 `packages/client/connection/tests/` 下新建：`downlink-message.client.spec.ts`
- 修改：`packages/client/connection/src/client/web-api-client.ts`

- [ ] **步骤 1：编写失败的 codec 测试**

覆盖一条有效 `ServerRequest`、有效非空 batch、256 条 request、257 条 request、空 batch、无效内部 envelope 与无效 stream payload。断言无效 batch 发布零个前缀。

```text
const batch = {
  type: 'server-batch',
  requests: [firstRequest, secondRequest],
}
expect(decodeDownlinkMessage(JSON.stringify(batch), muxFrameSchema))
  .toEqual([firstEnvelope, secondEnvelope])
expect(() => decodeDownlinkMessage(JSON.stringify({
  type: 'server-batch',
  requests: [firstRequest, malformedRequest],
}), muxFrameSchema)).toThrow()
```

- [ ] **步骤 2：运行 RED**

运行：`pnpm exec vitest run packages/client/connection/tests -t "downlink message"`

预期：FAIL，因为 batch codec 模块与 decoder 不存在。

- [ ] **步骤 3：实现浏览器安全的 wire 类型与 decoder**

定义 connection-local 类型与 schema，不从 package root 导出：

```text
export const MAX_SERVER_BATCH_REQUESTS = 256

export interface ServerBatch {
  type: 'server-batch'
  requests: ServerRequest[]
}

export type DownlinkMessage = ServerRequest | ServerBatch
```

每个成员使用 `serverRequestSchema`，wrapper 使用 `z.array(...).min(1).max(256)`。该模块不得引入 `Buffer` 等 Node 依赖，因为浏览器 bundle 会消费它。decoder 解析完整物理消息，把所有内部 request 及其 mux/host payload 验证到临时数组，并且只在整条消息成功后返回。

- [ ] **步骤 4：接入原子浏览器交付**

在 `WebApiClient.readWebSocket` 中，把一条物理消息解码为已验证 envelope，再按顺序为每个成员调用 `onEnvelope` 与 enqueue。出现任何 JSON、wrapper、envelope 或 stream-payload 错误时，只记录 path/category，以 code `1002` 关闭 socket，且不 enqueue 任何 batch 前缀。既有 `ConnectionController` 随后重建 generation。

- [ ] **步骤 5：运行 GREEN 并提交**

运行：`pnpm exec vitest run packages/client/connection/tests -t "downlink message|malformed WebSocket"`

预期：PASS。

运行：`pnpm exec tsc -b packages/client/connection`

预期：PASS。

```bash
git add packages/client/connection/src packages/client/connection/tests
git commit -m "feat(connection): add lossless downlink batches"
```

## 任务 2：增加有界宿主 accumulator 与部署可调配置

**文件：**

- 在 `packages/client/connection/src/` 下新建：`downlink-batch.ts`
- 在 `packages/client/connection/tests/` 下新建：`downlink-batch.host.spec.ts`
- 修改：`packages/client/connection/src/websocket-downlink.ts`
- 修改：`packages/client/connection/src/index.ts`
- 修改：`packages/client/connection/tests/websocket-downlink.host.spec.ts`
- 修改：`packages/client/connection/tests/node-half.host.spec.ts`
- 修改：`packages/client/connection/README.md`
- 修改：`packages/client/connection/README.zh.md`
- 修改：`packages/client/connection/README.i18n.yaml`
- 修改：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.md`
- 修改：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.zh.md`
- 修改：`.agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.i18n.yaml`
- 重新生成：`docs/config-catalog.md`
- 修改：`docs/config-catalog.zh.md`
- 修改：`docs/config-catalog.i18n.yaml`

- [ ] **步骤 1：编写失败的 accumulator 测试**

使用 fake timer 与可统计 `next()` 调用次数的 async source，覆盖：

- 64 条 request 立即按顺序 flush；
- 第 65 条 request 开始下一个 batch；
- 精确字节上限可容纳，下一条 request 会 flush 当前 batch；
- 一条超过 256 KiB 的 request 独立发送；
- 16 ms flush 未满 batch；
- clean end flush 剩余内容；
- abort 释放 timer 与 iterator；
- timer 赢得 `next()` 竞争时只留下一个 pending read 并复用它；
- 来源失败放弃本地未满 batch，并向 pump 传播。

```text
const batches = collectEncodedDownlinkMessages(source, {
  enabled: true,
  maxFrames: 64,
  maxBytes: 262_144,
  flushMs: 16,
}, signal)
```

- [ ] **步骤 2：运行 RED**

运行：`pnpm exec vitest run packages/client/connection/tests -t "downlink batch"`

预期：FAIL，因为 accumulator 与批处理选项不存在。

- [ ] **步骤 3：实现 accumulator**

定义内部选项对象：

```text
export interface DownlinkBatchOptions {
  enabled: boolean
  maxFrames: number
  maxBytes: number
  flushMs: number
}
```

这个 Host-only 模块把每个 `ServerRequest` 只序列化一次，使用 `Buffer.byteLength` 计算 UTF-8 字节，并用固定 prefix、逗号分隔的已编码 request 与 suffix 构建 batch 文本：

```text
const BATCH_PREFIX = '{"type":"server-batch","requests":['
const BATCH_SUFFIX = ']}'
```

关闭时，每条物理消息 yield 一个已编码 `ServerRequest`；开启时，持有已编码 request，直到数量、精确 wrapper 字节、deadline 或 clean end。保存一个 `Promise<IteratorResult<...>>`；deadline 胜出时发送未满 batch，再为下一 batch await 同一个 promise。绝不并发调用 `next()`。

- [ ] **步骤 4：增加已验证插件配置**

增加以下 package 默认值与范围：

```text
downlinkBatching: false
downlinkBatchMaxFrames: 64       // 1..256
downlinkBatchMaxBytes: 262144    // 1..1048576
downlinkBatchFlushMs: 16         // 1..100
```

batching 开启且 `downlinkBatchMaxBytes > downlinkMaxBufferedBytes` 时，让插件加载失败。向 `WebSocketDownlinks` 传入完整 batch options。

- [ ] **步骤 5：集成宿主 pump**

把 send helper 重构为接受已编码 text。`pump` 选择单条或 batch 编码，再对每条物理消息应用既有序列化字节熔断与发送 timeout。clean end 发送最后一个未满 batch。`stream/error` 保持一条已编码 `ServerRequest`，绝不插入普通 batch。

- [ ] **步骤 6：增加真实 WebSocket 集成测试**

开启 batching 时，断言 65 个来源帧作为两条物理消息到达，其中包含 64 与 1 条有序 request。断言 timer flush、clean-end flush、超大单条、字节熔断拒绝、来源失败、格式错误客户端消息、peer 隔离与 quiescent `close()`。关闭 batching 时，保持每条 request 对应一条物理消息。

- [ ] **步骤 7：更新约定与生成配置**

同步 README 与 proposed Agent Note，写明精确 wrapper、默认值/范围、单 pending-read 规则、失败/重连语义，以及测量证明 batching 必需的原因。运行 `pnpm run gen-config-catalog`，只更新对应中文 row，并重新记录三组配对。

- [ ] **步骤 8：验证并提交**

运行：

```bash
pnpm exec vitest run packages/client/connection/tests -t "downlink batch|downlink message|WebSocket downlinks|connection node half|ConnectionController"
pnpm exec tsc -b packages/client/connection
pnpm run verify-config-catalog
pnpm run verify-agent-note-format
git diff --check
```

预期：全部通过。

```bash
git add packages/client/connection .agents/notes/proposed/bug-fix/2026-08-27-web-realtime-backpressure.* docs/config-catalog.md docs/config-catalog.zh.md docs/config-catalog.i18n.yaml
git commit -m "feat(connection): batch websocket downlinks"
```

## 任务 3：更新固定基准并连续通过两次

**文件：**

- 修改：`scripts/websocket-downlink-benchmark-worker.ts`
- 修改：`scripts/websocket-downlink-benchmark.ts`
- 修改：`scripts/websocket-downlink-benchmark.spec.ts`
- 修改：`package.json`

- [ ] **步骤 1：扩展失败的报告测试**

为每个报告增加精确字段：

```text
webSocketMessages: number
maxBatchFrames: number
maxBatchBytes: number
producerBurstFrames: 24
producerIntervalMs: 16
```

summary 携带 `plainMessageReduction`、`compressedMessageReduction` 与 `compressionRssOverheadBytes`。拒绝未知/缺失字段、生产节奏不是 24/16、超过 64 帧或 262,144 字节的 batch、任一消息降幅低于 90%、序列化字节不一致、队列 overflow、压缩字节降幅低于 60%，以及压缩 RSS 开销超过 64 MiB。RSS 开销是 `max(0, compressed.rssDeltaBytes - plain.rssDeltaBytes)`。

- [ ] **步骤 2：运行 RED**

运行：`pnpm exec vitest run scripts/websocket-downlink-benchmark.spec.ts`

预期：FAIL，因为批处理指标与阈值不存在。

- [ ] **步骤 3：测量批处理物理消息**

在 plain 与 compressed worker 中启用完全相同的 batching：`true`、64、262,144 与 16 ms。客户端 peer 解析单条或 batch wrapper，统计每条内部 request、物理 `message` 事件数，并记录最大 batch request 数与原始消息字节。每个来源每推送 24 帧就等待 16 ms，最后一批后不额外等待。该固定节奏为每个来源持续提供 1,500 帧/s，同时保留已观测到的生产峰值 24 帧/16 ms；受影响的重负载 turn 平均约 7 个事件/s，峰值为 141/s。保留 start barrier、固定应用帧、TCP `bytesRead`、5 ms RSS 采样、队列观察与不含秘密的输出。

应用帧分母是精确值：

```text
5 * (24_000 + 256) = 121_280 frames
messageReduction = 1 - webSocketMessages / 121_280
```

- [ ] **步骤 4：改善失败运行诊断**

plain 成功而 compressed 失败时，在最终不含秘密的诊断中包含已验证的 plain 指标。成功时仍让 child stdout 恰好只有一行 JSON，失败时 stderr 有界。

- [ ] **步骤 5：运行 GREEN 单元测试与两次真实门槛**

运行：

```bash
pnpm exec vitest run scripts/websocket-downlink-benchmark.spec.ts
pnpm run benchmark:websocket-downlinks
pnpm run benchmark:websocket-downlinks
```

两次真实运行均预期：

- 无来源 overflow，且队列峰值不超过 4,096；
- 两个消息降幅都至少为 0.90；
- 压缩传输字节降幅至少为 0.60；
- 压缩 RSS 开销不超过 67,108,864 字节，并根据两个已报告 RSS 增量计算；
- 应用数量精确且序列化字节相同。

任一运行失败时，在任务 4 前停止并报告固定指标；不得修改 payload 或阈值以求通过。

- [ ] **步骤 6：提交已证明的门槛**

```bash
git add package.json scripts/websocket-downlink-benchmark-worker.ts scripts/websocket-downlink-benchmark.ts scripts/websocket-downlink-benchmark.spec.ts
git commit -m "test(connection): gate batched websocket compression"
```

## 任务 4：在阿里云 artifact 中启用批处理与压缩

**文件：**

- 修改：`deploy/alibaba-cloud/invite-auth.cordis.yml`
- 修改：`deploy/alibaba-cloud/package-release.sh`
- 修改：`scripts/alibaba-cloud-deployment.spec.ts`
- 修改：`deploy/alibaba-cloud/README.md`
- 修改：`deploy/alibaba-cloud/README.zh.md`
- 修改：`deploy/alibaba-cloud/README.i18n.yaml`

- [ ] **步骤 1：编写失败的部署断言**

要求 `api-gateway.maxEventStreamQueueFrames: 4096`。要求 connection row 保留动态 trusted hosts，并设置：

```yaml
downlinkBatching: true
downlinkBatchMaxFrames: 64
downlinkBatchMaxBytes: 262144
downlinkBatchFlushMs: 16
downlinkCompression: true
downlinkCompressionThresholdBytes: 0
downlinkCompressionConcurrency: 4
downlinkMaxBufferedBytes: 1048576
downlinkSendTimeoutMs: 5000
```

要求聚焦 ApiProxy/connection/deployment 测试之后执行两次 benchmark，且都在 `package-release.sh` 的 build 之前。

- [ ] **步骤 2：运行 RED**

运行：`pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts`

预期：FAIL，因为生产 batching 值与双 benchmark 顺序不存在。

- [ ] **步骤 3：应用并解析覆盖层**

patch 既有 `api-gateway` 与 `connection` row，保留 `inject: [webRuntime]` 与 `trustedHosts: !!js ctx.webRuntime.trustedHosts`。build 后运行：

```bash
node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config
```

预期：所有显式生产值都能解析，插件加载成功。

- [ ] **步骤 4：更新打包与操作文档**

在固定 Linux build container 中依次运行聚焦测试和两次 benchmark，然后才执行 `pnpm run build`。记录 64/256 KiB/16 ms、进程重启并发语义、熔断恢复，以及重复断线时应诊断网络而非扩大无界缓冲的规则。重新记录 README 配对。

- [ ] **步骤 5：验证并提交**

运行：

```bash
pnpm exec vitest run scripts/alibaba-cloud-deployment.spec.ts
pnpm run verify-cordis-config
git diff --check
```

预期：PASS。

```bash
git add deploy/alibaba-cloud scripts/alibaba-cloud-deployment.spec.ts
git commit -m "deploy: enable batched compressed downlinks"
```

## 任务 5：完成文档、打包、部署与 canary

**文件：**

- 把 active Agent Note 三件套从 `.agents/notes/proposed/bug-fix/` 移到 `.agents/notes/implemented/bug-fix/`。
- 修改：`docs/superpowers/plans/2026-08-27-web-realtime-backpressure.md`
- 修改：`docs/superpowers/plans/2026-08-27-web-realtime-backpressure.zh.md`
- 修改：`docs/superpowers/plans/2026-08-27-web-realtime-backpressure.i18n.yaml`

- [ ] **步骤 1：记录已发布事实**

使用 `git mv` 移动完整 Agent Note 配对/sidecar，设置 `Status: implemented`，用 decision/consequences/当前验证替换 proposal/acceptance/risks 标题，保留 alternatives，并在不包含 payload 文本的情况下记录两份真实基准报告与已发布默认值。更新先前实施计划，使其仅压缩 Task 6 不再与 batching continuation 冲突；链接本计划作为剩余工作 owner。重新记录两个配对。

- [ ] **步骤 2：运行一次完整相关证据**

```bash
pnpm exec vitest run packages/host/apiproxy/tests/frame-queue.spec.ts packages/host/apiproxy/tests/event-stream-backpressure.spec.ts packages/client/connection/tests packages/client/runtime/tests/session.client.spec.ts packages/client/ui-conversation/tests/input-bar.client.spec.tsx scripts/websocket-downlink-benchmark.spec.ts scripts/alibaba-cloud-deployment.spec.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/submit-feedback.e2e.ts
pnpm run benchmark:websocket-downlinks
pnpm run benchmark:websocket-downlinks
pnpm run typecheck
pnpm run build
pnpm run verify-cordis-config
pnpm run doc-sync
pnpm run lint
git diff --check
```

预期：所有行为/build/config gate 通过。已知 Windows symlink 权限失败若保持不变且独立存在，应准确报告，不得声称 `doc-sync` 通过；Linux packaging 提供该平台负责的信号。

- [ ] **步骤 3：提交最终记录**

```bash
git add .agents/notes/implemented/bug-fix/2026-08-27-web-realtime-backpressure.* docs/superpowers/plans/2026-08-27-web-realtime-backpressure.*
git commit -m "docs: finalize batched downlink contract"
```

- [ ] **步骤 4：打包并激活精确分支**

使用既有 WSL/Linux packager，设置 `DEPLOY_REF=refs/heads/fix/web-realtime-backpressure`；用 `C:\Users\a8798\.ssh\person.pem` 把唯一以 commit 命名的 artifact set 上传到 `root@120.24.146.133`，并调用已安装的 `/usr/local/sbin/mydsh-deploy-release`。绝不打印邀请码或 Kimi 秘密。helper 必须报告公开与已认证验收，失败时自动回滚。

- [ ] **步骤 5：运行生产 canary**

验证 Caddy/mydsh active、`current` 指向新 commit，且 DSH 只监听 `127.0.0.1:3080`。打开 2 至 5 个已认证浏览器，限速其中一个，并从健康浏览器发送。要求回执低于 100 ms、健康输出逐步显示、队列/socket metadata 有界、限速客户端重连后对话恰好一次且完整、模型运行不中断。只记录数量、大小、关闭原因、RSS 与 socket 队列。

- [ ] **步骤 6：最终审查与交接**

分派全范围规格与代码质量审查，修复所有 Critical/Important 问题，重跑被影响的证据，并报告已部署 commit、两份 benchmark summary、canary 结果、实际运行命令，以及仍存在时的已知 Windows 文档例外。
