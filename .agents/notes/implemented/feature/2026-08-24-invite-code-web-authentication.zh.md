# Agent Note: 邀请码 Web 认证

Status: implemented

[English](2026-08-24-invite-code-web-authentication.md) | 中文

## 问题

DSH Web server 有意不提供 TLS 或认证。载体级 trusted-host 栅栏可防止 DNS rebinding 和其他浏览器混淆代理人请求，但被接受的 host 不具有用户身份，任何能访问远程公开服务器的人都会获得相同权限。一个小规模可信群体需要远程浏览器访问，同时不能把面向开发环境的 Web server 变成部署安全框架，也不能改变默认的本地 Web 组合。

## 决策

`@deepseek-ai/dsh-host-invite-auth` 是原生 Cordis 函数插件，拥有 `/__invite` 认证 route、共享邀请码比较和无状态签名浏览器会话。它注册一个前缀，而不会拦截无关的 `WebServer` route。本决策补充而不取代[载体级浏览器信任决策](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)：既有 authority 和 origin 检查仍是混淆代理人防御，本插件和部署代理则对访问进行认证。

Caddy 终止 TLS，直接代理 `/__invite/*`，并在代理其他所有页面、API、SSE（Server-Sent Events）或 WebSocket 请求前调用 `/__invite/check`。发布的 Web 组合包默认保持无认证状态。阿里云部署通过显式覆盖层选择启用：该覆盖层插入邀请码认证，并将 `inviteAuthReadiness` 加入既有 `web-runtime` 配置项的依赖。

认证插件先注册前缀 route，再发布就绪状态。Cordis 依赖资源释放会撤回就绪状态，并在移除认证 route 前拆除依赖它的 `web-runtime` fiber，包括其前端 fallback。认证激活失败时永远不会释放 fallback，HMR（热模块替换）或卸载遵循相同的失败关闭顺序。

插件配置只保存大写 `DSH_*` 环境变量引用和非秘密策略。systemd 将仅 root 可读的服务器秘密文件读入进程环境；启动环境快照让插件只解析继承的 `process` 层。默认变量名包含 `SECRET`，因此标准子进程环境清理器会移除它们。秘密值绝不进入 Cordis 配置、配置转储或插件诊断。

该认证模型面向共享同一 DSH 实例的小规模可信群体。有效 Cookie 传递实例既有的浏览器权限；它不会创建身份、按用户划分的工作区、会话所有权或命令隔离。

阿里云部署将经过评审的 root 控制流安装在所有 release 之外的 `/usr/local/sbin/mydsh-deploy-release`。共享的非阻塞宿主锁将 bootstrap、部署、回滚和清理串行化。helper 会在变更前将 `prepared` 恢复 journal 持久保存到 `/var/lib/mydsh-deploy/activation`，其中包含之前的链接和 root 所有的宿主文件备份。失败会保留或重放该 journal，直到恢复成功；接受激活会先记录 `committed` 再清理，因此清理失败绝不会回滚已上线且已接受的 release。

`mydsh-build` 为每次操作获得新的 HOME、XDG 配置和缓存、pnpm 缓存、临时 `DSH_HOME` 以及 checkout。一个 transient service 使用 `KillMode=control-group` 运行完整构建流水线；systemd 会终止并等待全部 descendant，之后 root 才禁用 reflink，把结果复制到新的 root-private inode 中。builder 无法在已发布 tree 中保留可写 inode 或打开的文件描述符，也无法读取运行时状态、工作区文件、私有环境文件或认证密钥。

Git bundle 是传输格式，不是真实性证明：`git bundle verify` 检查结构、前置对象和对象连通性。部署信任管理员经过评审的本地 checkout，以及创建 bundle 时另行验证的签名 ref。helper 会保留该 bundle 的 root-only 副本，从可信 commit 的 root-only 提取目录取得每项特权部署资产，并先拒绝存在差异的 builder 侧副本，再验证候选宿主配置以及公开和认证行为。

## 会话和滥用控制

会话 token 包含版本、过期时间、随机 nonce 和 HMAC-SHA256 签名。仅限 host 的安全 Cookie 默认有效期为 30 天。更改邀请码只控制之后的登录；轮换签名秘密会撤销所有会话。退出登录只清除浏览器 Cookie，而不会在服务端撤销 token。

登录失败使用有容量限制、位于单个进程内的固定窗口限流器，并以回环 Caddy peer 提供的客户端地址为键。重启会清除计数器，不同 DSH 进程不共享状态，达到容量时会淘汰保留的地址 bucket，而不会让内存无限增长。

[包 README](../../../../packages/host/invite-auth/README.zh.md)负责当前的配置、HTTP、Cookie、代理 header 和限制细节。[部署设计](../../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.zh.md)负责完整的宿主和发布布局。

## 曾考虑的替代方案

**运行独立认证进程。** 独立服务会增加另一个运行时、健康模型、部署产物和秘密交接，而认证 route 仍需与 DSH 页面协调启动。原生插件复用 WebServer route 所有权和 Cordis 生命周期顺序，无需添加第二个应用进程。

**使用 Caddy Basic Authentication。** Basic Authentication 会在每次请求中发送长期共享凭据，使部署难以控制退出登录和会话轮换，而且呈现浏览器原生提示框，而非产品的同源登录流程。独立签名的会话把邀请码限制在登录 endpoint，并允许通过轮换签名秘密撤销所有浏览器会话。

**将 `dsh-host-webserver` 改造成认证 middleware。** 全局 middleware 会让通用 HTTP 载体拥有部署策略，并影响包括发布的本地 Web 组合包在内的所有组合。拥有前缀的插件加代理强制执行让认证保持可选，同时保留 WebServer 的 route 注册职责。

**让 Caddy 状态检查提供就绪状态，而不使用 Cordis 依赖。** Caddy 会在认证子请求不可用时保持失败关闭，但外部状态无法协调进程内前端 fallback 与 route 注册或 HMR 撤回的顺序。就绪依赖可防止该 fallback 在相同的启动和卸载窗口中存在。

**运行 release 内的 root helper。** 从 `/opt/mydsh/current` 执行部署控制流，会让正在激活的候选 release 选择负责安装 unit、处理密钥和执行回滚的 root 程序。独立安装且受管理的 helper 将这项权限保留在此前经过评审的宿主控制平面中。

**以运行时用户执行构建。** 依赖生命周期脚本和仓库构建工具将因此获得持久 DSH 状态、共享工作区和运行时可读凭据的访问权。独立构建身份只向不受信任的构建步骤提供可丢弃的候选数据和缓存状态。

**使用仅代码回滚。** release 可以同时更改 systemd unit、Caddy 配置和代码。只回滚符号链接可能让旧代码与新宿主配置配对，因此激活和恢复将这 4 个值作为一个串行事务处理。

## 后果

- Caddy 是必需的安全组件，`3080` 端口必须保持私有；直接访问会绕过认证。
- 30 天 Cookie 以较长的 bearer token 生命周期为代价，减少重复输入邀请码。轮换会话秘密是全局撤销机制；轮换邀请码不会撤销既有 Cookie。
- 邀请码认证发生 HMR 时，也会拆除并重新挂载依赖就绪状态的 Web runtime 和前端 fallback。
- 登录限流会在进程重启时重置，且不会跨副本协调，因此该部署只运行一个 DSH 进程。
- 所有通过认证的人共享相同的实例权限；多租户或互不信任的访问需要不同的身份与授权设计。
- bootstrap 和 release 操作不会在特权路径覆盖不受管理的文件或跟随符号链接，而是直接失败。
- 构建无法使用生产状态或密钥，代价是增加第二个系统账户和单次操作构建存储。
- 可部署的 Git bundle 必须来自可信且经过评审的 checkout；仅验证 bundle 并不足够。
