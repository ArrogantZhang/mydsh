---
description: "Family appearance, local preferences, shared-photo controls, and safe invite-page branding."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-family-theme

English | [中文](README.zh.md)

## Summary

Give the Web interface a family name, welcome message, and three warm palettes. Each browser keeps its own appearance preferences. Authorized visitors share one server-stored cover through the separate cover service. The ordinary Composer, workspaces, model selection, and permission controls remain available.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The [family bundle](../../bundle/family-theme/README.md) mounts the UI and its shared-cover service together. Open Settings → General → Make it home to change personal appearance or manage the shared cover.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Initial browser choice. |
| `name` | `家人小屋` | Plain-text name, 1–16 Unicode characters. |
| `greeting` | `回来啦，先歇一会儿。` | Plain-text welcome, 1–32 Unicode characters. |
| `palette` | `morning` | `morning`, `garden`, or `evening`. |

Saved browser choices take precedence over defaults. Storage refusal keeps choices in memory and displays a warning. Disabling the skin restores stock presentation without removing the shared photo. Photo replacement and removal affect every authorized visitor; removal asks for confirmation.

The skin refuses activation when another plugin occupies its brand, title, or hero seats, or selects a foreign custom theme. Disable that conflicting presentation explicitly. The family bundle disables only the stock official-brand row; it does not remove an independently installed theme.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Presentation ownership</summary>

The Client contributes to owner-declared slots and uses a reversible `theme.present()` selection without writing Host theme preferences. The [cover controller](src/client/cover-client.ts) refreshes on activation, focus, reconnect, and mutation, and releases object URLs on replacement or withdrawal. The Host half registers only presentation with the existing invite-page owner; its nonce-authorized bootstrap reads local appearance and never requests a photo. Failed metadata reads clear already-loaded private photos, and edits require an observed revision.

**Runtime invariant:** No companion is published. The UI reads its controllers' snapshots directly; no independent model or Session projection exists.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the skin registers presentation only and never sends cover bytes to the model.

#### KV Cache effect

None; starter cards only fill the ordinary draft and require the user to send it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits keep personal appearance separate from shared content.

- Shared photos do not push live updates continuously; refresh or refocus the page to adopt another visitor's change.
- Appearance belongs to a browser origin, not an account or a physical-machine identity.
- Existing arbitrary global CSS cannot be detected reliably; the slot and theme checks cover registered presentation owners.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context</summary>

None.

</details>
