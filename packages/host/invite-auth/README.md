# @deepseek-ai/dsh-host-invite-auth

English | [中文](README.zh.md)

Deployment opt-in for shared invite-code browser authentication. The plugin owns one `/__invite` prefix route and a stateless signed session; it does not globally intercept `WebServer`, so a reverse proxy such as Caddy must enforce its check before forwarding every other browser request. The shipped Web bundle remains unauthenticated unless a deployment overlay mounts this plugin and the proxy policy together.

## Configuration

| Field | Default | Accepted value |
|---|---|---|
| `inviteCodeEnv` | `DSH_INVITE_CODE_SECRET` | Inherited process-environment reference matching `DSH_[A-Z0-9_]+`; the plugin reads only the `process` launch layer. |
| `sessionSecretEnv` | `DSH_INVITE_SESSION_SECRET` | Inherited process-environment reference matching `DSH_[A-Z0-9_]+`; the plugin reads only the `process` launch layer. |
| `sessionTtlSeconds` | `2592000` | Safe integer from `60` through `31536000`. |
| `failureWindowSeconds` | `900` | Safe integer from `1` through `9007199254740`; the value multiplied by `1000` must also be a safe integer. |
| `maxFailuresPerWindow` | `10` | Positive safe integer. |
| `maxTrackedAddresses` | `10000` | Positive safe integer. |
| `maxBodyBytes` | `4096` | Safe integer from `128` through `65536`. |

Activation fails loudly before publishing readiness when either environment reference or numeric policy is invalid, the invite code contains fewer than 12 Unicode code points, or the session secret contains fewer than 32 UTF-8 bytes. Config contains environment-variable names and non-secret policy only; secret values never enter Cordis config, config dumps, or plugin diagnostics and logs.

## HTTP routes

| Method | Path | Success | Purpose |
|---|---|---|---|
| `GET` | `/__invite/login` | `200` or `303` | Render the Chinese login page, or redirect an already authenticated browser to a safe local `next` path. |
| `POST` | `/__invite/login` | `303` | Check same-origin proxy headers, rate limits, form bounds, and the invite code; then set the session cookie and redirect to a safe local `next` path. |
| `GET` | `/__invite/check` | `204`, `303`, or `401` | Authorize Caddy `forward_auth`; unauthenticated `GET` or `HEAD` HTML navigation redirects to login, while other unauthenticated traffic receives `401`. |
| `POST` | `/__invite/logout` | `303` | Clear the browser cookie and redirect to login after the same-origin proxy-header check. |

Expected failures use `400` for a missing form field or ambiguous client-address header, `401` for a wrong invite code or unauthenticated non-navigation check, `403` for a rejected origin, `404` for an unknown path under the prefix, `405` with `Allow` for a known path's wrong method, `413` for an oversized form, `415` for a non-URL-encoded form, and `429` with `Retry-After` for a blocked address. A response sent before the request body is complete includes `Connection: close`, preventing unread bytes from becoming a later request on the same connection.

## Sessions and secret rotation

The cookie value is `v1.<expiry>.<nonce>.<signature>`: a Unix-seconds expiry, a random 16-byte base64url nonce, and an HMAC-SHA256 signature over the preceding fields. `__Host-dsh_invite` is `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; its lifetime defaults to 30 days and cannot exceed 365 days.

Changing the invite code affects new logins only. Rotating the session secret revokes every issued cookie. Logout clears the browser cookie but maintains no server-side revocation state, so a copied old token remains cryptographically valid until its expiry or session-secret rotation.

## Reverse proxy and readiness

The plugin owns exactly one `prefix` registration at `/__invite`. It publishes `inviteAuthReadiness` only after that route is registered. The Alibaba Cloud overlay makes `web-runtime` depend on this fact, so the frontend fallback cannot start before authentication and readiness withdrawal disposes that fallback before removing the auth route. Startup failure and unload therefore fail closed for the fallback.

Caddy must proxy `/__invite/*` directly and run `/__invite/check` before forwarding every other HTTP, SSE, or WebSocket request to DSH. For login and logout it preserves one browser `Origin` and sets single-valued `X-Forwarded-Proto` and `X-Forwarded-Host`; HTTPS and exact origin/host agreement are required. It also overwrites `X-DSH-Invite-Client-IP` with one literal client IP. That client header is trusted only from an exact loopback proxy peer; otherwise the direct socket address owns the rate-limit bucket. Exposing DSH port `3080` bypasses Caddy authentication and is unsafe.

The fixed-window failure limiter is process-local and bounded by `maxTrackedAddresses`. At capacity it prunes expired buckets and then evicts the oldest insertion if necessary. A restart clears every bucket, and multiple DSH processes neither share failures nor coordinate capacity.

## Authorization scope

Invite authentication authorizes a browser to the whole DSH instance. It provides no user identity, per-user workspace, per-session ownership, or command isolation: every authorized person shares the instance's workspaces, sessions, credentials available to the process, and command authority. Deploy it only for a small trusted group. The [deployment design](../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.md) owns the complete host layout, and the [authentication decision](../../../.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md) owns the rationale.

## Model Experience

None, as the authentication plugin handles browser HTTP requests and never changes prompts, messages, tool schemas, model streams, or tool results.

#### KV Cache effect

None; the plugin never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **A reverse proxy must enforce the check** — the plugin owns authentication routes but does not intercept unrelated Web server routes; exposing port 3080 bypasses authentication.
- **Rate limits are process-local** — a restart clears buckets and multiple DSH processes do not share counters; the deployment runs exactly one DSH process.
