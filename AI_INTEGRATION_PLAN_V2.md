# Overleaf AI 集成实施方案 V2

## 文档目的

本方案用于替代 `AI_INTEGRATION_TODOS.md` 中较粗糙的第一版思路，目标是在当前 Overleaf 架构上为本地 Claude Code / Codex 增加可落地的集成路径。

这份方案优先解决 4 个现实问题：

1. Overleaf 的“项目路径”和“文档内容”不是同一份数据。
2. 运行时文档可能是 `lines[]`，也可能是 `history-ot` 的 `StringFileRawData`。
3. 实时协作已经依赖 `document-updater + OT`，不能绕开。
4. Claude Code / Codex 习惯操作文件系统，但 Overleaf 的权威写入路径不是本地文件，而是 API。

---

## 先给结论

推荐采用：

`Overleaf Frontend -> AI Panel -> AI Bridge -> 临时工作区 -> Claude Code/Codex -> 显式 Apply 回写 Overleaf`

不推荐采用：

- 直接监听 MongoDB / Redis 生成本地文件
- 直接修改 `document-updater` 的 OT 主链路
- 监听本地文件变化后自动持续回写
- 在浏览器里把 AI 产生的修改直接塞进 CodeMirror 而不做版本校验

---

## 当前仓库中的真实约束

### 1. 编辑器不是 ACE 主实现

当前源码编辑器主实现是 CodeMirror 6。

- 前端入口：`services/web/frontend/js/features/source-editor/components/source-editor.tsx`
- 实际组件树：`services/web/frontend/js/features/source-editor/components/codemirror-editor.tsx`
- 实时桥接：`services/web/frontend/js/features/source-editor/extensions/realtime.ts`

ACE 只剩部分历史兼容逻辑和用户设置字段，不适合作为 AI 集成切入点。

### 2. 项目路径和正文内容是分开的

- 项目树路径来自 `Project.rootFolder`
- doc 内容来自 docstore / document-updater
- 编译、打包、导出时，系统会把两者重新拼成真实工作区

因此 AI 工作区不能简单理解成“把 docs 集合写到磁盘”，而是要做一次“项目快照投影”。

### 3. doc 不是永远都是 `lines[]`

运行时存在两类文本表示：

- 旧格式：`string[]`
- 新格式：`StringFileRawData { content, comments, trackedChanges }`

AI 集成层不应该直接依赖内部格式，应统一通过 web/document-updater 暴露的 API 获取“当前可编辑文本视图”。

### 4. 外部回写已经是允许的，但要受控

现有系统已经支持外部来源修改文档，例如 `git-bridge`。这说明“外部工具生成修改，再回写 Overleaf”是和现有架构兼容的。

但这类回写目前会触发外部更新语义，因此 AI 回写必须：

- 带明确 `source`
- 只在用户显式确认后执行
- 避免高频 watcher 式回写

---

## 目标与非目标

### 目标

- 在 Overleaf 编辑器中提供一个 AI 面板
- 让 AI 能读取当前项目的文本工作区视图
- 支持 Claude Code / Codex 在临时目录中工作
- 支持把 AI 产生的修改以受控方式回写到 Overleaf
- 支持单文件和多文件文本修改

### MVP 非目标

- 不做实时双向文件镜像
- 不做 AI 自动持续接管编辑器
- 不处理复杂二进制文件改写
- 不改 OT 核心算法
- 不做“无确认自动提交”

---

## 推荐架构

### 总体架构

```text
Overleaf Frontend
  -> AI Assistant Panel
  -> same-origin AI API / local bridge client

AI Bridge
  -> 拉取项目快照
  -> 物化临时工作区
  -> 调用 Claude Code / Codex
  -> 生成变更集
  -> 等待用户确认
  -> 显式 apply 回写 Overleaf

Overleaf Backend
  -> 提供项目快照 API
  -> 提供 apply / validate API
  -> 继续走现有 document-updater / docstore 持久化链路
```

### 关键设计原则

1. 只通过 API 集成，不直读 Mongo / Redis。
2. 工作区是“快照投影”，不是权威存储。
3. AI 产出先形成 diff，再由用户确认 apply。
4. 回写时必须校验基线版本，发现冲突就拒绝并要求刷新。
5. 所有 AI 写入都标记 `source: 'ai-bridge'`。

---

## 10 个以内文件修改的延迟预期

以下预期只讨论“AI 已经生成完变更集之后，Overleaf 开始 apply”的阶段，不包含 Claude Code / Codex 自身推理、读写工作区和执行命令的耗时。

### 建议实现策略

- apply 按 doc 维度做有上限并发，MVP 默认并发度建议为 `4`
- 不采用“模拟前端逐字输入”的方式回写
- 前端区分两种状态：
  - 已在编辑器中可见
  - 已完成持久化

### MVP 性能目标

- [ ] 单个已打开 doc 在开始 apply 后 `1s` 内对当前用户可见
- [ ] `10` 个以内文本 doc 在开始 apply 后 `3s` 内完成“编辑器可见”更新
- [ ] `10` 个以内文本 doc 在开始 apply 后 `5s` 内完成持久化
- [ ] 任一 doc apply 失败时，前端能看到逐文件状态，而不是整个任务静默失败
- [ ] 超过上述阈值时，bridge 和 Overleaf API 都能输出 per-doc 耗时日志

### 说明

- 这些数字是基于当前代码链路的工程目标，不是现成系统已经验证过的 SLA
- 如果 doc 未预热在 redis、中途发生版本冲突、或文本特别大，尾延迟会明显升高
- 如果后续实测发现 `4` 并发过高或过低，再按实测调整为 `3` 或 `6`

---

## 分阶段实施

## Phase 0: 基线梳理与开关

### Step 0.1 建立 feature flag 和配置入口

**目标**

给 AI 功能加独立开关，避免直接影响普通编辑流。

**建议修改文件**

- `services/web/app/src/infrastructure/Features.mjs`
- `services/web/frontend/js/shared/context/split-test-context.tsx` 或对应特性上下文
- 如需实验开关，可参考现有 `overleaf-code` 实验模式

**完成内容**

- 增加 `ai-assistant` feature flag
- 增加前端可读配置：
  - bridge 地址
  - 是否启用本地 bridge 模式
  - provider 类型（`claude-code` / `codex`）

**验收方式**

- 关闭开关时，编辑器 UI 不出现任何 AI 入口
- 开启开关时，前端能读到配置但不执行任何写操作

### Step 0.2 明确 bridge 连接模式

**目标**

在编码前先固定“浏览器如何访问 bridge”这件事，避免后续前端和 bridge 各做各的。

**推荐模式**

模式 A，本地开发优先：

- Overleaf 页面运行在本机开发环境
- 前端可直接访问本地 bridge，例如 `http://127.0.0.1:PORT`

模式 B，正式部署优先：

- 浏览器只访问 Overleaf 同源接口
- Overleaf web 负责把 AI 请求转发到 bridge 或其他 agent 服务

**建议**

- MVP 如果目标就是本地开发，先做模式 A
- 如果目标包含远程部署，必须预留模式 B，不要把前端写死成直接连 localhost

**验收方式**

- 文档中明确写出当前项目采用 A 还是 B
- 前端代码中 bridge 地址来自配置，不硬编码

---

## Phase 1: Overleaf 侧新增 AI 快照与回写 API

### Step 1.1 增加 AI Workspace Snapshot API

**目标**

为 bridge 提供“项目快照投影”，而不是让 bridge 自己拼 Mongo/docstore。

**建议新增文件**

- `services/web/app/src/Features/AI/AIController.mjs`
- `services/web/app/src/Features/AI/AIService.mjs`

**建议修改文件**

- `services/web/app/src/router.mjs`

**建议接口**

- `GET /project/:project_id/ai/workspace`

**返回内容建议**

```json
{
  "projectId": "...",
  "rootDocId": "...",
  "snapshotVersion": "...",
  "docs": [
    {
      "docId": "...",
      "path": "/main.tex",
      "version": 12,
      "content": "..."
    }
  ],
  "files": [
    {
      "fileId": "...",
      "path": "/images/plot.png",
      "kind": "binary",
      "downloadUrl": "..."
    }
  ]
}
```

**实现要求**

- doc 路径通过项目树解析
- doc 内容返回统一字符串视图
- 二进制文件先只返回元数据和下载地址
- 不暴露底层 Redis / Mongo 细节

**验收方式**

- 调用接口后，能得到完整项目文本快照
- `main.tex`、子目录 doc 路径正确
- 至少一个含多级目录的项目能被正确展开

### Step 1.2 增加显式 Apply API

**目标**

让 bridge 提交“确认后的变更集”，由 Overleaf 负责逐文件回写。

**建议接口**

- `POST /project/:project_id/ai/apply`

**请求体建议**

```json
{
  "baseSnapshotVersion": "...",
  "changes": [
    {
      "type": "doc",
      "docId": "...",
      "path": "/main.tex",
      "baseVersion": 12,
      "newContent": "..."
    }
  ],
  "source": "ai-bridge"
}
```

**实现要求**

- 每个 doc 回写前校验 `baseVersion`
- 发现版本不一致时返回冲突详情
- 内部继续调用现有 `DocumentUpdaterHandler.setDocument` 或等价链路
- 暂不支持二进制文件写入

**验收方式**

- 单文件修改可以成功回写
- 多文件修改可以顺序回写
- 人为制造版本漂移时，接口返回冲突而不是覆盖

### Step 1.3 补充 AI Source 语义

**目标**

让前端能识别 AI 产生的外部修改，不把它当成未知来源。

**建议修改文件**

- `services/web/frontend/js/features/ide-react/context/editor-manager-context.tsx`
- 如有历史展示来源逻辑，也同步补充

**完成内容**

- 为 `source === 'ai-bridge'` 增加专门处理逻辑
- MVP 可以选择：
  - 不弹“document updated externally”通用错误框
  - 改成更轻的 “AI applied changes” 提示

**验收方式**

- AI apply 后，当前用户不会收到误导性的“外部修改”通用错误框
- 协作者仍能收到正常文档更新

---

## Phase 2: 本地 AI Bridge

### Step 2.1 创建 bridge 服务骨架

**建议目录**

- `services/ai-bridge/`

**建议文件**

- `services/ai-bridge/package.json`
- `services/ai-bridge/server.ts` 或 `server.js`
- `services/ai-bridge/src/config.ts`
- `services/ai-bridge/src/overleaf-client.ts`
- `services/ai-bridge/src/workspace-manager.ts`
- `services/ai-bridge/src/provider/claude-code.ts`
- `services/ai-bridge/src/provider/codex.ts`
- `services/ai-bridge/src/types.ts`

**完成内容**

- 本地 HTTP / WebSocket 服务
- 能读取配置
- 能和 Overleaf AI API 通讯
- provider 先做抽象层，不把 Claude/Codex 调用逻辑写死在主流程里

**验收方式**

- bridge 启动成功
- 健康检查接口返回正常
- 可以拿到指定项目 workspace 快照

### Step 2.2 实现 workspace materialization

**目标**

把项目快照投影到临时目录，供 Claude Code / Codex 使用。

**工作目录建议**

- `/tmp/overleaf-ai/{projectId}/workspace/`
- `/tmp/overleaf-ai/{projectId}/meta/manifest.json`

**完成内容**

- 文本 doc 写入真实路径
- 为每个 doc 记录：
  - `docId`
  - `path`
  - `baseVersion`
  - 内容 hash
- 二进制文件先按需懒加载，或在 MVP 中仅写占位元数据

**不要做的事**

- 不做文件 watcher 自动同步
- 不把临时目录当权威状态

**验收方式**

- workspace 目录结构和 Overleaf 项目一致
- 文本文件内容与 Overleaf 快照一致
- manifest 中的 `docId/path/baseVersion` 完整可追踪

### Step 2.3 集成 Claude Code / Codex provider

**目标**

让 bridge 能统一调用不同 agent。

**接口建议**

```ts
interface AIProvider {
  runTask(input: {
    workspacePath: string
    prompt: string
    allowedGlobs?: string[]
  }): Promise<{
    summary: string
    changedFiles: string[]
    rawOutput?: string
  }>
}
```

**完成内容**

- `claude-code` provider
- `codex` provider
- provider 输出统一为“修改后的文件集合 + 摘要”

**验收方式**

- provider 能在指定工作目录运行
- 一次简单任务可以修改 `main.tex`
- bridge 能识别哪些文件发生了变化

---

## Phase 3: 前端 AI 面板

### Step 3.1 新增 AI 面板目录

**建议目录**

- `services/web/frontend/js/features/ai-assistant/`

**建议文件**

- `ai-assistant-panel.tsx`
- `ai-assistant-context.tsx`
- `use-ai-bridge.ts`
- `ai-assistant-root.tsx`
- `ai-assistant.scss`

**完成内容**

- 聊天输入框
- 当前项目 / 当前文件上下文展示
- 任务执行状态
- 变更预览入口

**验收方式**

- 打开 doc 后可见 AI 面板入口
- 输入 prompt 后能向 bridge 发请求
- 能显示运行中 / 成功 / 失败状态

### Step 3.2 选择正确挂载点

**不要直接改**

- `services/web/frontend/js/features/source-editor/components/source-editor.tsx`

这个文件只是 lazy wrapper，不是适合承载复杂 UI 状态的地方。

**建议挂载点**

优先二选一：

1. `services/web/frontend/js/features/ide-react/components/layout/editor.tsx`
2. `services/web/frontend/js/features/source-editor/components/codemirror-editor.tsx`

推荐优先放在 `editor.tsx` 层，原因：

- 更容易控制侧栏布局
- 不污染 CodeMirror 内部组件树
- 更适合承载 AI 面板这种编辑器外侧 UI

**验收方式**

- 面板可展开/收起
- 不影响原有 `SourceEditor`、审阅面板、symbol palette
- 编辑器尺寸变化后布局仍正常

### Step 3.3 快捷键接入

**不要使用**

- `Ctrl/Cmd + K`

理由：

- 现有 Emacs keymap 已占用 `C-k`
- 会和用户已有编辑习惯冲突

**建议修改文件**

- `services/web/frontend/js/features/source-editor/extensions/shortcuts.ts`

**建议快捷键**

- `Mod-Alt-k`

**完成内容**

- 打开/关闭 AI 面板
- 快捷键事件埋点

**验收方式**

- 默认 keymap 下可正常触发
- Emacs / Vim 模式下不破坏已有行为

---

## Phase 4: 显式 Apply 流程

### Step 4.1 bridge 生成变更集而不是立即提交

**目标**

AI 运行后，先给前端返回候选修改。

**bridge 输出建议**

```json
{
  "summary": "更新了摘要并修复了引用",
  "changes": [
    {
      "path": "/main.tex",
      "oldContent": "...",
      "newContent": "...",
      "baseVersion": 12
    }
  ]
}
```

**验收方式**

- AI 运行后，前端先看到 diff，而不是文档立刻被改写

### Step 4.2 前端展示 diff 并由用户确认

**完成内容**

- 文件级变更列表
- 单文件 diff 视图
- “Apply selected” 按钮
- “Discard” 按钮

**验收方式**

- 用户可以只应用一部分文件
- 取消后 Overleaf 文档不发生变化

### Step 4.3 调用 Apply API 回写

**完成内容**

- 前端把选中的变更提交给 `POST /project/:project_id/ai/apply`
- 成功后刷新相关打开文档状态
- 冲突时展示“需要重新生成”的提示

**验收方式**

- 选中的 doc 在 Overleaf 中被正确更新
- 未选中的 doc 保持不变
- 冲突时不会发生静默覆盖

---

## Phase 5: 冲突处理与增强

### Step 5.1 冲突策略

**MVP 策略**

- 基于 `baseVersion` 的硬校验
- 一旦 doc 已被别人修改，拒绝 apply

**后续增强**

- 提供“重新基于最新版本生成”
- 对非重叠修改尝试自动 merge

**验收方式**

- 双用户同时编辑同一文件时，AI apply 能稳定拒绝冲突提交

### Step 5.2 增量 workspace 更新

**目标**

避免每次都重建整个工作区。

**完成内容**

- manifest hash 比较
- 仅更新受影响的文本文件
- 失效时退回全量重建

**验收方式**

- 大项目重复调用时，第二次执行明显少于首次写盘量

### Step 5.3 流式输出

**目标**

改善 AI 体验，但不改变核心写入模型。

**完成内容**

- bridge 向前端流式发送 agent 日志 / 中间状态
- 最终仍以“变更集 + 用户确认”结束

**验收方式**

- 长任务执行时，前端能持续显示进度

---

## 推荐实施顺序

建议按下面顺序做，而不是先写前端聊天 UI。

1. Phase 0：开关和配置
2. Phase 1：workspace snapshot + apply API
3. Phase 2：bridge + workspace materialization
4. Phase 4：显式 apply 闭环
5. Phase 3：前端 UI 和快捷键
6. Phase 5：冲突处理、增量同步、流式体验

原因很简单：如果快照和 apply 闭环还没建立，前端聊天面板只会制造一个看起来能说话、实际上无法安全改文件的半成品。

---

## 每阶段验收清单

### MVP 完成标准

满足以下 6 条即可认为 MVP 完成：

- [ ] 前端可打开 AI 面板
- [ ] bridge 可拉取指定项目 workspace 快照
- [ ] bridge 可在临时工作区调用 Claude Code 或 Codex
- [ ] AI 运行后可返回文件级 diff
- [ ] 用户确认后可将单文件或多文件修改回写到 Overleaf
- [ ] 冲突时能拒绝写入且不静默覆盖

### 不通过条件

出现任意一条都不应视为可上线：

- [ ] 通过 watcher 自动把本地文件变化持续回写
- [ ] 未确认就自动改写 Overleaf 文档
- [ ] 绕过 `document-updater` / web API 直接写底层存储
- [ ] 无版本校验直接覆盖协作者修改

---

## 测试方案

## 1. 单元测试

### Step T1 Snapshot 组装

**测试点**

- 项目树路径解析
- doc 内容拼装
- manifest 生成

**验收方式**

- 对包含多级目录和多个 doc 的 fixture，返回路径与内容完全匹配

### Step T2 Apply 校验

**测试点**

- `baseVersion` 一致时成功
- `baseVersion` 不一致时拒绝
- 只应用选中文件

**验收方式**

- 覆盖成功/冲突/部分选择三类 case

### Step T3 Provider 适配

**测试点**

- provider 参数构建
- workspacePath 传递
- changedFiles 提取

**验收方式**

- Claude Code 和 Codex provider 都可在 mock 场景返回统一结构

## 2. 集成测试

### Step IT1 单文件闭环

**场景**

- 打开一个 `main.tex`
- 让 AI 修改一段内容
- 用户确认 apply

**验收方式**

- Overleaf 页面中内容更新
- 文档版本号前进
- 不出现误导性外部更新错误框

### Step IT2 多文件闭环

**场景**

- 同时修改 `main.tex` 和 `sections/intro.tex`

**验收方式**

- 两个文件都被正确更新
- 未修改文件不受影响

### Step IT3 协作冲突

**场景**

- 用户 A 生成 AI diff
- 用户 B 在此期间修改同一文件
- 用户 A 再 apply

**验收方式**

- apply 被拒绝
- 前端得到明确冲突提示

## 3. 手动验收清单

1. 启动 Overleaf 开发环境
2. 启动 `ai-bridge`
3. 打开一个含多文件的 LaTeX 项目
4. 打开 AI 面板并发送任务
5. 查看生成的文件级 diff
6. 只勾选其中一个文件 apply
7. 确认 Overleaf 中只有该文件被更新
8. 让另一个浏览器标签页修改同一文件，再次 apply
9. 确认系统拒绝冲突写入

---

## 建议的首批代码落点

### Overleaf Web

- `services/web/app/src/Features/AI/AIController.mjs`
- `services/web/app/src/Features/AI/AIService.mjs`
- `services/web/app/src/router.mjs`
- `services/web/frontend/js/features/ai-assistant/`
- `services/web/frontend/js/features/ide-react/components/layout/editor.tsx`
- `services/web/frontend/js/features/source-editor/extensions/shortcuts.ts`
- `services/web/frontend/js/features/ide-react/context/editor-manager-context.tsx`

### Local Bridge

- `services/ai-bridge/package.json`
- `services/ai-bridge/src/server.ts`
- `services/ai-bridge/src/overleaf-client.ts`
- `services/ai-bridge/src/workspace-manager.ts`
- `services/ai-bridge/src/provider/claude-code.ts`
- `services/ai-bridge/src/provider/codex.ts`

---

## 最后一句话

这套方案的核心不是“把 AI 接进编辑器”，而是“在不破坏 Overleaf 现有协作和持久化链路的前提下，为 AI 提供一个可工作的文件系统投影视图，并把改动安全地带回 Overleaf”。

只要坚持：

- 快照投影
- 显式 apply
- 版本校验
- API 集成

这条路就是稳的。
