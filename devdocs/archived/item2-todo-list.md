# 详细方案：#2 TODO 列表工具 + 简易 UI

> 评估日期: 2026-04-20
> 状态: ✅ 已完成

## 价值分析

- 让 agent 在处理多步骤任务时有**可见的进度追踪**
- 用户可以实时看到 agent 的计划和进展
- 模型输出更收敛（有明确的步骤列表约束行为）
- Copilot 和 Claude Code 都有此功能，是高频使用的 tool

## 实现文件

**新增文件**:

- `core/tools/definitions/manageTodoList.ts` — items 数组参数 (id/title/status)，allowedWithoutPermission
- `core/tools/implementations/manageTodoList.ts` — 格式化为 markdown checkbox + 进度条

**修改文件**:

- `core/tools/builtIn.ts` — 枚举新增 `ManageTodoList = "manage_todo_list"`
- `core/tools/definitions/index.ts` — 导出 `manageTodoListTool`
- `core/tools/callTool.ts` — 导入 `manageTodoListImpl` + switch case
- `core/tools/index.ts` — 注册到 `getBaseToolDefinitions()`

## 设计方案

### Tool 定义

```typescript
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
            id: { type: "number" },
            title: { type: "string" },
            status: { type: "string", enum: ["not-started", "in-progress", "completed"] }
          }
        }
      }
    }
  }
}
```

### 实现代码

```typescript
// core/tools/implementations/manageTodoList.ts
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

  return [{ name: "Todo List", description: progress, content }];
};
```

### 状态存储

Tool 本身是**无状态**的 — 每次调用传入完整列表（和 Copilot 的 `manage_todo_list` 设计一致）。避免了跨调用状态管理的复杂性。

### GUI 渲染

利用现有的 tool call output 渲染机制：

- Tool 返回的 `ContextItem.content` 是格式化的 markdown checkbox list
- GUI 的 `StyledMarkdownPreview` 已有 `.task-list-item` CSS 样式

## 工作量

| 组件        | 改动量     |
| ----------- | ---------- |
| 枚举 + 注册 | ~5 行      |
| Tool 定义   | ~40 行     |
| Tool 实现   | ~30 行     |
| **总计**    | **~75 行** |
