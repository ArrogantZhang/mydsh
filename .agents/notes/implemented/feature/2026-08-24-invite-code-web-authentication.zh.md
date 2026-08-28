# Agent Note: 邀请码 Web 认证

Status: implemented

[English](2026-08-24-invite-code-web-authentication.md) | 中文

## 问题

DSH Web server 有意不提供 TLS 或认证。载体级 trusted-host 栅栏可防止 DNS rebinding 和其他浏览器混淆代理人请求，但被接受的 host 不具有用户身份，任何能访问远程公开服务器的人都会获得相同权限。一个小规模可信群体需要远程浏览器访问，同时不能把面向开发环境的 Web server 变成部署安全框架，也不能改变默认的本地 Web 组合。

## 决策

`@deepseek-ai/dsh-host-invite-auth` 是原生 Cordis 函数插件，拥有 `/__invite` 认证 route、共享邀请码比较和无状态签名浏览器会话。它注册一个前缀，而不会拦截无关的 `WebServer` route。本决策补充而不取代[载体级浏览器信任决策](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)：既有 authority 和 origin 检查仍是混淆代理人防御，本插件和部署代理则对访问进行认证。

Caddy 终止 TLS，直接代理 `/__invite/*`，并在代理其他所有页面、API、SSE（Server-Sent Events）或 WebSocket 请求前调用 `/__invite/check`。`forward_auth` 子请求会删除继承的逐跳 `Connection` 与 `Upgrade` header，让 Node 把检查作为普通 HTTP 处理。最终 reverse proxy 不会删除或改写这些 header，因此已认证 WebSocket 请求会保留 upgrade 握手。发布的 Web 组合包默认保持无认证状态。阿里云部署通过显式覆盖层选择启用：该覆盖层插入邀请码认证，并将 `inviteAuthReadiness` 加入既有 `web-runtime` 配置项的依赖。

鉴权响应使用 `Referrer-Policy: same-origin`。登录文档不会跨源泄露 `Referer`，而其同源导航表单 POST 会携带具体的 `Origin`，用于精确校验公网 host。插件仍会拒绝 `Origin: null`，不会削弱该证明。

认证插件先注册前缀 route，再发布就绪状态。Cordis 依赖资源释放会撤回就绪状态，并在移除认证 route 前拆除依赖它的 `web-runtime` fiber，包括其前端 fallback。认证激活失败时永远不会释放 fallback，HMR（热模块替换）或卸载遵循相同的失败关闭顺序。

插件配置只保存大写 `DSH_*` 环境变量引用和非秘密策略。systemd 将仅 root 可读的服务器秘密文件读入进程环境；启动环境快照让插件只解析继承的 `process` 层。默认变量名包含 `SECRET`，因此标准子进程环境清理器会移除它们。秘密值绝不进入 Cordis 配置、配置转储或插件诊断。

该认证模型面向共享同一 DSH 实例的小规模可信群体。有效 Cookie 传递实例既有的浏览器权限；它不会创建身份、按用户划分的工作区、会话所有权或命令隔离。

阿里云部署将经过评审的 root 控制流安装在所有 release 之外的 `/usr/local/sbin/mydsh-deploy-release`。该稳定 helper 拥有 journal 格式 1，并被排除在自动 release 更新之外；更改它需要单独评审的维护流程。root 所有的 systemd unit、Caddyfile 和 Caddy drop-in 也是冻结的控制平面输入：候选必须携带逐字节相同的副本，正常部署绝不会替换或重新加载这些文件。共享的非阻塞宿主锁将 bootstrap、部署、回滚、清理、遗留 staging 清理，以及邀请或会话密钥轮换串行化。轮换会在服务器上生成密钥，原子同步私有环境文件，并在重启或验收失败时恢复它。helper 会在切换代码前于 root-only 的同级 `activation.new.*` 目录中构建完整的格式 1 `prepared` 恢复 journal，其中包含之前的链接和服务之前的启用状态，再将其原子发布为 `/var/lib/mydsh-deploy/activation`。失败会恢复并同步该状态，直到恢复成功；接受激活会验证监听、通过公开代理登录、加载已认证主页，并使用同一个 root-private cookie jar 要求两条实时 WebSocket 路径都完成真实的 `101` upgrade。每次探测都必须保持打开，直到两秒 curl 超时；响应正文、header、密钥和 cookie 值均不会输出。随后 helper 会启用服务、同步受影响文件系统，并在清理前记录 `committed`。

稳定 helper 拥有两个带版本的格式 1 journal：激活与轮换。它拒绝未知格式，并在每项操作前协调两者。`prepared` 轮换恢复并同步旧环境、重启 DSH 并重复验收；`committed` 轮换保留新密钥并清理 journal。恢复失败会保留状态并阻止后续工作，且没有经过验证的活动 release 时，轮换不能发布状态。

候选 release 绝不会在生产宿主上构建。选定的具名 Git ref 提供 `package-release.sh`；脚本会对照该 ref 检查自身字节并创建可信解压目录，再在 digest 固定、使用全新本地状态且没有生产环境的临时官方 Node 24 Linux 容器中，执行固定 pnpm 安装、冻结依赖、invite-auth 测试、完整构建和配置转储。CPU、内存、进程数和运行时间受限；网络与磁盘使用量不受限。容器只能写入精确源码 tree 的副本，不能接触调用者输出目录。容器退出后，宿主把每个静态安全输入与可信解压目录逐字节比较，生成 manifest 和 checksum，再通过一次目录重命名发布完整 artifact-set 目录。服务器仅支持 Linux amd64，没有 builder 身份、pnpm、源码 checkout、生命周期执行、测试运行器或候选构建缓存。

通过 SSH 交付的 SHA-256 sidecar 能发现 artifact 损坏，但不是真实性证明。部署信任精确的已评审本地 ref，以及打包前另行验证的签名 tag 或 commit。本地 packager 和宿主 helper 执行相同的压缩大小、member 数量、单个 member 和展开大小 artifact 限制。helper 还会为每个 member 预算文件系统 metadata 和备用 inode，要求以 commit 命名的 artifact-set 目录中恰好只有 archive 和 checksum，把两者复制到持久的 root-private 新 inode，拒绝不安全 archive member 和越界链接，并验证 manifest 格式、commit、具名 ref、Linux amd64 平台、固定镜像 digest、运行时输出和 helper journal 兼容版本。与已安装控制平面的逐字节比较关闭了候选配置语法；helper 绝不会执行 release 内的控制流。候选 systemd 验证在可执行的 release staging 文件系统上使用短生命周期的 `.verify.<6>` 合成根目录，其完整目录链均可遍历且 mode 为 `0755`，占位文件为空且 mode 与真实语义一致。秘密值绝不进入该根目录。正常完成和验证失败会立即删除它，EXIT 清理拥有精确的活动路径，下次加锁操作只删除异常终止留下的规范、root 所有 `.verify.<6>` 同级目录。

## 会话和滥用控制

会话 token 包含版本、过期时间、随机 nonce 和 HMAC-SHA256 签名。仅限 host 的安全 Cookie 默认有效期为 30 天。更改邀请码只控制之后的登录；轮换签名秘密会撤销所有会话。退出登录只清除浏览器 Cookie，而不会在服务端撤销 token。

登录失败使用有容量限制、位于单个进程内的固定窗口限流器，并以回环 Caddy peer 提供的客户端地址为键。通过代理 header 校验后，每次登录都会先在 `maxBodyBytes` 上限内完整读取请求体，再查询失败 bucket。限流检查、邀请码比较和失败记录随后同步执行，因此并发流式请求体无法共享同一份尚未记录的失败额度。重启会清除计数器，不同 DSH 进程不共享状态，达到容量时会淘汰保留的地址 bucket，而不会让内存无限增长。

[包 README](../../../../packages/host/invite-auth/README.zh.md)负责当前的配置、HTTP、Cookie、代理 header 和限制细节。[部署设计](../../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.zh.md)负责完整的宿主和发布布局。

## 曾考虑的替代方案

**运行独立认证进程。** 独立服务会增加另一个运行时、健康模型、部署产物和秘密交接，而认证 route 仍需与 DSH 页面协调启动。原生插件复用 WebServer route 所有权和 Cordis 生命周期顺序，无需添加第二个应用进程。

**使用 Caddy Basic Authentication。** Basic Authentication 会在每次请求中发送长期共享凭据，使部署难以控制退出登录和会话轮换，而且呈现浏览器原生提示框，而非产品的同源登录流程。独立签名的会话把邀请码限制在登录 endpoint，并允许通过轮换签名秘密撤销所有浏览器会话。

**登录时接受 `Origin: null`。** null origin 无法证明请求来源与公网 HTTPS host 一致，而且可能来自不透明或沙箱化文档。登录页通过响应策略保留具体的同源表单 origin，因此 route 继续执行精确来源校验。

**将 `dsh-host-webserver` 改造成认证 middleware。** 全局 middleware 会让通用 HTTP 载体拥有部署策略，并影响包括发布的本地 Web 组合包在内的所有组合。拥有前缀的插件加代理强制执行让认证保持可选，同时保留 WebServer 的 route 注册职责。

**让 Caddy 状态检查提供就绪状态，而不使用 Cordis 依赖。** Caddy 会在认证子请求不可用时保持失败关闭，但外部状态无法协调进程内前端 fallback 与 route 注册或 HMR 撤回的顺序。就绪依赖可防止该 fallback 在相同的启动和卸载窗口中存在。

**运行 release 内的 root helper。** 从 `/opt/mydsh/current` 执行部署控制流，会让正在激活的候选 release 选择负责安装 unit、处理密钥和执行回滚的 root 程序。独立安装且受管理的 helper 将这项权限保留在此前经过评审的宿主控制平面中。

**在生产宿主上构建，无论使用运行时用户还是独立 builder。** 即使无法读取运行时密钥，依赖生命周期脚本仍可留下 descendant、消耗宿主资源、接触内核和服务状态，并扩大生产信任边界。本地临时容器会在 SSH 传输前生成完整 artifact，因此生产只执行验证和激活。

**允许正常 release 更新 unit 或 Caddy 配置。** 候选控制宿主配置会把 release 扩展到特权控制平面，并使其语法难以安全封闭。因此正常 release 只激活代码，且必须携带逐字节相同的控制平面副本；经过评审的维护流程负责有意变更 unit、proxy 或 helper。

## 后果

- Caddy 是必需的安全组件，`3080` 端口必须保持私有；直接访问会绕过认证。
- 30 天 Cookie 以较长的 bearer token 生命周期为代价，减少重复输入邀请码。轮换会话秘密是全局撤销机制；轮换邀请码不会撤销既有 Cookie。
- 邀请码认证发生 HMR 时，也会拆除并重新挂载依赖就绪状态的 Web runtime 和前端 fallback。
- 登录限流会在进程重启时重置，且不会跨副本协调，因此该部署只运行一个 DSH 进程。
- 所有通过认证的人共享相同的实例权限；多租户或互不信任的访问需要不同的身份与授权设计。
- bootstrap 和 release 操作不会在特权路径覆盖不受管理的文件或跟随符号链接，而是直接失败。
- 构建无法使用生产状态或密钥，代价是本地必须具备 Docker 和完成完整 Linux 构建所需的资源。
- 可部署 artifact 必须来自可信且经过评审的 ref；仅有 checksum 并不足够。
