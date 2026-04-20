---
name: task-planning
description: Use when facing a complex multi-step task. Break it into actionable items before writing code.
---

# Task Planning

Before implementing complex features or multi-file changes, create a structured plan.

## When to Plan

- Task involves 3+ files
- Task has dependencies between steps
- Task requires understanding existing architecture first
- User's request is ambiguous and needs decomposition

## Planning Process

### 1. Understand the Goal

- Restate the user's request in concrete terms
- Identify acceptance criteria (what does "done" look like?)
- Note any constraints mentioned

### 2. Gather Context

- Read relevant existing code to understand current architecture
- Check for patterns in similar existing implementations
- Identify all files that will need changes

### 3. Decompose into Steps

Create ordered, atomic tasks:

- Each task should be independently verifiable
- Tasks should be small enough to complete in one action
- Dependencies between tasks must be explicit
- Group related changes (e.g., "add interface" before "implement interface")

### 4. Identify Risks

- Which steps might fail or need alternative approaches?
- Are there breaking changes that need migration?
- What's the rollback plan if something goes wrong?

## Plan Format

```
Goal: [one sentence]

Steps:
1. [action] — [file(s)] — [verification]
2. [action] — [file(s)] — [verification]
...

Risks:
- [risk]: [mitigation]
```

## Execution Rules

- Complete one step fully before starting the next
- Verify each step (use `get_problems` after code changes)
- If a step fails, reassess the plan before continuing
- Use `manage_todo_list` to track progress on multi-step plans
