---
name: refactoring-safety
description: Use when renaming symbols, moving files, or restructuring code. Ensures no references are broken.
---

# Safe Refactoring

## When to Apply

- Renaming functions, classes, variables, or files
- Moving code between files or modules
- Changing function signatures
- Extracting or inlining code

## Process

### 1. Assess Impact

Before making changes:

- Use `findReferences` to see all usages of the symbol
- Use `gotoDefinition` to understand the symbol's origin
- Count how many files will be affected

### 2. Choose Strategy

| Scope                     | Strategy                     |
| ------------------------- | ---------------------------- |
| Single file, few refs     | Manual edit + `get_problems` |
| Many files, simple rename | Use `renameSymbol` tool      |
| Signature change          | Manual edit all call sites   |
| File move                 | Update all imports manually  |

### 3. Execute

- For renames: prefer `renameSymbol` — it updates all references atomically
- For signature changes: update the definition first, then fix all callers
- For file moves: update the file path, then fix all imports

### 4. Verify

After refactoring:

1. `get_problems` on ALL affected files (not just the one you edited)
2. If the project has tests, run them
3. Check that no "unused import" or "cannot find module" errors remain

## Common Pitfalls

- ❌ Renaming in one file but forgetting re-exports
- ❌ Changing a type without updating all implementations
- ❌ Moving a file without updating relative imports in OTHER files
- ❌ Renaming a string-based reference (e.g., tool names in switch statements)

## String-Based References

Some references won't be caught by LSP rename:

- Enum values used as string keys in `switch/case`
- Dynamic property access: `obj[variableName]`
- Configuration files referencing code symbols
- Test fixtures using symbol names as strings

For these, use `exactSearch` to find all string occurrences.
