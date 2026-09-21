---
description: "通过邀请码、签名 Cookie 和官方浏览器认证桥接保护共享 Web 访问。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-invite-auth

[English](README.md) | 中文

## 概述

通过共享邀请码，让小规模可信群体访问同一个 Web 实例。浏览器使用签名 Cookie 保持访问权限，可选桥接还会建立官方浏览器会话。反向代理必须先检查邀请码 Cookie，再转发受保护的流量。所有获准访问的人共享该实例的工作区和命令权限。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此插件与 WebServer 一起挂载，并通过继承的进程环境变量提供秘密。对于 Web 应用，还须挂载 Connection、启用桥接，并执行下述代理检查。

```yaml
- name: '@deepseek-ai/dsh-host-invite-auth'
  config:
    bridgeBrowserAuth: true
```

### 配置

| 字段 | 默认值 | 接受的值 |
|---|---|---|
| `bridgeBrowserAuth` | `false` | 依赖 Connection，将已验证的邀请码访问权限兑换为官方浏览器 Cookie。Web 部署应启用。 |
| `inviteCodeEnv` | `DSH_INVITE_CODE_SECRET` | 匹配 `DSH_[A-Z0-9_]+` 的继承进程环境变量引用；插件只读取启动环境的 `process` 层。 |
| `sessionSecretEnv` | `DSH_INVITE_SESSION_SECRET` | 匹配 `DSH_[A-Z0-9_]+` 的继承进程环境变量引用；插件只读取启动环境的 `process` 层。 |
| `sessionTtlSeconds` | `2592000` | 从 `60` 到 `31536000` 的安全整数。 |
| `failureWindowSeconds` | `900` | 从 `1` 到 `9007199254740` 的安全整数；该值乘以 `1000` 后也必须是安全整数。 |
| `maxFailuresPerWindow` | `10` | 正安全整数。 |
| `maxTrackedAddresses` | `10000` | 正安全整数。 |
| `maxBodyBytes` | `4096` | 从 `128` 到 `65536` 的安全整数。 |

当任一环境变量引用或数值策略无效、邀请码少于 12 个 Unicode 码位，或会话秘密少于 32 个 UTF-8 字节时，激活会在发布就绪状态前明确失败。配置只包含环境变量名称和非秘密策略；秘密值绝不进入 Cordis 配置、配置转储、插件诊断或日志。

### HTTP route

| 方法 | 路径 | 状态 | 用途 |
|---|---|---|---|
| `GET` | `/__invite/login` | `200` 或 `303` | 渲染中文登录页，或将已经认证的浏览器重定向到安全的本地 `next` 路径。 |
| `POST` | `/__invite/login` | `303` | 检查同源代理 header、读取有界表单、执行限流并比较邀请码，再设置会话 Cookie 并重定向到安全的本地 `next` 路径。 |
| `GET` | `/__invite/check` | `204`、`303` 或 `401` | 为 Caddy `forward_auth` 授权；未认证的 `GET` 或 `HEAD` HTML 导航重定向到登录页，其他未认证流量收到 `401`。 |
| `POST` | `/__invite/logout` | `303` | 检查同源代理 header 后清除浏览器 Cookie，并重定向到登录页。 |

预期失败状态包括：表单字段缺失或客户端地址 header 有歧义时返回 `400`；邀请码错误或非导航检查未认证时返回 `401`；来源被拒绝时返回 `403`；前缀下路径未知时返回 `404`；已知路径的方法错误时返回带 `Allow` 的 `405`；表单过大时返回 `413`；表单不是 URL 编码时返回 `415`；地址被阻止时返回带 `Retry-After` 的 `429`。若响应发出时请求体尚未完整接收，响应会包含 `Connection: close`，防止未读取字节在同一连接上成为后续请求。

### 会话和秘密轮换

启用 `bridgeBrowserAuth` 后，成功登录会设置两个 Cookie。携带有效邀请码 Cookie 的 `GET /__invite/login` 也会恢复官方 Cookie。Connection 负责 token 兑换、签名、过期和 authority 绑定；插件在内部调用其公开认证方法，绝不将进程 token 发送到浏览器 URL、响应体或日志。官方 Cookie 额外设置 `Secure`。两条登录路径都要求代理提供无歧义的 HTTPS 转发 header。错误或过期的邀请码凭据不能获取官方 Cookie。

Cookie 值为 `v1.<expiry>.<nonce>.<signature>`：Unix 秒级过期时间、随机的 16 字节 base64url nonce，以及对前述字段计算的 HMAC-SHA256 签名。`__Host-dsh_invite` 设置 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `Path=/`；其生命周期默认为 30 天，且最长不超过 365 天。

更改邀请码只影响新登录。轮换会话秘密会撤销所有已签发 Cookie。退出登录会清除浏览器 Cookie，但不维护服务端撤销状态，因此已复制的旧 token 在到期或轮换会话秘密之前仍可通过密码学验证。

### 反向代理和就绪状态

该插件只拥有一个 `/__invite` 的 `prefix` 注册。它仅在注册该 route 后发布 `inviteAuthReadiness`。启用桥接时，route 注册和就绪状态都依赖 Connection；撤回 Connection 会移除两者。部署从 `webStartup` 加载 Connection，并让 Web runtime 依赖邀请码就绪状态，因此前端 fallback 仅在邀请码认证就绪后启动，且在撤回时先移除。Caddy 独立执行检查，缺失邀请码 route 时无法授权受保护的流量。

官方 Cookie 不会取代代理检查的邀请码 Cookie。退出登录会清除邀请码 Cookie；即使官方 Cookie 仍有效，邀请码过期或签名秘密轮换也会让 Caddy 拒绝后续请求。后端端口必须保持私有：仅有官方认证不能强制执行邀请码撤销。

Caddy 必须直接代理 `/__invite/*`，并在向 DSH 转发其他所有 HTTP、SSE（Server-Sent Events）或 WebSocket 请求之前执行 `/__invite/check`。对于登录和退出请求，它保留一个浏览器 `Origin`，并设置单值的 `X-Forwarded-Proto` 和 `X-Forwarded-Host`；请求必须使用 HTTPS，且 origin 与 host 必须完全一致。它还会用一个字面量客户端 IP 覆盖 `X-DSH-Invite-Client-IP`。仅当直接代理 peer 是精确的回环地址时才信任该客户端 header；否则直接 socket 地址拥有对应限流 bucket。公开 DSH 的 `3080` 端口会绕过 Caddy 认证，因此不安全。

固定窗口失败限流器位于单个进程内，并受 `maxTrackedAddresses` 约束。通过代理 header 校验后，每次登录都会先在 `maxBodyBytes` 上限内完整读取 URL 编码的请求体，再查询限流器；随后的限流检查、邀请码比较和失败记录不会让出执行权，因此并发流式请求会观察到先完成请求的失败记录。限流前读取每个请求最多保留 `maxBodyBytes`。达到容量时，限流器会先清理已过期 bucket，随后按需淘汰最早插入的记录。进程重启会清除全部 bucket，多个 DSH 进程既不共享失败计数，也不协调容量。

### 授权范围

邀请码认证会授权浏览器访问整个 DSH 实例。它不提供用户身份、按用户划分的工作区、按会话划分的所有权或命令隔离：所有通过认证的人共享该实例的工作区、会话、进程可用的凭据和命令权限。仅应将它部署给小规模可信群体。[部署设计](../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.zh.md)负责完整的宿主布局，[认证决策](../../../.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.zh.md)负责其理由。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[路由所有者](src/index.ts)先验证邀请码访问权限，再在内存中调用 Connection 的 token 兑换。它原样传递转发的 Host，让 Connection 在签发 Cookie 和处理后续请求时使用相同的 authority 归一化规则，包括显式端口。[签名 token 原语](src/token.ts)与[请求策略](src/policy.ts)将 Cookie 验证与限流、代理校验分开。

该包没有运行时不变量伴随插件：授权由各个签名 Cookie 推导，没有可用于比较的独立维护状态。真实组合测试覆盖 route 注册与资源释放。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍相邻服务与完整部署。

- [WebServer](../webserver/README.zh.md)：HTTP route 所有权。
- [Connection](../../client/connection/README.zh.md)：官方浏览器认证。
- [部署](../../../deploy/alibaba-cloud/README.zh.md)：Caddy 与宿主配置。

-----

<a id="model-experience"></a>
## 模型体验

无。该认证插件处理浏览器 HTTP 请求，绝不更改提示词、消息、工具 schema、模型流或工具结果。

#### KV Cache 影响

无；该插件绝不组装或发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

部署必须考虑以下访问与可用性限制。

- **必须由反向代理强制执行检查**：该插件拥有认证 route，但不会拦截无关的 Web server route；公开 3080 端口会绕过认证。
- **限流位于单个进程内**：重启会清除 bucket，多个 DSH 进程不共享计数器；该部署只运行一个 DSH 进程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
