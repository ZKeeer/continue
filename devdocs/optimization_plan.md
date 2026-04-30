# Agent 优化全景 — Overview & Status

> **项目**: continue v1.3.19-vscode (zkdev 分支)
> **范围**: VS Code + IntelliJ extensions，GUI agent 路径
> **最后更新**: 2026-04-30

本文档是优化计划的**总览和状态追踪**。各优化项的详细方案见子目录：

- `archived/` — 已完成的优化项（含实现记录）
- `plan-items/` — 待实施的优化项（含设计方案）

---

## 已完成的优化轮次

| 轮次            | 内容                                                                                                                       | 详细文档                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 第一轮 (P0-P3)  | readFile超时、agent迭代上限、tool解析错误反馈、压缩通知、thinking裁剪、滑动窗口、分级阈值                                  | [archived/p0-p3-round1.md](archived/p0-p3-round1.md)           |
| 第二轮          | 压缩输入预处理（跳过thinking + 截断大tool output）                                                                         | [archived/round2-compaction.md](archived/round2-compaction.md) |
| 第三轮          | IntelliJ readFile超时、writeFile错误、VFS缓存优先、ripgrep硬超时、Qwen tool支持                                            | [archived/round3-intellij.md](archived/round3-intellij.md)     |
| 第四轮          | getProblems、TODO列表、终端持久化、Rules沉淀、结构化重试、验证Skill、Sub-Agent、LSP操作                                    | 见下方第四轮实施记录                                           |
| 2026-04-30 增量 | Terminal runtime、Agent 控制闭环第一批、Edit pending diff 非阻塞续流、Sub-Agent 执行层保底路由、SGLang/Qwen reasoning ~~修复~~（已废弃 strip+flatten，改为选择性保留 thinking + 混血格式） | 见下方增量实施记录；实施记录已归档 |
| 第五轮          | Compaction UI 与逻辑修复（token 显示/自动重算/maxTokens）、Apply 模型效率优化（prefix/suffix 上下文/range 限制）               | [archived/compaction-ui-and-logic-fixes.md](archived/compaction-ui-and-logic-fixes.md)、[archived/apply-model-efficiency.md](archived/apply-model-efficiency.md) |

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

- [x] **[#1 getProblems 升级为 Agent tool](archived/item1-get-problems.md)** — 极低成本（定义+实现各 20 行）✅ 已实施
  - 底层已完整实现，仅差 tool 包装；做完 agent 改完代码可自查编译错误
- [x] **[#2 TODO 列表工具 + 简易 UI](archived/item2-todo-list.md)** — 低成本 ✅ 已实施
  - 模型行为更收敛，用户有透明度
- [x] **[#3 终端持久化会话](archived/item3-persistent-terminal.md)** — 中成本 ✅ 已实施
  - sessionId + PTY 管理
- [x] **[#4 Rules 自动沉淀](archived/item4-rules-precipitation.md)** — 低成本 ✅ 已实施
  - createRuleBlock 已存在，只需在合适时机触发

#### A 级 — 高价值 + 中成本

- [x] **[#5 Tool call 结构化重试](archived/item5-tool-retry.md)** — callTool 错误反馈已有，但缺系统重试 ✅ 已实施
- [x] **[#6 验证循环 skill](archived/item6-verification-skill.md)** — 基于 Plan 模式 + getProblems 组合 ✅ 已实施
- [x] **[#7 本地子 agent](archived/item7-sub-agent.md)** — Background 模式架构可参考 ✅ 已实施
- [x] **[#7 Agent 控制循环第一批](archived/item7-agent-control-loop-first-batch.md)** — S-1a / S-2a / S-3 / S-4 / S-5+A-7 ✅ 已实施
- [x] **[#7 Sub-Agent runtime 增强](archived/item7-subagent-enhancement-2026-04-30.md)** — 模型选择、V2 结果、执行层保底路由 ✅ 已实施
- [ ] **[#8 Git 历史正式化](plan-items/item8-git-history.md)** — 复活 deprecated provider 或接入 Git MCP
- [ ] **[#9 Prompt caching 扩展](plan-items/item9-prompt-caching.md)** — 仅 Anthropic/OpenRouter 有，OpenAI 未做

#### B 级 — 高价值 + 高成本

- [x] **[#10 LSP 符号操作（findReferences/rename）](archived/item8-lsp-ops.md)** — IntelliJ 侧工程量大 ✅ 已实施（含 IntelliJ 适配）
- [ ] **[#11 Composer 多文件 diff 预览](plan-items/item11-composer-diff.md)** — V0.5 已实现 edit pending diff 非阻塞续流；完整多文件面板仍待做
- [ ] **[#12 Autocomplete 质量](plan-items/item12-autocomplete.md)** — 架构完整但模型层受限

#### C 级 — 锦上添花

- [ ] **[#13-#15 笔记本编辑 / 浏览器自动化 / 专用测试执行](plan-items/item13-15-misc.md)**
  - #13 笔记本编辑 — 小众场景
  - #14 浏览器自动化 — 大工程
  - #15 专用测试执行 — 可用 runTerminalCommand 替代

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

## 详细方案索引

### 已完成（archived/）

| #   | 功能                                                 | 详细文档                                                                                                 |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | getProblems Agent Tool                               | [archived/item1-get-problems.md](archived/item1-get-problems.md)                                         |
| 2   | TODO 列表工具 + 简易 UI                              | [archived/item2-todo-list.md](archived/item2-todo-list.md)                                               |
| 3   | 终端持久化会话                                       | [archived/item3-persistent-terminal.md](archived/item3-persistent-terminal.md)                           |
| 4   | Rules 自动沉淀                                       | [archived/item4-rules-precipitation.md](archived/item4-rules-precipitation.md)                           |
| 5   | Tool Call 结构化重试                                 | [archived/item5-tool-retry.md](archived/item5-tool-retry.md)                                             |
| 6   | 验证循环 Skill                                       | [archived/item6-verification-skill.md](archived/item6-verification-skill.md)                             |
| 7   | 本地 Sub-Agent                                       | [archived/item7-sub-agent.md](archived/item7-sub-agent.md)                                               |
| 8   | LSP 符号操作（findReferences/rename/gotoDefinition） | [archived/item8-lsp-ops.md](archived/item8-lsp-ops.md)                                                   |
| 9   | Agent 控制循环第一批（S-1a/S-2a/S-3/S-4/S-5+A-7）    | [archived/item7-agent-control-loop-first-batch.md](archived/item7-agent-control-loop-first-batch.md)     |
| 10  | Sub-Agent runtime 增强与执行层保底路由               | [archived/item7-subagent-enhancement-2026-04-30.md](archived/item7-subagent-enhancement-2026-04-30.md)   |
| 11  | Terminal / Agent Loop / Sub-Agent Runtime 修正       | [archived/item16-terminal-agent-subagent-runtime.md](archived/item16-terminal-agent-subagent-runtime.md) |
| 12  | Qwen Reasoning 根因修复（选择性 thinking + 混血格式）    | [archived/qwen-reasoning-root-cause-fix.md](archived/qwen-reasoning-root-cause-fix.md)                   |

### 待实施（plan-items/）

| #         | 功能                                     | 评级   | 详细文档                                                                       |
| --------- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| 7-roadmap | Agent 控制循环后续能力                   | A/B 级 | [plan-items/item7-agent-enhancement.md](plan-items/item7-agent-enhancement.md) |
| 8-roadmap | Git 历史正式化                           | A 级   | [plan-items/item8-git-history.md](plan-items/item8-git-history.md)             |
| 9         | Prompt caching 扩展                      | A 级   | [plan-items/item9-prompt-caching.md](plan-items/item9-prompt-caching.md)       |
| 11        | Composer 多文件 diff 预览                | B 级   | [plan-items/item11-composer-diff.md](plan-items/item11-composer-diff.md)       |
| 12        | Autocomplete 质量提升                    | B 级   | [plan-items/item12-autocomplete.md](plan-items/item12-autocomplete.md)         |
| 13-15     | 笔记本编辑 / 浏览器自动化 / 专用测试执行 | C 级   | [plan-items/item13-15-misc.md](plan-items/item13-15-misc.md)                   |

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

---

## 2026-04-30 增量实施记录

已归档的实施记录：

- [archived/item16-terminal-agent-subagent-runtime.md](archived/item16-terminal-agent-subagent-runtime.md)
- [archived/item7-agent-control-loop-first-batch.md](archived/item7-agent-control-loop-first-batch.md)
- [archived/item7-subagent-enhancement-2026-04-30.md](archived/item7-subagent-enhancement-2026-04-30.md)

### Edit pending diff 非阻塞续流

`edit_existing_file` 写入后不再等用户在 diff 视图里 accept/reject 才继续 agent loop。

实现口径：

- `ApplyState.status === "done"` 表示文件已应用并进入 pending review，此时 GUI 将 edit tool call 标记为完成并继续后续流式响应。
- `ApplyState.status === "closed"` 只表示用户之后显式 accept/reject，不再重复触发 agent continuation。
- 工具输出写入隐藏 context item：`Edit Pending Review`，告知模型该文件已编辑、diff 仍等待用户审查。

核心文件：

- `gui/src/redux/thunks/handleApplyStateUpdate.ts`
- `gui/src/redux/thunks/handleApplyStateUpdate.test.ts`

当前状态：V0.5 已落地。它解决“每改一个文件都阻塞等待 review”的问题；统一多文件列表、逐文件点击审查、Accept All/Reject All 仍属于 #11 后续 UI 工作。

### Sub-Agent 执行层保底路由

`sub_agent` 不再暴露给主模型作为普通可选 function，避免与 `grep_search`、`codebase`、`get_problems` 等工具同层竞争。

实现口径：

- 主模型可见工具列表过滤掉 `sub_agent`。
- 在 `callToolById` 执行边界，对指定探索类工具做确定性包装：当存在 configured subagent model 时，将原始工具调用改写为 `sub_agent` 调用。
- 当前路由工具包括 `grep_search`、`file_glob_search`、`codebase`、`get_problems`、`view_repo_map`、`view_subdirectory`。
- 包装后的 `allowedTools` 只包含原始工具和可用时的 `manage_todo_list`，避免子 agent 获得不必要的写权限。

核心文件：

- `gui/src/redux/thunks/subAgentToolRouter.ts`
- `gui/src/redux/thunks/callToolById.ts`
- `gui/src/redux/thunks/streamNormalInput.ts`
- `gui/src/redux/thunks/subAgentToolRouter.test.ts`
- `gui/src/redux/thunks/streamResponse_toolCalls.test.ts`

当前状态：V1 已落地。该实现是执行层保底路由，不依赖主模型主动选择 `sub_agent`。

### SGLang/Qwen reasoning 排查与修复

#### 问题根因分析

Qwen3.5 多轮 agent 场景下 reasoning 消失的根因是 **history 中 assistant 消息缺少 reasoning 导致的 few-shot 污染**：

1. 为了节省 token，某次改动将 history 中的 `thinking` 消息和 assistant 的 `reasoning_content` 等字段 strip 掉了
2. 此时 tool-call 的 assistant 消息变成 `content=" "` + `tool_calls`，无 reasoning
3. chat_template 渲染后 model 反复看到：`<|im_start|>assistant\n \n<tool_call>...</tool_call>`
4. 模型学到的模式："不需要 `<think>`，直接输出 `<tool_call>`"
5. 补丁 `openaiHistoryPreprocessor.ts`（自定义 XML 扁平化）绕过了问题，但没修根

推理服务端参数（`reasoning:false`、`stopCount:0`、`maxTokens:87333`）经排查均非主因。`chat_template` 已将 `role:"tool"` 正确转换为 `<tool_response>` 标签，问题不在 tool result 格式。

#### ~~旧方案（已废弃）~~ vs 新方案

| 维度 | ~~旧方案（strip + 自定义扁平化）~~ | 新方案（选择性保留 + 混血格式） |
|------|-----------------------------------|-------------------------------|
| thinking 处理 | 全部 strip，无差别删除 | **有 tool_calls 的 assistant 保留**，无 tool_calls 的 strip |
| reasoning 字段 | 无条件删除 `reasoning_content` 等 | **非 toolcall assistant strip**；toolcall assistant 保留 |
| tool history | 自定义 `<previous_tool_round>` XML 扁平化 | **Qwen-native 混血格式**：文本描述 tool calls + `<tool_response>` 标签 |
| 模型范围 | 仅 Qwen/QwQ（`modelIdentifier.includes("qwen")`） | 所有推理模型（qwen/deepseek/o1/o3/o4/gpt-5） |
| 本质 | 后处理补丁，打破 few-shot 污染 | **源头修复** + 原生标签 fallback |

#### 新方案设计

**策略A（源头修复）**：`selectivelyStripReasoning`

```
对于 thinking 消息 → 只有后面是 toolcall assistant 时才保留，否则 strip
对于 assistant 无 toolcall → strip reasoning 字段（省 token，下轮模型会重新生成 thinking）
对于 assistant 有 toolcall → 保留 reasoning 字段（提供工具选择上下文）
```

**策略B（混血格式 fallback）**：`flattenToolRound`

当 toolcall assistant 缺 reasoning 时，扁平化为 Qwen-native 混血格式：

```
上一轮 agent 操作记录（纯文本摘要，不要当成真实 tool 消息）：

1. 调用 read_file({"filepath": "scripts/coverage.py"})
<tool_response>
# coding:utf-8...
</tool_response>

2. 调用 grep_search({"query": "coverage_plan"})
<tool_response>
scripts/coverage_plan.md
</tool_response>
```

- `1. 调用 xxx(args)` — 纯文本描述 tool calls，不触发 `<tool_call>` 解析
- `<tool_response>...</tool_response>` — Qwen3 tokenizer 中的特殊 token，模型训练过

**整体数据流**：

```
Chat 消息历史
  │
  ├── assistant 有 tool_calls + reasoning → 保留 reasoning，toChatMessage 合并 reasoning_content → API
  │     Token: <|im_start|>assistant\n<think>...</think>\n<tool_call>...
  │
  ├── assistant 有 tool_calls 无 reasoning → 扁平化为混血格式 user 消息 → API
  │     Token: <|im_start|>user\n1. 调用 xxx(...)\n<tool_response>...</tool_response>
  │
  └── assistant 无 tool_calls → strip reasoning 字段 → API
```

#### 核心文件

- `core/llm/openaiHistoryPreprocessor.ts` — 重写：`selectivelyStripReasoning` + `hasReasoningAssignedToToolCallAssistant` + `flattenToolRound`（混血格式）
- `core/llm/openaiHistoryPreprocessor.vitest.ts` — 重写：覆盖选择性 strip、混血格式、prefix-cache 稳定性
- `core/llm/index.ts` — `prepareOpenAICompatibleMessagesForReasoning` 改为 `stripReasoning: false` + 扩展推理模型列表
- `core/llm/llms/OpenAI.ts` — 移除 `_convertArgs` 中冗余的 `prepareOpenAICompatibleMessagesForReasoning` 调用（统一在 `_streamChat` 处理）

---

## 第五轮实施记录：Compaction UI 修复 + Apply 模型效率优化

> 实施日期: 2026-04-30
> 状态: ✅ 全部完成并通过类型检查

### [#1] Compaction UI 与逻辑修复

详见 [archived/compaction-ui-and-logic-fixes.md](archived/compaction-ui-and-logic-fixes.md)

核心改动：

| 文件 | 改动 |
|------|------|
| `gui/src/components/mainInput/ContextStatus.tsx` | `contextPercentage` 为 `undefined` 时显示 `--/--` 而非 `0%`；新增 `historyLength` 和 `compactConversation` 变量；按钮传 `-1` |
| `gui/src/util/compactConversation.ts` | 新增 `recalculateContextPercentage()` 压缩后重算；新增 `findCompactTarget(-1)` 跳过空消息；等待 `loadSession()` 完成后再重算 |
| `core/util/conversationCompaction.ts` | summary 生成添加 `maxTokens: 2048` |

### [#2] Apply 模型效率优化

详见 [archived/apply-model-efficiency.md](archived/apply-model-efficiency.md)

核心改动：

| 文件 | 改动 |
|------|------|
| `core/llm/templates/edit/gpt.ts` | `defaultApplyPrompt` 新增 prefix/suffix 分支，仅要求输出修改范围内代码；无 prefix/suffix 时保留全文件 fallback |
| `core/edit/streamDiffLines.ts` | `constructApplyPrompt` 新增 prefix/suffix/highlighted/language 参数；`streamDiffLines` 的 apply 路径传入这些参数 |
| `extensions/vscode/src/apply/ApplyManager.ts` | 新增 `computeApplyRange()`：文件 ≤80 行用全文件，否则光标 ±40 行窗口；`handleNonInstantDiff` 无选区时使用此方法 |
