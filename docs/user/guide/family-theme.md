# Family home theme

English | [中文](family-theme.zh.md)

## Summary

Use a family name, a welcome message, and warm colors while retaining the ordinary DSH chat controls. Your browser keeps these appearance choices. The family cover is uploaded to the server and shared with everyone admitted to the instance. The photo is never attached to a conversation automatically.

## Table of Contents

- [Enable the theme](#enable-the-theme)
- [Personal appearance](#personal-appearance)
- [Shared photos](#shared-photos)
- [Operations](#operations)

<a id="enable-the-theme"></a>
## Enable the theme

Start with a built checkout and an existing Web profile. Add the optional [family bundle](../../../packages/bundle/family-theme/README.md) using its verified local-link instructions, then restart that profile. The package is not available from the public npm registry. Leave the existing invitation and reverse-proxy configuration enabled.

If another skin already owns branding or a custom palette, explicitly disable that presentation first. The family skin reports the conflict and does not silently overwrite it.

<a id="personal-appearance"></a>
## Personal appearance

Open Settings → General → Make it home. Save a name of up to 16 Unicode characters, a welcome message of up to 32 characters, and one of Morning sunshine, Garden afternoon, or Evening fireside. These choices do not change another browser's appearance. Turn off Use family theme to restore the original interface.

Choose a workspace before using a starter card. A card fills the existing message draft; it does not send anything until you use the ordinary Send control.

<a id="shared-photos"></a>
## Shared photos

Use Upload a family photo on the home page or in Make it home. Static JPG, PNG, and WebP are supported. The default server budget is 10 MiB and 24 million decoded pixels, with a normalized long edge of at most 1600 pixels. The server strips capture metadata and stores WebP rather than the original file.

Every authorized visitor can replace or remove this one shared photo. Removal requires confirmation and restores the default living-room illustration for everyone. There is no album, private-photo permission, or individual owner.

The page refreshes its cover when it opens, regains focus, reconnects, or finishes its own change. It does not continuously push photo updates. If someone changes the cover first, refresh and review their image before retrying; a stale change cannot overwrite it.

<a id="operations"></a>
## Operations

Keep `DSH_HOME/family-theme` outside release directories and include it in backups. Uninstalling or disabling the theme leaves these data intact. The service must keep using authenticated `/api` routes; never add a public static route to that directory. The unauthenticated invite page uses the family title and local palette but never loads the shared photo.

The [storage reference](../../../packages/host/family-cover/README.md) owns processing limits and failure semantics. The [appearance reference](../../../packages/client/ui-family-theme/README.md) owns browser persistence and conflict behavior. Deployments still require the existing [invite-authentication setup](../../../deploy/alibaba-cloud/README.md).

## Dev Note

None.
