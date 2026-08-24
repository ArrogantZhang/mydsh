# DSH Invite-Code Authentication and Alibaba Cloud Deployment Design

English | [中文](2026-08-24-dsh-invite-auth-deployment-design.zh.md)

## Status and scope

This design defines a DeepSeek Harness Web deployment for a small group of trusted users: the application runs on an Alibaba Cloud Hong Kong or overseas Ubuntu 22.04/24.04 ECS instance, serves HTTPS on a dedicated subdomain, and requires each visitor to enter one shared invite code. A browser remains authenticated for 30 days after successful verification.

The deployment uses the latest `master` from `deepseek-ai/deepseek-harness` fetched at implementation time and keeps the local extension in isolated commits. Model configuration does not enter source control or deployment automation; an administrator adds Kimi as a custom OpenAI-compatible provider in the Web UI.

Every authorized visitor shares one DSH instance, its sessions, its workspace, and the service account's permissions. This design applies only to the administrator and fully trusted users; it does not provide multi-tenant isolation.

## Non-goals

- Do not provide user accounts, individual invite codes, an invite-code administration UI, permission roles, or identity auditing.
- Do not isolate visitors' sessions, files, or command execution.
- Do not restrict DSH's existing file and command capabilities.
- Do not store Kimi credentials in the repository, deployment package, or automated tests.
- Do not enable unattended upstream updates.

## Selected approach

The deployment adds a native Cordis plugin named `@deepseek-ai/dsh-host-invite-auth`. The plugin serves the login page, verifies the shared invite code, issues session cookies, logs browsers out, and supplies the Caddy authorization endpoint. Caddy terminates TLS and calls that endpoint before proxying ordinary pages, API traffic, SSE, or WebSocket connections.

A separate authentication process would reduce changes to the upstream composition but add another service and failure point. Caddy Basic Auth does not provide a product login page or the 30-day signed session required here. A native plugin follows DSH's “everything is a plugin” architecture and keeps login and authorization behavior in one independently testable package.

## System architecture

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

Caddy is the only public entry point. DSH retains its official `127.0.0.1:3080` default binding, and the Alibaba Cloud security group permits only SSH, HTTP, and HTTPS, not port 3080. The Web startup command accepts exactly one public subdomain through `--trusted-host`.

`packages/host/invite-auth` owns the authentication behavior and injects the `webServer` service. The Web profile mounts the plugin after the `webserver` entry. The plugin registers only HTTP routes under `/__invite/`; it does not modify the agent loop, model requests, session logs, or frontend application.

Caddy proxies `/__invite/*` directly so an unauthenticated browser can load the login page and submit an invite code. Every other request first passes through `forward_auth`; after a successful check, Caddy proxies the original request to the same DSH upstream. Caddy's native reverse proxy handles WebSocket upgrades.

## Plugin configuration and secrets

Plugin configuration stores only environment-variable names and non-secret policy values, never the invite code or signing secret. Its default configuration refers to `DSH_INVITE_CODE` and `DSH_INVITE_SESSION_SECRET` and exposes these validated parameters: a 2,592,000-second session lifetime, a 900-second failure window, 10 failures per source address, and a 4,096-byte request-body limit.

The plugin reads secrets from the frozen `dsh-launch-environment` startup snapshot. This preserves DSH's unified startup-source semantics and prevents `--dump-config` from printing secrets. The invite code contains at least 12 characters, and the session secret contains at least 32 bytes. If either value is missing or too short, plugin activation fails and Loader releases the Web server that already started.

The server stores secrets in `/etc/mydsh/mydsh.env`, owned by the dedicated DSH user with mode `0600`. Deployment generates a random session secret on the server without printing it to the terminal, logs, or conversation. DSH's credential store manages Kimi credentials separately.

## HTTP and session behavior

The plugin provides these routes:

- `GET /__invite/login` returns a responsive Chinese login page; a browser with a valid cookie returns to the safe `next` path.
- `POST /__invite/login` validates the request origin, form size, rate-limit state, and invite code; success issues a cookie and sends a `303` redirect to the safe `next` path.
- `GET /__invite/check` serves Caddy `forward_auth`; a valid cookie returns `204`, an unauthorized page navigation returns a login redirect, and other requests return `401`.
- `POST /__invite/logout` clears the cookie and redirects to the login page.

`next` accepts only same-site absolute paths that start with one `/`; scheme-relative addresses, full URLs, backslashes, and unparseable values fall back to `/`. Login submission accepts only `application/x-www-form-urlencoded`, requires the forwarded protocol to be HTTPS, and requires `Origin` to match the public Host.

Caddy sets a dedicated client-address header on login and authorization requests. The plugin trusts that header only when the TCP peer is a loopback address; otherwise it uses the socket peer address, preventing a public client from forging its rate-limit identity.

Invite-code verification performs a constant-time comparison of equal-length digests. An incorrect code returns one generic error that does not reveal length, partial matches, or comparison progress. Failure counts reside in process memory and use a fixed window per source address; successful login clears the address's failure count, and a process restart clears all rate-limit state.

Successful login issues a stateless token containing a version, expiration time, and random nonce, with HMAC-SHA-256 covering the complete payload. The cookie is named `__Host-dsh_invite` and always carries `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without `Domain`. An expired token, malformed token, invalid signature, or unknown version is always unauthenticated.

Changing the shared invite code affects only later logins; rotating the session secret immediately revokes every issued cookie. Logout clears only the current browser's cookie.

The login page and all authentication responses send `Cache-Control: no-store`, a CSP that restricts script and resource sources, `X-Content-Type-Options: nosniff`, a policy that forbids framing, and a strict referrer policy. The plugin never logs the invite code, session token, Cookie header, or environment-variable values.

## Failure behavior

A malformed form returns `400`, an incorrect invite code returns `401`, failed origin validation returns `403`, an oversized body returns `413`, and rate limiting returns `429`. Unauthorized API, SSE, and WebSocket requests return `401` and never reach DSH. Page navigation uses `303` to reach the login page.

When DSH is unavailable, Caddy returns `502`, and systemd restores the service according to a bounded restart policy. An authorization-check failure denies access and never lets the request bypass Caddy to reach DSH.

## Server layout and processes

- Directories under `/opt/mydsh/releases/` named by the full Git commit hash hold complete, built, immutable releases.
- `/opt/mydsh/current` points to the active release.
- `/var/lib/mydsh` is the persistent `DSH_HOME`, independent of releases.
- `/srv/mydsh/workspace` is the systemd working directory and default DSH workspace.
- `/etc/mydsh/mydsh.env` stores secrets and path settings readable only by the startup process.

The server uses Node.js 24 and the pnpm version declared by the repository's `packageManager`. Each release runs `pnpm install --frozen-lockfile` and `pnpm run build`. `DSH_PUBLIC_HOST` in `/etc/mydsh/mydsh.env` stores the actual subdomain; systemd runs `/opt/mydsh/current/apps/cli/lib/bin.js web --no-open --trusted-host ${DSH_PUBLIC_HOST}` as a dedicated, non-login `mydsh` user from `/srv/mydsh/workspace`, so the source tree does not become the default workspace.

Caddy listens on ports 80 and 443, obtains and renews certificates automatically, and proxies to `127.0.0.1:3080`. `caddy validate` must pass before configuration reload.

## Release and rollback

The local repository retains the DeepSeek upstream remote and the invite-code extension commits. An upgrade fetches the latest `master` and merges the local commits into a new deployment branch. Because upstream is a developer preview, every upgrade is an explicit release that requires renewed verification.

Deployment places a candidate in a new release directory, runs dependency installation, build, configuration checks, and a local smoke test, then atomically switches the `current` symlink and restarts the systemd service. A failed external acceptance test switches back to the previous symlink and restarts. `DSH_HOME` does not roll back with code; any future upstream release that requires data migration receives a separate backward-compatibility assessment before deployment.

## Testing and acceptance

Plugin unit tests cover invite-code comparison, token issuance, lifetime, tampering, unknown versions, redirect-path sanitization, source-address selection, rate-limit windows, and request-body limits.

Plugin integration tests use a temporary loopback port from `dsh-host-webserver` and cover the login page, incorrect and correct invite codes, cookie attributes, the authorization endpoint, logout, origin rejection, size rejection, rate limiting, and security response headers. A Web profile composition test proves that the plugin mounts after `webserver` and that all required dependencies are publishable.

Implementation adds the package README, its Chinese counterpart, and an Agent Note as required by the repository. It runs the focused unit and integration tests, typecheck, build, configuration checks, doc-sync, and `git diff --check`. Because the login page is product-visible behavior, implementation also adds a real Web composition snapshot that requires no model credentials.

Server acceptance must prove that the Caddy configuration is valid, the systemd service is active, port 3080 listens only on loopback, the public certificate is valid, unauthenticated requests cannot reach the home page, API, SSE, or WebSocket, a correct invite code loads DSH, logout invalidates access immediately, reopening the browser within 30 days reuses the cookie, a tampered cookie is rejected, and release rollback preserves `DSH_HOME` data.

The administrator finally configures Kimi as a custom OpenAI-compatible provider in the Web UI and verifies the model connection with one real conversation. This verification never writes the API key to tests, deployment logs, or the repository.

## Deployment inputs

Implementation can complete the local plugin, tests, documentation, and deployment templates without production secrets. Before production deployment begins, the administrator supplies the public subdomain, ECS public address, SSH user, and authentication method, and ensures that the subdomain's DNS A/AAAA record points to the ECS instance. The administrator separately chooses the shared invite code; deployment generates the session secret.
