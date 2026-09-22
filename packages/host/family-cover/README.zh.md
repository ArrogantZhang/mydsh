---
description: "通过有大小限制的图片处理、版本检查和私密读取管理共享封面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-family-cover

[English](README.md) | 中文

## 概述

在一个 Web 实例的已授权访问者之间共享一张家庭封面。上传内容会转换为清除拍摄信息的静态 WebP 图片。替换和移除操作必须携带最后读取的版本。封面字节不会进入会话日志或模型请求。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

完整界面请使用[家庭组合包](../../bundle/family-theme/README.zh.md)，也可在 Connection 旁挂载本服务，并将 `root` 配置为绝对路径的私有目录。不要把该目录作为公共静态文件目录。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 发布目录之外、由插件独占的绝对路径数据目录。 |
| `maxInputBytes` | `10485760` | 流式上传的最大字节数。 |
| `maxInputPixels` | `24000000` | 解码图片的最大像素数。 |
| `maxOutputDimension` | `1600` | 处理后图片的最大长边；不会放大小图片。 |
| `maxOutputBytes` | `10485760` | 图片存储和读取的最大字节数。 |
| `maxConcurrentUploads` | `2` | 每个服务生命周期内允许并行处理的修改数。 |
| `timeoutSeconds` | `15` | 原生图片处理的超时秒数。 |
| `lockWaitMs` | `5000` | 等待跨进程写锁的最长毫秒数。 |

Connection 对元数据、移除、上传和图片请求进行鉴权。原始上传还要求来源和版本匹配。若访问必须使用邀请码，请配置现有的邀请码代理和浏览器 Cookie 桥接；仅有 Connection 鉴权不等于检查邀请码。

备份整个 `root`，包括 `cover.json` 及其引用的 WebP。发生版本冲突时，应先刷新再重试。发布成功后仍可能发生响应失败，因此客户端会在每次修改操作结束后刷新。若把 `maxOutputBytes` 调低到已有封面大小以下，服务会拒绝该记录，而不是进行无界读取。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>持久化与鉴权</summary>

[存储](src/store.ts)在文件锁内比较版本，发布标准化内容和带版本的元数据指针，并仅清理未被引用的自有图片文件。读取时会验证内容摘要。dispose（资源释放）会取消接收并等待已启动工作完全停稳。[HTTP 适配器](src/http.ts)返回禁止缓存的私密响应，不包含原始文件名或存储路径。

**运行时不变量：** 不发布配套检查插件。读取会直接验证权威记录及其摘要，没有可供交叉比较的独立会话事件投影。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为本服务只存储展示图片，不构造模型输入。

#### KV Cache 影响

无；封面操作不会改变提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

共享封面具有以下访问和持久化限制。

- 所有已授权访问者都能替换或移除这一张封面，没有个人所有者或角色划分。
- 仅接受静态 JPEG、PNG 和 WebP，不支持动画、SVG 或保留原文件。
- POSIX 发布时会同步父目录；Windows 会同步文件字节，但无法使用 Node 的目录 fsync。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>工作上下文</summary>

无。

</details>
