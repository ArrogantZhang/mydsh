# Agent Note: Browser downloads preserve current source files

Status: implemented

English | [中文](2026-09-23-browser-original-file-download.zh.md)

## Problem

A remote browser cannot save generated files through the Host's default desktop application. Preview content is not a substitute for an original document: text may be paginated, and Office previews contain converted PDF bytes.

## Decision

The [document preview](../../../../packages/client/ui-sidebar-documentpreview/README.md) offers an explicit browser download for its addressed Session file. It reads current original bytes through the existing authenticated `workspaceFiles.readAll` method, retaining filesystem policy and the configured complete-file limit. It hands those bytes to the browser as an attachment with the original basename, without invoking a Host application or publishing a new file route.

This extends the [workspace source-file decision](../feature/2026-09-08-present-workspace-source-files.md) with an explicit browser-save action; content-free delivery declarations, native opening, and the absence of preserved delivery snapshots remain unchanged. Downloads neither modify files nor add Session events or model inputs.

Each tab owns its request and at most one retained object URL. Duplicate pending gestures share the read. Closing the tab cancels the request and releases its URL; plugin disposal also joins reads cancelled by previously closed tabs. A late result cannot start a download. Status reports browser handoff, not successful saving to disk.

## Alternatives considered

**Downloading displayed content** can silently save an incomplete text prefix or a converted Office preview. Reading the original preserves every byte independently of renderer availability and preview state.

**A dedicated download endpoint** adds another transport operation over the same bounded file reader. The existing complete-byte method already owns authentication, Session path resolution, regular-file checks, and size refusals; a native-open fallback also depends on a desktop unavailable to server deployments.

**Persisting immutable delivery copies** introduces a storage and retention policy. This change keeps the existing current-source semantics; it does not preserve a file after deletion or freeze a displayed version.

## Consequences

Complete downloads buffer bounded source bytes in the Host and browser. Files over `maxFileBytes` fail without truncation; large-file streaming remains outside this change. Browser policy and the user still control the final save.

Controller tests cover unchanged bytes, Chinese basenames, duplicate gestures, failures, cancellation, late results, URL cleanup, and joined disposal. A recorded-session browser scenario compares downloaded Word, Excel, PDF, text, and unsupported-preview files byte for byte, with Office conversion disabled, and verifies anonymous, oversized, and deleted-file refusals.
