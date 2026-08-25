# DSH Invite-Code Authentication and Alibaba Cloud Deployment Design

English | [中文](2026-08-24-dsh-invite-auth-deployment-design.zh.md)

## Status and scope

This design defines a DeepSeek Harness Web deployment for a small group of trusted users: the application runs on an Alibaba Cloud Hong Kong or overseas Ubuntu 22.04/24.04 ECS instance, serves HTTPS on a dedicated subdomain, and requires each visitor to enter one shared invite code. A browser remains authenticated for 30 days after successful verification.

Each deployment uses an explicit reviewed branch or signed tag recorded as `DEPLOY_REF`; unattended upstream updates are excluded. Model configuration does not enter source control or deployment automation; an administrator adds Kimi as a custom OpenAI-compatible provider in the Web UI.

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

`packages/host/invite-auth` owns the authentication behavior and injects the `webServer` service. The shipped Web bundle remains unchanged; the Alibaba Cloud deployment passes an explicit patch overlay that inserts the plugin after the existing `webserver` entry. The plugin registers only HTTP routes under `/__invite/`; it does not modify the agent loop, model requests, session logs, or frontend application.

Caddy proxies `/__invite/*` directly so an unauthenticated browser can load the login page and submit an invite code. Every other request first passes through `forward_auth`; after a successful check, Caddy proxies the original request to the same DSH upstream. Caddy's native reverse proxy handles WebSocket upgrades.

## Plugin configuration and secrets

Plugin configuration stores only environment-variable names and non-secret policy values, never the invite code or signing secret. Its default configuration refers to `DSH_INVITE_CODE_SECRET` and `DSH_INVITE_SESSION_SECRET`; both names include `SECRET` so DSH's subprocess environment scrubber removes them. The plugin exposes these validated parameters: a 2,592,000-second session lifetime, a 900-second failure window, 10 failures per source address, at most 10,000 tracked source addresses, and a 4,096-byte request-body limit.

The plugin reads secrets only from the inherited-process layer of the frozen `dsh-launch-environment` startup snapshot; project and Harness-home `.env` files cannot set authentication secrets. This preserves DSH's unified startup-source semantics and prevents `--dump-config` from printing secrets. The invite code contains at least 12 characters, and the session secret contains at least 32 bytes. If either value is missing or too short, plugin activation fails and Loader releases the Web server that already started.

The server stores secrets in root-owned `/etc/mydsh/mydsh.env` with mode `0600`. The system service manager reads the file before starting the process as the dedicated DSH user. Deployment generates the initial invite code and session secret on the server without printing either value to the terminal, logs, or conversation. DSH's credential store manages Kimi credentials separately.

## HTTP and session behavior

The plugin provides these routes:

- `GET /__invite/login` returns a responsive Chinese login page; a browser with a valid cookie returns to the safe `next` path.
- `POST /__invite/login` validates the request origin, form size, rate-limit state, and invite code; success issues a cookie and sends a `303` redirect to the safe `next` path.
- `GET /__invite/check` serves Caddy `forward_auth`; a valid cookie returns `204`, an unauthorized page navigation returns a login redirect, and other requests return `401`.
- `POST /__invite/logout` clears the cookie and redirects to the login page.

`next` accepts only same-site absolute paths that start with one `/`; scheme-relative addresses, full URLs, backslashes, and unparseable values fall back to `/`. Login submission accepts only `application/x-www-form-urlencoded`, requires the forwarded protocol to be HTTPS, and requires `Origin` to match the public Host.

Caddy sets a dedicated client-address header on login and authorization requests. The plugin trusts that header only when the TCP peer is a loopback address; otherwise it uses the socket peer address, preventing a public client from forging its rate-limit identity.

Invite-code verification performs a constant-time comparison of equal-length digests. An incorrect code returns one generic error that does not reveal length, partial matches, or comparison progress. Failure counts reside in process memory and use a fixed window per source address; successful login clears the address's failure count, and a process restart clears all rate-limit state. The limiter prunes expired entries and evicts the oldest entry before exceeding its configured capacity, which bounds memory under distributed attempts.

Successful login issues a stateless token containing a version, expiration time, and random nonce, with HMAC-SHA-256 covering the complete payload. The cookie is named `__Host-dsh_invite` and always carries `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without `Domain`. An expired token, malformed token, invalid signature, or unknown version is always unauthenticated.

Changing the shared invite code affects only later logins; rotating the session secret immediately revokes every issued cookie. Logout clears only the current browser's cookie.

The login page and all authentication responses send `Cache-Control: no-store`, a CSP that restricts script and resource sources, `X-Content-Type-Options: nosniff`, a policy that forbids framing, and a strict referrer policy. The plugin never logs the invite code, session token, Cookie header, or environment-variable values.

## Failure behavior

A malformed form returns `400`, an incorrect invite code returns `401`, failed origin validation returns `403`, an oversized body returns `413`, an unsupported media type returns `415`, and rate limiting returns `429`. Unauthorized API, SSE, and WebSocket requests return `401` and never reach DSH. Page navigation uses `303` to reach the login page.

When DSH is unavailable, Caddy returns `502`, and systemd restores the service according to a bounded restart policy. An authorization-check failure denies access and never lets the request bypass Caddy to reach DSH.

## Server layout and processes

- Directories under `/opt/mydsh/releases/` named by the full Git commit hash hold complete, built, immutable releases.
- `/opt/mydsh/current` points to the active release.
- `/var/lib/mydsh` is the persistent `DSH_HOME`, independent of releases.
- `/srv/mydsh/workspace` is the systemd working directory and default DSH workspace.
- `/usr/local/sbin/mydsh-deploy-release` is the root-owned deployment, rollback, and pruning control helper; release content never supplies root control flow.
- `/var/lib/mydsh-build` and `/var/cache/mydsh-build/pnpm` belong to the separate non-login builder identity and cannot expose runtime state or workspace data.
- `/run/lock/mydsh-deploy.lock` serializes bootstrap, deployment, rollback, and pruning.
- `/etc/mydsh/public.env` stores the non-secret `DSH_PUBLIC_HOST` for both systemd services.
- `/etc/mydsh/mydsh.env` stores root-only secrets and the persistent `DSH_HOME` path.

The server uses Node.js 24 and the pnpm version declared by the repository's `packageManager`. `mydsh-build` runs clone, frozen dependency installation, lifecycle scripts, tests, build, and config dump under `env -i` with its own HOME, cache, and scratch `DSH_HOME`; it cannot read `/var/lib/mydsh`, `/srv/mydsh/workspace`, or the root-only environment files. The helper compares privileged deployment inputs with a root-only copy of the trusted bundle before root makes the completed release immutable. systemd reads `/etc/mydsh/public.env` and the private environment file, then runs `/opt/mydsh/current/apps/cli/lib/bin.js web --patch /opt/mydsh/current/deploy/alibaba-cloud/invite-auth.cordis.yml --no-open --trusted-host ${DSH_PUBLIC_HOST}` as the separate non-login `mydsh` runtime user from `/srv/mydsh/workspace`. Caddy reads only the public environment file.

Caddy listens on ports 80 and 443, obtains and renews certificates automatically, and proxies to `127.0.0.1:3080`. `caddy validate` must pass before configuration reload.

## Release and rollback

The local repository retains the DeepSeek upstream remote and the invite-code extension commits. An upgrade fetches the latest `master` and merges the local commits into a new deployment branch. Because upstream is a developer preview, every upgrade is an explicit release that requires renewed verification.

The root-installed helper validates candidate Caddy and systemd files before activation, backs up the current managed host files, atomically installs the candidate unit, Caddyfile, and Caddy drop-in, reloads systemd, switches `current`, and restarts DSH. It then verifies the active PID belongs to `mydsh`, the link names the candidate, loopback login is ready, public unauthenticated HTML and API responses fail closed, and a real invite-code login reaches the guarded application. Any failure restores the previous link and all three host files, reloads systemd, restarts the previous service, and reloads the previous Caddy configuration; first-deployment failure removes the candidate link, stops DSH, and restores bootstrap configuration. `DSH_HOME` does not roll back with code, so any future data migration requires a separate backward-compatibility assessment.

## Testing and acceptance

Plugin unit tests cover invite-code comparison, token issuance, lifetime, tampering, unknown versions, redirect-path sanitization, source-address selection, rate-limit windows, and request-body limits.

Plugin integration tests use a temporary loopback port from `dsh-host-webserver` and cover the login page, incorrect and correct invite codes, cookie attributes, the authorization endpoint, logout, origin rejection, size rejection, rate limiting, and security response headers. A Web profile composition test applies the deployment overlay, proves that the plugin mounts after `webserver`, and proves that the shipped Web bundle remains usable without authentication secrets.

Implementation adds the package README, its Chinese counterpart, and an Agent Note as required by the repository. It runs the focused unit and integration tests, typecheck, build, configuration checks, doc-sync, and `git diff --check`. Because the login page is product-visible behavior, implementation also adds a real Web composition snapshot that requires no model credentials.

Server acceptance must prove that the candidate and installed Caddy configurations are valid, the candidate systemd unit and drop-in verify, the active MainPID belongs to `mydsh`, `current` names the candidate, and port 3080 listens only on loopback. Bounded public HTTPS checks require unauthenticated HTML to redirect and API traffic to return `401`; the root helper also performs an authenticated login without printing the invite code, cookie, or response headers. Manual acceptance additionally proves the public certificate, SSE and WebSocket denial, logout, 30-day browser reuse, tamper rejection, serialized rollback, and preserved `DSH_HOME` data.

The administrator finally configures Kimi as a custom OpenAI-compatible provider in the Web UI and verifies the model connection with one real conversation. This verification never writes the API key to tests, deployment logs, or the repository.

## Deployment inputs

Implementation can complete the local plugin, tests, documentation, and deployment templates without production secrets. Before production deployment begins, the administrator supplies the public subdomain, ECS public address, SSH user, and authentication method, and ensures that the subdomain's DNS A/AAAA record points to the ECS instance. Deployment generates the initial shared invite code and session secret; the administrator retrieves or rotates the invite code directly over SSH without sending it through the implementation conversation.
