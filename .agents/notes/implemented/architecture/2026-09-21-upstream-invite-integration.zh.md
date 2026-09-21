# Agent Note: 上游 Remote 传输上的邀请码部署

Status: implemented

[English](2026-09-21-upstream-invite-integration.md) | 中文

## Problem

上游 Web 应用会认证浏览器会话，并通过一个 Remote mux 承载有类型的逻辑流。邀请码部署需要保留共享代码入口，同时不保留已移除的 ApiProxy 协议，也不绕过上游认证。

## Decision

使用产品版本 `0.1.6-alpha.2` 的上游框架。邀请码登录仍是额外的部署授权层。验证邀请码后，可选桥接通过 Connection 现有的启动令牌交换在进程内获取上游浏览器 cookie。令牌不会被重定向到浏览器或打印。Caddy 在转发应用流量前检查邀请码 cookie；Connection 独立验证自己的 cookie。持有有效邀请码会话的浏览器可以通过登录路由续建上游 cookie。

部署使用 `/api/remote.mux`、上游心跳和各业务域拥有的回放。退役的双流批处理实现及其基准不迁入另一种 wire 协议。其测量值保留在[历史背压记录](../../archived/bug-fix/2026-08-27-web-realtime-backpressure.md)中，不用于衡量当前载体。composer 的即时反馈仍是本地 pending 状态，而不是持久确认。

回环部署的 Connection 行从 `webStartup` 读取显式受信主机，使 Connection 能先于邀请码认证和依赖其就绪的 Web runtime 激活。邀请码路由注册前，前端保持不可用。应用端口必须只监听回环地址。部署禁用启动 URL 打印，避免上游令牌进入服务日志。

## Alternatives considered

**在 Remote mux 旁保留旧载体。** 这会留下互不关联的会话交付实现和不兼容的回放语义。上游载体与业务域消费者必须一同演进。

**禁用上游浏览器认证。** 代理的邀请码验证会成为唯一防线，并需要分叉 Connection 的认证策略。在验证邀请码后交换 cookie 可以保留两项检查。

**把旧压缩测量值当作当前证据。** payload 和物理传输已经不同。当前验证必须覆盖上游 Gateway 和装配后的邀请码组合。

## Consequences

旧的 64 帧批处理、压缩比、队列容量和字节熔断保证不是当前载体的承诺。后续传输调优属于上游 Gateway，需要独立测量。邀请码认证仍提供共享实例权限，而不是独立身份或工作区隔离。

更新仓库不会迁移生产 Harness home。部署前应备份凭据、设置、profile 和会话代际，并在副本上验证上游相邻 Session 迁移链。不得为支持降级而覆盖已发布的后继代际。

验证覆盖错误邀请码拒绝、进程内浏览器 cookie 交换、两层认证、Remote mux 升级和即时 composer 反馈。部署 helper 与冻结配置更新仍属于单独的服务器维护操作。
