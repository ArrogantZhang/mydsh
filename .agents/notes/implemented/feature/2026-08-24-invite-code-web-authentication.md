# Agent Note: Invite-code Web authentication

Status: implemented

English | [中文](2026-08-24-invite-code-web-authentication.zh.md)

## Problem

The DSH Web server intentionally provides neither TLS nor authentication. Its carrier-level trusted-host fence prevents DNS rebinding and other browser confused-deputy requests, but an accepted host has no user identity and anyone who can reach a remotely exposed server receives the same authority. A small trusted group needs remote browser access without turning the development-oriented Web server into a deployment security framework or changing the default local Web composition.

## Decision

`@deepseek-ai/dsh-host-invite-auth` is a native Cordis function plugin that owns the `/__invite` authentication routes, shared invite-code comparison, and stateless signed browser session. It registers one prefix rather than intercepting unrelated `WebServer` routes. This decision complements, and does not supersede, the [carrier-level browser-trust decision](../architecture/2026-07-28-api-browser-trust-boundary.md): the existing authority and origin checks remain confused-deputy defenses, while this plugin and the deployment proxy authenticate access.

Caddy terminates TLS, proxies `/__invite/*` directly, and calls `/__invite/check` before proxying every other page, API, SSE, or WebSocket request. The published Web bundle remains unauthenticated by default. The Alibaba Cloud deployment opts in through an explicit overlay that inserts invite auth and adds `inviteAuthReadiness` to the existing `web-runtime` row's dependencies.

The auth plugin registers its prefix route before publishing readiness. Cordis dependency disposal withdraws readiness and tears down the dependent `web-runtime` fiber, including its frontend fallback, before the auth route is removed. A failed auth activation never releases the fallback, and HMR or unload follows the same fail-closed order.

Plugin config holds only uppercase `DSH_*` environment references and non-secret policy. systemd reads root-only server secret files into the process environment; the launch-environment snapshot lets the plugin resolve only that inherited `process` layer. The default variable names contain `SECRET`, so the standard child-process environment scrubber removes them. Secret values never enter Cordis config, config dumps, or plugin diagnostics.

This authentication model is for a small trusted group sharing one DSH instance. A valid cookie conveys the instance's existing browser authority; it does not create identities, per-user workspaces, session ownership, or command isolation.

## Session and abuse controls

The session token carries a version, expiry, random nonce, and HMAC-SHA256 signature. The host-only secure cookie defaults to 30 days. Changing the invite code controls future login only; rotating the signing secret revokes all sessions. Logout is browser-side cookie clearing rather than server-side token revocation.

Failed logins use a bounded, process-local fixed-window limiter keyed by the client address that the loopback Caddy peer supplies. Restarts clear its counters, separate DSH processes do not share state, and capacity pressure evicts retained address buckets instead of permitting unbounded memory growth.

The [package README](../../../../packages/host/invite-auth/README.md) owns current configuration, HTTP, cookie, proxy-header, and limitation details. The [deployment design](../../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.md) owns the complete host and release layout.

## Alternatives considered

**Run a standalone authentication process.** A separate service adds another runtime, health model, deployment artifact, and secret handoff while the authenticated routes still need coordinated startup with the DSH page. The native plugin reuses WebServer route ownership and Cordis lifecycle ordering without adding a second application process.

**Use Caddy Basic Authentication.** Basic Authentication sends the long-lived shared credential on every request, gives the deployment little control over logout and session rotation, and exposes browser-native prompts rather than the product's same-origin login flow. A short signed session keeps the invite code at the login endpoint and permits signing-secret rotation to revoke all browsers.

**Convert `dsh-host-webserver` into authentication middleware.** Global middleware would make a generic HTTP carrier own deployment policy and would affect every composition, including the shipped local Web bundle. A prefix-owning plugin plus proxy enforcement keeps authentication opt-in and preserves WebServer's route-registration role.

**Let Caddy status checks provide readiness without a Cordis dependency.** Caddy fails closed when its auth subrequest is unavailable, but an external status cannot order the in-process frontend fallback against route registration or HMR withdrawal. The readiness dependency prevents that fallback from existing during the same startup and unload windows.

## Consequences

- Caddy is a required security component and port `3080` must remain private; direct access bypasses authentication.
- The 30-day cookie reduces repeated invite entry at the cost of a long bearer-token lifetime. Session-secret rotation is the global revocation mechanism; invite-code rotation does not revoke existing cookies.
- HMR of invite auth also tears down and remounts the readiness-dependent Web runtime and frontend fallback.
- Login rate limits reset on process restart and do not coordinate across replicas, so this deployment runs one DSH process.
- Every authenticated person shares the same instance authority; multi-tenant or mutually untrusted access requires a different identity and authorization design.
