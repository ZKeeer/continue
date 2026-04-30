# 详细方案：#6 验证循环 Skill + 必要 Skill 迁移

> 评估日期: 2026-04-20
> 状态: ✅ 已完成（`.continue/skills/verification/SKILL.md` 已创建）

## Continue Skill 系统回顾

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

## Skills vs Rules 的区别

| 维度       | Skills                      | Rules                                 |
| ---------- | --------------------------- | ------------------------------------- |
| Token 占用 | 按需加载（仅在调用时占用）  | 命中就注入 system message（每次占用） |
| 触发方式   | Agent 自主调用 `read_skill` | 自动（glob/regex）或手动              |
| 内容长度   | 可以很长（整个工作流说明）  | 应简短（5 行内）                      |
| 适用场景   | 复杂工作流、多步骤流程      | 简短约束、编码规范                    |

## 实现文件

**新增文件**:

- `.continue/skills/verification/SKILL.md` — 验证-before-completion 技能

## 验证循环 SKILL.md

```markdown
---
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

1. **Check for problems** — Call `get_problems` on the edited file(s)
2. **Analyze errors** — Read each error message and its location
3. **Fix errors** — Apply targeted fixes (do NOT rewrite entire files for minor issues)
4. **Re-check** — Call `get_problems` again to verify the fix
5. **Repeat** — Loop until no errors remain (max 3 iterations per file)

## Escape Conditions

- If the same error persists after 3 fix attempts → inform the user
- If errors are in files you didn't edit → report but don't fix (may be pre-existing)
- If errors are only warnings (not errors) → report but continue

## Anti-patterns to Avoid

- Do NOT suppress errors with `// @ts-ignore` or `# type: ignore` unless explicitly asked
- Do NOT add try/catch blocks solely to silence type errors
- Do NOT change function signatures to avoid errors (may break callers)
```

## 配套 Rule

```markdown
## <!-- .continue/rules/verify-after-edit.md -->

name: Verify After Edit
globs: "\*_/_.{ts,tsx,js,jsx,py,kt,java,rs,go,cs}"

---

After editing code files, use the verification-loop skill to check for compilation errors.
```

## 推荐创建的其他 Skills

| Skill                  | 描述                 | 来源/参考                                    |
| ---------------------- | -------------------- | -------------------------------------------- |
| `systematic-debugging` | 遇 bug 时的排查流程  | 参考 `.copilot/skills/systematic-debugging/` |
| `task-planning`        | 复杂任务拆解为子步骤 | 参考 `.copilot/skills/writing-plans/`        |
| `refactoring-safety`   | 安全重构工作流       | 1.查引用 2.改代码 3.验证编译 4.运行测试      |

## 工作量

| 组件                       | 改动量                          |
| -------------------------- | ------------------------------- |
| verification-loop SKILL.md | ~40 行 markdown                 |
| verify-after-edit rule     | ~6 行 markdown                  |
| **总计**                   | **~46 行 markdown，0 代码改动** |

## 依赖关系

```
#1 getProblems tool ──→ verification-loop skill 可完整工作
#10 getReferences   ──→ refactoring-safety skill 的 "查引用" 步骤
#3 终端持久化       ──→ tdd skill 的 "运行测试" 步骤更流畅
```
