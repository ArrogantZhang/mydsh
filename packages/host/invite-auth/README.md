---
description: "Protect shared Web access with invite codes, signed cookies, and the official browser-authentication bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-invite-auth

English | [中文](README.zh.md)

## Summary

Give a small trusted group access to one Web instance through a shared invite code. Browsers retain access with signed cookies, and the optional bridge also establishes the official browser session. A reverse proxy must check the invite cookie before forwarding protected traffic. Every admitted person shares the instance's workspaces and command authority.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside WebServer and supply its secrets through inherited process variables. For the Web application, also mount Connection, enable the bridge, and enforce the proxy check described below.

```yaml
- name: '@deepseek-ai/dsh-host-invite-auth'
  config:
    bridgeBrowserAuth: true
```

### Configuration

| Field | Default | Accepted value |
|---|---|---|
| `bridgeBrowserAuth` | `false` | Require Connection and exchange accepted invite access for its official browser cookie. Enable for the Web deployment. |
| `inviteCodeEnv` | `DSH_INVITE_CODE_SECRET` | Inherited process-environment reference matching `DSH_[A-Z0-9_]+`; the plugin reads only the `process` launch layer. |
| `sessionSecretEnv` | `DSH_INVITE_SESSION_SECRET` | Inherited process-environment reference matching `DSH_[A-Z0-9_]+`; the plugin reads only the `process` launch layer. |
| `sessionTtlSeconds` | `2592000` | Safe integer from `60` through `31536000`. |
| `failureWindowSeconds` | `900` | Safe integer from `1` through `9007199254740`; the value multiplied by `1000` must also be a safe integer. |
| `maxFailuresPerWindow` | `10` | Positive safe integer. |
| `maxTrackedAddresses` | `10000` | Positive safe integer. |
| `maxBodyBytes` | `4096` | Safe integer from `128` through `65536`. |

Activation fails loudly before publishing readiness when either environment reference or numeric policy is invalid, the invite code contains fewer than 12 Unicode code points, or the session secret contains fewer than 32 UTF-8 bytes. Config contains environment-variable names and non-secret policy only; secret values never enter Cordis config, config dumps, or plugin diagnostics and logs.

### HTTP routes

| Method | Path | Status | Purpose |
|---|---|---|---|
| `GET` | `/__invite/login` | `200` or `303` | Render the Chinese login page, or redirect an already authenticated browser to a safe local `next` path. |
| `POST` | `/__invite/login` | `303` | Check same-origin proxy headers, read the bounded form, enforce rate limits, and compare the invite code; then set the session cookie and redirect to a safe local `next` path. |
| `GET` | `/__invite/check` | `204`, `303`, or `401` | Authorize Caddy `forward_auth`; unauthenticated `GET` or `HEAD` HTML navigation redirects to login, while other unauthenticated traffic receives `401`. |
| `POST` | `/__invite/logout` | `303` | Clear the browser cookie and redirect to login after the same-origin proxy-header check. |

Expected failures use `400` for a missing form field or ambiguous client-address header, `401` for a wrong invite code or unauthenticated non-navigation check, `403` for a rejected origin, `404` for an unknown path under the prefix, `405` with `Allow` for a known path's wrong method, `413` for an oversized form, `415` for a non-URL-encoded form, and `429` with `Retry-After` for a blocked address. A response sent before the request body is complete includes `Connection: close`, preventing unread bytes from becoming a later request on the same connection.

### Sessions and secret rotation

With `bridgeBrowserAuth`, successful login sets both cookies. A `GET /__invite/login` with a valid invite cookie also restores the official cookie. Connection owns token exchange, signing, expiry, and authority binding; the plugin calls its public authentication methods internally, never sending the process token through a browser URL, response body, or log. The official cookie also receives `Secure`. Both login paths require the proxy's unambiguous HTTPS forwarding headers. Wrong or expired invite credentials cannot obtain an official cookie.

The cookie value is `v1.<expiry>.<nonce>.<signature>`: a Unix-seconds expiry, a random 16-byte base64url nonce, and an HMAC-SHA256 signature over the preceding fields. `__Host-dsh_invite` is `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; its lifetime defaults to 30 days and cannot exceed 365 days.

Changing the invite code affects new logins only. Rotating the session secret revokes every issued cookie. Logout clears the browser cookie but maintains no server-side revocation state, so a copied old token remains cryptographically valid until its expiry or session-secret rotation.

### Reverse proxy and readiness

The plugin owns exactly one `prefix` registration at `/__invite`. It publishes `inviteAuthReadiness` only after that route is registered. With the bridge enabled, route registration and readiness depend on Connection; withdrawing Connection removes both. The deployment loads Connection from `webStartup` and makes Web runtime depend on invite readiness, so the frontend fallback starts only after invite authentication and is removed first on withdrawal. Caddy enforces the check independently, so an absent invite route cannot authorize protected traffic.

The official cookie does not replace the invite cookie at the proxy. Logout clears the invite cookie, and invite expiry or signing-secret rotation makes Caddy reject subsequent requests even while the official cookie remains valid. Keep the backend port private: official authentication alone does not enforce invite revocation.

Caddy must proxy `/__invite/*` directly and run `/__invite/check` before forwarding every other HTTP, SSE, or WebSocket request to DSH. For login and logout it preserves one browser `Origin` and sets single-valued `X-Forwarded-Proto` and `X-Forwarded-Host`; HTTPS and exact origin/host agreement are required. It also overwrites `X-DSH-Invite-Client-IP` with one literal client IP. That client header is trusted only from an exact loopback proxy peer; otherwise the direct socket address owns the rate-limit bucket. Exposing DSH port `3080` bypasses Caddy authentication and is unsafe.

The fixed-window failure limiter is process-local and bounded by `maxTrackedAddresses`. After proxy-header validation, each login reads its complete URL-encoded body within `maxBodyBytes` before consulting the limiter; the subsequent limiter check, invite-code comparison, and failure record do not yield, so concurrent streamed requests observe earlier completed failures. This pre-limit read retains at most `maxBodyBytes` per request. At capacity the limiter prunes expired buckets and then evicts the oldest insertion if necessary. A restart clears every bucket, and multiple DSH processes neither share failures nor coordinate capacity.

### Authorization scope

Trusted plugins may register one reversible `invitePage` presentation for the existing form. Text values are escaped. Only the fixed plugin bootstrap receives a fresh per-response CSP nonce; the default policy still blocks remote resources and embedding. The stock page remains script-free when no presentation is registered. This extension changes neither login validation nor cookie authority.

Invite authentication authorizes a browser to the whole DSH instance. It provides no user identity, per-user workspace, per-session ownership, or command isolation: every authorized person shares the instance's workspaces, sessions, credentials available to the process, and command authority. Deploy it only for a small trusted group. The [deployment design](../../../docs/superpowers/specs/2026-08-24-dsh-invite-auth-deployment-design.md) owns the complete host layout, and the [authentication decision](../../../.agents/notes/implemented/feature/2026-08-24-invite-code-web-authentication.md) owns the rationale.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [route owner](src/index.ts) validates invite access before calling Connection's token exchange in memory. It passes the forwarded Host unchanged so Connection uses the same authority normalization for cookie issuance and later requests, including explicit ports. [Signed-token primitives](src/token.ts) and [request policy](src/policy.ts) keep cookie verification separate from rate limiting and proxy validation.

No runtime invariant companion is published. Authorization is derived from each signed cookie, with no independently maintained state to compare. Real-composition tests cover route registration and disposal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the adjacent services and complete deployment.

- [WebServer](../webserver/README.md): HTTP route ownership.
- [Connection](../../client/connection/README.md): official browser authentication.
- [Deployment](../../../deploy/alibaba-cloud/README.md): Caddy and host configuration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the authentication plugin handles browser HTTP requests and never changes prompts, messages, tool schemas, model streams, or tool results.

#### KV Cache effect

None; the plugin never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Deployments must account for these access and availability limits.

- **A reverse proxy must enforce the check** — the plugin owns authentication routes but does not intercept unrelated Web server routes; exposing port 3080 bypasses authentication.
- **Rate limits are process-local** — a restart clears buckets and multiple DSH processes do not share counters; the deployment runs exactly one DSH process.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
