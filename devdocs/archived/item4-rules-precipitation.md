# 详细方案：#4 Rules 自动沉淀

> 评估日期: 2026-04-20
> 状态: ✅ 已完成（V1 零代码方案 + createRuleBlock policy 改动）

## Rules 系统回顾

Continue 的 Rules **不是 memory**——它是直接追加到 system message 末尾的文本片段，LLM 每次对话都会看到。

**四种触发模式**：

| 模式                | 条件                       | 注入时机                         |
| ------------------- | -------------------------- | -------------------------------- |
| **Always**          | `alwaysApply: true`        | 每次对话都注入 system message    |
| **Auto Attached**   | 有 `globs`/`regex`         | 对话中出现匹配文件时自动注入     |
| **Agent Requested** | 有 `description`           | AI 根据 description 判断是否拉取 |
| **Manual**          | 无 globs/regex/description | 仅 `@ruleName` 手动引用          |

## 核心风险（为何不能全自动）

1. **规则冲突**：自动生成的规则 A 说"用 tabs"，规则 B 说"用 spaces"
2. **规则过时**：3 个月前沉淀的规则不再适用当前代码
3. **注意力稀释**：LLM 对 system message 的注意力有限，规则太多每条有效性下降

## 实现文件

**新增文件**:

- `.continue/rules/auto-rule-precipitation.md` — always-apply 规则，指导 agent 在发现重复模式/用户纠正时主动建议创建规则

**修改文件**:

- `core/tools/definitions/createRuleBlock.ts` — `defaultToolPolicy` 从 `"disabled"` 改为 `"allowedWithPermission"`

## 实现方案（V1: AI 建议 + 人工确认）

### 核心原则

- **不做全自动沉淀** — agent 发现模式后**建议**用户创建规则
- **默认用 glob 限定 scope** — 不创建 always-apply 规则
- **打开文件供审阅** — `createRuleBlock` 已实现此行为

### 触发时机识别

| 场景                     | 识别方式                                   | 建议的规则类型              |
| ------------------------ | ------------------------------------------ | --------------------------- |
| 同类错误重复出现 3+ 次   | 连续 tool call 中出现相似错误 message      | glob + regex 匹配该文件类型 |
| 用户明确说"以后都这样做" | 对话中出现 "always"/"每次"/"以后" 等关键词 | always-apply 或 glob        |
| agent 发现项目约定       | 多个文件中一致的模式                       | glob 匹配相关文件           |

### auto-rule-precipitation.md

```markdown
---
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

## 工作量

| 组件                        | 改动量                   |
| --------------------------- | ------------------------ |
| V1: 两个 .md 规则文件       | ~30 行 markdown          |
| createRuleBlock policy 改动 | 1 行                     |
| **总计**                    | **~31 行，最小代码改动** |
