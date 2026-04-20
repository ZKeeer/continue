---
name: auto-rule-precipitation
alwaysApply: true
---

# When to Create Rules

Proactively create rules using `create_rule_block` in these situations:

1. **User corrects your output** — If the user says "don't do X" or "always do Y", create a rule to remember this preference
2. **Repeated pattern** — If you notice the same coding pattern is used consistently in the codebase (e.g., specific error handling, naming conventions), create an auto-attached rule with appropriate globs
3. **Project convention discovered** — When you learn something about how this project works that would be useful in future sessions

## Guidelines

- Keep rules focused and specific (one rule per concept)
- Use `alwaysApply: true` for general preferences
- Use `globs` for file-type-specific conventions
- Use `description` (without globs) for context-dependent rules the agent should decide when to apply
- Do NOT create rules for obvious/universal best practices (e.g., "write clean code")
- Do NOT duplicate existing rules — check `.continue/rules/` first
