---
name: verification-before-completion
description: Use after making code changes to verify they compile and work correctly before claiming completion.
---

# Verification Before Completion

After making code changes, ALWAYS verify before claiming success:

## Verification Steps

1. **Check for compile errors** — Use `get_problems` tool on modified files
2. **If errors found** — Fix them immediately, then re-check
3. **Repeat until clean** — No errors/warnings should remain in modified files

## Rules

- NEVER claim "done" or "fixed" without running `get_problems` first
- If `get_problems` returns errors in files you edited, fix them before responding
- For TypeScript changes: type errors count as blockers
- For multi-file changes: check ALL modified files, not just the last one

## Verification Loop Pattern

```
1. Make changes
2. get_problems(filepath) for each modified file
3. If errors → fix → goto 2
4. Only then report completion
```

## When to Skip

- Documentation-only changes (.md files)
- Configuration file changes (.json, .yaml) without schema validation
- When explicitly told "don't verify"

---

## Sub-Agent Failure Recovery

When a `sub_agent` tool call returns content that indicates failure (timeout message, "reached maximum iterations", or explicit error):

1. **Read the failure reason** before acting
2. Choose a recovery strategy based on the reason:
   - `timed out` → Split into smaller sub-tasks and re-dispatch each separately
   - `reached maximum iterations` → The task is too complex; handle the critical steps yourself
   - Tool error inside sub-agent → Note which step failed, tell the user, ask whether to continue
3. **Do NOT** silently retry the same prompt — it will fail the same way
4. **Do NOT** take over and silently redo all the work — inform the user of what happened first
