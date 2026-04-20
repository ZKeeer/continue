---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior. Requires finding root cause before proposing fixes.
---

# Systematic Debugging

When encountering a bug, test failure, or unexpected behavior, follow this methodology BEFORE proposing any fix.

## Iron Law

**Find the root cause FIRST. Never guess-and-fix.**

## Process

### 1. Reproduce & Observe

- Run the failing command/test and capture exact error output
- Note the error type, message, and stack trace
- Identify which file and line the error originates from

### 2. Form Hypotheses

List 2-3 possible causes ranked by likelihood:

- Most recent change that could affect this code path
- Missing dependency or import
- Type mismatch or incorrect assumption about data shape

### 3. Gather Evidence

Use tools to validate/eliminate hypotheses:

- `readFile` — read the file around the error location
- `get_problems` — check for compile/lint errors
- `runTerminalCommand` — run specific tests or commands
- `exactSearch` — find related usages or patterns

### 4. Identify Root Cause

Only proceed to fix when you can state:

- "The error occurs because [specific cause] at [specific location]"
- You can explain WHY the error happens, not just WHERE

### 5. Fix & Verify

- Make the minimal fix that addresses the root cause
- Run `get_problems` on modified files
- Re-run the original failing command to confirm the fix

## Anti-Patterns

- ❌ Changing code "to see if it helps" without understanding why
- ❌ Adding try/catch to suppress errors instead of fixing them
- ❌ Making multiple changes at once without isolating the cause
- ❌ Assuming the first error in a stack trace is the root cause
- ❌ Fixing symptoms instead of underlying problems

## Escape Conditions

If after 3 evidence-gathering rounds you cannot identify the root cause:

1. Summarize what you've found so far
2. List remaining hypotheses
3. Ask the user for additional context
