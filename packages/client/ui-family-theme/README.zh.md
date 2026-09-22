---
description: "家庭主题、浏览器本地偏好、共享照片控件及安全的邀请码页面品牌展示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-family-theme

[English](README.md) | 中文

## 概述

为 Web 界面设置家庭名称、欢迎语和三套温馨配色。每个浏览器分别保存自己的外观偏好。已授权访问者通过独立封面服务共享一张服务器图片。原有输入框、工作区、模型选择和权限控件保持可用。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

[家庭组合包](../../bundle/family-theme/README.zh.md)会一起挂载界面和共享封面服务。打开“设置 → 通用设置 → 布置小屋”，即可修改个人外观或管理共享封面。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 浏览器的初始启用选择。 |
| `name` | `家人小屋` | 纯文本名称，1–16 个 Unicode 字符。 |
| `greeting` | `回来啦，先歇一会儿。` | 纯文本欢迎语，1–32 个 Unicode 字符。 |
| `palette` | `morning` | `morning`、`garden` 或 `evening`。 |

已保存的浏览器选择优先于默认值。浏览器拒绝存储时，选择仍在内存中生效，并显示提示。关闭主题会恢复原有界面，但不会删除共享照片。替换和移除照片会影响所有已授权访问者；移除前会要求确认。

若其他插件占据品牌、标题或首页 slot，或选中了其他自定义主题，本主题会拒绝启用。请明确停用冲突的展示插件。家庭组合包仅停用默认官方品牌配置项，不会移除另行安装的主题。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>展示所有权</summary>

客户端向拥有方声明的 slot 提供内容，并使用可撤销的 `theme.present()` 选择，不写入 Host 主题偏好。[封面控制器](src/client/cover-client.ts)会在启用、获得焦点、重新连接和修改后刷新，并在替换或退出时释放对象 URL。Host 部分仅向现有邀请码页面拥有方注册展示内容；经 nonce 授权的启动脚本读取本地外观，但从不请求照片。 元数据读取失败时，会清除已经加载的私密照片；修改操作必须具有已读取的版本。

**运行时不变量：** 不发布配套检查插件。界面直接读取控制器快照，没有独立的模型或会话投影。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为主题仅注册展示内容，绝不向模型发送封面字节。

#### KV Cache 影响

无；建议卡片仅填写普通草稿，需要用户主动发送。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制用于区分个人外观和共享内容。

- 共享照片不会持续实时推送更新；刷新页面或重新获得焦点可读取其他访问者的修改。
- 外观属于浏览器来源，不属于账号或物理机器身份。
- 无法可靠检测已有的任意全局 CSS；slot 和主题检查仅覆盖已注册的展示拥有方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>工作上下文</summary>

无。

</details>
