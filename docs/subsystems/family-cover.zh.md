# 家庭封面

[English](family-cover.md) | 中文

[家庭封面服务](../../packages/host/family-cover/README.zh.md)为一个可信群体保存一张私密图片。本页定义浏览器可见的元数据；配置、存储限制和备份说明由包参考文档拥有。

## 元数据

版本是不可解释的比较令牌，不是文件路径。移除封面也会生成新版本，因此旧请求无法覆盖后续修改。

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

## 传输

`familyCover.current` 和 `familyCover.removeCover` 使用生成的 Remote。POST `/api/family-cover/upload` 接收原始图片字节，并要求匹配的 Origin 和 `If-Match` 版本。GET `/api/family-cover/image?revision=…` 只返回当前版本的标准化 WebP。所有路径均经过 Connection 鉴权；二进制响应使用 `Cache-Control: private, no-store`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
