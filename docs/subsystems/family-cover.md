# Family cover

English | [中文](family-cover.zh.md)

The [family cover service](../../packages/host/family-cover/README.md) keeps one private image for a trusted group. This page defines browser-visible metadata; the package reference owns configuration, storage limits, and backups.

## Metadata

A revision is an opaque comparison token, not a file path. Removal also creates a new revision, so an old request cannot overwrite a later change.

```ts type-equiv
/** Opaque compare-and-swap token for a committed cover record. */
type CoverRevision = Branded<'FamilyCoverRevision'>
```

```ts type-equiv
/** Shared image metadata, excluding its storage path and original filename. */
interface CoverImage {
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly mediaType: 'image/webp'
}
```

```ts type-equiv
/** The shared cover, or a revisioned empty state after removal. */
interface CoverSnapshot {
  readonly revision: CoverRevision
  readonly cover: CoverImage | null
}
```

## Transport

`familyCover.current` and `familyCover.removeCover` use generated Remote. POST `/api/family-cover/upload` receives raw image bytes and requires a matching Origin and `If-Match` revision. GET `/api/family-cover/image?revision=…` returns only the current revision's normalized WebP. Every path uses Connection authentication; binary responses use `Cache-Control: private, no-store`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfamilycover--familycover"></a>

### `ctx.familyCover` — `FamilyCover`

Authenticated Host capability with one plugin-owned storage lifetime.

```ts cordis-catalog
/**
 * Read current cover metadata without exposing private storage paths.
 * @param signal - Remote caller cancellation.
 * @returns the current shared revision and normalized image dimensions.
 */
@Remote current(signal: AbortSignal): Promise<CoverSnapshot>

/**
 * Remove the shared cover for all authorized visitors.
 * @param revision - last observed revision; stale removals fail.
 * @param signal - Remote caller cancellation before commit.
 * @returns a new empty revision.
 */
@Remote('removeCover') remove(revision: CoverRevision, signal: AbortSignal): Promise<CoverSnapshot>
```

Source: [`packages/host/family-cover/src/index.ts`](../../packages/host/family-cover/src/index.ts)
<!-- END GENERATED cordis-surface -->
