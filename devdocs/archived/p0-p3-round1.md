# 第一轮优化：可靠性基础 (P0-P3)

> 实施日期: 2026-04-16
> 状态: ✅ 全部完成

## 改动方案

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
- **文件**: `gui/src/redux/thunks/streamNormalInput.ts`, `gui/src/util/compactConversation.ts`
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

## 后续优化方向（记录）

1. **CLI 路径同步**: 将相同的超时/迭代上限/thinking裁剪逻辑同步到 `extensions/cli/src/stream/` 路径
2. **Tool 级别超时差异化**: 为不同 tool 设置不同超时（readFile 30s, runTerminalCommand 120s, searchWeb 30s 等）
3. **用户可配置**: 将 MAX_AGENT_ITERATIONS、超时时间、AUTO_COMPACT_THRESHOLD 暴露为配置项
4. **Telemetry**: 对超时、迭代上限、压缩触发等事件添加 posthog tracking
