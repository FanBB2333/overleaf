# Overleaf AI Assistant 集成方案 - TODOs

## 项目概述

在Overleaf编辑器界面中集成本地AI助手（Claude Code），通过虚拟文件系统适配层实现。

---

## 原有Overleaf架构说明

### 1. 文档存储流程

```
用户编辑 → Frontend (CodeMirror) → WebSocket → Real-time Service
                                                        ↓
                                            document-updater (Redis)
                                                        ↓
                                            docstore (MongoDB)
                                                        ↓
                                            filestore (S3)
```

**关键文件路径：**
- Frontend编辑器: `services/web/frontend/js/features/source-editor/`
- 实时更新: `services/document-updater/app/js/DocumentManager.js`
- 文档存储: `services/docstore/app/js/DocManager.js`
- MongoDB管理: `services/docstore/app/js/MongoManager.js`

### 2. 文档数据结构

```javascript
// MongoDB中的文档格式
{
  _id: ObjectId(docId),
  project_id: ObjectId(projectId),
  lines: ["\\documentclass{article}", "\\begin{document}", ...],  // 按行存储
  version: 123,
  ranges: { comments: [...], changes: [...] },  // 追踪修改
  rev: 45,  // 乐观锁版本号
  pathname: "main.tex",  // 文件路径（元数据）
  inS3: false  // 是否已归档到S3
}
```

### 3. 实时协作机制

- 使用 **ShareJS** 的 Operational Transformation (OT) 算法
- 多用户编辑通过 `document-updater` 服务协调
- Redis作为实时缓存，MongoDB作为持久化存储

---

## 新增AI集成架构

```
┌─────────────────────────────────────────────────────────────┐
│ Overleaf Frontend (Browser)                                 │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ CodeMirror Editor (原有)                                │ │
│ │ + AI Assistant Panel (新增) ←────────────────────────┐  │ │
│ │   - Chat界面                                         │  │ │
│ │   - 代码建议显示                                      │  │ │
│ │   - 快捷键触发 (Ctrl+K)                              │  │ │
│ └─────────────────────────────────────────────────────────┘ │
│              ↕ WebSocket (新增连接)                         │
└─────────────────────────────────────────────────────────────┘
                    ↕
┌─────────────────────────────────────────────────────────────┐
│ AI Bridge Server (本地机器 - 新增服务)                      │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Virtual File System Adapter                             │ │
│ │ - 监听Overleaf项目变化                                   │ │
│ │ - MongoDB文档 → 本地文件映射                            │ │
│ │ - 本地文件修改 → Overleaf API同步                       │ │
│ └─────────────────────────────────────────────────────────┘ │
│              ↕ Overleaf REST API                            │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ /tmp/overleaf-project-{id}/  (临时文件系统)             │ │
│ │   ├── main.tex                                          │ │
│ │   ├── chapters/                                         │ │
│ │   │   ├── chapter1.tex                                  │ │
│ │   │   └── chapter2.tex                                  │ │
│ │   └── references.bib                                    │ │
│ └─────────────────────────────────────────────────────────┘ │
│              ↕ File System                                  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Claude Code / Local AI                                  │ │
│ │ - 读取本地文件                                           │ │
│ │ - 生成代码建议                                           │ │
│ │ - 修改文件内容                                           │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 需要修改/新增的文件

### 阶段1: 本地Bridge服务器 (新增)

#### 1.1 创建新服务目录
```bash
mkdir -p services/ai-bridge
cd services/ai-bridge
npm init -y
```

**路径:** `services/ai-bridge/`

**文件清单:**
- [ ] `services/ai-bridge/package.json` - 依赖配置
- [ ] `services/ai-bridge/server.js` - 主服务器
- [ ] `services/ai-bridge/lib/virtual-fs.js` - 虚拟文件系统适配器
- [ ] `services/ai-bridge/lib/overleaf-client.js` - Overleaf API客户端
- [ ] `services/ai-bridge/lib/ai-client.js` - AI调用封装
- [ ] `services/ai-bridge/config.js` - 配置文件

#### 1.2 核心功能实现

**文件:** `services/ai-bridge/lib/virtual-fs.js`
```javascript
// 功能：
// 1. 从Overleaf API获取项目所有文档
// 2. 将 {lines: [...]} 转换为本地文件
// 3. 监听本地文件变化
// 4. 将文件修改同步回Overleaf
```

**文件:** `services/ai-bridge/lib/overleaf-client.js`
```javascript
// 需要调用的Overleaf API:
// GET  /project/:project_id/doc/:doc_id
// POST /project/:project_id/doc/:doc_id (更新文档)
// GET  /project/:project_id/docs (获取所有文档)
```

**文件:** `services/ai-bridge/lib/ai-client.js`
```javascript
// 功能：
// 1. 调用本地Claude Code CLI
// 2. 或集成其他本地AI模型
// 3. 处理AI响应并格式化
```

---

### 阶段2: Overleaf前端修改

#### 2.1 新增AI助手组件

**路径:** `services/web/frontend/js/features/ai-assistant/`

**文件清单:**
- [ ] `ai-assistant-panel.tsx` - AI聊天面板UI
- [ ] `ai-assistant-context.tsx` - React Context管理状态
- [ ] `use-websocket.ts` - WebSocket连接Hook
- [ ] `ai-assistant.scss` - 样式文件

**修改点说明:**
```typescript
// 新增组件，不修改现有代码
// 通过React Portal挂载到编辑器侧边栏
```

#### 2.2 修改编辑器主组件

**文件:** `services/web/frontend/js/features/source-editor/components/source-editor.tsx`

**修改内容:**
```typescript
// 原有代码 (保持不变):
export function SourceEditor() {
  return (
    <div className="source-editor">
      <CodeMirrorEditor />
    </div>
  )
}

// 修改后 (添加AI面板):
import { AIAssistantPanel } from '../../ai-assistant/ai-assistant-panel'

export function SourceEditor() {
  const [showAI, setShowAI] = useState(false)

  return (
    <div className="source-editor">
      <CodeMirrorEditor />

      {/* 新增: AI助手面板 */}
      {showAI && (
        <div className="ai-sidebar">
          <AIAssistantPanel />
        </div>
      )}

      {/* 新增: 切换按钮 */}
      <button onClick={() => setShowAI(!showAI)}>
        🤖 AI
      </button>
    </div>
  )
}
```

**影响范围:** 仅添加新功能，不影响现有编辑器逻辑

#### 2.3 添加快捷键支持

**文件:** `services/web/frontend/js/features/source-editor/extensions/keybindings.ts`

**修改内容:**
```typescript
// 添加 Ctrl+K 快捷键触发AI助手
{
  key: 'Ctrl-k',
  run: (view) => {
    // 触发AI助手面板
    window.dispatchEvent(new CustomEvent('toggle-ai-assistant'))
    return true
  }
}
```

---

### 阶段3: Overleaf后端API扩展 (可选)

**说明:** 如果需要更好的集成，可以在web服务添加专门的AI API端点

**文件:** `services/web/app/src/Features/AI/AIController.mjs` (新增)

**路由:** `services/web/app/src/router.mjs`
```javascript
// 新增路由
app.post('/project/:project_id/ai/chat', AIController.chat)
app.get('/project/:project_id/ai/context', AIController.getContext)
```

**功能:**
- 提供项目上下文给AI
- 记录AI交互历史
- 权限控制

---

## 实现步骤 (按优先级)

### Phase 1: 最小可行原型 (MVP)

- [ ] **Step 1.1:** 创建AI Bridge服务器基础框架
  - 文件: `services/ai-bridge/server.js`
  - 功能: WebSocket服务器 + 基础路由
  - 预计时间: 2小时

- [ ] **Step 1.2:** 实现虚拟文件系统适配器
  - 文件: `services/ai-bridge/lib/virtual-fs.js`
  - 功能: Overleaf文档 → 本地文件映射
  - 预计时间: 4小时

- [ ] **Step 1.3:** 前端WebSocket连接
  - 文件: `services/web/frontend/js/features/ai-assistant/use-websocket.ts`
  - 功能: 建立与Bridge服务器的连接
  - 预计时间: 1小时

- [ ] **Step 1.4:** 简单的AI聊天界面
  - 文件: `services/web/frontend/js/features/ai-assistant/ai-assistant-panel.tsx`
  - 功能: 基础聊天UI
  - 预计时间: 3小时

- [ ] **Step 1.5:** 集成Claude Code
  - 文件: `services/ai-bridge/lib/ai-client.js`
  - 功能: 调用本地Claude Code CLI
  - 预计时间: 2小时

**MVP总计:** ~12小时

### Phase 2: 功能增强

- [ ] **Step 2.1:** 实时文件同步
  - 功能: 监听本地文件变化，自动同步回Overleaf
  - 预计时间: 4小时

- [ ] **Step 2.2:** 代码建议内联显示
  - 功能: 在编辑器中直接显示AI建议
  - 预计时间: 6小时

- [ ] **Step 2.3:** 快捷键支持
  - 功能: Ctrl+K触发AI助手
  - 预计时间: 2小时

- [ ] **Step 2.4:** 上下文感知
  - 功能: AI能理解整个项目结构
  - 预计时间: 4小时

**Phase 2总计:** ~16小时

### Phase 3: 优化与完善

- [ ] **Step 3.1:** 错误处理与重连机制
- [ ] **Step 3.2:** 性能优化（增量同步）
- [ ] **Step 3.3:** UI/UX优化
- [ ] **Step 3.4:** 配置界面（选择AI模型等）
- [ ] **Step 3.5:** 文档与测试

**Phase 3总计:** ~20小时

---

## 关键技术决策

### 1. 为什么不直接修改document-updater?

**原因:**
- document-updater使用OT算法处理实时协作
- AI的批量修改可能与OT冲突
- 通过API层面集成更安全，不破坏现有逻辑

### 2. 为什么需要虚拟文件系统?

**原因:**
- Claude Code期望操作文件系统
- Overleaf文档存储在MongoDB中
- 虚拟文件系统作为适配层，桥接两者

### 3. 为什么使用WebSocket而非HTTP?

**原因:**
- AI响应可能需要流式输出
- 实时双向通信更适合聊天场景
- 可以推送文件变化通知

---

## 测试计划

### 单元测试
- [ ] 虚拟文件系统映射逻辑
- [ ] Overleaf API客户端
- [ ] WebSocket消息处理

### 集成测试
- [ ] 端到端文档同步
- [ ] AI建议应用到编辑器
- [ ] 多用户协作场景

### 手动测试场景
1. 打开Overleaf项目
2. 启动AI Bridge服务器
3. 在编辑器中触发AI助手
4. AI修改代码后，验证同步
5. 多用户同时编辑，验证无冲突

---

## 潜在问题与解决方案

### 问题1: 实时协作冲突

**场景:** 用户A在编辑，AI同时修改同一文档

**解决方案:**
- AI修改前锁定文档
- 或使用OT算法合并AI的修改
- 或提示用户"AI正在工作，请稍候"

### 问题2: 性能问题

**场景:** 大型项目（100+文件）同步慢

**解决方案:**
- 增量同步（只同步修改的文件）
- 延迟加载（按需同步）
- 缓存机制

### 问题3: 安全性

**场景:** 本地Bridge服务器暴露API

**解决方案:**
- 使用Token认证
- 只允许localhost连接
- HTTPS加密通信

---

## 开发环境设置

### 1. 启动Overleaf开发环境
```bash
cd /Users/l1ght/repos/overleaf
npm install
npm run dev
```

### 2. 启动AI Bridge服务器
```bash
cd services/ai-bridge
npm install
npm start
```

### 3. 配置Claude Code
```bash
# 确保Claude Code CLI可用
which claude
# 或安装
npm install -g @anthropic-ai/claude-code
```

---

## 参考资料

### Overleaf相关文件
- 编辑器入口: `services/web/frontend/js/features/source-editor/components/source-editor.tsx`
- 文档管理: `services/docstore/app/js/DocManager.js`
- 实时更新: `services/document-updater/app/js/DocumentManager.js`
- WebSocket处理: `services/web/app/src/Features/Collaborators/`

### 技术栈
- Frontend: React + TypeScript + CodeMirror 6
- Backend: Node.js + Express + WebSocket
- AI: Claude Code CLI / Anthropic API

---

## 下一步行动

**立即开始:**
1. 创建 `services/ai-bridge/` 目录
2. 实现基础WebSocket服务器
3. 测试与Overleaf前端的连接

**需要帮助时:**
- 查看此文档的"实现步骤"部分
- 参考"关键技术决策"了解设计思路
- 遇到问题查看"潜在问题与解决方案"

---

## 更新日志

- 2025-01-XX: 初始版本创建
