# Family Home Theme Implementation Plan

> **For agentic workers:** Use `executing-plans` inline. The user selected the current branch, without a worktree or subagents. Steps use checkboxes for tracking.

English | [中文](2026-09-22-family-home-theme.zh.md)

**Goal:** Implement the [approved skin](../specs/2026-09-22-family-home-theme-design.md) with real DSH controls and an authenticated server-shared cover.

**Architecture:** A Host cover service owns bounded image processing, revision-checked persistence, and authenticated transport. A Client skin contributes through slots and the theme registry. Generic title/hero and invite-page appearance extensions remain owned by their existing packages.

**Tech Stack:** TypeScript, Cordis, Typert Remote, React, CSS Modules, Sharp, node:fs, Vitest, Playwright.

---

## Task 1: Shared cover storage

Files: new `packages/host/family-cover/` package, with `src/types.ts`, `src/store.ts`, `src/image.ts`, `src/errors.ts`, and `tests/store.spec.ts`. Register its source alias and Host project reference.

- [x] Add tests for empty storage, upload/read/reopen, removal, stale revisions, corrupt metadata, MIME spoofing, byte/pixel limits, aborts, and bounded concurrent uploads. Observe RED before implementation.
- [x] Implement the store with immutable normalized WebP files and a versioned metadata pointer. Coordinate writers with `withFileLock`; re-read and compare the revision under the lock. Flush files before publication, keep prior state on pre-commit failure, and delete only unreferenced plugin-owned blobs.
- [x] Run `pnpm exec vitest run packages/host/family-cover/tests/store.spec.ts`; require green and no unhandled work before moving on.

The browser-safe result contains no server paths or original filenames:

```ts ignore-check
type CoverRevision = Branded<'FamilyCoverRevision'>
interface CoverSnapshot {
  readonly revision: CoverRevision
  readonly cover: null | { readonly width: number; readonly height: number; readonly bytes: number; readonly mediaType: 'image/webp' }
}
```

## Task 2: Authenticated cover transport

Files: `packages/host/family-cover/src/index.ts`, `src/http.ts`, `tests/http.spec.ts`, `tests/service.spec.ts`, the package's `./remote` and `./typert` exports, and `packages/api/remotes/` registration and references.

- [x] Use a real Loader and Connection fixture to fail on unauthorized reads, cross-origin mutations, oversized streams, stale writes, and provider disposal.
- [x] Expose `familyCover.current(signal)` and `familyCover.removeCover(expectedRevision, signal)` through generated Remote. Register exact authenticated raw POST `/api/family-cover/upload` and GET `/api/family-cover/image` routes for binary bodies. Mutation HTTP requests require a matching Origin and revision; responses use `Cache-Control: private, no-store`.
- [x] Reject admission above configured concurrency immediately. Disposal aborts owned requests and awaits all started processing; no upload can publish after disposal.
- [x] Generate strict Remote artifacts through the normal build; run the store and transport tests together.

## Task 3: Owner-managed presentation extensions

Files: `packages/client/ui-layout/src/client/{index.ts,AppFrame.tsx}`, `packages/client/ui-conversation/src/client/{contract/slots.ts,apply.ts,skeleton/ConversationContent.tsx}`, and `packages/host/invite-auth/src/{index.ts,page.ts,http.ts}` with their owning tests.

- [x] Add failing fallback/replacement/disposal tests for `shell.document.title` and `conversation.hero.content`; retain existing title navigation and composer behavior.
- [x] Declare the slots in their owning parents. The root title fallback remains DocumentTitle; the hero fallback remains HeroShell. Family rendering never owns or remounts the composer.
- [x] Add one effect-owned invite-page presentation registration with a stock fallback. Escape all values, allow only nonce-authorized fixed script, preserve existing authentication headers and every POST/check/logout behavior.
- [x] Run the existing layout/hero/invite suites plus the new regression cases.

## Task 4: Family preferences and skin activation

Files: new `packages/client/ui-family-theme/`, including shared `src/preferences.ts`, Host `src/index.ts`, and Client `src/client/{index.ts,appearance.ts,cover-client.ts,locales.ts}` with client tests.

- [x] Test validated defaults, browser persistence failures, saved preferences, conflict refusal, stock restoration, and cover refresh/cancellation before implementing controllers.
- [x] Register three palette definitions through `ctx.theme`; release only owned theme overrides. Keep shared observable snapshots stable and expose them through framework-bound injected hooks. UI components receive plain values/callbacks, not Context or service objects.
- [x] Read cover metadata on activation/focus/reconnect and after mutation, then fetch bytes for that revision. Clear old object URLs on replacement, authentication loss, disablement, and disposal; ignore superseded completions.
- [x] Keep only name/greeting/palette/enablement in browser preferences; photo bytes remain server-owned and never enter the prompt or attachment APIs.

## Task 5: Real UI and themed login

Files: `packages/client/ui-family-theme/src/client/` components, CSS Modules, `src/assets/`, and Host login presentation modules. Reuse the approved project-owned house/interior art and shared Button, Input, Switch, and Modal primitives.

- [x] Add component tests for names, greeting, starter-card draft filling, upload errors, removal confirmation, personal disablement, and keyboard focus.
- [x] Implement sidebar mark/name, document title, hero/photo, warm token mapping, settings, and local preference bootstrap on the invite form. Do not request photo data on the unauthenticated page.
- [x] Keep real session lists, workspace picking, message sending/stopping, tools, attachments, and model selection. Do not ship mock conversation data or fake responses.
- [x] Verify all palettes at desktop/mobile widths, reduced motion, regular-text contrast, and stock behavior after disablement.

## Task 6: Opt-in bundle, docs, and assembled regression

Files: new `packages/bundle/family-theme/`, `apps/cli/config/examples/family-theme/cordis.yml`, `apps/web/tests/family-theme.e2e.ts`, an owning `snapshots/web/family-theme/` scenario, package README pairs, relevant subsystem docs/catalogs, and one active Agent Note for shared-cover authority and lifecycle decisions.

- [x] Wire the bundle through explicit manifests and compiler faces, without mounting it in stock profiles. Expose all deployment defaults in validated Config fields.
- [x] Build and boot the real Web profile with the optional overlay and in-page directory picker. Use two authenticated browser contexts to prove cover sharing; prove anonymous refusal, conflict behavior, restart persistence, and normal recorded-session replay.
- [x] Run focused tests, typecheck, relevant package/client checks, build and built smoke, keyless browser snapshot, doc-sync, and lint. Record platform-specific baseline failures without weakening checks.
- [x] Review the final diff and commit only intended files. Hand off local implementation and evidence; do not deploy or overwrite the existing server theme without a deployment request.

## Verification record

Implemented on the current feature branch without worktrees or subagents. Production was not changed.

- `pnpm run build`: passed; the latest Host provider was also rebuilt after its awaited initialization change.
- Focused storage, UI, invite-auth, layout, theme, and conversation suites: 20 files, 250 tests passed.
- Real browser sharing/restart, themed login, and recorded conversation replay: 3 files, 3 tests passed.
- `pnpm run lint:contracts-ready`, `pnpm run test:docs`, constraints, package invariants, type equivalence, and generated documentation freshness checks passed for the exercised scope.
- Text, muted-text, and button-label palette contrast checks exceeded 4.5:1 for all three palettes.
- Full doc-sync and hygiene retain Windows-only limitations: a documentation symlink fixture and the NodeNext consumer link setup receive `EPERM`; the checked-out ACP profile link is a regular file containing its target path. These checks were not weakened or reported as passing.

Local installation and removal were verified using a linked package in a private temporary profile. That profile and its link were removed without touching repository or application data.
