---
description: "Family Home skin requirements, server-shared cover photos, local appearance preferences, branding, and verification scope."
---

# Family Home theme plugin design

English | [中文](2026-09-22-family-home-theme-design.zh.md)

## Summary

This design specifies a warm family-themed DSH skin with configurable names, welcome text, three palettes, and one server-shared family cover photo. The visual direction is approved; production implementation is pending. The skin retains existing model behavior, authentication, and shared-member permissions. Browser-local appearance preferences are separate from the shared cover and sessions in the invite-protected deployment.

## Table of Contents

- [Scope and appearance](#appearance)
- [Customization and photos](#customization)
- [Plugin integration](#integration)
- [Verification and delivery](#verification)
- [Dev Note](#dev-note)

-----

<a id="appearance"></a>
## Scope and appearance

The default identity is “家人小屋” with the welcome line “回来啦，先歇一会儿。” A paper photo frame and a small house-and-heart mark identify the skin. Existing conversations and workspaces retain their real names and controls; the mockup's sample conversations are not seeded into production.

| Area | Required presentation |
|---|---|
| Sidebar | House mark, configurable family name, warm navigation and new-conversation button |
| Browser tab | Family name; selected conversations retain the `conversation title — family name` format |
| Empty conversation | Configurable greeting, family photo frame, and optional family-oriented starter prompts |
| Composer and messages | Warm buttons, readable message backgrounds, and all existing send/stop/upload/model controls |
| Invite page | Family name, house mark, “欢迎回家。”, and the existing invite form styled with “进来坐坐” |
| Settings | A “小屋外观设置” entry, palette choice, name/greeting fields, photo replacement/removal, and enable/disable control |

The three approved palettes remain selectable. Morning Cream is the initial default; a saved browser choice takes precedence. Paper tones, readable text, rounded controls, and restrained motion apply throughout. Error, warning, approval, and disabled states must remain distinguishable.

| Palette | Canvas | Accent | Main text | Supporting text | Button text |
|---|---|---|---|---|---|
| Morning Cream | `#FFF9F1` | `#AC492B` | `#4E382C` | `#705F53` | `#FFFDF8` |
| Garden Afternoon | `#F7F8EF` | `#46654C` | `#344738` | `#5C6859` | `#FFFDF8` |
| Evening Lamplight | `#29231F` | `#F0AE7C` | `#F8E8D3` | `#D0BFA9` | `#392A20` |

System KaiTi/serif fallbacks give headings a handwritten character; system Chinese sans-serif fonts serve controls and conversation text. The plugin makes no third-party font or background-media requests; the shared cover is fetched from the authenticated same-origin server. Body text follows DSH's text-size setting. Regular text targets at least 4.5:1 contrast; decoration cannot obstruct controls or obscure content.

The approved mockups show [Morning Cream](assets/family-home-theme/morning.png), [Garden Afternoon](assets/family-home-theme/garden.png), [Evening Lamplight](assets/family-home-theme/evening.png), [mobile layout](assets/family-home-theme/mobile.png), and the [invite page](assets/family-home-theme/login.png). They are design evidence, not screenshots of an implemented plugin.

-----

<a id="customization"></a>
## Customization and photos

Names, greeting, palette, and enablement belong to the current browser profile and site origin. They survive ordinary reloads and browser restarts but are not synchronized to other devices. The single family cover is stored on the server and shared with all authenticated invite holders; clearing one browser's data does not remove it. The plugin never sends the cover to Kimi, includes it in model prompts, or stores it in session events.

- Names default to “家人小屋” and accept up to 16 Unicode characters; greetings accept up to 32. Empty fields show their defaults. Render user text as text, never HTML.
- The file picker and drop target accept one JPG, PNG, or WebP. Proposed deployment-configurable defaults are 10 MiB input, 24 million decoded pixels, and a 1600-pixel output long edge.
- The server validates declared type, actual decodability, streamed byte size, and dimensions; browser checks provide early feedback only. Resize and re-encode to WebP without keeping the original upload or metadata. Bound concurrent processing through validated configuration.
- Store immutable normalized image bytes and a versioned current-cover record in a plugin-owned directory below the Harness home, outside release directories and included in data backups. Keep bounded personal appearance preferences in the browser. Do not reuse session attachments as a shared-cover store.
- Publish the cover record atomically only after validation and durable storage succeed. Invalid files, interrupted uploads, insufficient server space, and processing failures keep the previous cover. Mutations require the observed cover revision; concurrent stale replacement/removal returns a conflict and asks the member to refresh rather than overwriting a newer choice.
- Every authenticated invite holder may replace or remove the cover under the existing shared authority. A confirmed removal switches everyone back to the illustration and removes only plugin-owned image data. Disabling the skin, removing its package, or clearing personal preferences does not delete the shared cover. Cleanup must not affect DSH attachments or other files.

The uploader sees the committed cover immediately. Other members fetch the latest revision on page load, refresh, window focus, and reconnect; continuous live push is outside this first version. Private authenticated read/upload/remove routes enforce authorization and same-origin mutation checks. Do not place cover files under a public static directory or the public invite-route prefix. Use private non-storable HTTP responses and clear the rendered cover when authentication is lost. Original filenames never select server paths.

Changing the family name updates the sidebar, browser title, and login title. The invite page can apply the same bounded browser-local text and palette before login, but never requests or displays the shared cover. A fresh browser sees the configured default name and palette and, after login, the family's current photo. “Shared” means the invited group, not public Internet access, and does not add per-person isolation.

Starter cards fill the real composer only when clicked; they never submit automatically. Their placement and copy are presentation. Once the user sends the draft, ordinary DSH logging and model delivery apply. No simulated response, fake conversation, or decorative data enters the production app.

-----

<a id="integration"></a>
## Plugin integration

The implementation targets the project's current Web composition and is distributed as an opt-in Cordis composition bundle. Disabling it removes its presentation effects and restores the stock UI while retaining its saved preferences and shared cover for re-enablement. Clearing personal customization and removing the shared cover are distinct actions; shared removal requires a confirmation explaining that it affects everyone. Installation and production activation are separate actions.

<details>
<summary>Implementation constraints</summary>

Use [theme registration](../../../packages/client/ui-theme/README.md), the existing sidebar brand slots, the conversation component slots, and the settings extension. The [sidebar slot declarations](../../../packages/client/ui-sidebar/src/client/contract/slots.ts) already expose mark and name replacements. The [document-title owner](../../../packages/client/ui-layout/src/client/DocumentTitle.tsx) currently uses a build/localized product title; it needs a small typed branding extension to preserve its single ownership of `document.title`. Homepage text/photo layout and invite-page presentation likewise need explicit owner-managed extension points where existing slots do not suffice.

Do not implement branding by polling or rewriting rendered DOM text, matching hashed CSS names, replacing complete host packages, or changing the agent loop. Keep palette and browser-local customization in the family plugin; keep defaults and extension ownership in the existing UI packages. Public registrations return disposers and are installed through Cordis effects. Plugin removal and partial initialization must restore the stock presentation without stale handlers or competing title writers.

The [invite-auth plugin](../../../packages/host/invite-auth/README.md) continues to own verification, cookies, origin checks, throttling, redirects, and failure statuses. Its appearance extension may supply trusted presentation data and a fixed local-preference bootstrap; it must not replace authentication handlers. If a script is needed before login, use a per-response nonce and escaped data, not `unsafe-inline`, `unsafe-eval`, remote scripts, or user-supplied CSS/JavaScript. Unloading the appearance provider restores the default login form without withdrawing its authentication routes.

The family plugin owns the Host cover store and authenticated upload/read/remove methods. Reuse maintained image processing and the existing authenticated Connection/Remote mechanisms, with streamed upload limits, revision-checked updates, bounded processing, and cleanup on cancellation/unload. Never execute uploaded content or accept arbitrary server paths. Metadata and bytes need not be loaded until an enabled authenticated client requests them.

Runtime limits, cover-storage directory, and default name, greeting, palette, and starter-card enablement belong in validated Cordis configuration. Browser-stored values and durable server metadata are validated when read. Product strings use typed Chinese/English locale dictionaries. The bundled illustration and house icon are project-owned assets.

Only one skin may own these presentation overrides. Detect declared theme/brand conflicts and keep the original UI with a clear diagnostic rather than silently stacking skins. The existing deployed `dsh-theme` package must not be deleted; any eventual switch preserves its configuration and explicitly disables the conflicting presentation before enabling this skin. Unknown third-party CSS cannot be proven conflict-free by package naming alone.

</details>

The plugin does not add family accounts, per-person permissions, a multi-photo album, contract processing, or model credentials. Cover upload is a dedicated appearance feature and does not change document/message attachments. The existing instance remains shared by trusted invite holders. Other profiles and installations without this bundle remain unchanged.

-----

<a id="verification"></a>
## Verification and delivery

The independent prototype has exercised title/greeting editing, all three palettes, local image replacement and reload, invalid-file refusal, the login mockup, simulated conversation controls, and mobile navigation. Its browser checks report no script errors, failed HTTP requests, external requests, or mobile horizontal overflow. This local prototype does not implement server sharing; production integration needs the following evidence.

1. Unit tests cover configuration and stored-preference parsing, authoritative image validation, revision conflicts, interrupted writes, storage failures, owned-file cleanup, and enable/disable restoration.
2. Real Loader tests cover presentation registration/removal, missing optional providers, explicit conflicts, and unchanged invite authentication. Refuse unauthenticated cover reads/writes, cross-origin writes, path injection, malicious custom text, and script injection; prove valid requests succeed.
3. Real Web browser tests use independent authenticated contexts: one uploads and the other sees the shared cover after refresh/focus; removal, reconnect, and server restart preserve the defined state. Also cover desktop/mobile palettes, title navigation, no photo sent to a model, no photo requested before login, keyboard focus, reduced motion, and stock-UI restoration. Verify actual text contrast, not just the named palette values.
4. A keyless recorded-session scenario exercises the real composer, streaming response, reload, and unchanged transcript under the skin. Authentication-page and appearance-only expectations stay with their owning tests.
5. Build, relevant type/lint/package checks, bilingual documentation checks, and one built-profile smoke cover the installable bundle. Deployment requires its own backup, existing-theme conflict check, and real Kimi/browser verification; this design approval does not deploy it.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Design status</summary>

The user approved the interactive visual direction and requested server-shared photos on 2026-09-22. This written specification is awaiting review before implementation planning. Installation instructions and final extension API signatures are intentionally not presented as existing functionality.

</details>
