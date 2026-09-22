---
description: "Opt-in family UI and authenticated shared-photo storage for a Web profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-family-theme

English | [中文](README.zh.md)

## Summary

Add a family-themed Web interface and one private shared cover to a profile. The bundle is opt-in and does not change shipped profile defaults. Browser appearance remains personal; the photo is shared by authorized visitors. Keep the existing invite proxy when public access must require an invite.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use an already built checkout with a Web profile. This package is not published to the npm registry; link the local package using its absolute path. The verified Windows example below assumes the checkout is `D:/Code/mydsh`; substitute your checkout path.

```powershell
node apps/cli/lib/bin.js plugin --profile web add "link:D:/Code/mydsh/packages/bundle/family-theme"
node apps/cli/lib/bin.js plugin --profile web remove @deepseek-ai/dsh-family-theme
```

Adding the dependency appends the family layer after the existing Web layers; removal withdraws that layer. Restart the profile to adopt its next composition. The [usage guide](../../../docs/user/guide/family-theme.md) explains appearance, photo sharing, and backup boundaries.

The layer disables `ui-brand-official` and mounts [family appearance](../../client/ui-family-theme/README.md) with [shared-cover storage](../../host/family-cover/README.md). Existing third-party theme rows require an explicit operator decision; this bundle does not delete or override them.

Photos live at `DSH_HOME/family-theme`, outside release directories. Include that directory in backups. Uninstalling the bundle or disabling its UI does not delete the cover.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Composition</summary>

The [patch](cordis.patch.yml) owns only opt-in presentation and storage rows. Its private root resolves through the existing Harness-home capability. The individual packages own limits, authentication, refresh behavior, and failure semantics. No runtime invariant companion is published because this bundle contributes only configuration.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the bundle adds presentation and private photo storage without model-facing registrations.

#### KV Cache effect

None; the layer does not modify prompts, tool schemas, or provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The layer is intended for the existing trusted-group Web deployment.

- The profile must already contain the Web composition, including the official-brand row targeted by the patch.
- The bundle does not configure TLS, DNS, invite secrets, or multi-user isolation.
- Local links require the checkout and built artifacts to remain available; deployment packaging is a separate operation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context</summary>

None.

</details>
