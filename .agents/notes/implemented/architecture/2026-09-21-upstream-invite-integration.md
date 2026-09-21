# Agent Note: Invite deployment over the upstream Remote transport

Status: implemented

English | [中文](2026-09-21-upstream-invite-integration.zh.md)

## Problem

The upstream Web application authenticates browser sessions and carries typed logical streams on one Remote mux. The invite deployment must preserve its shared-code entry without retaining the removed ApiProxy protocol or bypassing upstream authentication.

## Decision

Use the upstream framework from product version `0.1.6-alpha.2`. Invite login remains an additional deployment authorization layer. After validating the invite, the opt-in bridge obtains an upstream browser cookie through Connection's existing launch-token exchange inside the process. The token is not redirected to the browser or printed. Caddy checks the invite cookie before forwarding application traffic; Connection separately verifies its own cookie. Existing valid invite sessions can renew the upstream cookie through the login route.

The deployment uses `/api/remote.mux`, upstream heartbeats, and domain-owned replay. The retired two-stream batching implementation and its benchmark are not carried into a different wire protocol. Their measurements remain in the [historical backpressure note](../../archived/bug-fix/2026-08-27-web-realtime-backpressure.md) and do not measure the current carrier. Immediate composer feedback remains local pending state, not a durable acknowledgement.

The loopback deployment's Connection row reads explicit trusted hosts from `webStartup`, allowing Connection to activate before invite authentication and the readiness-dependent Web runtime. The frontend remains unavailable until the invite route is registered. The application port must remain loopback-only. Launch URL printing is disabled to avoid writing the upstream token to the service journal.

## Alternatives considered

**Retain the old carrier beside Remote mux.** It would leave disconnected implementations of session delivery and incompatible replay semantics. The upstream carrier and domain consumers must evolve together.

**Disable upstream browser authentication.** Invite verification at the proxy would become the only defense and would require a fork of Connection's authentication policy. Exchanging a cookie after invite verification preserves both checks.

**Treat old compression measurements as current evidence.** The payloads and physical transport differ. Current validation must exercise the upstream Gateway and the assembled invite composition.

## Consequences

The old 64-frame batching, compression ratio, queue capacity, and byte-fuse guarantees are not promises of the current carrier. Future transport tuning belongs to the upstream Gateway and needs its own measurements. Invite authentication still provides shared instance authority rather than individual identity or workspace isolation.

Updating the repository does not migrate the production Harness home. Before deployment, back up credentials, settings, profiles, and session generations and validate the upstream adjacent Session migration chain on a copy. Published successor generations must not be overwritten to support a downgrade.

Validation covers invalid invite refusal, internal browser-cookie exchange, both authentication layers, Remote mux upgrade, and immediate composer feedback. Deployment helper and frozen configuration updates remain a separate server maintenance operation.
