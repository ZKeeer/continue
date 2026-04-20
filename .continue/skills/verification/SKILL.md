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
