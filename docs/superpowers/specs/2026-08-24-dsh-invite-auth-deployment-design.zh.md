# DSH 邀请码鉴权与阿里云部署设计

[English](2026-08-24-dsh-invite-auth-deployment-design.md) | 中文

## 状态与范围

本设计定义一套面向小范围可信用户的 DeepSeek Harness Web 部署：应用运行在阿里云香港或海外 Ubuntu 22.04/24.04 ECS 上，通过独立子域名提供 HTTPS 访问，并要求访问者先输入一个共享邀请码。浏览器通过验证后保持登录 30 天。

每次部署都使用记录在 `DEPLOY_REF` 中的显式已评审具名 ref；如果条件允许，优先使用已验证的签名 tag。不允许无人值守的上游更新。模型配置不进入源码或部署自动化；管理员在 Web UI 中把 Kimi 添加为自定义 OpenAI 兼容提供方。

所有获准访问者共享同一个 DSH 实例、会话、工作区和服务账号权限。本设计只适用于管理员本人及完全信任的人，不提供多租户隔离。

## 非目标

- 不提供用户账号、个人邀请码、邀请码管理后台、权限角色或审计身份。
- 不隔离访问者的会话、文件或命令执行能力。
- 不限制 DSH 自身已有的文件和命令功能。
- 不在仓库、部署包或自动化测试中保存 Kimi 密钥。
- 不启用无人值守的上游自动更新。

## 方案选择

部署新增一个原生 Cordis 插件 `@deepseek-ai/dsh-host-invite-auth`，由该插件提供登录页面、共享邀请码验证、会话 Cookie 签发、退出和 Caddy 鉴权端点。Caddy 终止 TLS，并在代理普通页面、API、SSE 或 WebSocket 之前调用鉴权端点。

独立鉴权进程会减少对上游组合的修改，但增加一个服务和故障点；Caddy Basic Auth 不支持产品化登录页面或本设计的 30 天签名会话。原生插件与 DSH 的“everything is a plugin”结构一致，并让登录和鉴权行为保持在一个可独立测试的包中。

## 系统架构

```text
Browser
  |
  | HTTPS :443
  v
Caddy
  |-- /__invite/* ---------------------------> invite-auth routes
  |
  |-- every other HTTP/SSE/WebSocket request
          |
          | forward_auth /__invite/check
          |-- 2xx ---------------------------> DSH Web
          `-- non-2xx ------------------------> browser

invite-auth routes and DSH Web share 127.0.0.1:3080.
Only Caddy listens on public interfaces.
```

Caddy 是唯一公网入口。DSH 保持官方默认的 `127.0.0.1:3080` 绑定，阿里云安全组只开放 SSH、HTTP 和 HTTPS，不开放 3080。Web 启动命令通过 `--trusted-host` 接受唯一的公网子域名。

`packages/host/invite-auth` 拥有鉴权行为，并注入 `webServer` 服务。发布的 Web 组合包保持不变；阿里云部署通过显式 patch 覆盖层在既有 `webserver` 配置项后插入插件。插件只注册 `/__invite/` 下的 HTTP route，不修改 agent loop、模型请求、会话日志或前端应用。

Caddy 对 `/__invite/*` 直接反向代理，以便未登录浏览器加载登录页和提交邀请码。其余请求先执行 `forward_auth`；验证成功后，Caddy 再把原请求代理到同一 DSH upstream。Caddy 原生反向代理负责 WebSocket upgrade。

## 插件配置与秘密

插件配置只保存环境变量名称和非秘密策略值，不保存邀请码或签名密钥本身。默认配置引用 `DSH_INVITE_CODE_SECRET` 与 `DSH_INVITE_SESSION_SECRET`；两者的名称都包含 `SECRET`，因此 DSH 的子进程环境清洗会移除它们。插件提供以下可验证参数：会话有效期 2,592,000 秒、失败窗口 900 秒、每个来源地址最多失败 10 次、最多跟踪 10,000 个来源地址、请求体上限 4,096 字节。

插件只从 `dsh-launch-environment` 冻结启动快照的继承进程层读取秘密；项目与 Harness home 的 `.env` 文件不能设置鉴权秘密。该方式保留 DSH 对启动来源的统一语义，并避免 `--dump-config` 输出秘密。邀请码至少包含 12 个字符；会话密钥至少包含 32 个字节。任一值缺失或不满足长度要求时，插件激活失败，Loader 随即释放已启动的 Web server。

服务器把秘密放在 root 所有且权限为 `0600` 的 `/etc/mydsh/mydsh.env`。系统服务管理器先读取该文件，再以 DSH 专用用户启动进程。部署过程在服务器上生成初始邀请码和会话密钥，不把任一值打印到终端、日志或对话。Kimi 凭据由 DSH 的凭据存储单独管理。

## HTTP 与会话行为

插件提供以下 route：

- `GET /__invite/login` 返回响应式的中文登录页面；已有有效 Cookie 时跳回安全的 `next` 路径。
- `POST /__invite/login` 验证请求来源、表单大小、限流状态和邀请码；成功后签发 Cookie，并以 `303` 跳转到安全的 `next` 路径。
- `GET /__invite/check` 供 Caddy `forward_auth` 调用；有效 Cookie 返回 `204`，未登录的页面导航返回登录跳转，其他请求返回 `401`。
- `POST /__invite/logout` 清除 Cookie，并返回登录页跳转。

`next` 只接受以单个 `/` 开头的站内绝对路径；协议相对地址、完整 URL、反斜杠和无法解析的值都回退到 `/`。登录提交只接受 `application/x-www-form-urlencoded`，并要求转发协议为 HTTPS，且 `Origin` 与公网 Host 一致。

Caddy 为登录与鉴权请求设置一个专用的客户端地址 header。插件仅在 TCP peer 为回环地址时信任该 header，否则使用 socket peer 地址，避免公网客户端伪造限流身份。

邀请码比较对等长摘要执行恒定时间比较。错误邀请码只返回统一错误，不暴露长度、部分匹配或比较阶段。失败计数保存在进程内存中，按来源地址和固定窗口记录；成功登录清除该地址的失败计数，进程重启会清空限流状态。限流器会清理过期条目，并在超过配置容量前淘汰最旧条目，从而限制分布式尝试造成的内存占用。

成功登录签发一个带版本、过期时间和随机 nonce 的无状态 token，并使用 HMAC-SHA-256 覆盖完整 payload。Cookie 名为 `__Host-dsh_invite`，属性固定为 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，且不设置 `Domain`。过期、格式错误、签名错误或版本未知的 token 一律视为未登录。

修改共享邀请码只影响后续登录；轮换会话密钥会立即撤销所有已签发 Cookie。退出只清除当前浏览器的 Cookie。

登录页面和所有鉴权响应发送 `Cache-Control: no-store`，并设置限制脚本和资源来源的 CSP、`X-Content-Type-Options: nosniff`、禁止 framing 的策略和严格的 referrer policy。插件不记录邀请码、会话 token、Cookie header 或环境变量值。

## 失败行为

格式错误的表单返回 `400`，错误邀请码返回 `401`，来源验证失败返回 `403`，请求体超限返回 `413`，不支持的媒体类型返回 `415`，触发限流返回 `429`。未授权的 API、SSE 与 WebSocket 请求返回 `401`，不会转发到 DSH。页面导航通过 `303` 进入登录页。

DSH 不可用时，Caddy 返回 `502`；systemd 根据有界重启策略恢复服务。鉴权检查自身失败时采用拒绝访问的关闭式失败，不允许请求绕过 Caddy 进入 DSH。

## 服务器布局与进程

- `/opt/mydsh/releases/` 下以完整 Git commit hash 命名的目录保存各个已构建、不可变的 release。
- `/opt/mydsh/current` 指向当前 release。
- `/var/lib/mydsh` 是持久化 `DSH_HOME`，独立于 release。
- `/srv/mydsh/workspace` 是 systemd 的工作目录和默认 DSH workspace。
- `/usr/local/sbin/mydsh-deploy-release` 是 root 所有、拥有 journal 格式 1 的部署、回滚和清理控制 helper；release 内容绝不提供或更新 root 控制流。
- `/var/lib/mydsh-deploy` 是 root-only 事务状态，`/var/lib/mydsh-deploy/activation` 是持久激活 journal。每个 builder tree 使用 root 所有的 releases 父目录下一个隐藏的单次操作目录，并在发布或失败后删除。
- `/run/lock/mydsh-deploy.lock` 将 bootstrap、部署、回滚和清理串行化。
- `/etc/mydsh/public.env` 保存供两个 systemd 服务使用的非秘密 `DSH_PUBLIC_HOST`。
- `/etc/mydsh/mydsh.env` 保存仅 root 可读的秘密与持久化 `DSH_HOME` 路径。

服务器只安装 Node.js 24 运行时和 Caddy，不存在 builder 账户、pnpm、源码 checkout、依赖生命周期执行、测试运行器或构建缓存。在开发机上，`package-release.sh` 归档精确的具名 Git ref，并在受资源限制的临时官方 Node 24 Linux 容器中使用全新状态和固定 pnpm tarball integrity，执行冻结依赖安装、invite-auth 测试、完整构建和配置转储。生成的确定性 archive 包含完整 Linux 运行时 tree、依赖、已构建前端和库、部署数据，以及记录格式、commit、具名 ref、平台、Node、pnpm 和 helper journal 兼容版本的 manifest。

稳定的宿主 helper 会把 artifact 和 checksum 复制到 root-private 新 inode，验证 SHA-256，拒绝绝对路径、父目录穿越、特殊文件、重复条目和越界链接，不保留上传所有权地解压，验证 manifest 与必要输出，再发布 root 所有的不可变 commit 目录。它绝不会运行候选 Git、包管理、生命周期 hook、测试、构建命令、配置脚本或 release 内的 helper。之后 systemd 以非登录 `mydsh` 运行时用户从 `/srv/mydsh/workspace` 启动已接受的 release；Caddy 只读取公共环境文件。

Caddy 监听 80 和 443、自动申请与续期证书，并代理到 `127.0.0.1:3080`。`caddy validate` 必须在重新加载配置前通过。

## 发布与回滚

本地仓库保留 DeepSeek 上游 remote 和邀请码扩展提交。升级先获取最新 `master`，再把本地提交合并到新的已评审部署 ref。上游处于 developer preview，因此每次升级都视为需要重新验证的显式发布。

root 安装的 helper 会在 root-only 的同级 `activation.new.*` 目录中构建完整的格式 1 `prepared` journal，其中包含之前的链接、宿主文件备份和服务之前的启用状态；完成 fsync 后，helper 将其原子重命名为 `activation`，然后才安装候选 unit、Caddyfile 和 Caddy drop-in。helper 本身不属于 release 事务；更改 helper 或 journal 格式需要在 DSH 停止时执行单独评审的维护流程。部署锁保护下会删除经过验证的遗留同级目录；不安全的条目会保留供检查，但不会成为恢复状态。helper 随后重新加载 systemd，切换 `current`，重启 DSH，验证 PID 所有者、精确且仅限回环的 `127.0.0.1:3080` 监听、回环登录、公开拒绝和认证访问，启用服务，同步每个受影响的 `/opt`、`/etc` 和 `/var` 路径，最后才记录 `committed`。在该提交前发生的任何中断或失败都会恢复并同步之前的链接、宿主文件、进程状态以及启用或禁用状态；恢复失败会保留完整 journal 并阻止新工作。已提交 journal 的清理失败只会留下供下一次操作删除且不会触发回滚的状态。`DSH_HOME` 不随代码回滚，因此任何未来数据迁移都需要单独评估向后兼容性。

## 测试与验收

插件单元测试覆盖邀请码比较、token 签发、有效期、篡改、未知版本、跳转路径清洗、来源地址选择、限流窗口和请求体限制。

使用 `dsh-host-webserver` 的临时回环端口运行插件集成测试，覆盖登录页面、错误和正确邀请码、Cookie 属性、鉴权端点、退出、来源拒绝、大小拒绝、限流和安全响应 header。Web profile 组合测试应用部署覆盖层，证明插件在 `webserver` 后挂载，并证明发布的 Web 组合包在没有鉴权秘密时仍可正常使用。

实现按仓库规则增加对应包 README、中文配对文档与 Agent Note，并运行相关单元/集成测试、类型检查、构建、配置检查、文档同步检查和 `git diff --check`。登录页面属于产品可见行为，因此增加一个无需模型密钥的真实 Web 组合快照。

服务器验收必须证明候选和已安装 Caddy 配置有效、候选 systemd unit 和 drop-in 通过验证、活动 MainPID 属于 `mydsh`、`current` 指向候选 release，并且恰好只有一个 `127.0.0.1:3080` listener，不存在通配、公网、IPv6 或重复 listener。有界的公开 HTTPS 检查要求未认证 HTML 重定向且 API 流量返回 `401`；root helper 还会执行认证登录，且不打印邀请码、Cookie 或响应头。手动验收还会证明公网证书、SSE 和 WebSocket 拒绝、退出登录、30 天浏览器复用、篡改拒绝、串行化回滚以及 `DSH_HOME` 数据保留。

管理员最后在 Web UI 中配置 Kimi 自定义 OpenAI 兼容提供方，并以一次真实对话验证模型连接。该验证不把 API key 写入测试、部署日志或仓库。

## 部署所需输入

实施可以在不持有生产秘密的情况下完成本地插件、测试、文档和部署模板。实际部署开始前，管理员提供公网子域名、ECS 公网地址、SSH 用户与认证方式，并确保该子域名的 DNS A/AAAA 记录指向 ECS。部署过程生成初始共享邀请码和会话密钥；管理员直接通过 SSH 获取或轮换邀请码，不把它发送到实施对话中。
