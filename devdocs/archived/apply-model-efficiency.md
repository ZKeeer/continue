# Apply 模型效率优化

> 实施日期: 2026-04-30
> 状态: ✅ 已完成
> 范围: 降低 apply 模型生成完整文件的 token 浪费

## 根因

### 问题 1: `defaultApplyPrompt` 要求输出完整文件

`core/llm/templates/edit/gpt.ts:93`:
```
Output the complete modified file.
```

每次 apply 操作模型都会输出整个文件，即使只改了 5 行。

### 问题 2: `handleNonInstantDiff()` 传入全文件范围

`ApplyManager.ts:208-216` — 用户无选区时 `rangeToApplyTo = fullEditorRange`，`streamEdit()` 将全文件设为 `highlighted` 传给 LLM。

### 问题 3: `constructApplyPrompt` 忽略 prefix/suffix

`streamDiffLines.ts:112` — `type === "apply"` 路径下 `prefix`/`suffix` 存在但不传给 prompt，只用 `oldLines.join("\n")`（即全文件内容）。

## 改动方案

### 改动 1: `defaultApplyPrompt` — prefix/suffix 上下文 + 仅输出修改范围

新增 prefix/suffix 分支（当有 prefix/suffix 时）:
```
This is the prefix of the file:
```language
${prefix}
```

This is the suffix of the file:
```language
${suffix}
```

This is the code to modify:
```language
${highlighted}
```

SUGGESTED EDIT:
```language
${new_code}
```

Apply the SUGGESTED EDIT to the code. Only output the modified code within the range, not the prefix or suffix.
```

无 prefix/suffix 时保留原有 fallback（全文件模式）。

**文件**: `core/llm/templates/edit/gpt.ts`

### 改动 2: `constructApplyPrompt` — 接收 prefix/suffix/highlighted/language

函数签名从 `(originalCode, newCode, llm)` 改为 `(prefix, highlighted, suffix, llm, newCode, language)`，传递 `prefix`/`suffix`/`codeToEdit`/`language` 给 prompt 模板。

**文件**: `core/edit/streamDiffLines.ts`

### 改动 3: `streamDiffLines` — 传入 prefix/suffix

`type === "apply"` 路径改为:
```typescript
constructApplyPrompt(prefix, highlighted, suffix, llm, options.newCode, language)
```

**文件**: `core/edit/streamDiffLines.ts`

### 改动 4: `computeApplyRange` — 限制范围

新增 `computeApplyRange()` 方法:
- 文件 ≤ 80 行 → 使用全文件
- 文件 > 80 行 → 光标 ± 40 行窗口

`handleNonInstantDiff()` 无选区时使用此方法而非 `fullEditorRange`。

**文件**: `extensions/vscode/src/apply/ApplyManager.ts`

## 效果

| 文件大小 | 原输出量 | 新输出量 |
|---------|---------|---------|
| 小 (≤80行) | 全文件 | 全文件（不变） |
| 大 (500行) | 500行 | 81行（光标±40） |
| 大 + 选区 | 选区内容 | 选区内容（不变） |
