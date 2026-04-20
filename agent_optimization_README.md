# Agent Optimization Plan & Implementation Log

> **日期**: 2026-04-16
> **范围**: GUI路径 (VS Code插件内聊天)，最小改动实现
> **目标**: 解决 agent 模式下 tool_call 失败、读文件卡死、thinking 历史膨胀、压缩通知不足等问题

---

## 改动方案 (Plan)

### P0-1: readFile / tool 超时机制

- **问题**: `VsCodeIde.readFile()` 中 `stat()` + `readFile()` 无超时，如果文件系统提供程序挂起会永久等待
- **方案**: 在 `VsCodeIde.readFile()` 中包裹 `Promise.race` 超时保护（30s）
- **文件**: `extensions/vscode/src/VsCodeIde.ts`
- **改动量**: ~10行

### P0-2: agent 循环迭代上限 (GUI路径)

- **问题**: `streamNormalInput` 通过 `depth` 参数递归调用自身（tool call → streamResponseAfterToolCall → streamNormalInput），测试环境有50轮限制，生产环境无限制
- **方案**: 将 depth 上限从仅测试环境改为生产环境也生效，上限50轮，超过后 dispatch setInactive + setInlineErrorMessage 提示用户
- **文件**: `gui/src/redux/thunks/streamNormalInput.ts`, `gui/src/components/mainInput/InlineErrorMessage.tsx`
- **改动量**: ~15行

### P1-1: tool_call 解析失败 → 反馈模型自修复

- **问题**: `safeParseToolCallArgs()` 解析失败时静默返回 `{}`，console.error 被注释。后续 `getStringArg` 抛错但错误信息不含原始参数，模型无法自修复
- **方案**:
  1. 恢复 console.error 日志
  2. 解析失败时抛出带原始 arguments 摘要的错误（而非返回 `{}`）
  3. 上层 `callTool` 已有 catch 将错误返回给模型，模型可据此重试
- **文件**: `core/tools/parseArgs.ts`
- **改动量**: ~8行

### P1-2: 压缩时用户可见通知

- **问题**: 自动压缩时用户几乎无感知，ContextStatus 只有小电池图标
- **方案**:
  1. 自动压缩触发时 dispatch `setInlineErrorMessage("auto-compacting")` 显示内联消息
  2. 在 InlineErrorMessage 组件中新增 "auto-compacting" 类型渲染
  3. 压缩完成/失败后清除消息
- **文件**: `gui/src/redux/thunks/streamNormalInput.ts`, `gui/src/components/mainInput/InlineErrorMessage.tsx`
- **改动量**: ~20行

### P2-1: 历史 thinking 内容裁剪

- **问题**: 所有 thinking 消息都保留在历史中参与 token 计数，浪费上下文空间
- **方案**: 在 `constructMessages()` 中只保留最近2轮的 thinking 消息，更早的跳过
- **文件**: `gui/src/redux/util/constructMessages.ts`
- **改动量**: ~15行

### P2-2: 滑动窗口压缩策略

- **问题**: 压缩后所有旧消息丢弃，只剩摘要。最近几轮消息也丢细节
- **方案**: 压缩时保留最近3轮完整消息（user+assistant对），只对更早的消息生成摘要。在 `compactConversation` 调用时调整 compactIndex 即可
- **文件**: `gui/src/redux/thunks/streamNormalInput.ts` (自动压缩的 compactIndex 计算), `gui/src/util/compactConversation.ts` (手动压缩)
- **改动量**: ~5行

### P3: 分级压缩阈值

- **问题**: 当前只有80%一个阈值触发自动压缩
- **方案**:
  - 75%: ContextStatus 显示更明显的警告色（黄色）
  - 85%: 自动触发压缩（从80%调至85%，给用户更多空间）
  - 95%+isPruned: 建议新会话
- **文件**: `gui/src/redux/thunks/streamNormalInput.ts`, `gui/src/components/mainInput/ContextStatus.tsx`
- **改动量**: ~10行

---

## 实现记录

> 以下按实施顺序记录每个改动的具体内容，所有改动已完成并通过编译检查

### [P0-1] readFile 超时 — `extensions/vscode/src/VsCodeIde.ts`

- 新增 `READ_FILE_TIMEOUT_MS = 30_000` 常量
- 新增 `withTimeout<T>()` 工具方法，使用 `Promise.race` 实现超时
- `readFile()` 中的 `stat()` 和 `readFile()` 两个磁盘IO调用包裹超时保护
- 超时后走已有的 catch(e) 路径返回空字符串
- 内存中的 notebook/openDocument 读取不受超时影响（无磁盘IO）
- catch 中增加 `console.warn` 日志，方便故障排查

### [P0-2] Agent 迭代上限 — `gui/src/redux/thunks/streamNormalInput.ts` + `gui/src/components/mainInput/InlineErrorMessage.tsx`

- 新增 `MAX_AGENT_ITERATIONS = 50` 常量
- 将 depth 检查从仅测试环境 (`process.env.NODE_ENV === "test"`) 改为所有环境生效
- 超限时 dispatch `setInlineErrorMessage("max-iterations")` + `setInactive()` 优雅停止
- InlineErrorMessage 新增 `"max-iterations"` 类型：显示黄色警告 + Hide 按钮

### [P1-1] tool_call 解析错误反馈 — `core/tools/parseArgs.ts` + `core/tools/callTool.ts`

- 新增 `ToolCallParseError` 类，包含 toolName 和 rawArgs 摘要（前200字符）
- 保留 `safeParseToolCallArgs()` 原有静默行为（用于 Gemini/Bedrock/Anthropic LLM provider 构造消息）
- 新增 `strictParseToolCallArgs()`：解析失败时抛出 `ToolCallParseError`
- `callTool()` 改用 `strictParseToolCallArgs()`，其已有的 catch 块会将错误信息返回给模型
- 模型收到包含原始参数摘要的错误后可以自行修正参数格式重试
- 恢复了被注释的 console.error 日志

### [P1-2] 压缩用户可见通知 — `gui/src/redux/thunks/streamNormalInput.ts` + `gui/src/components/mainInput/InlineErrorMessage.tsx`

- 自动压缩前 dispatch `setInlineErrorMessage("auto-compacting")`
- 压缩完成/失败后 dispatch `setInlineErrorMessage(undefined)` 清除通知
- InlineErrorMessage 新增 `"auto-compacting"` 类型：显示 "Context window getting full. Auto-compacting..." 提示
- 压缩失败时不阻断正常流程（try-catch-finally 保证清理）

### [P2-1] Thinking 裁剪 — `gui/src/redux/util/constructMessages.ts`

- 在消息构建前，从后往前遍历 history 统计 thinking 消息数量
- 使用 Set 记录需要保留的 thinking 消息索引（最近2轮）
- 循环中对 `role === "thinking"` 的消息检查是否在保留集中，不在则跳过
- 更早的 thinking 消息不进入 msgs，节省 token 开销

### [P2-2] 滑动窗口压缩 — `gui/src/redux/thunks/streamNormalInput.ts`

- 自动压缩时 compactIndex 计算改为保留最近3轮（6条消息）
- `preserveCount = Math.min(6, history.length - 2)`
- `compactIndex = Math.max(0, history.length - 2 - preserveCount)`
- 只对更早的消息生成摘要，最近几轮保持原始精度

### [P3] 分级压缩阈值 — `gui/src/redux/thunks/streamNormalInput.ts` + `gui/src/components/mainInput/ContextStatus.tsx`

- `AUTO_COMPACT_THRESHOLD` 从 0.8 调整为 0.85（给用户更多操作空间）
- ContextStatus 进度条颜色分级：
  - 60-75%: 灰色（`bg-description`）
  - 75-85%: 黄色（`bg-warning`）+ 警告文案
  - 85%+: 红色（`bg-error`）+ "Auto-compaction will trigger soon" 提示
  - isPruned: 红色 + 粗体 "Strongly recommend starting a new session"

---

## 改动文件清单

| 文件                                                  | 改动类型 | 描述                                                    |
| ----------------------------------------------------- | -------- | ------------------------------------------------------- |
| `extensions/vscode/src/VsCodeIde.ts`                  | 修改     | readFile 超时保护                                       |
| `gui/src/redux/thunks/streamNormalInput.ts`           | 修改     | agent迭代上限 + 压缩通知 + 滑动窗口 + 阈值调整          |
| `gui/src/components/mainInput/InlineErrorMessage.tsx` | 修改     | 新增 max-iterations 和 auto-compacting 消息类型         |
| `gui/src/components/mainInput/ContextStatus.tsx`      | 修改     | 分级颜色 + 分级警告文案                                 |
| `gui/src/redux/util/constructMessages.ts`             | 修改     | thinking 内容裁剪（保留最近2轮）                        |
| `core/tools/parseArgs.ts`                             | 修改     | 新增 ToolCallParseError + strictParseToolCallArgs       |
| `core/tools/callTool.ts`                              | 修改     | 使用 strictParseToolCallArgs 替代 safeParseToolCallArgs |
| `core/util/conversationCompaction.ts`                 | 修改     | 压缩预处理：跳过thinking + 截断大tool output            |

---

## 后续优化方向

1. **CLI 路径同步**: 将相同的超时/迭代上限/thinking裁剪逻辑同步到 `extensions/cli/src/stream/` 路径
2. **Tool 级别超时差异化**: 为不同 tool 设置不同超时（readFile 30s, runTerminalCommand 120s, searchWeb 30s 等）
3. **用户可配置**: 将 MAX_AGENT_ITERATIONS、超时时间、AUTO_COMPACT_THRESHOLD 暴露为配置项
4. **Telemetry**: 对超时、迭代上限、压缩触发等事件添加 posthog tracking

---

## 第二轮优化：压缩质量优化

### [追加] 压缩输入预处理 — `core/util/conversationCompaction.ts`

- **问题**: 压缩时将所有消息（包括 thinking、大文件读取结果）原样发给摘要模型，浪费大量 token
- **方案**:
  1. 跳过 `role === "thinking"` 消息（模型内部推理对摘要无价值）
  2. 截断 `role === "tool"` 内容到 2000 字符（大文件/终端输出只保留摘要级别的内容）
  3. 截断处添加 `...[truncated, N chars omitted]` 标记
- **新增常量**: `MAX_TOOL_CONTENT_CHARS_FOR_COMPACTION = 2000`
- **新增函数**: `truncateForCompaction()` — 超长内容截断并添加标记
- **改动文件**: `core/util/conversationCompaction.ts`

---

## 第三轮优化：IntelliJ 侧适配 + Qwen 模型支持

### [追加] IntelliJ readFile 超时 — `extensions/intellij/.../IntelliJIde.kt`

- 新增 `READ_FILE_TIMEOUT_MS = 30_000L` 常量
- `readFile()` 包裹 `withTimeout` + `Dispatchers.IO`（使阻塞调用可被协程取消）
- 超时返回空字符串并打印日志

### [追加] IntelliJ writeFile 错误可见 — `extensions/intellij/.../file/FileUtils.kt`

- `writeFile()` 中的 `return LOG.warn(...)` 改为 `throw IllegalArgumentException/IllegalStateException`
- 错误信息包含原始 URI 便于排查
- Core 侧 callTool catch 块可将错误反馈给模型自修复

### [追加] IdeProtocolClient 异常时 respond — `extensions/intellij/.../IdeProtocolClient.kt`

- catch 块末尾加 `respond(null)`
- 防止任何 IDE 操作异常导致 Core 的 request Promise 永久挂起

### [追加] findFile VFS 缓存优先 — `extensions/intellij/.../file/FileUtils.kt`

- `findFile()` 先用 `findFileByUrl()`（内存缓存，不阻塞）
- 找不到才 fallback 到 `refreshAndFindFileByUrl()`
- 已加载文件场景下避免昂贵的 VFS 磁盘刷新

### [追加] Ripgrep 硬超时 + 进程杀死 — `extensions/intellij/.../IntelliJIde.kt`

- 新增 `execWithTimeout()` 方法：`Process.waitFor(timeout)` + `destroyForcibly()`
- 用 `CompletableFuture.supplyAsync` 在独立线程消费 stdout 防止管道缓冲区死锁
- `getFileResults()` 和 `getSearchResults()` 使用此方法替代 `ExecUtil.execAndGetOutput`

### [追加] getDocumentSymbols dumb mode 保护 — `extensions/intellij/.../IntelliJIde.kt`

- `getDocumentSymbols()` 在 `DumbService.isDumb` 时直接返回空列表
- 避免项目索引期间 PSI 访问异常

### [追加] Qwen 模型 tool call 支持 — `core/llm/toolSupport.ts`

- `openai` provider 的 tool support 检测中加入 `lower.includes("qwen")` 匹配
- 用 `provider: openai` + 自定义 `apiBase` 指向 sglang 端点时，模型名含 "qwen" 即可启用 tool call

### IntelliJ 改动文件清单

| 文件                                           | 改动类型 | 描述                                        |
| ---------------------------------------------- | -------- | ------------------------------------------- |
| `extensions/intellij/.../IntelliJIde.kt`       | 修改     | readFile 超时 + execWithTimeout + dumb mode |
| `extensions/intellij/.../file/FileUtils.kt`    | 修改     | writeFile 抛异常 + findFile 缓存优先        |
| `extensions/intellij/.../IdeProtocolClient.kt` | 修改     | 异常时 respond(null) 防 Core 挂起           |
| `core/llm/toolSupport.ts`                      | 修改     | openai provider 加 Qwen tool support        |

---

## 能力全景评估（vs GitHub Copilot / Cursor / Claude Code）

> 评估日期: 2026-04-17
> 基于 continue v1.3.19 代码库实际实现核查

### 已达到/接近顶尖水平的能力

| 能力                  | 现状                                                              | 评价                           |
| --------------------- | ----------------------------------------------------------------- | ------------------------------ |
| 基础文件操作          | read/edit/create/multiEdit（含模糊匹配+缩进调整）                 | 超过 Claude Code               |
| Rules 系统            | 4 种触发模式 + glob/regex + colocated rules.md + agent 可自主创建 | 超过所有竞品                   |
| Grep/Glob 搜索        | ripgrep 底层                                                      | 持平                           |
| 语义代码搜索          | codebaseTool: Embedding + 可选 Reranker                           | 持平 Cursor                    |
| Context Provider 生态 | 30 种（含 Postgres/Jira/GitLab/Discord/Greptile 等）              | 远超 Claude Code，持平 Copilot |
| Prompt caching        | Anthropic `cache_control: ephemeral` + OpenRouter 已实现          | 已有                           |
| 图像/多模态           | `ImageMessagePart` + Anthropic/OpenAI 适配器处理图片              | 已有                           |
| Plan 模式             | 独立 "plan" mode + 只读工具约束 + 专属 system message             | 已有                           |
| Background Agent      | 控制面板发起远程执行 + 状态跟踪 + 拉回本地                        | 接近 Cursor Background         |
| 多 Provider + 开源    | 支持 OpenAI/Anthropic/Gemini/DeepSeek/Ollama/sglang/vLLM 等       | 独特优势                       |
| Web 搜索              | searchWeb + fetchUrlContent 工具                                  | 已有                           |

### 已有但存在差距的能力

| 能力                    | 现状                                                          | 差距点                          |
| ----------------------- | ------------------------------------------------------------- | ------------------------------- |
| LSP 诊断                | VS Code `getProblems` 完整实现 + `@problems` context provider | 缺独立 tool，agent 不能主动调用 |
| Git 历史                | GitCommitContextProvider 存在                                 | 已标记 deprecated，推荐 Git MCP |
| 终端执行                | runTerminalCommand 文档明确 "shell is not stateful"           | 无会话持久化/后台任务管理       |
| viewRepoMap             | LLM 生成含签名 + viewSubdirectory 子目录级                    | 依赖 LLM 质量，不如 AST 精确    |
| Inline Edit             | ApplyManager 完整                                             | 交互不如 Cursor 流畅            |
| Autocomplete + NextEdit | 完整架构（NextEdit 捕获 ±5 行预测编辑）                       | 延迟和质量落后一档              |
| Tool call 健壮性        | 本轮已补 strictParseToolCallArgs + 错误反馈                   | 缺结构化重试策略                |
| Codebase Indexing       | 向量索引 + repo map                                           | 增量刷新粗糙；缺符号级索引      |

### 确认缺失的能力

| 能力                      | Copilot         | Cursor        | Claude Code  | Continue |
| ------------------------- | --------------- | ------------- | ------------ | -------- |
| TODO 列表 / 任务追踪 UI   | ✅              | ⚠️            | ✅           | ❌       |
| 本地子 Agent 分派         | ✅ runSubagent  | ⚠️ Background | ✅ Task tool | ❌       |
| 专用测试执行/失败捕获     | ✅ test_failure | ✅            | ⚠️ bash      | ❌       |
| 自动验证循环              | ✅              | ⚠️            | ✅           | ❌       |
| LSP findReferences/rename | ✅              | ✅            | ❌           | ❌       |
| Composer 多文件 diff 预览 | ✅              | ✅ 一等公民   | ⚠️           | ❌       |
| 浏览器自动化              | ✅ Playwright   | ⚠️ preview    | ❌           | ❌       |

### 改进路线图（按 ROI 排序，含实现追踪）

#### S 级 — 极高价值 + 低成本

- [x] **#1 getProblems 升级为 Agent tool** — 极低成本（定义+实现各 20 行）✅ 已实施
  - 底层已完整实现，仅差 tool 包装；做完 agent 改完代码可自查编译错误
- [x] **#2 TODO 列表工具 + 简易 UI** — 低成本 ✅ 已实施
  - 模型行为更收敛，用户有透明度
- [x] **#3 终端持久化会话** — 中成本 ✅ 已实施
  - sessionId + PTY 管理
- [x] **#4 Rules 自动沉淀** — 低成本 ✅ 已实施
  - createRuleBlock 已存在，只需在合适时机触发

#### A 级 — 高价值 + 中成本

- [x] **#5 Tool call 结构化重试** — callTool 错误反馈已有，但缺系统重试 ✅ 已实施
- [x] **#6 验证循环 skill** — 基于 Plan 模式 + getProblems 组合 ✅ 已实施
- [x] **#7 本地子 agent** — Background 模式架构可参考 ✅ 已实施
- [ ] **#8 Git 历史正式化** — 复活 deprecated provider 或接入 Git MCP
- [ ] **#9 Prompt caching 扩展** — 仅 Anthropic/OpenRouter 有，OpenAI 未做

#### B 级 — 高价值 + 高成本

- [x] **#10 LSP 符号操作（findReferences/rename）** — IntelliJ 侧工程量大 ✅ 已实施（含 IntelliJ 适配）
- [ ] **#11 Composer 多文件 diff 预览** — 大量 UI 工作
- [ ] **#12 Autocomplete 质量** — 架构完整但模型层受限

#### C 级 — 锦上添花

- [ ] **#13 笔记本编辑** — 小众场景
- [ ] **#14 浏览器自动化** — 大工程
- [ ] **#15 专用测试执行** — 可用 runTerminalCommand 替代

### 战略建议

**差异化方向**：放大 Rules 系统优势，做"活的项目知识库"

- Agent 完成任务自动沉淀 rules
- 团队 rules 通过 `.continue/rules/` 随仓库共享（Cursor/Copilot 做不到）
- 开源 + 多 provider + 精细化模式匹配 = 复合壁垒

**不建议追赶的战场**：

- Autocomplete 质量（Cursor 有专有模型，投入产出比极差）
- Composer UI（Cursor 全职设计团队支撑）

**本轮工作定位**：可靠性级改进（超时/报错/压缩/兼容性），为下一阶段能力扩展打基础

---

## 详细方案：#1 getProblems 升级为 Agent Tool

> 评估日期: 2026-04-20

### 现状分析

| 层级                         | VS Code                                | IntelliJ                                                | 说明                                |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| IDE 方法 `getProblems()`     | ✅ `vscode.languages.getDiagnostics()` | ✅ `DocumentMarkupModel.allHighlighters`                | 双端已完整实现                      |
| IPC 消息协议                 | ✅ `core/protocol/ide.ts`              | ✅ `IdeProtocolClient.kt`                               | 消息桥已通                          |
| `@problems` context provider | ✅ 可用                                | ❌ 被显式过滤（代码注释: "not supported in jetbrains"） | IntelliJ 底层有但 provider 层被禁用 |
| Agent Tool（模型主动调用）   | ❌ 不存在                              | ❌ 不存在                                               | **本次要做的**                      |

### 核心价值

1. **自动验证循环**：agent 改完代码后主动调用 → 发现编译错误 → 自动修复（当前是"盲改"）
2. **定向修 bug**：用户说"帮我修编译错误"→ agent 精准拿到 error message + 位置
3. **重构验证**：rename/重构后检查是否有遗漏引用导致的 type error
4. **竞品对标**：Copilot/Claude Code 中模型最频繁主动调用的 tool 之一

### 实现方案

#### Step 1: 定义 Tool — `core/tools/builtIn.ts`

在 `BuiltInToolNames` 枚举中新增 `"getProblems"`

#### Step 2: 实现 Tool — `core/tools/implementations/getProblems.ts`

```typescript
import { BuiltInToolNames } from "../builtIn.js";
import { ToolImpl } from "../util.js";

export const getProblemsImpl: ToolImpl = async (args, extras) => {
  const { ide } = extras;
  const filepath = args.filepath as string | undefined;

  const problems = await ide.getProblems(filepath);

  if (problems.length === 0) {
    return [
      {
        name: "No Problems",
        description: "No errors or warnings found.",
        content: "No problems detected.",
      },
    ];
  }

  const formatted = problems
    .map(
      (p) =>
        `${p.filepath}:${p.range.start.line + 1}:${p.range.start.character} [${p.severity}] ${p.message}`,
    )
    .join("\n");

  return [
    {
      name: "Problems",
      description: `Found ${problems.length} problem(s)`,
      content: formatted,
    },
  ];
};
```

#### Step 3: 注册 Tool — `core/tools/implementations/index.ts`

将 `getProblemsImpl` 加入 tool 注册表

#### Step 4: Tool 参数定义

```json
{
  "name": "getProblems",
  "description": "Get compiler/linter errors and warnings. Call with no arguments to get all problems, or specify a filepath to get problems for a specific file. Use this after editing files to verify changes compile correctly.",
  "parameters": {
    "type": "object",
    "properties": {
      "filepath": {
        "type": "string",
        "description": "Optional. Absolute path to check for problems. If omitted, returns problems for all open files."
      }
    }
  }
}
```

#### Step 5: IntelliJ `@problems` 解禁

- 文件: `core/config/loadContextProviders.ts` L80-85
- 删除 `if (isJetBrains) { filter out problems }` 条件
- IntelliJ 底层 `getProblems()` 已实现，只是 context provider 层被人为禁用

### 工作量估算

| 步骤          | 文件                                        | 改动量      |
| ------------- | ------------------------------------------- | ----------- |
| 枚举定义      | `core/tools/builtIn.ts`                     | +1 行       |
| Tool 实现     | `core/tools/implementations/getProblems.ts` | 新建 ~30 行 |
| 注册          | `core/tools/implementations/index.ts`       | +2 行       |
| 参数 schema   | tool 定义处                                 | ~15 行      |
| IntelliJ 解禁 | `core/config/loadContextProviders.ts`       | 删除 ~5 行  |
| **总计**      |                                             | **~50 行**  |

### 后续组合：验证循环

getProblems tool 完成后，可通过 system message / rules 实现自动验证循环：

```
After editing any file, always call getProblems to check for compilation errors.
If errors are found, fix them before proceeding to the next task.
```

这等效于 Copilot 的 `get_errors` tool 行为，无需额外代码。

---

## 详细方案：#10 LSP 符号操作（findReferences / rename）

> 评估日期: 2026-04-20

### 现状分析

| 方法                           | VS Code IDE 实现 | IntelliJ IDE 实现            | Agent Tool |
| ------------------------------ | ---------------- | ---------------------------- | ---------- |
| `gotoDefinition(location)`     | ✅ L85           | ❌ throw NotImplementedError | ❌         |
| `gotoTypeDefinition(location)` | ✅ L96           | ❌ throw NotImplementedError | ❌         |
| `getReferences(location)`      | ✅ L118          | ❌ throw NotImplementedError | ❌         |
| `getDocumentSymbols(uri)`      | ✅ L129          | ✅ PSI (有 dumb mode 保护)   | ❌         |
| `getProblems(fileUri?)`        | ✅ L650          | ✅ HighlightInfo             | ❌         |
| `rename(symbol, newName)`      | ❌ 接口不存在    | ❌ 接口不存在                | ❌         |

### 价值评估

- **findReferences**：重命名/重构前查所有引用点，比 grep 精确（不匹配注释/字符串中的同名词）
- **rename**：语义级跨文件重命名（含 import 路径更新），比 sed/replace 安全
- **gotoDefinition（作为 tool）**：agent 看到函数调用想了解实现 → 精确跳转而非模糊搜索

### 为何评为 B 级

1. **VS Code 侧低成本**：底层 `getReferences()` 已实现，包装成 tool 只需 ~30 行
2. **IntelliJ 侧高成本**：`gotoDefinition`/`getReferences` 全部 `throw NotImplementedError`，需要：
   - 在 EDT 线程安全调用 PsiElement.getReferences()
   - 处理 dumb mode / 索引未完成场景
   - 跨模块引用需要 ProjectFileIndex 配合
   - 工程量估算：每个方法 ~80-120 行 Kotlin
3. **rename 需要新增 IDE 接口**：`core/index.d.ts` 中无 `rename` 方法定义

### 分阶段实现方案

#### Phase 1: VS Code only — getReferences tool（低成本）

```typescript
// core/tools/implementations/getReferences.ts
export const getReferencesImpl: ToolImpl = async (args, extras) => {
  const { ide } = extras;
  const { filepath, line, character } = args;

  const locations = await ide.getReferences({
    uri: filepath,
    position: { line: Number(line), character: Number(character) },
  });

  if (locations.length === 0) {
    return [
      {
        name: "No References",
        description: "No references found.",
        content: "No references found.",
      },
    ];
  }

  const formatted = locations
    .map(
      (loc) =>
        `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character}`,
    )
    .join("\n");

  return [
    {
      name: "References",
      description: `Found ${locations.length} reference(s)`,
      content: formatted,
    },
  ];
};
```

**局限**：IntelliJ 用户调用时会 throw error（需要 callTool catch 返回 "not supported" 给模型）

#### Phase 2: IntelliJ 实现底层方法（高成本）

```kotlin
// IntelliJIde.kt — gotoDefinition 实现骨架
override suspend fun gotoDefinition(location: Location): List<Location> = withContext(Dispatchers.EDT) {
    if (DumbService.isDumb(project)) return@withContext emptyList()

    val psiFile = findPsiFile(location.uri) ?: return@withContext emptyList()
    val offset = getOffset(psiFile, location.position)
    val element = psiFile.findElementAt(offset) ?: return@withContext emptyList()
    val resolved = element.reference?.resolve() ?: return@withContext emptyList()

    listOf(psiElementToLocation(resolved))
}

// getReferences 实现骨架
override suspend fun getReferences(location: Location): List<Location> = withContext(Dispatchers.IO) {
    if (DumbService.isDumb(project)) return@withContext emptyList()

    val psiFile = findPsiFile(location.uri) ?: return@withContext emptyList()
    val offset = getOffset(psiFile, location.position)
    val element = psiFile.findElementAt(offset) ?: return@withContext emptyList()

    val results = ReferencesSearch.search(element, ProjectScope.projectScope(project))
    results.mapNotNull { ref -> psiElementToLocation(ref.element) }
}
```

#### Phase 3: rename tool（需新增接口）

1. `core/index.d.ts` 新增：`rename(location: Location, newName: string): Promise<void>`
2. VS Code 实现：调用 `vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", ...)`
3. IntelliJ 实现：`RefactoringFactory.getInstance(project).createRename(element, newName)`
4. Tool 包装：接受 filepath + line + character + newName

### 工作量估算

| Phase                                | 改动量                      | 前置条件          |
| ------------------------------------ | --------------------------- | ----------------- |
| Phase 1 (VS Code getReferences tool) | ~50 行                      | 无                |
| Phase 2 (IntelliJ 底层实现)          | ~300 行 Kotlin              | IntelliJ 开发环境 |
| Phase 3 (rename 全链路)              | ~150 行 TS + ~100 行 Kotlin | Phase 1 + 2       |

### 建议

- Phase 1 可以和 #1 getProblems 一起做（同批 tool 注册，半天工作量）
- Phase 2/3 推迟到有 IntelliJ 开发资源时再做
- VS Code 用户先享受 getReferences，IntelliJ 用户 graceful fallback 到 grep

---

## 详细方案：#7 本地子 Agent 分派

> 评估日期: 2026-04-20

### 现状分析

| 路径                    | 现有能力                                            | 缺失                                   |
| ----------------------- | --------------------------------------------------- | -------------------------------------- |
| CLI (`extensions/cli/`) | ✅ 完整 subagent：executor + tool 定义 + agent 发现 | —                                      |
| GUI-VS Code (`gui/`)    | ❌ 无本地 subagent                                  | 只有远端 Background Agent（需登录+云） |
| GUI-IntelliJ            | ❌ 无                                               | 同上                                   |

CLI 路径已验证的架构：

- `extensions/cli/src/subagent/executor.ts` — 子会话执行
- `extensions/cli/src/subagent/get-agents.ts` — agent 发现
- `extensions/cli/src/tools/subagent.ts` — tool 定义（name, prompt, subagent_name 参数）

### 核心优势

1. **上下文隔离**：子 agent 历史不回流到父 agent，父 agent 只收到简短结果摘要。解决 token 膨胀的架构级方案
2. **并行执行**：多个独立任务并行处理（如"给 5 个文件加单测"→ 5 个子 agent 并行）
3. **失败隔离**：子 agent 超时/死循环只影响自身，父 agent 收到 `{ success: false }` 可决定重试或跳过
4. **无需云依赖**：完全本地运行，适用于离线/内网/自托管 LLM 场景

### 实现方案

#### 架构设计

```
┌─────────────────────────────────────────────┐
│  GUI streamNormalInput (父 agent)            │
│  ├─ tool_call: subagent(prompt, name)       │
│  │   ┌─────────────────────────────────┐    │
│  │   │ 子 agent session (独立历史)      │    │
│  │   │ ├─ streamNormalInput(depth=0)    │    │
│  │   │ ├─ tool calls (readFile, edit…)  │    │
│  │   │ └─ return final response         │    │
│  │   └─────────────────────────────────┘    │
│  ├─ tool_result: "子 agent 摘要结果"         │
│  └─ continue...                              │
└─────────────────────────────────────────────┘
```

#### Step 1: Tool 定义 — `core/tools/builtIn.ts` + `core/tools/implementations/subagent.ts`

```typescript
// Tool 参数
{
  name: "subagent",
  description: "Launch a subagent to handle a complex sub-task independently. The subagent runs in an isolated context and returns a summary result. Use for tasks that are independent from the current work.",
  parameters: {
    type: "object",
    required: ["prompt", "description"],
    properties: {
      prompt: { type: "string", description: "Detailed task description for the subagent" },
      description: { type: "string", description: "Short 3-5 word label for the task" },
    }
  }
}
```

#### Step 2: GUI 侧执行器 — `gui/src/redux/thunks/executeSubagent.ts`

核心逻辑（参考 CLI executor）：

```typescript
export async function executeSubagent(
  prompt: string,
  parentDispatch: AppDispatch,
  ideMessenger: IIdeMessenger,
  config: ContinueConfig,
): Promise<{ success: boolean; response: string }> {
  // 1. 创建独立的 history（不影响父会话）
  const childHistory: ChatHistoryItem[] = [
    {
      message: { role: "user", content: prompt },
      contextItems: [],
    },
  ];

  // 2. 使用相同的 model config 但独立的 depth 计数
  // 3. 调用 streamResponse 系列函数处理子会话
  // 4. 子 agent 也受 MAX_AGENT_ITERATIONS 限制
  // 5. 返回最终 assistant 消息作为结果

  return { success: true, response: lastAssistantMessage };
}
```

#### Step 3: callTool 集成

在 `callTool` 的 switch/case 中处理 `"subagent"` tool：

- 调用 `executeSubagent()`
- 将返回值包装为 tool result 回传给父 agent
- 父 agent 继续基于摘要结果决策

#### 难点与解决方案

| 难点                                                | 解决方案                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| IDE 操作并发（两个子 agent 同时 editFile 同一文件） | 串行化 IDE 操作队列（或 V1 先禁止并行子 agent）             |
| 子 agent 的 tool 权限                               | 继承父 agent 权限，V1 不做差异化                            |
| UI 展示（子 agent 进度）                            | V1 作为 tool call 的 streaming output 展示；V2 独立面板     |
| Token 消耗翻倍                                      | 子 agent 使用更小/更快的模型（配置化）；或复用父 agent 模型 |
| 取消/中断                                           | 父 agent abort 时级联 abort 子 agent 的 AbortController     |

#### 分阶段交付

| Phase                 | 内容                                                | 工作量        |
| --------------------- | --------------------------------------------------- | ------------- |
| V1: 串行单子 agent    | tool 定义 + 独立 history + 串行执行 + 结果回传      | ~200 行       |
| V2: 并行 + 进度 UI    | 并行执行多个子 agent + IDE 操作队列 + 进度面板      | ~500 行       |
| V3: 专用子 agent 模型 | 配置不同模型给子 agent（快/便宜模型处理简单子任务） | ~50 行 config |

### 与 CLI 实现的差异

| 维度       | CLI 路径                         | GUI 路径（待实现）                       |
| ---------- | -------------------------------- | ---------------------------------------- |
| IDE 操作   | 直接文件系统操作                 | 通过 webview ↔ extension host messenger |
| 会话管理   | services 单例覆盖/恢复           | 独立 Redux state slice 或内存 history    |
| Tool 权限  | serviceContainer 覆盖            | 继承父 session 权限                      |
| 输出展示   | terminal text stream             | webview tool call UI                     |
| Agent 发现 | ModelService.getSubagentModels() | config.models 或新增 subagentModel 配置  |

### 工作量估算

| 组件                        | 改动量      |
| --------------------------- | ----------- |
| Tool 定义 + builtIn 注册    | ~30 行      |
| executeSubagent 执行器      | ~150 行     |
| callTool 集成               | ~20 行      |
| IDE 操作串行化（V1 简化版） | ~30 行      |
| **V1 总计**                 | **~230 行** |

---

## 详细方案：#3 终端持久化会话

> 评估日期: 2026-04-20

### 问题分析

当前 `runTerminalCommand` **每次调用 spawn 一个全新 shell 子进程**，命令执行完进程退出。工具描述中明确写了：

> "The shell is not stateful and will not remember any previous commands."
> — `core/tools/definitions/runTerminalCommand.ts` L28

**具体表现**：

- `cd /some/dir` → 下一次调用又回到默认目录
- `export MY_VAR=foo` → 下一次调用变量丢失
- `source venv/bin/activate` → 下一次调用 venv 未激活
- 无法运行交互式程序（无 stdin 写入）
- 无法启动服务后再与之交互

### 现状基础设施

| 组件                      | 文件                                                  | 状态                                               |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `runTerminalCommand` 实现 | `core/tools/implementations/runTerminalCommand.ts`    | `childProcess.spawn()` 每次新进程                  |
| 进程状态追踪              | `core/util/processTerminalStates.ts`                  | 仅追踪当前正在执行的进程（不跨调用持久化）         |
| node-pty 封装             | `extensions/vscode/src/terminal/terminalEmulator.ts`  | 代码存在但被注释（"node-pty is causing problems"） |
| CLI 后台任务              | `extensions/cli/src/services/BackgroundJobService.ts` | 管理后台进程生命周期，不提供跨调用 shell           |
| VS Code 终端集成          | `VsCodeIde.runCommand()`                              | 用 `sendText()` 发命令到集成终端（无输出捕获）     |

### 核心收益

1. **环境累积**：agent 可以分步构建复杂环境（cd → activate → install → test）
2. **后台服务交互**：启动 dev server 后可继续 curl 测试
3. **Token 节省**：拆分长命令链，每步独立看输出、独立决策
4. **交互式程序**：回答 Y/N 确认、与 REPL 交互、输入密码

### 竞品对比

| 能力         | Copilot                             | Claude Code         | Continue 当前     |
| ------------ | ----------------------------------- | ------------------- | ----------------- |
| 有状态 shell | ✅ PTY session + send_to_terminal   | ✅ bash tool 持久化 | ❌ 每次新进程     |
| 后台进程管理 | ✅ async mode + get_terminal_output | ⚠️ 手动 & + 检查    | ⚠️ GUI 有简陋标记 |
| 交互式输入   | ✅ send_to_terminal                 | ⚠️ 有限             | ❌ 无 stdin       |

### 实现方案

#### 架构设计

```
┌────────────────────────────────────────────────┐
│  TerminalSessionManager (extension host 侧)     │
│  ├─ sessions: Map<sessionId, PTYSession>        │
│  │   └─ PTYSession {                            │
│  │       pty: node-pty.IPty                     │
│  │       outputBuffer: string[]                 │
│  │       lastActivity: timestamp                │
│  │       cwd: string                            │
│  │   }                                          │
│  ├─ createSession(cwd?) → sessionId             │
│  ├─ sendCommand(sessionId, cmd) → output        │
│  ├─ getOutput(sessionId, since?) → output       │
│  ├─ destroySession(sessionId)                   │
│  └─ cleanupIdleSessions(timeout=5min)           │
└────────────────────────────────────────────────┘
```

#### Step 1: 修改 `runTerminalCommand` tool 参数

新增可选参数：

```json
{
  "parameters": {
    "type": "object",
    "required": ["command"],
    "properties": {
      "command": { "type": "string" },
      "sessionId": {
        "type": "string",
        "description": "Optional. Reuse an existing terminal session. If omitted, uses the default persistent session."
      },
      "waitForCompletion": { "type": "boolean", "default": true }
    }
  }
}
```

#### Step 2: TerminalSessionManager — `extensions/vscode/src/terminal/TerminalSessionManager.ts`

```typescript
import * as pty from "node-pty";

interface PTYSession {
  pty: pty.IPty;
  outputBuffer: string;
  lastCommandOutput: string;
  lastActivity: number;
  cwd: string;
}

const DEFAULT_SESSION = "__default__";
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

export class TerminalSessionManager {
  private sessions = new Map<string, PTYSession>();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60_000);
  }

  getOrCreateSession(sessionId = DEFAULT_SESSION, cwd?: string): PTYSession {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/bash";
    const ptyProcess = pty.spawn(shell, [], {
      cwd: cwd || process.cwd(),
      cols: 120,
      rows: 30,
    });
    const session: PTYSession = {
      pty: ptyProcess,
      outputBuffer: "",
      lastCommandOutput: "",
      lastActivity: Date.now(),
      cwd: cwd || process.cwd(),
    };
    ptyProcess.onData((data) => {
      session.outputBuffer += data;
      session.lastActivity = Date.now();
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  async sendCommand(
    sessionId: string,
    command: string,
    timeout = 120_000,
  ): Promise<string> {
    const session = this.getOrCreateSession(sessionId);
    const marker = `__CMD_DONE_${Date.now()}__`;
    session.lastCommandOutput = "";
    const startLen = session.outputBuffer.length;

    // 发送命令 + 结束标记
    session.pty.write(`${command}; echo ${marker}\r`);

    // 等待结束标记或超时
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(session.outputBuffer.slice(startLen)),
        timeout,
      );
      const check = setInterval(() => {
        if (session.outputBuffer.includes(marker)) {
          clearInterval(check);
          clearTimeout(timer);
          const output = session.outputBuffer
            .slice(startLen)
            .replace(marker, "")
            .trim();
          resolve(output);
        }
      }, 100);
    });
  }

  destroySession(sessionId: string) {
    /* kill pty + remove from map */
  }
  destroyAll() {
    /* 清理所有 session */
  }
  private cleanupIdleSessions() {
    /* 超时未活动的 session 自动销毁 */
  }
}
```

#### Step 3: 集成到 runTerminalCommand 实现

```typescript
// core/tools/implementations/runTerminalCommand.ts 改动
// 当检测到 IDE 支持持久化 session 时:
if (extras.ide.terminalSessionManager) {
  const output = await extras.ide.terminalSessionManager.sendCommand(
    args.sessionId || "__default__",
    command,
    timeout,
  );
  return [{ name: "Terminal Output", content: output }];
}
// fallback: 原有 spawn 逻辑
```

#### Step 4: IDE 接口扩展

`core/index.d.ts` 新增：

```typescript
sendToTerminal?(sessionId: string, text: string): Promise<string>;
getTerminalOutput?(sessionId: string): Promise<string>;
```

#### Step 5: 更新工具描述

从 "The shell is not stateful" 改为：

```
The shell maintains state between calls. Environment variables, working directory,
and running processes persist across multiple invocations within the same session.
```

### 难点与解决方案

| 难点                                    | 解决方案                                                |
| --------------------------------------- | ------------------------------------------------------- |
| node-pty 在某些环境编译失败             | 设为可选依赖，编译失败时 fallback 到原有 spawn 逻辑     |
| 输出分割（区分本次 vs 历史）            | 用唯一 marker（`__CMD_DONE_<timestamp>__`）标记命令结束 |
| PTY 输出含 ANSI 转义码                  | `strip-ansi` 库清理后返回纯文本                         |
| session 泄漏（用户关闭面板但 pty 存活） | idle 超时 + VS Code `onDidCloseTerminal` 事件清理       |
| 远程环境（SSH/WSL）                     | V1 仅本地支持；远程环境 fallback 到 `ide.runCommand()`  |

### 分阶段交付

| Phase                  | 内容                                                 | 工作量  |
| ---------------------- | ---------------------------------------------------- | ------- |
| V1: 默认持久化 session | 单 session + sendCommand + idle 超时 + marker 分割   | ~200 行 |
| V2: 多 session + 交互  | 多 session 管理 + `sendToTerminal` stdin 写入        | ~150 行 |
| V3: 后台进程管理       | `waitForCompletion=false` + `getTerminalOutput` 轮询 | ~100 行 |

### 工作量估算

| 组件                      | 改动量      |
| ------------------------- | ----------- |
| TerminalSessionManager 类 | ~120 行     |
| runTerminalCommand 适配   | ~40 行      |
| IDE 接口 + messenger 路由 | ~30 行      |
| 工具描述更新              | ~10 行      |
| **V1 总计**               | **~200 行** |

---

## 详细方案：#4 Rules 自动沉淀

> 评估日期: 2026-04-20

### Rules 系统回顾

Continue 的 Rules **不是 memory**——它是直接追加到 system message 末尾的文本片段，LLM 每次对话都会看到。

**四种触发模式**：

| 模式                | 条件                       | 注入时机                         |
| ------------------- | -------------------------- | -------------------------------- |
| **Always**          | `alwaysApply: true`        | 每次对话都注入 system message    |
| **Auto Attached**   | 有 `globs`/`regex`         | 对话中出现匹配文件时自动注入     |
| **Agent Requested** | 有 `description`           | AI 根据 description 判断是否拉取 |
| **Manual**          | 无 globs/regex/description | 仅 `@ruleName` 手动引用          |

**Token 影响**：所有命中的规则直接拼入 system message，无数量/大小硬限制，与历史消息共同竞争上下文窗口预算。

### 核心风险（为何不能全自动）

1. **规则冲突**：自动生成的规则 A 说"用 tabs"，规则 B 说"用 spaces"
2. **规则过时**：3 个月前沉淀的规则不再适用当前代码
3. **泛化过度**：特定 bug 中学到的教训被错误地沉淀为全局规则
4. **注意力稀释**：LLM 对 system message 的注意力有限，规则太多每条有效性下降
5. **Token 膨胀**：30 条 × 200 tokens = 6K tokens 固定消耗

### 实现方案：AI 建议 + 人工确认

#### 设计原则

- **不做全自动沉淀** — agent 发现模式后**建议**用户创建规则
- **默认用 glob 限定 scope** — 不创建 always-apply 规则
- **打开文件供审阅** — `createRuleBlock` 已实现此行为
- **数量感知** — 超过阈值时提醒用户整合

#### Step 1: 触发时机识别

在以下场景中，agent 可以建议沉淀规则：

| 场景                     | 识别方式                                   | 建议的规则类型                 |
| ------------------------ | ------------------------------------------ | ------------------------------ |
| 同类错误重复出现 3+ 次   | 连续 tool call 中出现相似错误 message      | glob + regex 匹配该文件类型    |
| 用户明确说"以后都这样做" | 对话中出现 "always"/"每次"/"以后" 等关键词 | always-apply 或 glob           |
| agent 发现项目约定       | 多个文件中一致的模式（命名、导入风格等）   | glob 匹配相关文件              |
| 长任务完成后总结         | agent 完成复杂任务后的总结阶段             | description（Agent Requested） |

#### Step 2: 建议机制（不修改核心代码）

通过 **always-apply rule** 指导 agent 行为（零代码改动方案）：

```markdown
## <!-- .continue/rules/suggest-rules.md -->

name: Rule Suggestion Awareness
alwaysApply: true

---

When you notice any of the following patterns during a conversation:

1. The user corrects you on the same issue more than once
2. You discover a project-specific convention (naming, imports, architecture)
3. The user says "always do X" or "never do Y"
4. You complete a complex task and learned something project-specific

At the end of your response, suggest creating a rule:
"I noticed [pattern]. Would you like me to create a rule for this?
It would apply to [scope] files and ensure [behavior]."

If the user agrees, use the createRuleBlock tool with:

- globs matching the relevant file types (NOT alwaysApply unless user explicitly requests)
- A concise, actionable rule text
- A clear name
```

#### Step 3: 增强版（代码改动，可选）

如果想要更智能的触发，需在 `streamNormalInput` 中添加检测逻辑：

```typescript
// gui/src/redux/thunks/streamNormalInput.ts — 在 agent 完成后
const RULE_SUGGESTION_THRESHOLD = 3; // 同类错误出现 3 次

function detectRepeatPatterns(history: ChatHistoryItem[]): string | null {
  // 分析最近的 tool results 中是否有重复的错误模式
  const toolErrors = history
    .filter(
      (h) => h.message.role === "tool" && h.message.content?.includes("Error"),
    )
    .map((h) => extractErrorSignature(h.message.content));

  const counts = new Map<string, number>();
  for (const err of toolErrors) {
    counts.set(err, (counts.get(err) || 0) + 1);
  }

  for (const [pattern, count] of counts) {
    if (count >= RULE_SUGGESTION_THRESHOLD) return pattern;
  }
  return null;
}
```

#### Step 4: 规则数量管控

```markdown
## <!-- .continue/rules/rule-hygiene.md -->

name: Rule Hygiene
alwaysApply: true

---

Before creating a new rule with createRuleBlock:

1. Check if a similar rule already exists (use grep to search .continue/rules/)
2. Prefer updating existing rules over creating new ones
3. Always use globs to limit scope — avoid alwaysApply unless absolutely necessary
4. Keep rule content under 5 lines — be concise and actionable
```

### 分阶段交付

| Phase                     | 内容                                              | 工作量               |
| ------------------------- | ------------------------------------------------- | -------------------- |
| V1: 指导性 rule（零代码） | 添加 `suggest-rules.md` + `rule-hygiene.md`       | 2 个文件，0 代码改动 |
| V2: 重复模式检测          | `streamNormalInput` 中添加错误模式统计 + 建议逻辑 | ~50 行               |
| V3: 规则清理工具          | 新 tool `manageRules`：列出、删除、合并规则       | ~80 行               |

### 工作量估算

| 组件                    | 改动量          |
| ----------------------- | --------------- |
| V1: 两个 .md 规则文件   | ~30 行 markdown |
| V2: 重复模式检测        | ~50 行 TS       |
| V3: manageRules tool    | ~80 行 TS       |
| **V1 总计（推荐先做）** | **0 代码改动**  |

### 适用场景举例

```
用户: "帮我修这个 TypeScript 错误"
Agent: [修复成功]
Agent: "I noticed this project uses strict null checks and you've had
       similar errors 3 times. Would you like me to create a rule to
       remind future sessions about this? It would apply to *.ts files."
用户: "好的"
Agent: [调用 createRuleBlock]
  → 生成 .continue/rules/strict-null-checks.md:
    ---
    name: TypeScript Strict Null Checks
    globs: "**/*.ts"
    ---
    This project uses strictNullChecks. Always handle nullable types explicitly.
    Use optional chaining (?.) and nullish coalescing (??) instead of non-null assertions (!).
```

---

## 详细方案：#6 验证循环 Skill + 必要 Skill 迁移

> 评估日期: 2026-04-20

### Continue Skill 系统回顾

Continue 有完整的 Skill 架构：

```
存储:  .continue/skills/<name>/SKILL.md  （也兼容 .claude/skills/）
加载:  loadMarkdownSkills() 扫描三个目录
注册:  read_skill tool 动态列出所有 skill 的 name + description
触发:  Agent 根据 tool description 中的技能列表自主调用 read_skill(name)
返回:  SKILL.md 内容 + 同目录辅助文件列表
```

**关键特性**：

- Agent **自主判断**何时调用 skill（不占固定 token，按需加载）
- 支持辅助文件（同目录下放模板、示例代码等）
- 兼容 `.claude/skills/` 目录（可复用 Claude Code 社区 skills）

### 与 Rules 的区别

| 维度       | Skills                      | Rules                                 |
| ---------- | --------------------------- | ------------------------------------- |
| Token 占用 | 按需加载（仅在调用时占用）  | 命中就注入 system message（每次占用） |
| 触发方式   | Agent 自主调用 `read_skill` | 自动（glob/regex）或手动              |
| 内容长度   | 可以很长（整个工作流说明）  | 应简短（5 行内）                      |
| 适用场景   | 复杂工作流、多步骤流程      | 简短约束、编码规范                    |

### 验证循环 Skill 实现

**前提条件**：#1 getProblems tool 已完成

#### SKILL.md 文件

```markdown
## <!-- .continue/skills/verification-loop/SKILL.md -->

name: verification-loop
description: Verify code changes compile correctly after edits. Use after making any code modifications to catch and fix compilation errors before proceeding.

---

# Verification Loop

## When to Use

- After editing any code file (_.ts, _.tsx, _.py, _.kt, \*.java, etc.)
- After refactoring or renaming
- After adding new imports or dependencies
- Before claiming a task is complete

## Procedure

1. **Check for problems** — Call `getProblems` on the edited file(s)
2. **Analyze errors** — Read each error message and its location
3. **Fix errors** — Apply targeted fixes (do NOT rewrite entire files for minor issues)
4. **Re-check** — Call `getProblems` again to verify the fix
5. **Repeat** — Loop until no errors remain (max 3 iterations per file)

## Escape Conditions

- If the same error persists after 3 fix attempts → inform the user
- If errors are in files you didn't edit → report but don't fix (may be pre-existing)
- If errors are only warnings (not errors) → report but continue

## Anti-patterns to Avoid

- Do NOT suppress errors with `// @ts-ignore` or `# type: ignore` unless explicitly asked
- Do NOT add try/catch blocks solely to silence type errors
- Do NOT change function signatures to avoid errors (may break callers)

## Example Flow
```

Edit file.ts → getProblems("file.ts") →
2 errors found →
Fix error 1 (missing import) →
Fix error 2 (type mismatch) →
getProblems("file.ts") →
0 errors → ✅ proceed

```

```

#### 配套 Rule（让 agent 知道什么时候该用这个 skill）

```markdown
## <!-- .continue/rules/verify-after-edit.md -->

name: Verify After Edit
globs: "\*_/_.{ts,tsx,js,jsx,py,kt,java,rs,go,cs}"

---

After editing code files, use the verification-loop skill to check for compilation errors.
```

### 必要 Skill 迁移计划

基于竞品分析和实际使用需求，以下 skills 对项目开发高度必要：

#### 优先级 1：直接创建（无外部依赖）

| Skill                    | 描述                 | 来源/参考                                    |
| ------------------------ | -------------------- | -------------------------------------------- |
| **verification-loop**    | 改代码后验证编译     | 上述方案                                     |
| **systematic-debugging** | 遇 bug 时的排查流程  | 参考 `.copilot/skills/systematic-debugging/` |
| **task-decomposition**   | 复杂任务拆解为子步骤 | 参考 `.copilot/skills/writing-plans/`        |

#### 优先级 2：从 Copilot skills 适配

你的 `.copilot/skills/` 目录有现成内容，可以适配为 Continue 格式：

| Copilot Skill                             | 迁移为 Continue Skill                            | 适配工作                                    |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `systematic-debugging/SKILL.md`           | `.continue/skills/systematic-debugging/SKILL.md` | 去掉 Copilot 特有引用，改用 Continue 工具名 |
| `verification-before-completion/SKILL.md` | `.continue/skills/verification-loop/SKILL.md`    | 合并入上述验证循环                          |
| `test-driven-development/SKILL.md`        | `.continue/skills/tdd/SKILL.md`                  | 适配 runTerminalCommand 用法                |
| `writing-plans/SKILL.md`                  | `.continue/skills/task-planning/SKILL.md`        | 直接使用（内容通用）                        |

#### 优先级 3：新建（竞品有但 Copilot skills 中没有的）

| Skill                     | 描述                | 内容要点                                                    |
| ------------------------- | ------------------- | ----------------------------------------------------------- |
| **refactoring-safety**    | 安全重构工作流      | 1.查引用 2.改代码 3.验证编译 4.运行相关测试                 |
| **git-commit-convention** | commit message 格式 | conventional commits + scope + breaking change              |
| **project-onboarding**    | 新项目快速上手      | 1.读 README 2.查目录结构 3.找 package.json/build 4.识别框架 |

### Skill 文件创建计划

#### `.continue/skills/systematic-debugging/SKILL.md`

```markdown
---
name: systematic-debugging
description: Diagnose bugs methodically before proposing fixes. Use when encountering errors, test failures, or unexpected behavior.
---

# Systematic Debugging

## Principle

Understand the bug BEFORE fixing it. Never apply speculative fixes.

## Procedure

1. **Reproduce** — Identify exact steps/input that trigger the bug
2. **Locate** — Use getProblems, grep, and readFile to find the error source
3. **Understand** — Read surrounding code to understand intended behavior
4. **Hypothesize** — Form a specific theory about root cause
5. **Verify** — Confirm hypothesis with evidence (not assumptions)
6. **Fix** — Apply minimal, targeted fix
7. **Validate** — Run getProblems + relevant tests to confirm

## Anti-patterns

- Do NOT guess-and-check with random changes
- Do NOT fix symptoms without understanding root cause
- Do NOT rewrite working code "just in case"
- Do NOT add error handling to mask the real issue

## When Stuck

- Check git history for recent changes to affected area
- Search for similar patterns elsewhere in codebase
- Look at test files for expected behavior documentation
- Ask user for clarification rather than guessing
```

#### `.continue/skills/task-planning/SKILL.md`

```markdown
---
name: task-planning
description: Break complex tasks into manageable steps before implementation. Use when facing multi-file changes or tasks with unclear scope.
---

# Task Planning

## When to Use

- Task involves 3+ files
- Requirements are ambiguous
- Task has multiple possible approaches
- Risk of breaking existing functionality

## Procedure

1. **Clarify** — Identify any ambiguity in requirements (ask user if needed)
2. **Scope** — List all files that need changes
3. **Order** — Determine dependency order (which changes depend on others)
4. **Plan** — Write numbered steps, each producing a verifiable result
5. **Execute** — Work through steps one at a time
6. **Verify** — After each step, check for errors before proceeding

## Plan Format
```

Step 1: [action] in [file] — [expected result]
Step 2: [action] in [file] — [expected result]
...

```

## Guidelines
- Each step should be independently verifiable
- Keep steps small enough to easily revert
- Mark dependencies between steps explicitly
- If a step fails, reassess the plan before continuing
```

### 迁移工具：批量适配脚本

对于从 `.copilot/skills/` 迁移，核心改动是：

1. 将 `SKILL.md` 复制到 `.continue/skills/<name>/SKILL.md`
2. YAML frontmatter 只保留 `name` + `description`（移除 Copilot 特有字段如 `file`）
3. 内容中将 Copilot 工具名替换为 Continue 工具名：
   - `run_in_terminal` → `runTerminalCommand`
   - `read_file` → `readFile`（Continue 用驼峰）
   - `get_errors` → `getProblems`（待实现 #1 后）
   - `grep_search` → `exactSearch`

### 工作量估算

| 组件                           | 改动量                           |
| ------------------------------ | -------------------------------- |
| verification-loop SKILL.md     | ~40 行 markdown                  |
| verify-after-edit rule         | ~6 行 markdown                   |
| systematic-debugging SKILL.md  | ~35 行 markdown                  |
| task-planning SKILL.md         | ~35 行 markdown                  |
| refactoring-safety SKILL.md    | ~30 行 markdown                  |
| git-commit-convention SKILL.md | ~20 行 markdown                  |
| **总计**                       | **~170 行 markdown，0 代码改动** |

### 依赖关系

```
#1 getProblems tool ──→ verification-loop skill 可完整工作
                    ──→ refactoring-safety skill 可完整工作
#10 getReferences  ──→ refactoring-safety skill 的 "查引用" 步骤
#3 终端持久化      ──→ tdd skill 的 "运行测试" 步骤更流畅
```

### 注意事项

- Skills 是**按需加载**的，不占固定 token 预算（和 rules 不同）
- 每个 skill 建议控制在 50 行以内，太长的 skill 会浪费加载时的 token
- skill 的 `description` 是关键——它出现在 `read_skill` tool 的描述中，帮助 agent 决定是否调用
- 可以通过观察 agent 是否频繁调用某个 skill 来评估其价值

---

## 详细方案：#2 TODO 列表工具 + 简易 UI

> 评估日期: 2026-04-20

### 价值分析

- 让 agent 在处理多步骤任务时有**可见的进度追踪**
- 用户可以实时看到 agent 的计划和进展
- 模型输出更收敛（有明确的步骤列表约束行为）
- Copilot 和 Claude Code 都有此功能，是高频使用的 tool

### 设计方案

#### Tool 定义

```typescript
// 两个互补的 tool：manageTodoList（创建/更新列表）和 getTodoList（查看当前状态）
{
  name: "manage_todo_list",
  description: "Create and manage a task list to track progress. Use when working on multi-step tasks. Update status as you complete each step.",
  parameters: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        description: "Complete list of all todo items with their current status",
        items: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "number", description: "Sequential ID starting from 1" },
            title: { type: "string", description: "Short action-oriented description" },
            status: { type: "string", enum: ["not-started", "in-progress", "completed"], description: "Current status" }
          }
        }
      }
    }
  }
}
```

#### 实现架构

```
┌─────────────────────────────────────────────┐
│  Core: manage_todo_list tool                 │
│  ├─ 接收完整 items 数组                      │
│  ├─ 存储到 session 级别的 state              │
│  └─ 返回确认 context item                    │
├─────────────────────────────────────────────┤
│  GUI: TodoList 组件                          │
│  ├─ 在 tool call output 中渲染              │
│  ├─ checkbox 样式 + 进度条                   │
│  └─ 折叠/展开交互                            │
└─────────────────────────────────────────────┘
```

#### 状态存储

Tool 本身是**无状态**的 — 每次调用传入完整列表（和 Copilot 的 `manage_todo_list` 设计一致）。这避免了跨调用状态管理的复杂性。

#### GUI 渲染

利用现有的 tool call output 渲染机制：

- Tool 返回的 `ContextItem.content` 是格式化的 markdown checkbox list
- GUI 的 `StyledMarkdownPreview` 已有 `.task-list-item` CSS 样式
- 无需新增 React 组件，利用现有 markdown 渲染即可

### 实现步骤

| 步骤    | 文件                                           | 内容                                       |
| ------- | ---------------------------------------------- | ------------------------------------------ |
| 1. 枚举 | `core/tools/builtIn.ts`                        | 新增 `ManageTodoList = "manage_todo_list"` |
| 2. 定义 | `core/tools/definitions/manageTodoList.ts`     | Tool schema + metadata                     |
| 3. 实现 | `core/tools/implementations/manageTodoList.ts` | 格式化为 markdown checkbox                 |
| 4. 注册 | `core/tools/callTool.ts`                       | switch case 新增                           |
| 5. 导出 | `core/tools/definitions/index.ts`              | 加入 allTools                              |

### 实现代码

```typescript
// core/tools/implementations/manageTodoList.ts
import { ToolImpl } from ".";

interface TodoItem {
  id: number;
  title: string;
  status: "not-started" | "in-progress" | "completed";
}

export const manageTodoListImpl: ToolImpl = async (args, extras) => {
  const items = args.items as TodoItem[];

  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const inProgress = items.filter((i) => i.status === "in-progress").length;

  const lines = items.map((item) => {
    const checkbox = item.status === "completed" ? "[x]" : "[ ]";
    const marker = item.status === "in-progress" ? " ⏳" : "";
    return `- ${checkbox} ${item.title}${marker}`;
  });

  const progress = `Progress: ${completed}/${total} completed${inProgress > 0 ? `, ${inProgress} in progress` : ""}`;
  const content = `${progress}\n\n${lines.join("\n")}`;

  return [
    {
      name: "Todo List",
      description: progress,
      content,
    },
  ];
};
```

### 工作量估算

| 组件        | 改动量     |
| ----------- | ---------- |
| 枚举 + 注册 | ~5 行      |
| Tool 定义   | ~40 行     |
| Tool 实现   | ~30 行     |
| **总计**    | **~75 行** |

---

## 详细方案：#5 Tool Call 结构化重试

> 评估日期: 2026-04-20

### 现状分析

当前错误处理流程：

1. `callTool()` catch 异常 → 返回 `{ errorMessage }`
2. `callToolById` 检测到 error → dispatch `updateToolCallOutput` 写入错误 context item
3. 错误文本作为 tool role message 加入历史
4. `streamNormalInput` 再次调用 LLM → LLM 自行决定是否重试

**问题**：

- LLM 可能忽略错误继续做其他事
- 重复同样错误的调用（LLM 不改参数）导致无限循环
- 没有重试计数器，无法区分"第一次失败"和"已经失败 5 次了"

### 设计原则

1. **不在 core 层自动重试** — 保持 tool 调用的确定性，让 LLM 主动决策
2. **增强错误反馈信息** — 在错误消息中添加重试建议和失败计数
3. **相同错误重复上限** — 连续 3 次相同 tool + 相同错误签名时，强制停止并提示用户

### 实现方案

#### 方案核心：错误追踪 + 增强反馈

```typescript
// core/tools/callTool.ts 中新增

interface ToolErrorTracker {
  consecutiveErrors: Map<string, { count: number; lastError: string }>;
}

const MAX_CONSECUTIVE_SAME_ERRORS = 3;

function getErrorKey(toolName: string, errorMessage: string): string {
  // 取错误消息前100字符作为签名（忽略动态部分如行号）
  return `${toolName}:${errorMessage.slice(0, 100)}`;
}
```

#### 改动点 1: callTool 返回增强错误信息

```typescript
// 在 callTool 的 catch 中：
const enhancedError = formatToolError(toolName, errorMessage, retryCount);

function formatToolError(
  toolName: string,
  error: string,
  attemptNumber: number,
): string {
  let msg = `Tool "${toolName}" failed: ${error}`;
  if (attemptNumber > 1) {
    msg += `\n\n⚠️ This is attempt #${attemptNumber} with a similar error.`;
  }
  if (attemptNumber >= MAX_CONSECUTIVE_SAME_ERRORS) {
    msg += `\nYou have failed ${attemptNumber} times with similar errors. Stop retrying and inform the user about the issue.`;
  } else {
    msg += `\nPlease analyze the error and try a different approach.`;
  }
  return msg;
}
```

#### 改动点 2: GUI 侧追踪连续错误

在 `callToolById.ts` 或 `streamNormalInput.ts` 中追踪：

```typescript
// gui/src/redux/thunks/callToolById.ts — 新增错误追踪
const toolErrorCounts = new Map<string, number>(); // session-level

function trackToolError(toolName: string, error: string): number {
  const key = `${toolName}:${error.slice(0, 100)}`;
  const count = (toolErrorCounts.get(key) || 0) + 1;
  toolErrorCounts.set(key, count);
  return count;
}

function clearToolErrors(toolName: string) {
  // 工具成功后清除该工具的错误计数
  for (const key of toolErrorCounts.keys()) {
    if (key.startsWith(`${toolName}:`)) toolErrorCounts.delete(key);
  }
}
```

#### 改动点 3: 达到上限时强制停止

```typescript
// 在 callToolById 的错误处理中：
if (errorCount >= MAX_CONSECUTIVE_SAME_ERRORS) {
  // 不再继续 agent loop，而是停止并提示用户
  dispatch(setInlineErrorMessage("tool-retry-limit"));
  dispatch(setInactive());
  return; // 不调用 streamResponseAfterToolCall
}
```

### 与现有机制的关系

| 现有机制                                    | 本方案增强                       |
| ------------------------------------------- | -------------------------------- |
| `ToolCallParseError` — 解析失败返回原始参数 | 保持不变，本方案在其上层         |
| `MAX_AGENT_ITERATIONS = 50` — 全局迭代上限  | 本方案是更细粒度的"相同错误"上限 |
| 错误消息返回 LLM                            | 增强消息内容（加入计数+建议）    |

### 工作量估算

| 组件                                            | 改动量     |
| ----------------------------------------------- | ---------- |
| 错误追踪逻辑（Map + track/clear）               | ~30 行     |
| 增强错误消息格式化                              | ~20 行     |
| 达到上限时停止 agent loop                       | ~15 行     |
| InlineErrorMessage 新增 "tool-retry-limit" 类型 | ~10 行     |
| **总计**                                        | **~75 行** |

### 注意事项

- 错误追踪是 session 级别（页面刷新清零）
- 只追踪**连续**的相同错误 — 工具成功后清零
- 不做自动 backoff/delay — LLM 自行决定重试时机
- 与 sub-agent 兼容 — 子 agent 有独立的错误追踪器

---

## 详细方案：#2 TODO 列表工具 + 简易 UI

> 评估日期: 2026-04-20

### 价值分析

- 让 agent 在处理多步骤任务时有**可见的进度追踪**
- 用户可以实时看到 agent 的计划和进展
- 模型输出更收敛（有明确的步骤列表约束行为）
- Copilot 和 Claude Code 都有此功能，是高频使用的 tool

### 设计方案

#### Tool 定义

```typescript
// 两个互补的 tool：manageTodoList（创建/更新列表）和 getTodoList（查看当前状态）
{
  name: "manage_todo_list",
  description: "Create and manage a task list to track progress. Use when working on multi-step tasks. Update status as you complete each step.",
  parameters: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        description: "Complete list of all todo items with their current status",
        items: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "number", description: "Sequential ID starting from 1" },
            title: { type: "string", description: "Short action-oriented description" },
            status: { type: "string", enum: ["not-started", "in-progress", "completed"], description: "Current status" }
          }
        }
      }
    }
  }
}
```

#### 实现架构

```
┌─────────────────────────────────────────────┐
│  Core: manage_todo_list tool                 │
│  ├─ 接收完整 items 数组                      │
│  ├─ 存储到 session 级别的 state              │
│  └─ 返回确认 context item                    │
├─────────────────────────────────────────────┤
│  GUI: TodoList 组件                          │
│  ├─ 在 tool call output 中渲染              │
│  ├─ checkbox 样式 + 进度条                   │
│  └─ 折叠/展开交互                            │
└─────────────────────────────────────────────┘
```

#### 状态存储

Tool 本身是**无状态**的 — 每次调用传入完整列表（和 Copilot 的 `manage_todo_list` 设计一致）。这避免了跨调用状态管理的复杂性。

#### GUI 渲染

利用现有的 tool call output 渲染机制：

- Tool 返回的 `ContextItem.content` 是格式化的 markdown checkbox list
- GUI 的 `StyledMarkdownPreview` 已有 `.task-list-item` CSS 样式
- 无需新增 React 组件，利用现有 markdown 渲染即可

### 实现步骤

| 步骤    | 文件                                           | 内容                                       |
| ------- | ---------------------------------------------- | ------------------------------------------ |
| 1. 枚举 | `core/tools/builtIn.ts`                        | 新增 `ManageTodoList = "manage_todo_list"` |
| 2. 定义 | `core/tools/definitions/manageTodoList.ts`     | Tool schema + metadata                     |
| 3. 实现 | `core/tools/implementations/manageTodoList.ts` | 格式化为 markdown checkbox                 |
| 4. 注册 | `core/tools/callTool.ts`                       | switch case 新增                           |
| 5. 导出 | `core/tools/definitions/index.ts`              | 加入 allTools                              |

### 实现代码

```typescript
// core/tools/implementations/manageTodoList.ts
import { ToolImpl } from ".";

interface TodoItem {
  id: number;
  title: string;
  status: "not-started" | "in-progress" | "completed";
}

export const manageTodoListImpl: ToolImpl = async (args, extras) => {
  const items = args.items as TodoItem[];

  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const inProgress = items.filter((i) => i.status === "in-progress").length;

  const lines = items.map((item) => {
    const checkbox = item.status === "completed" ? "[x]" : "[ ]";
    const marker = item.status === "in-progress" ? " ⏳" : "";
    return `- ${checkbox} ${item.title}${marker}`;
  });

  const progress = `Progress: ${completed}/${total} completed${inProgress > 0 ? `, ${inProgress} in progress` : ""}`;
  const content = `${progress}\n\n${lines.join("\n")}`;

  return [
    {
      name: "Todo List",
      description: progress,
      content,
    },
  ];
};
```

### 工作量估算

| 组件        | 改动量     |
| ----------- | ---------- |
| 枚举 + 注册 | ~5 行      |
| Tool 定义   | ~40 行     |
| Tool 实现   | ~30 行     |
| **总计**    | **~75 行** |

---

## 详细方案：#5 Tool Call 结构化重试

> 评估日期: 2026-04-20

### 现状分析

当前错误处理流程：

1. `callTool()` catch 异常 → 返回 `{ errorMessage }`
2. `callToolById` 检测到 error → dispatch `updateToolCallOutput` 写入错误 context item
3. 错误文本作为 tool role message 加入历史
4. `streamNormalInput` 再次调用 LLM → LLM 自行决定是否重试

**问题**：

- LLM 可能忽略错误继续做其他事
- 重复同样错误的调用（LLM 不改参数）导致无限循环
- 没有重试计数器，无法区分"第一次失败"和"已经失败 5 次了"

### 设计原则

1. **不在 core 层自动重试** — 保持 tool 调用的确定性，让 LLM 主动决策
2. **增强错误反馈信息** — 在错误消息中添加重试建议和失败计数
3. **相同错误重复上限** — 连续 3 次相同 tool + 相同错误签名时，强制停止并提示用户

### 实现方案

#### 方案核心：错误追踪 + 增强反馈

```typescript
// core/tools/callTool.ts 中新增

interface ToolErrorTracker {
  consecutiveErrors: Map<string, { count: number; lastError: string }>;
}

const MAX_CONSECUTIVE_SAME_ERRORS = 3;

function getErrorKey(toolName: string, errorMessage: string): string {
  // 取错误消息前100字符作为签名（忽略动态部分如行号）
  return `${toolName}:${errorMessage.slice(0, 100)}`;
}
```

#### 改动点 1: callTool 返回增强错误信息

```typescript
// 在 callTool 的 catch 中：
const enhancedError = formatToolError(toolName, errorMessage, retryCount);

function formatToolError(
  toolName: string,
  error: string,
  attemptNumber: number,
): string {
  let msg = `Tool "${toolName}" failed: ${error}`;
  if (attemptNumber > 1) {
    msg += `\n\n⚠️ This is attempt #${attemptNumber} with a similar error.`;
  }
  if (attemptNumber >= MAX_CONSECUTIVE_SAME_ERRORS) {
    msg += `\nYou have failed ${attemptNumber} times with similar errors. Stop retrying and inform the user about the issue.`;
  } else {
    msg += `\nPlease analyze the error and try a different approach.`;
  }
  return msg;
}
```

#### 改动点 2: GUI 侧追踪连续错误

在 `callToolById.ts` 或 `streamNormalInput.ts` 中追踪：

```typescript
// gui/src/redux/thunks/callToolById.ts — 新增错误追踪
const toolErrorCounts = new Map<string, number>(); // session-level

function trackToolError(toolName: string, error: string): number {
  const key = `${toolName}:${error.slice(0, 100)}`;
  const count = (toolErrorCounts.get(key) || 0) + 1;
  toolErrorCounts.set(key, count);
  return count;
}

function clearToolErrors(toolName: string) {
  // 工具成功后清除该工具的错误计数
  for (const key of toolErrorCounts.keys()) {
    if (key.startsWith(`${toolName}:`)) toolErrorCounts.delete(key);
  }
}
```

#### 改动点 3: 达到上限时强制停止

```typescript
// 在 callToolById 的错误处理中：
if (errorCount >= MAX_CONSECUTIVE_SAME_ERRORS) {
  // 不再继续 agent loop，而是停止并提示用户
  dispatch(setInlineErrorMessage("tool-retry-limit"));
  dispatch(setInactive());
  return; // 不调用 streamResponseAfterToolCall
}
```

### 与现有机制的关系

| 现有机制                                    | 本方案增强                       |
| ------------------------------------------- | -------------------------------- |
| `ToolCallParseError` — 解析失败返回原始参数 | 保持不变，本方案在其上层         |
| `MAX_AGENT_ITERATIONS = 50` — 全局迭代上限  | 本方案是更细粒度的"相同错误"上限 |
| 错误消息返回 LLM                            | 增强消息内容（加入计数+建议）    |

### 工作量估算

| 组件                                            | 改动量     |
| ----------------------------------------------- | ---------- |
| 错误追踪逻辑（Map + track/clear）               | ~30 行     |
| 增强错误消息格式化                              | ~20 行     |
| 达到上限时停止 agent loop                       | ~15 行     |
| InlineErrorMessage 新增 "tool-retry-limit" 类型 | ~10 行     |
| **总计**                                        | **~75 行** |

### 注意事项

- 错误追踪是 session 级别（页面刷新清零）
- 只追踪**连续**的相同错误 — 工具成功后清零
- 不做自动 backoff/delay — LLM 自行决定重试时机
- 与 sub-agent 兼容 — 子 agent 有独立的错误追踪器

---

## 第四轮实施记录：Agent 能力扩展（8 项功能 + IntelliJ 适配）

> 实施日期: 2026-04-20
> 状态: ✅ 全部完成并通过编译+打包验证
> 产物: `extensions/vscode/build/continue-win32-x64-1.3.39.vsix`

### 实现总览

| #   | 功能                   | 状态 | 核心文件                                                                            |
| --- | ---------------------- | ---- | ----------------------------------------------------------------------------------- |
| 1   | getProblems Agent Tool | ✅   | `core/tools/definitions/getProblems.ts` + `implementations/getProblems.ts`          |
| 2   | TODO 列表工具          | ✅   | `core/tools/definitions/manageTodoList.ts` + `implementations/manageTodoList.ts`    |
| 3   | 终端持久化会话         | ✅   | `core/tools/implementations/persistentShell.ts` + `runTerminalCommand.ts`           |
| 4   | Rules 自动沉淀         | ✅   | `.continue/rules/auto-rule-precipitation.md` + `createRuleBlock.ts` policy 改动     |
| 5   | 结构化重试             | ✅   | `gui/src/util/toolErrorTracker.ts` + `callToolById.ts`                              |
| 6   | 验证循环 Skill         | ✅   | `.continue/skills/verification/SKILL.md`                                            |
| 7   | 本地 Sub-Agent         | ✅   | `core/tools/definitions/subAgent.ts` + `implementations/subAgent.ts`                |
| 8   | LSP 操作               | ✅   | `findReferences.ts` + `gotoDefinition.ts` + `renameSymbol.ts`（定义+实现+全栈适配） |

### [#1] getProblems Agent Tool

**新增文件**:

- `core/tools/definitions/getProblems.ts` — Tool 定义，readonly，allowedWithoutPermission，可选 filepath 参数
- `core/tools/implementations/getProblems.ts` — 调用 `extras.ide.getProblems(filepath)`，按文件分组，输出 markdown 格式

**修改文件**:

- `core/tools/builtIn.ts` — 枚举新增 `GetProblems = "get_problems"`
- `core/tools/definitions/index.ts` — 导出 `getProblemsTool`
- `core/tools/callTool.ts` — 导入 `getProblemsImpl` + switch case
- `core/tools/index.ts` — 注册到 `getBaseToolDefinitions()`

### [#2] TODO 列表工具

**新增文件**:

- `core/tools/definitions/manageTodoList.ts` — items 数组参数 (id/title/status)，allowedWithoutPermission
- `core/tools/implementations/manageTodoList.ts` — 格式化为 markdown checkbox + 进度条

**修改文件**: 同上注册路径（builtIn, index, callTool, tools/index）

### [#3] 终端持久化会话

**新增文件**:

- `core/tools/implementations/persistentShell.ts` — `PersistentShell` 类
  - 通过 `child_process.spawn` 创建持久化 shell（Windows: powershell, Unix: $SHELL）
  - 基于 marker 的命令输出检测
  - 120s 命令超时
  - Session 级别单例模式（Map by cwd）
  - 支持 streaming output 回调

**修改文件**:

- `core/tools/implementations/runTerminalCommand.ts` — 当 `waitForCompletion && extras.onPartialOutput` 时优先使用持久化 shell 路径，失败时 fallback 到传统 spawn

### [#4] Rules 自动沉淀

**新增文件**:

- `.continue/rules/auto-rule-precipitation.md` — always-apply 规则，指导 agent 在发现重复模式/用户纠正时主动建议创建规则

**修改文件**:

- `core/tools/definitions/createRuleBlock.ts` — `defaultToolPolicy` 从 `"disabled"` 改为 `"allowedWithPermission"`

### [#5] 结构化重试

**新增文件**:

- `gui/src/util/toolErrorTracker.ts` — 错误追踪模块
  - `trackToolError(toolName, errorMessage)` → 返回连续错误计数
  - `clearToolErrors(toolName)` → 工具成功时清零
  - `hasReachedErrorLimit()` → 连续 3 次相同错误时返回 true
  - `formatEnhancedToolError()` → 在错误消息中附加尝试次数 + 引导建议

**修改文件**:

- `gui/src/redux/thunks/callToolById.ts` — 错误路径调用 trackToolError；达到上限时 dispatch `setInactive()`

### [#6] 验证循环 Skill

**新增文件**:

- `.continue/skills/verification/SKILL.md` — 验证-before-completion 技能

### [#7] 本地 Sub-Agent

**新增文件**:

- `core/tools/definitions/subAgent.ts` — Tool 定义
- `core/tools/implementations/subAgent.ts` — 使用 `extras.llm.streamChat()` 实现独立 agent 循环，最多 15 轮

### [#8] LSP 操作（findReferences / gotoDefinition / renameSymbol）

**新增文件**: 6 个（3 定义 + 3 实现）

**IDE 全栈适配（renameSymbol 贯穿整个通信链路）**:

- `core/index.d.ts` → `core/protocol/ide.ts` → `messageIde.ts` → `reverseMessageIde.ts` → `filesystem.ts` → `config/types.ts`
- VS Code: `VsCodeIde.ts` + `VsCodeMessenger.ts`
- IntelliJ: `MessageTypes.kt` → `protocol/ide.kt` → `types.kt` → `IdeProtocolClient.kt` → `IntelliJIde.kt`

### [IPC] IntelliJ 缓冲区扩容

- `ContinueNuProcess.kt` / `ContinueSocketProcess.kt` / `ContinueProcessHandler.kt` — buffer 256KB → 8MB

### 路线图状态更新

| #   | 功能                   | 原评级 | 状态                              |
| --- | ---------------------- | ------ | --------------------------------- |
| 1   | getProblems Agent Tool | S 级   | ✅ 已完成                         |
| 2   | TODO 列表工具          | S 级   | ✅ 已完成                         |
| 3   | 终端持久化会话         | S 级   | ✅ 已完成                         |
| 4   | Rules 自动沉淀         | S 级   | ✅ 已完成                         |
| 5   | 结构化重试             | A 级   | ✅ 已完成                         |
| 6   | 验证循环 Skill         | A 级   | ✅ 已完成                         |
| 7   | 本地子 Agent           | A 级   | ✅ 已完成                         |
| 8   | LSP 符号操作           | B→A 级 | ✅ 已完成（含 IntelliJ 全栈适配） |
| 9   | Prompt caching 扩展    | A 级   | 未开始                            |
| 10  | Composer 多文件 diff   | B 级   | 未开始                            |
