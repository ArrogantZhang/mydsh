---
description: "为 Web profile 提供家庭界面和经过鉴权的共享照片存储的可选组合层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-family-theme

[English](README.md) | 中文

## 概述

为 profile 增加家庭主题 Web 界面和一张私密共享封面。此组合包需要主动启用，不改变已提供 profile 的默认配置。浏览器外观仍属于个人设置；照片由已授权访问者共享。若公网访问必须使用邀请码，请保留现有的邀请码代理。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

使用已经构建的源码目录和 Web profile。此包尚未发布到 npm registry；请通过绝对路径链接本地包。以下已验证的 Windows 示例假定源码位于 `D:/Code/mydsh`，请替换为你的源码路径。

```powershell
node apps/cli/lib/bin.js plugin --profile web add "link:D:/Code/mydsh/packages/bundle/family-theme"
node apps/cli/lib/bin.js plugin --profile web remove @deepseek-ai/dsh-family-theme
```

添加依赖后，家庭主题层会追加在已有 Web 层之后；移除依赖会撤销该层。重启 profile 后采用新的组合。[使用指南](../../../docs/user/guide/family-theme.zh.md)介绍外观、照片共享和备份范围。

此层会停用 `ui-brand-official`，并挂载[家庭外观](../../client/ui-family-theme/README.zh.md)和[共享封面存储](../../host/family-cover/README.zh.md)。已有第三方主题配置项需要运维者明确决定如何处理；本组合包不会删除或覆盖它们。

照片位于发布目录之外的 `DSH_HOME/family-theme`。请把该目录纳入备份。卸载组合包或关闭其界面不会删除封面。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>组合</summary>

[补丁](cordis.patch.yml)仅负责需要主动启用的展示和存储配置项。其私有根目录通过现有 Harness-home 能力解析。各个包分别负责限制、鉴权、刷新行为和失败语义。由于本组合包仅提供配置，因此不发布运行时不变量配套插件。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为组合包只增加展示和私密照片存储，不进行面向模型的注册。

#### KV Cache 影响

无；此层不修改提示词、工具 schema 或提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

此层面向已有的可信小群体 Web 部署。

- profile 必须已包含 Web 组合，以及补丁所针对的官方品牌配置项。
- 组合包不配置 TLS、DNS、邀请码秘密或多用户隔离。
- 本地链接要求源码目录和构建产物持续可用；部署打包是独立操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>工作上下文</summary>

无。

</details>
