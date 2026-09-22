# Agent Note: Private shared family covers and local appearance

Status: implemented

English | [中文](2026-09-22-family-cover-and-personal-appearance.zh.md)

## Problem

A shared family cover must survive browser changes and release replacement without becoming a public asset or model attachment. Personal branding must not change other visitors' preferences or replace the live Composer. Multiple authorized visitors can edit the same cover.

## Decision

A Host-owned directory stores one normalized cover and a versioned metadata pointer. Connection authenticates all reads and mutations; the existing [invite authority](2026-08-24-invite-code-web-authentication.md) remains unchanged. A writer lock and revision comparison reject stale edits. Publication preserves the previous pointer until replacement is ready; readers verify the referenced digest. Clients refresh after a mutation even when its response fails because publication may already have committed.

Browser-local appearance selects owner-declared brand, title, and hero slots. `theme.present()` overlays a registered palette without writing the Host preference; disposing it reveals the latest underlying choice. The [styling constraints](../process/2026-07-19-web-styling-system.md) continue to govern components. The invite-page owner keeps its real form and authentication policy, escapes text, and authorizes only the trusted fixed bootstrap with a per-response nonce.

## Alternatives considered

**Store photos in localStorage.** This cannot share a cover between independent browsers or preserve a server-owned backup. Local storage therefore holds appearance only.

**Expose a public image URL.** This would disclose the family photo without invite authorization. Every image read stays on Connection's authenticated carrier instead.

**Replace shell DOM or shared theme settings.** DOM mutation bypasses component ownership, while shared preferences change other visitors' views. Owner-managed slots and temporary palette selection preserve lifecycle and personal scope.

## Consequences

All admitted visitors have equal cover-edit authority; this is not a multi-tenant permission model. Reads refresh on activation, focus, reconnect, and mutation rather than a continuous push stream. Resource budgets are validated configuration, and disposal joins already-started work. The source tests cover revision conflicts and cancellation, real Web tests cover cross-browser sharing and restart, and a borrowed recorded Session verifies the unchanged Composer path.
