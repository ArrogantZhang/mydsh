# 家人小屋主题插件实施计划

> **供执行者：** 使用 `executing-plans` 在当前会话逐步执行。用户已选择当前分支，不创建 worktree，也不使用子代理。步骤用复选框跟踪。

[English](2026-09-22-family-home-theme.md) | 中文

**目标：** 实现[已确认皮肤](../specs/2026-09-22-family-home-theme-design.zh.md)，保留真实 DSH 控件，提供鉴权后的服务器共享封面。

**架构：** Host 封面服务负责有界图片处理、版本校验持久化和鉴权传输。Client 皮肤通过 slot 和主题注册表贡献呈现。通用标题、首页和邀请页外观扩展仍由已有包负责。

**技术栈：** TypeScript、Cordis、Typert Remote、React、CSS Modules、Sharp、node:fs、Vitest、Playwright。

---

## 任务 1：共享封面存储

文件：新增 `packages/host/family-cover/` 包，包含 `src/types.ts`、`src/store.ts`、`src/image.ts`、`src/errors.ts` 和 `tests/store.spec.ts`，注册源码别名及 Host 项目引用。

- [x] 先增加空存储、上传读取与重开、移除、陈旧版本、损坏元数据、类型伪装、字节和像素限制、取消及有界并发测试，再观察 RED。
- [x] 用不可变 WebP 文件和带版本的元数据指针实现存储。通过 `withFileLock` 协调写入，锁内重读并比较版本；发布前刷盘，提交前失败保留旧状态，只删除插件自有且未被引用的图片。
- [x] 运行 `pnpm exec vitest run packages/host/family-cover/tests/store.spec.ts`，通过且无未处理工作后继续。

浏览器安全的结果不包含服务器路径或原始文件名：

```ts ignore-check
type CoverRevision = Branded<'FamilyCoverRevision'>
interface CoverSnapshot {
  readonly revision: CoverRevision
  readonly cover: null | { readonly width: number; readonly height: number; readonly bytes: number; readonly mediaType: 'image/webp' }
}
```

## 任务 2：鉴权封面传输

文件：`packages/host/family-cover/src/index.ts`、`src/http.ts`、`tests/http.spec.ts`、`tests/service.spec.ts`，包的 `./remote`、`./typert` 导出，以及 `packages/api/remotes/` 注册与引用。

- [x] 用真实 Loader 和 Connection 的 fixture（测试前置数据）先验证未授权读取、跨源修改、超大流、陈旧写入和提供方释放。
- [x] 通过生成的 Remote 提供 `familyCover.current(signal)` 和 `familyCover.removeCover(expectedRevision, signal)`。注册精确鉴权路由 POST `/api/family-cover/upload` 和 GET `/api/family-cover/image` 传输二进制正文。HTTP 修改请求要求 Origin 和版本匹配，响应使用 `Cache-Control: private, no-store`。
- [x] 超过配置并发数立即拒绝接收。释放时取消自有请求并等待已启动处理，释放之后不得发布上传结果。
- [x] 通过正常构建生成严格 Remote 产物，一起运行存储与传输测试。

## 任务 3：所有者管理的呈现扩展

文件：`packages/client/ui-layout/src/client/{index.ts,AppFrame.tsx}`、`packages/client/ui-conversation/src/client/{contract/slots.ts,apply.ts,skeleton/ConversationContent.tsx}`、`packages/host/invite-auth/src/{index.ts,page.ts,http.ts}` 及其所属测试。

- [x] 为 `shell.document.title` 和 `conversation.hero.content` 增加回退、替换及释放的失败测试，保留原有标题导航和输入行为。
- [x] 在所属父组件声明 slot：根标题默认仍是 DocumentTitle，首页默认仍是 HeroShell。家庭呈现不接管或重建输入框。
- [x] 增加一个由 effect 管理的邀请页呈现注册，并保留原版回退。转义所有值，仅允许 nonce 授权的固定脚本，保留原有安全头和全部 POST、检查、退出行为。
- [x] 运行已有布局、首页、邀请码测试及新增回归用例。

## 任务 4：家庭偏好与皮肤启用

文件：新增 `packages/client/ui-family-theme/`，包括共享 `src/preferences.ts`、Host `src/index.ts`、Client `src/client/{index.ts,appearance.ts,cover-client.ts,locales.ts}` 及客户端测试。

- [x] 实现控制器前，测试校验默认值、浏览器保存失败、已存偏好、冲突拒绝、原生恢复及封面刷新与取消。
- [x] 通过 `ctx.theme` 注册三套配色，只释放自有覆盖。共享可观察快照保持稳定，通过框架绑定的注入 Hook 提供；组件只接收普通值和回调，不接收 Context 或服务对象。
- [x] 启用、窗口获焦、重连及修改后读取封面元数据，再获取对应版本字节。替换、失去鉴权、停用及释放时清理旧对象 URL，忽略被后续操作取代的完成结果。
- [x] 浏览器偏好只保存名字、欢迎语、配色和启停状态；照片字节由服务器持有，不进入提示词或附件 API。

## 任务 5：真实界面与家庭登录页

文件：`packages/client/ui-family-theme/src/client/` 组件、CSS Modules、`src/assets/` 与 Host 登录呈现模块。复用已确认的项目自有小屋和客厅素材，以及共享 Button、Input、Switch、Modal 控件。

- [x] 增加名字、欢迎语、起始卡片填入草稿、上传错误、移除确认、个人停用及键盘焦点测试。
- [x] 实现侧栏标识和名字、文档标题、首页和照片、暖色 token 映射、设置，以及邀请表单上的本地偏好启动脚本。未登录页面不得请求照片。
- [x] 保留真实会话列表、工作区选择、消息发送和停止、工具、附件及模型选择，不发布模拟会话数据或虚假回复。
- [x] 验证全部配色的桌面与手机布局、减少动态效果、普通文字对比度及停用后的原版行为。

## 任务 6：可选组合包、文档和组装回归

文件：新增 `packages/bundle/family-theme/`、`apps/cli/config/examples/family-theme/cordis.yml`、`apps/web/tests/family-theme.e2e.ts`、所属 `snapshots/web/family-theme/` 场景、包 README 配对、相关子系统文档和目录，以及记录共享封面权限和生命周期决策的一篇有效 Agent Note。

- [x] 通过明确 manifest（元数据清单）和编译面接入组合包，不在原生 profile 中默认加载；所有部署默认值放入已验证 Config 字段。
- [x] 构建并通过可选覆盖层及页内目录选择器启动真实 Web profile。使用两个已登录浏览器上下文验证封面共享，并验证匿名拒绝、冲突行为、重启保存和正常录制会话回放。
- [x] 运行聚焦测试、类型检查、相关包和客户端检查、构建及构建后冒烟、无密钥浏览器快照、doc-sync（文档同步门禁）和 lint。如实记录平台基线失败，不削弱检查。
- [x] 检查最终差异，只提交有意修改的文件。交付本地实现与验证证据；没有部署请求时，不上线或覆盖现有服务器主题。

## 验证记录

已在当前功能分支实现，未使用 worktree 或 subagent，未改动生产环境。

- `pnpm run build`：通过；为 Host 提供方加入等待初始化后，也重新构建了该提供方。
- 聚焦的存储、界面、邀请码鉴权、布局、主题与会话测试：20 个文件、250 项测试通过。
- 真实浏览器共享及重启、主题登录页和录制会话回放：3 个文件、3 项测试通过。
- 已执行范围内的 `pnpm run lint:contracts-ready`、`pnpm run test:docs`、约束、包不变量、类型等价与生成文档新鲜度检查通过。
- 三套配色的正文、次要文字和按钮文字对比度检查均超过 4.5:1。
- 完整 doc-sync 与 hygiene 仍存在 Windows 环境限制：文档符号链接 fixture（测试前置数据）和 NodeNext 消费方链接创建收到 `EPERM`；检出的 ACP profile 链接是包含目标路径的普通文件。没有削弱这些检查，也未把它们报告为通过。

已在私有临时 profile 中验证本地链接包的安装和移除。该 profile 及其链接已清理，未触及源码或应用数据。
