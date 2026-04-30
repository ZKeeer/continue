# Compaction UI 与逻辑修复

> 实施日期: 2026-04-30
> 状态: ✅ 已完成
> 范围: 压缩后 token 显示、summary maxTokens、自动跳过空消息

## 修复列表

### Fix 1: 压缩后 token 不再显示 `0%`

**问题**: `ContextStatus.tsx` 中 `contextPercentage` 在压缩后因 `newSession()` 重置为 `undefined`，被 `?? 0` 吞掉后显示 `0 / contextLength tokens (0%)`，与真实压缩后用量不符。

**方案**:
- `percent` 和 `usedTokens` 在 `contextPercentage === undefined` 时设为 `undefined`
- UI 显示 `--/--` 和 `-- / N tokens`，表示"尚未计算"
- bar 颜色使用 `bg-description-muted` 灰色状态
- 压缩完成后通过 `recalculateContextPercentage()` 调用 `llm/compileChat` 重新计算

**文件**: `gui/src/components/mainInput/ContextStatus.tsx`

### Fix 2: 压缩后自动重新计算 contextPercentage

**问题**: 手动压缩后 `compactConversation.ts` 只 `loadSession()` 重新加载会话，不更新 `contextPercentage`。

**方案**:
- 在 `loadSession()` 完成后调用 `recalculateContextPercentage(dispatch, ideMessenger)`
- 该函数从 `store.getState()` 获取最新状态、调用 `constructMessages()` 构建消息、调用 `llm/compileChat` 计算百分比
- 通过 `setContextPercentage()` 更新到 Redux

**文件**: `gui/src/util/compactConversation.ts`

### Fix 3: summary 添加 maxTokens 限制

**问题**: `conversationCompaction.ts:152` 传入 `{}` 无 `maxTokens`，summary 可能极长，压缩效果大打折扣。

**方案**: 添加 `maxTokens: 2048` 限制摘要长度。

**文件**: `core/util/conversationCompaction.ts`

### Fix 4: 手动压缩跳过空消息

**问题**: `ContextStatus.tsx` 写死 `compactConversation(history.length - 1)`，若最后一条消息是流式输出中的空 assistant 消息，会包含不完整数据。

**方案**:
- 按钮传 `-1` 给 `useCompactConversation`
- `findCompactTarget(-1)` 从末尾向前找到第一条非空 assistant 消息作为目标

**文件**: `gui/src/components/mainInput/ContextStatus.tsx`, `gui/src/util/compactConversation.ts`
