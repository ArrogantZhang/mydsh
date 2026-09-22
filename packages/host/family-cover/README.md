---
description: "Authenticated shared-cover storage with bounded image processing, revision checks, and private reads."
kind: "package-reference"
---

# @deepseek-ai/dsh-family-cover

English | [中文](README.zh.md)

## Summary

Share one family cover among authorized visitors to a Web instance. Uploads become static WebP images with capture metadata removed. Replacements and removals require the last observed revision. Cover bytes remain outside Session logs and model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use the [family bundle](../../bundle/family-theme/README.md) for the complete UI, or mount this service beside Connection with an absolute private `root`. Never serve that directory as public static files.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Absolute plugin-owned data directory outside release trees. |
| `maxInputBytes` | `10485760` | Maximum streamed upload bytes. |
| `maxInputPixels` | `24000000` | Maximum decoded image pixels. |
| `maxOutputDimension` | `1600` | Maximum normalized long edge; smaller images are not enlarged. |
| `maxOutputBytes` | `10485760` | Maximum stored or read image bytes. |
| `maxConcurrentUploads` | `2` | Admitted mutations per service lifetime. |
| `timeoutSeconds` | `15` | Native image-processing deadline. |
| `lockWaitMs` | `5000` | Maximum wait for the cross-process writer lock. |

Connection authenticates metadata, removal, upload, and image requests. Raw uploads additionally require a matching Origin and revision. Configure the existing invite proxy and browser-cookie bridge when access must require an invite; Connection authentication alone is not an invite check.

Back up the whole `root`, including `cover.json` and its referenced WebP. A revision conflict requires refreshing before retry. A failed response can follow publication, so clients refresh after every mutation outcome. Lowering `maxOutputBytes` below the stored cover size rejects that record instead of allocating an unbounded read.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Persistence and authorization</summary>

The [store](src/store.ts) compares revisions under a file lock, publishes normalized content and a versioned metadata pointer, and cleans only unreferenced owned blobs. Reads verify the content digest. Disposal cancels intake and joins started work. The [HTTP adapter](src/http.ts) returns private, non-cacheable responses without original filenames or storage paths.

**Runtime invariant:** No companion is published. Reads validate the authoritative record and digest directly; there is no independent Session event projection to compare.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the service stores presentation-only images without constructing model input.

#### KV Cache effect

None; cover operations do not change provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The shared cover has these access and persistence limits.

- All authorized visitors can replace or remove the single cover; there are no individual owners or roles.
- Only static JPEG, PNG, and WebP are accepted; animation, SVG, and original-file retention are unsupported.
- POSIX publication flushes the parent directory; Windows flushes file bytes but cannot use Node directory fsync.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context</summary>

None.

</details>
