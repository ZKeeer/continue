# 详细方案：#7 本地子 Agent 分派

> 评估日期: 2026-04-20
> 状态: ✅ 已完成（core 层，串行，最多 15 轮）

## 现状分析

| 路径                    | 现有能力                                            | 缺失                                   |
| ----------------------- | --------------------------------------------------- | -------------------------------------- |
| CLI (`extensions/cli/`) | ✅ 完整 subagent：executor + tool 定义 + agent 发现 | —                                      |
| GUI-VS Code (`gui/`)    | ❌ 无本地 subagent                                  | 只有远端 Background Agent（需登录+云） |
| GUI-IntelliJ            | ❌ 无                                               | 同上                                   |

## 实现文件

**新增文件**:

- `core/tools/definitions/subAgent.ts` — Tool 定义
- `core/tools/implementations/subAgent.ts` — 使用 `extras.llm.streamChat()` 实现独立 agent 循环，最多 15 轮

**修改文件**: 同标准注册路径

## 核心优势

1. **上下文隔离**：子 agent 历史不回流到父 agent，父 agent 只收到简短结果摘要。解决 token 膨胀的架构级方案
2. **失败隔离**：子 agent 超时/死循环只影响自身，父 agent 收到 `{ success: false }` 可决定重试或跳过
3. **无需云依赖**：完全本地运行，适用于离线/内网/自托管 LLM 场景

## 架构设计

```
┌─────────────────────────────────────────────┐
│  GUI streamNormalInput (父 agent)            │
│  ├─ tool_call: subagent(prompt, description) │
│  │   ┌─────────────────────────────────┐    │
│  │   │ 子 agent session (独立历史)      │    │
│  │   │ ├─ extras.llm.streamChat()       │    │
│  │   │ ├─ tool calls (readFile, edit…)  │    │
│  │   │ └─ return final response         │    │
│  │   └─────────────────────────────────┘    │
│  ├─ tool_result: "子 agent 摘要结果"         │
│  └─ continue...                              │
└─────────────────────────────────────────────┘
```

## Tool 定义

```typescript
{
  name: "sub_agent",
  description: "Launch a subagent to handle a complex sub-task independently. The subagent runs in an isolated context and returns a summary result. Use for tasks that are independent from the current work.",
  parameters: {
    type: "object",
    required: ["prompt", "description"],
    properties: {
      prompt: { type: "string", description: "Detailed task description for the subagent" },
      description: { type: "string", description: "Short 3-5 word label for the task" }
    }
  }
}
```

## 实现要点

- 使用 `extras.llm.streamChat()` 与父 agent 共享同一个 LLM 连接
- 独立的 history 数组，不与父 agent 的 history 共享
- 最多 15 轮迭代上限（`MAX_SUB_AGENT_ITERATIONS = 15`）
- 超时或失败时返回 `{ success: false, error: message }`

## 与 CLI 实现的对比

| 维度     | CLI 路径               | Core/GUI 路径（已实现） |
| -------- | ---------------------- | ----------------------- |
| IDE 操作 | 直接文件系统操作       | 通过 extras.ide 接口    |
| 会话管理 | services 单例覆盖/恢复 | 独立内存 history        |
| 输出展示 | terminal text stream   | tool call output        |
| 并行支持 | 多 executor 实例       | 目前串行                |

## 工作量

| 组件                     | 改动量      |
| ------------------------ | ----------- |
| Tool 定义 + builtIn 注册 | ~30 行      |
| subAgent 执行器          | ~150 行     |
| callTool 集成            | ~20 行      |
| **V1 总计**              | **~200 行** |

## 注意事项

- 当前实现是**串行**的（一次只运行一个子 agent）
- 并行执行取决于父 LLM 是否同时发出多个 sub_agent tool_call（模型行为）
- V2 可考虑：子 agent 使用更小/更快的模型（配置化）
