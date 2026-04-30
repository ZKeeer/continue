# 详细方案：#5 Tool Call 结构化重试

> 评估日期: 2026-04-20
> 状态: ✅ 已完成

## 现状分析

当前错误处理流程：

1. `callTool()` catch 异常 → 返回 `{ errorMessage }`
2. `callToolById` 检测到 error → dispatch `updateToolCallOutput` 写入错误 context item
3. 错误文本作为 tool role message 加入历史
4. `streamNormalInput` 再次调用 LLM → LLM 自行决定是否重试

**问题**：

- LLM 可能忽略错误继续做其他事
- 重复同样错误的调用（LLM 不改参数）导致无限循环
- 没有重试计数器，无法区分"第一次失败"和"已经失败 5 次了"

## 实现文件

**新增文件**:

- `gui/src/util/toolErrorTracker.ts` — 错误追踪模块
  - `trackToolError(toolName, errorMessage)` → 返回连续错误计数
  - `clearToolErrors(toolName)` → 工具成功时清零
  - `hasReachedErrorLimit()` → 连续 3 次相同错误时返回 true
  - `formatEnhancedToolError()` → 在错误消息中附加尝试次数 + 引导建议

**修改文件**:

- `gui/src/redux/thunks/callToolById.ts` — 错误路径调用 trackToolError；达到上限时 dispatch `setInactive()`

## 设计原则

1. **不在 core 层自动重试** — 保持 tool 调用的确定性，让 LLM 主动决策
2. **增强错误反馈信息** — 在错误消息中添加重试建议和失败计数
3. **相同错误重复上限** — 连续 3 次相同 tool + 相同错误签名时，强制停止并提示用户

## 实现方案

### toolErrorTracker.ts

```typescript
const MAX_CONSECUTIVE_SAME_ERRORS = 3;

const toolErrorCounts = new Map<string, number>(); // session-level

export function trackToolError(toolName: string, error: string): number {
  const key = `${toolName}:${error.slice(0, 100)}`;
  const count = (toolErrorCounts.get(key) || 0) + 1;
  toolErrorCounts.set(key, count);
  return count;
}

export function clearToolErrors(toolName: string) {
  for (const key of toolErrorCounts.keys()) {
    if (key.startsWith(`${toolName}:`)) toolErrorCounts.delete(key);
  }
}

export function formatEnhancedToolError(
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

### callToolById.ts 集成

```typescript
// 错误路径：
const count = trackToolError(toolName, errorMessage);
const enhanced = formatEnhancedToolError(toolName, errorMessage, count);
// dispatch enhanced error to tool output

if (count >= MAX_CONSECUTIVE_SAME_ERRORS) {
  dispatch(setInlineErrorMessage("tool-retry-limit"));
  dispatch(setInactive());
  return; // 不调用 streamResponseAfterToolCall
}
```

## 与现有机制的关系

| 现有机制                                    | 本方案增强                       |
| ------------------------------------------- | -------------------------------- |
| `ToolCallParseError` — 解析失败返回原始参数 | 保持不变，本方案在其上层         |
| `MAX_AGENT_ITERATIONS = 50` — 全局迭代上限  | 本方案是更细粒度的"相同错误"上限 |
| 错误消息返回 LLM                            | 增强消息内容（加入计数+建议）    |

## 工作量

| 组件                                            | 改动量     |
| ----------------------------------------------- | ---------- |
| 错误追踪逻辑（Map + track/clear）               | ~30 行     |
| 增强错误消息格式化                              | ~20 行     |
| 达到上限时停止 agent loop                       | ~15 行     |
| InlineErrorMessage 新增 "tool-retry-limit" 类型 | ~10 行     |
| **总计**                                        | **~75 行** |

## 注意事项

- 错误追踪是 session 级别（页面刷新清零）
- 只追踪**连续**的相同错误 — 工具成功后清零
- 不做自动 backoff/delay — LLM 自行决定重试时机
- 与 sub-agent 兼容 — 子 agent 有独立的错误追踪器
