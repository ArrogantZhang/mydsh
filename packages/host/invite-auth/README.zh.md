# @deepseek-ai/dsh-host-invite-auth

[English](README.md) | 中文

面向部署的共享邀请码浏览器认证可选插件。该插件拥有一个 `/__invite` 前缀 route 和无状态签名会话；它不会全局拦截 `WebServer`，因此 Caddy 等反向代理必须先强制执行认证检查，再转发其他所有浏览器请求。除非部署覆盖层同时挂载该插件和代理策略，否则发布的 Web 组合包保持无认证状态。

## 配置

| 字段 | 默认值 | 接受的值 |
|---|---|---|
| `inviteCodeEnv` | `DSH_INVITE_CODE_SECRET` | 匹配 `DSH_[A-Z0-9_]+` 的继承进程环境变量引用；插件只读取启动环境的 `process` 层。 |
| `sessionSecretEnv` | `DSH_INVITE_SESSION_SECRET` | 匹配 `DSH_[A-Z0-9_]+` 的继承进程环境变量引用；插件只读取启动环境的 `process` 层。 |
| `sessionTtlSeconds` | `2592000` | 从 `60` 到 `31536000` 的安全整数。 |
| `failureWindowSeconds` | `900` | 从 `1` 到 `9007199254740` 的安全整数；该值乘以 `1000` 后也必须是安全整数。 |
| `maxFailuresPerWindow` | `10` | 正安全整数。 |
| `maxTrackedAddresses` | `10000` | 正安全整数。 |
| `maxBodyBytes` | `4096` | 从 `128` 到 `65536` 的安全整数。 |

当任一环境变量引用或数值策略无效、邀请码少于 12 个 Unicode 码位，或会话秘密少于 32 个 UTF-8 字节时，激活会在发布就绪状态前明确失败。配置只包含环境变量名称和非秘密策略；秘密值绝不进入 Cordis 配置、配置转储、插件诊断或日志。

## HTTP route

| 方法 | 路径 | 状态 | 用途 |
|---|---|---|---|
| `GET` | `/__invite/login` | `200` 或 `303` | 渲染中文登录页，或将已经认证的浏览器重定向到安全的本地 `next` 路径。 |
| `POST` | `/__invite/login` | `303` | 检查同源代理 header、限流、表单边界和邀请码，再设置会话 Cookie 并重定向到安全的本地 `next` 路径。 |
| `GET` | `/__invite/check` | `204`、`303` 或 `401` | 为 Caddy `forward_auth` 授权；未认证的 `GET` 或 `HEAD` HTML 导航重定向到登录页，其他未认证流量收到 `401`。 |
| `POST` | `/__invite/logout` | `303` | 检查同源代理 header 后清除浏览器 Cookie，并重定向到登录页。 |

预期失败状态包括：表单字段缺失或客户端地址 header 有歧义时返回 `400`；邀请码错误或非导航检查未认证时返回 `401`；来源被拒绝时返回 `403`；前缀下路径未知时返回 `404`；已知路径的方法错误时返回带 `Allow` 的 `405`；表单过大时返回 `413`；表单不是 URL 编码时返回 `415`；地址被阻止时返回带 `Retry-After` 的 `429`。若响应发出时请求体尚未完整接收，响应会包含 `Connection: close`，防止未读取字节在同一连接上成为后续请求。

## 会话和秘密轮换

Cookie 值为 `v1.<expiry>.<nonce>.<signature>`：Unix 秒级过期时间、随机的 16 字节 base64url nonce，以及对前述字段计算的 HMAC-SHA256 签名。`__Host-dsh_invite` 设置 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `Path=/`；其生命周期默认为 30 天，且最长不超过 365 天。

更改邀请码只影响新登录。轮换会话秘密会撤销所有已签发 Cookie。退出登录会清除浏览器 Cookie，但不维护服务端撤销状态，因此已复制的旧 token 在到期或轮换会话秘密之前仍可通过密码学验证。

## 反向代理和就绪状态

该插件只拥有一个 `/__invite` 的 `prefix` 注册。它仅在注册该 route 后发布 `inviteAuthReadiness`。阿里云覆盖层让 `web-runtime` 依赖此状态，因此前端 fallback 无法在认证之前启动，而撤回就绪状态会在移除认证 route 之前先 dispose（资源释放）该 fallback。启动失败和卸载因此对 fallback 保持失败关闭。

Caddy 必须直接代理 `/__invite/*`，并在向 DSH 转发其他所有 HTTP、SSE（Server-Sent Events）或 WebSocket 请求之前执行 `/__invite/check`。对于登录和退出请求，它保留一个浏览器 `Origin`，并设置单值的 `X-Forwarded-Proto` 和 `X-Forwarded-Host`；请求必须使用 HTTPS，且 origin 与 host 必须完全一致。它还会用一个字面量客户端 IP 覆盖 `X-DSH-Invite-Client-IP`。仅当直接代理 peer 是精确的回环地址时才信任该客户端 header；否则直接 socket 地址拥有对应限流 bucket。公开 DSH 的 `3080` 端口会绕过 Caddy 认证，因此不安全。

固定窗口失败限流器位于单个进程内，并受 `maxTrackedAddresses` 约束。达到容量时，它先清除已过期 bucket，必要时再淘汰最早插入的 bucket。重启会清除所有 bucket，多个 DSH 进程既不共享失败记录，也不协调容量。

## 授权范围

邀请码认证会授权浏览器访问整个 DSH 实例。它不提供用户身份、按用户划分的工作区、按会话划分的所有权或命令隔离：所有通过认证的人共享该实例的工作区、会话、进程可用的凭据和命令权限。仅应将它部署给小规模可信群体。[部署设计](../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.zh.md)负责完整的宿主布局，[认证决策](../../../.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.zh.md)负责其理由。

## 模型体验

无。该认证插件处理浏览器 HTTP 请求，绝不更改提示词、消息、工具 schema、模型流或工具结果。

#### KV Cache 影响

无；该插件绝不组装或发送提供方请求。

## 已知限制与暂缓事项

- **必须由反向代理强制执行检查**：该插件拥有认证 route，但不会拦截无关的 Web server route；公开 3080 端口会绕过认证。
- **限流位于单个进程内**：重启会清除 bucket，多个 DSH 进程不共享计数器；该部署只运行一个 DSH 进程。
