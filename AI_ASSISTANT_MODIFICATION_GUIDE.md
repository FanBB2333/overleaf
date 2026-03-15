# AI Assistant 改造说明

## 1. 改造目标

这次改造的目标是给现有 Overleaf 编辑器增加一个低侵入的 AI Workspace Bridge MVP，核心能力只有两类：

1. 从当前项目导出一个 `workspace snapshot`
2. 接收一个 `change set` 并把文本类 doc 的变更回写到现有项目

这套方案没有改 OT 主链路，也没有改 `document-updater` 内核，只是在 `services/web` 层增加了一层 AI feature。

## 2. 后端改动在哪里

### 2.1 新增 AI 业务层

文件：

- `services/web/app/src/Features/AI/AIService.mjs`
- `services/web/app/src/Features/AI/AIController.mjs`

职责说明：

#### `AIService.mjs`

这个文件是这次改造的核心。

它新增了两组能力：

1. `getPublicConfig()`
   - 从 `Settings.aiAssistant` 读取开关和前端配置
   - 输出给前端使用的配置对象

2. `getWorkspaceSnapshot(projectId)`
   - 用 `ProjectGetter` 读取项目结构
   - 用 `ClsiStateManager.computeHash(project, {})` 生成当前项目结构版本
   - 用 `ProjectEntityHandler.getAllDocPathsFromProject(project)` 获取 doc path 映射
   - 优先通过 `DocumentUpdaterHandler.getProjectDocsIfMatch(...)` 获取当前编辑态文档内容
   - 如果 doc-updater 不可直接命中，则回退到逐个 `getDocument(...)`
   - 额外把项目里的二进制文件也枚举出来，但当前只暴露下载信息，不支持 AI 直接修改

3. `applyWorkspaceChanges(projectId, userId, changeSet)`
   - 校验用户是否登录
   - 校验 `updates` 是否为空
   - 校验路径是否重复
   - 校验 `baseSnapshotVersion`
   - 校验每个 doc 的 `baseVersion`
   - 拒绝二进制文件更新
   - 通过现有 `ProjectEntityUpdateHandler` 执行：
     - `upsertDocWithPath(...)`
     - `deleteEntityWithPath(...)`
   - 写入 source 固定为 `ai-bridge`

说明：

- 当前 MVP 只支持文本 doc 的 `create / update / delete`
- 不支持 file 二进制内容写入
- 删除分支已经修正过一次参数顺序问题，现在调用顺序是正确的

#### `AIController.mjs`

这个文件只是薄控制器，职责很轻：

1. `getWorkspace`
   - 调用 `AIService.getWorkspaceSnapshot`
2. `applyChanges`
   - 从 session 里拿 `userId`
   - 调用 `AIService.applyWorkspaceChanges`

### 2.2 路由接入

文件：

- `services/web/app/src/router.mjs`

新增了两条路由：

- `GET /project/:Project_id/ai/workspace`
- `POST /project/:Project_id/ai/apply`

路由保护条件：

1. 必须 feature flag 打开
2. 必须登录
3. 必须有项目写权限

### 2.3 Feature Flag 接入

文件：

- `services/web/app/src/infrastructure/Features.mjs`

新增：

- `case 'ai-assistant': return Boolean(Settings.aiAssistant?.enabled)`

也就是说，这个功能是否启用，完全由 `Settings.aiAssistant.enabled` 决定。

### 2.4 编辑页配置注入

文件：

- `services/web/app/src/Features/Project/ProjectController.mjs`
- `services/web/app/views/project/editor/_meta.pug`

这里做了两件事：

1. 在进入编辑页渲染时，计算 `aiAssistantConfig`
2. 只对登录且有写权限的用户，把 `aiAssistant` 注入到页面 meta

注入后的前端读取入口是：

- `meta(name="ol-aiAssistant" data-type="json" content=aiAssistant)`

## 3. 前端是否需要改

如果你只想提供后端 API 给外部桥接程序调用，那么前端不是必须改。

如果你希望在 Overleaf 编辑器里直接看到 AI 入口、查看 snapshot、粘贴 change set 并执行 apply，那么前端就必须改。

这次我已经做了最小 UI 接入。

## 4. 前端改动在哪里

### 4.1 Toolbar 增加 AI 入口按钮

文件：

- `services/web/frontend/js/features/ai-assistant/ai-assistant-toggle-button.tsx`
- `services/web/frontend/js/features/source-editor/components/codemirror-toolbar.tsx`

当前做法：

1. 新增一个 `AIAssistantToggleButton`
2. 挂到 source editor toolbar 的末端按钮区
3. 点击后通过 `window.dispatchEvent(new Event('ai-assistant:toggle'))` 打开侧栏

这是低侵入做法，因为：

- 没有改原有 toolbar 布局逻辑
- 只是插入一个额外按钮

### 4.2 编辑器外层增加 AI Panel 容器

文件：

- `services/web/frontend/js/features/source-editor/components/source-editor.tsx`

当前做法：

1. 保留原有 `CodeMirrorEditor`
2. 外层包一层：
   - `.ol-ai-assistant-shell`
   - `.ol-ai-assistant-editor`
3. 在右侧追加 `<AIAssistantPanel />`
4. 通过事件 `ai-assistant:toggle` 控制开合

这也是低侵入做法，因为：

- 没有改编辑器核心逻辑
- 只是增加一个旁路 UI 容器

### 4.3 新增 AI Side Panel

文件：

- `services/web/frontend/js/features/ai-assistant/ai-assistant-panel.tsx`

当前面板分成三块：

1. `Workspace`
   - 调用 `GET /project/:id/ai/workspace`
   - 展示 snapshot JSON

2. `Apply Change Set`
   - 用户粘贴 JSON
   - 调用 `POST /project/:id/ai/apply`

3. `Status`
   - 展示 apply 结果或错误

这个面板现在是一个手动桥接面板，不是自动同步型 AI 助手。

### 4.4 前端 meta 类型扩展

文件：

- `services/web/frontend/js/utils/meta.ts`

新增了：

- `'ol-aiAssistant'`

对应字段：

- `enabled`
- `provider`
- `bridgeUrl`
- `localBridge`
- `source`

如果不扩这个类型，TypeScript 前端代码读取 meta 时会缺类型。

### 4.5 样式接入

文件：

- `services/web/frontend/stylesheets/pages/editor/ai-assistant.scss`
- `services/web/frontend/stylesheets/pages/all.scss`

当前样式策略：

1. editor 与 panel 双栏布局
2. 大屏右侧侧栏
3. 小屏自动改为上下布局

这部分是纯附加样式，没有去改现有 editor 主题变量或 toolbar 核心样式。

## 5. 如果你要继续改前端界面，应该改哪些地方

如果你想把当前 MVP 面板继续做成正式 UI，建议按下面的层次改，而不是直接重写整个编辑器页。

### 5.1 只换入口，不动数据链路

改这两个文件：

- `services/web/frontend/js/features/ai-assistant/ai-assistant-toggle-button.tsx`
- `services/web/frontend/js/features/source-editor/components/codemirror-toolbar.tsx`

适合场景：

- 只想把按钮换成图标、下拉菜单、或者更符合产品风格的入口

不建议动：

- `AIService` 和后端接口

### 5.2 只换面板 UI，不动接口协议

改这个文件：

- `services/web/frontend/js/features/ai-assistant/ai-assistant-panel.tsx`

适合场景：

- 要把 JSON 文本框换成：
  - 聊天窗口
  - diff 预览
  - 文件树选择器
  - 审批式 apply 界面

建议保留：

- `GET /ai/workspace`
- `POST /ai/apply`
- `baseSnapshotVersion`
- `baseVersion`

因为这几项是当前并发安全校验的核心。

### 5.3 只换布局，不动业务逻辑

改这两个文件：

- `services/web/frontend/js/features/source-editor/components/source-editor.tsx`
- `services/web/frontend/stylesheets/pages/editor/ai-assistant.scss`

适合场景：

- 想把侧栏改成 Drawer
- 想把面板改成底部浮层
- 想让 panel 在移动端全屏

### 5.4 如果要做真正的 AI 助手交互

建议在 `ai-assistant-panel.tsx` 基础上增加：

1. prompt 输入区
2. 模型响应展示区
3. diff 预览区
4. apply 前确认区
5. 文件级选择器

但建议仍然沿用现在这条链路：

1. 先 `workspace snapshot`
2. AI 在外部或前端生成 `change set`
3. 最后统一 `apply`

这样对现有代码侵入最小。

## 6. 当前最小接入步骤

如果你要在另一套前端上复用这次能力，最小需要改的内容其实只有下面几项：

### 必改后端

1. 增加 `AIService`
2. 增加 `AIController`
3. 注册 `/ai/workspace` 和 `/ai/apply`
4. 增加 `Features` 开关
5. 在编辑页注入 `ol-aiAssistant`

### 必改前端

1. 扩展 `meta.ts` 里的 `ol-aiAssistant`
2. 增加一个入口按钮
3. 增加一个面板组件
4. 调用两个接口：
   - `GET /project/:id/ai/workspace`
   - `POST /project/:id/ai/apply`

### 可不改

下面这些都不是 MVP 必需：

1. 不需要改编辑器 OT 逻辑
2. 不需要改 `document-updater` 核心逻辑
3. 不需要改项目树结构
4. 不需要改 file upload/download 主流程

## 7. 当前配置要求

当前功能依赖：

```js
Settings.aiAssistant = {
  enabled: true,
  provider: 'codex',
  bridgeUrl: 'http://127.0.0.1:8787',
  localBridge: true,
}
```

最关键的是：

- `enabled: true`

否则：

1. feature flag 不会打开
2. 路由不会注册
3. 前端按钮也不会显示

## 8. 当前方案的边界

当前版本故意收敛为 MVP，边界如下：

1. 只支持文本 doc
2. 不支持 binary file 写回
3. 面板是手动 snapshot/apply，不是自动桥接
4. 没有做 prompt-to-change-set 的模型交互层
5. 主要目标是“先跑通低侵入链路”

## 9. 推荐后续演进方式

如果后面你还要继续做，建议按下面顺序推进：

1. 先保留当前 `snapshot/apply` 协议不变
2. 在前端面板里增加 diff 预览
3. 再增加 prompt 和模型响应区
4. 最后再考虑自动同步或更复杂的 bridge

这样可以保证：

1. 后端协议稳定
2. 对现有 Overleaf 主链路侵入最小
3. 出问题时也容易回滚

