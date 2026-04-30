# Agent 侧 Diff 生成与 Apply 架构

> **版本**: Continue v1.3.19 (main 分支)
> **范围**: 从 agent 发出编辑请求 → LLM 生成 diff → 应用 diff 到文件 → 用户审查的全链路
> **最后更新**: 2026-05-01

---

## 1. 架构总览

```
用户/Agent 请求
     │
     ▼
┌─────────────────────────────────────────────────────┐
│                  工具层 (Tools)                       │
│  edit_file / single_find_replace / multi_edit        │
└─────────────────────────────────────────────────────┘
     │
     ▼ (GUI/Client Side)
┌─────────────────────────────────────────────────────┐
│               Client Tool Router                     │
│          callClientTool()                             │
│  ┌───────────┬──────────────┬──────────────────┐    │
│  │ editImpl │  S&R Impl  │   multiEditImpl   │    │
│  └─────┬─────┴──────┬───────┴────────┬─────────┘    │
│        │            │                 │              │
│        ▼            ▼                 ▼              │
│  applyForEditTool() ←── 统一入口 ─────────           │
└─────────────────────────────────────────────────────┘
     │
     ▼ (IDE 侧)
┌─────────────────────────────────────────────────────┐
│                ApplyManager (VS Code)                 │
│  ┌────────────────────────────────────────────────┐  │
│  │  applyToFile()                                 │  │
│  │  ├─ handleEmptyDocument() → instantApplyDiff   │  │
│  │  └─ handleExistingDocument()                   │  │
│  │       ├─ applyCodeBlock() → 3 种策略           │  │
│  │       │   ├─ UnifiedDiff 解析 (instant)        │  │
│  │       │   ├─ deterministicApply (instant)      │  │
│  │       │   └─ streamLazyApply (LLM assisted)    │  │
│  │       └─ handleNonInstantDiff()                │  │
│  │           └─ streamDiffLines / generateApplied │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
     │
     ▼ (Diff 渲染)
┌─────────────────────────────────────────────────────┐
│              VerticalDiffManager                     │
│  ├─ streamDiffLines() ── 流式 diff 渲染              │
│  ├─ instantApplyDiff() ── 立即 diff 渲染             │
│  └─ streamEdit() ── LLM 辅助 diff 排流               │
└─────────────────────────────────────────────────────┘
     │
     ▼ (Agent loop 续流)
┌─────────────────────────────────────────────────────┐
│              handleApplyStateUpdate                   │
│  status="done" + edit tool → 非阻塞续流               │
│  status="closed" → 记录 tool call 结果 + 续流         │
└─────────────────────────────────────────────────────┘
```

---

## 2. Agent 工具定义

Continue 给 Agent 暴露了 **4 种编辑工具**，都在 `core/tools/builtIn.ts` 中定义为 `CLIENT_TOOLS_IMPLS`（客户端侧处理）：

| 工具 | 枚举名 | 用途 | 实现文件 |
|------|--------|------|---------|
| `edit_existing_file` | `EditExistingFile` | 通用编辑，agent 传 `filepath` + `changes` | `editImpl.ts` |
| `single_find_and_replace` | `SingleFindAndReplace` | 精确 search/replace 模式 | `singleFindAndReplaceImpl.ts` |
| `multi_edit` | `MultiEdit` | 同一个文件多个 search/replace 片段 | `multiEditImpl.ts` |
| `create_new_file` | `CreateNewFile` | 创建新文件 | `createNewFileImpl.ts` |

**关键设计**: 这 4 个工具不经过 `core/tools/callTool.ts`（即服务器侧），而是在 GUI 层的 `callClientTool()` 中路由处理。这是因为编辑需要直接访问 IDE 的编辑器 API（如读取当前文件内容、打开文件）。

### 2.1 `edit_existing_file` 工具

**定义**: `core/tools/definitions/editFile.ts`

```typescript
interface EditToolArgs {
  filepath: string;  // 工作区相对路径
  changes: string;   // 代码变更，可以是完整文件或带 "// ... existing code ..." 的稀疏编辑
}
```

特点：
- `defaultToolPolicy: "allowedWithPermission"` — 需用户确认
- `isInstant: false` — 非即时工具（依赖 LLM 生成 diff）
- 禁止与其他工具并行调用
- `readonly: false`
- System message 中嵌入示例，引导 Agent 使用 `... existing code ...` lazy block 模式

### 2.2 `single_find_and_replace` 工具

精确匹配模式，参数：

```typescript
interface SingleFindAndReplaceArgs {
  filepath: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

### 2.3 `multi_edit` 工具

一个文件内多个 search/replace：

```typescript
interface MultiEditArgs {
  filepath: string;
  edits: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
}
```

---

## 3. 客户端工具路由 (Client Tool Router)

**入口**: `gui/src/util/clientTools/callClientTool.ts`

```typescript
async function callClientTool(toolCallState, extras): ClientToolResult {
  switch (toolCall.function.name) {
    case BuiltInToolNames.EditExistingFile:
      return await editToolImpl(parsedArgs, toolCall.id, extras);
    case BuiltInToolNames.SingleFindAndReplace:
      return await singleFindAndReplaceImpl(...);
    case BuiltInToolNames.MultiEdit:
      return await multiEditImpl(...);
    case BuiltInToolNames.CreateNewFile:
      return await createNewFileImpl(...);
  }
}
```

### 3.1 `editImpl.ts` — 通用编辑路径

```typescript
export const editToolImpl: ClientToolImpl = async (args, toolCallId, extras) => {
  // 1. 校验参数
  if (!args.filepath || !args.changes) throw Error(...);
  
  // 2. 解析文件路径（相对路径 → URI）
  let fileUri = await resolveRelativePathInDir(filepath, extras.ideMessenger.ide);
  if (!fileUri) { /* 遍历打开的文件匹配 */ }
  
  // 3. 生成 streamId，分派 applyForEditTool
  const streamId = uuid();
  void extras.dispatch(applyForEditTool({ streamId, text: args.changes, toolCallId, filepath: fileUri }));
  
  // 4. 延迟响应 — 不阻塞 agent loop
  return { respondImmediately: false, output: undefined };
};
```

**关键设计模式**: `respondImmediately: false` + `applyForEditTool` 分派。这意味着：
- Client tool 调用**不阻塞** agent loop 继续
- 实际的编辑进度由后续的 `ApplyState` 更新事件驱动
- 编辑完成时通过 `handleApplyStateUpdate` 重新触发 `streamResponseAfterToolCall`

### 3.2 `singleFindAndReplaceImpl.ts` — 精确搜索替换路径

```typescript
export const singleFindAndReplaceImpl: ClientToolImpl = async (args, toolCallId, extras) => {
  // 1. 校验 old_string / new_string
  const { oldString, newString, replaceAll } = validateSingleEdit(...);
  
  // 2. 读取文件当前内容
  const editingFileContents = await extras.ideMessenger.ide.readFile(fileUri);
  
  // 3. 在 GUI 层执行搜索替换（不调用 LLM）
  const newFileContents = executeFindAndReplace(editingFileContents, oldString, newString, replaceAll, 0);
  
  // 4. 将完整文件新内容传给 ApplyManager
  const streamId = uuid();
  void extras.dispatch(applyForEditTool({ 
    streamId, toolCallId, 
    text: newFileContents,  // ← 是完整的文件内容！
    filepath: fileUri,
    isSearchAndReplace: true,  // ← 标记为 search/replace
  }));
  
  return { respondImmediately: false, output: undefined };
};
```

**差异点**: search/replace 直接在 GUI 层完成文本运算，传给 ApplyManager 的是**完整的文件新内容**。ApplyManager 侧遇到 `isSearchAndReplace: true` 时走 `instantApplyDiff` 路径。

### 3.3 `multiEditImpl.ts`

同上，在一个文件内依次执行多个 search/replace，传入 ApplyManager 的是完整文件内容。

---

## 4. ApplyManager (VS Code 侧)

**入口**: `extensions/vscode/src/apply/ApplyManager.ts`

这是 diff 生成与应用的**核心协调器**。

### 4.1 `applyToFile()` 入口

```typescript
async applyToFile({ streamId, filepath, text, toolCallId, isSearchAndReplace }) {
  const editor = await this.ensureFileOpen(filepath);
  const originalFileContent = editor.document.getText();
  
  // 通知 GUI: 开始流式处理
  await this.webviewProtocol.request("updateApplyState", {
    streamId, status: "streaming", fileContent: text, originalFileContent, toolCallId,
  });
  
  if (hasExistingDocument) {
    if (isSearchAndReplace) {
      // search/replace → 完整内容，直接 myers diff
      await this.verticalDiffManager.instantApplyDiff(originalFileContent, text, streamId, toolCallId);
    } else {
      // edit_existing_file → 需要解析 "changes" 中的稀疏编辑
      await this.handleExistingDocument(editor, text, streamId, toolCallId);
    }
  } else {
    await this.handleEmptyDocument(editor, text, streamId, toolCallId);
  }
}
```

### 4.2 `handleExistingDocument()` — 3 种 Apply 策略

```typescript
private async handleExistingDocument(editor, text, streamId, toolCallId) {
  const llm = config.selectedModelByRole.apply ?? config.selectedModelByRole.chat;
  
  const { isInstantApply, diffLinesGenerator } = await applyCodeBlock(
    editor.document.getText(),  // oldFile
    text,                        // newLazyFile (可能含 ... existing code ...)
    filename,
    llm,
    abortController,
  );
  
  if (isInstantApply) {
    // 策略 1/2 成功 → 立即渲染 diff
    await this.verticalDiffManager.streamDiffLines(diffLinesGenerator, true, streamId, toolCallId);
  } else {
    // 策略 3 fallback → 需要 LLM 辅助
    await this.handleNonInstantDiff(editor, text, llm, streamId, verticalDiffManager, toolCallId, ...);
  }
}
```

### 4.3 `applyCodeBlock()` — 3 种策略选择

**入口**: `core/edit/lazy/applyCodeBlock.ts`

```typescript
export async function applyCodeBlock(oldFile, newLazyFile, filename, llm, abortController) {
  
  // ─── 策略 1: Unified Diff 直接解析 ───
  if (isUnifiedDiffFormat(newLazyFile)) {
    try {
      const diffLines = applyUnifiedDiff(oldFile, newLazyFile);
      return { isInstantApply: true, diffLinesGenerator: generateLines(diffLines) };
    } catch (e) { /* fall through */ }
  }
  
  // ─── 策略 2: 确定性 lazy block 解析 ───
  if (canUseInstantApply(filename)) { // 支持 tree-sitter 的语言
    const diffLines = await deterministicApplyLazyEdit({
      oldFile, newLazyFile, filename,
      onlyFullFileRewrite: true,  // V2：只处理无 lazy block 的全文件重写
    });
    if (diffLines !== undefined) {
      return { isInstantApply: true, diffLinesGenerator: generateLines(diffLines) };
    }
  }
  
  // ─── 策略 3: LLM 辅助 lazy apply ───
  return {
    isInstantApply: false,
    diffLinesGenerator: streamLazyApply(oldFile, filename, newLazyFile, llm, abortController),
  };
}
```

---

## 5. 三种 Apply 策略详解

### 5.1 策略 1: Unified Diff 解析

**文件**: `core/edit/lazy/unifiedDiffApply.ts`

当 LLM 的输出格式为 **unified diff**（`@@ -n,m +n,m @@` 格式）时直接解析：

```typescript
isUnifiedDiffFormat(newLazyFile)  // 检查是否包含 @@ hunk header
  → parseUnifiedDiff()            // 解析 hunks
  → findHunkInSource()            // 在原始文件中定位上下文
    → linesMatch()                // 支持模糊匹配（trim 后比较）
  → applyHunks()                  // 生成 DiffLine[]
```

**匹配规则**:
- 上下文行使用 `linesMatch()`（trim 前缀空白后比较）
- 逐 hunk 在源文件中定位，从 `currentPos` 开始搜索
- 如果 hunk 无法定位 → 抛出错误 → fallthrough 到策略 2/3

### 5.2 策略 2: 确定性 Lazy Block 解析

**文件**: `core/edit/lazy/deterministic.ts`

当 LLM 的输出包含 `// ... existing code ...` 或 `# ... rest of code ...` 时，用 **tree-sitter AST** 解析：

```
当前模式 (onlyFullFileRewrite = true):
  1. 检查是否含 lazy block
  2. 如果没有 lazy block → myersDiff(oldFile, newLazyFile)
  3. 如果删除比例 > 30% → 拒绝，fallback
  4. 返回 DiffLine[]

遗留模式 (onlyFullFileRewrite = false):
  1. AST 解析新旧文件
  2. findLazyBlockReplacements() — 类似 Myers diff 的 AST 节点匹配
     - 遇到新文件中的 lazy block 时进入 "lazy 模式"
     - 收集旧文件中被 lazy block 替代的所有节点
     - 遇到匹配节点时退出 lazy 模式
  3. reconstructNewFile() — 用旧文件代码填充 lazy block
  4. myersDiff() 比较重建后的文件和旧文件
  5. 如果删除比例 > 30% → 拒绝
```

**核心算法** `findLazyBlockReplacements()`:
```
输入: oldNode (旧 AST), newNode (新 AST)
处理: 同时遍历新旧两个 AST 的子节点
  - 如果新节点是 lazy block → 进入 lazy 模式，跳过
  - 查找旧节点在新节点列表中的相似匹配（nodesAreSimilar）
    - 无匹配 → 在 lazy 模式下将其加入替换列表
    - 有匹配 → 记录替换关系，递归处理匹配对
输出: replacements[] (lazy block → 旧代码片段)
```

**节点相似度检测** `nodesAreSimilar()`:
1. 同名节点（`name` field 匹配）→ 相似
2. 第一个 namedChild + 第二个 child 匹配 → 相似
3. JSX 元素：标签名匹配 + LevDist ≤ 0.3 → 相似
4. 第一行 LevDist ≤ 0.2 → 相似

### 5.3 策略 3: LLM 辅助 Lazy Apply (streamLazyApply)

**文件**: `core/edit/lazy/streamLazyApply.ts`

当策略 1/2 都失败时的最终 fallback，额外调用 LLM 来生成完整文件：

```typescript
async function* streamLazyApply(oldCode, filename, newCode, llm, abortController) {
  // 1. 构建 lazy apply prompt
  const promptMessages = lazyApplyPromptForModel(llm.model, llm.providerName)(oldCode, filename, newCode);
  
  // 2. 流式请求 LLM 生成完整文件
  const lazyCompletion = streamAssistantContentOnly(llm.streamChat(promptMessages));
  
  // 3. 流式填充 UNCHANGED CODE 块
  const lines = streamFillUnchangedCode(
    lazyCompletionLines, oldCode, 
    (oldCode, linesBefore, linesAfter) => getReplacementWithLlm(oldCode, linesBefore, linesAfter, llm)
  );
  
  // 4. 与原始 oldCode 对比生成 DiffLine
  const diffLines = streamDiff(oldLines, lines);
  yield diffLines;
}
```

**lazy apply prompt**（`prompts.ts`）:
```
ORIGINAL CODE:
```${filename}
${oldCode}
```

NEW CODE:
```
${newCode}
```

Apply the NEW CODE to the ORIGINAL CODE and show what the entire file would look like.
- Whenever any part of the code is the same as before, use "UNCHANGED CODE" comment
- Keep at least one line above and below from original code
- Leave existing comments in place
```

**streamFillUnchangedCode** 算法:
```
逐行读取 LLM 流式输出
  - 如果遇到 "UNCHANGED CODE"：
    → 缓冲后续 BUFFER_LINES_BELOW 行
    → 调用 getReplacementWithLlm() 找到原文件中匹配的代码段
    → 输出替换代码
    → 输出缓冲行
  - 否则直接输出
```

**注意**: `lazyApplyPromptForModel` 目前只支持 `sonnet` 模型（`model.includes("sonnet")`），其他模型会抛出错误。

---

## 6. `handleNonInstantDiff()` — Apply 模型 LLM 路径

当策略 1/2 都失败时，ApplyManager 走 `handleNonInstantDiff()` 路径，用一个专门的 **Apply 模型**（`config.selectedModelByRole.apply` 或 `chat`）来生成 diff。

### 6.1 流程图

```
handleNonInstantDiff()
  │
  ├─ computeApplyRange() → 计算编辑范围（全文件 或 光标 ±40 行窗口）
  │
  ├─ calculatePrefixSuffix() → 裁剪 prefix/suffix（不超过 1/4 context length）
  │
  ├─ [已有 diff handler?]
  │   └─ Yes → generateAppliedContent() → 累积 LLM 输出 → instantApplyDiff
  │
  ├─ [streaming = true]
  │   └─ verticalDiffManager.streamEdit() → 流式 LLM 输出 + 实时 diff 渲染
  │       └─ 异常处理: Token limit → fallback 到 myersDiff
  │
  └─ [streaming = false (fast apply 模型)]
      └─ generateAppliedContent() → 累积 LLM 输出 → myersDiff → instantApplyDiff
```

### 6.2 streamDiffLines() — 核心流式编辑

**文件**: `core/edit/streamDiffLines.ts`

```typescript
export async function* streamDiffLines(options, llm, abortController, overridePrompt, rules) {
  const { type, prefix, highlighted, suffix, input, language } = options;
  
  // 1. 构建 prompt（edit 或 apply）
  const prompt = type === "apply" 
    ? constructApplyPrompt(prefix, highlighted, suffix, llm, options.newCode, language)
    : constructEditPrompt(prefix, highlighted, suffix, llm, input, language);
  
  // 2. 可选加入 rules
  const systemMessage = getSystemMessageWithRules(...);
  
  // 3. 调用 LLM 流式生成
  const completion = recursiveStream(llm, abortController, type, prompt, prediction);
  
  // 4. 过滤管线
  let lines = streamLines(completion);
  lines = filterEnglishLinesAtStart(lines);  
  lines = filterCodeBlockLines(lines);       // 去除 ``` 标记
  lines = stopAtLines(lines, ...);
  lines = skipLines(lines);
  lines = removeTrailingWhitespace(lines);
  
  // 5. 与 oldLines 对比生成 DiffLine
  let diffLines = streamDiff(oldLines, lines);
  diffLines = filterLeadingAndTrailingNewLineInsertion(diffLines);
  
  yield diffLines;
}
```

**apply prompt** (`core/llm/templates/edit/gpt.ts`):

有 prefix/suffix 时（精确范围）：
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
${newCode}
```

Apply the SUGGESTED EDIT to the code. Only output the modified code within the range.
```

无 prefix/suffix 时（全文件）：
```
ORIGINAL CODE:
```
${originalCode}
```

SUGGESTED EDIT:
```
${newCode}
```

Apply the SUGGESTED EDIT to the ORIGINAL CODE. Output the complete modified code.
- Output ONLY code.
- Leave existing comments in place.
- Preserve all unchanged code exactly as-is.
```

### 6.3 Myers Diff

**文件**: `core/diff/myers.ts`

标准 Myers diff 算法实现，用于将 LLM 输出的完整代码与原始代码逐行对比，生成 `DiffLine[]`（`same`/`new`/`old`）。

**streamDiff** (`core/diff/streamDiff.ts`) 是 Myers diff 的**流式变体**，一边接收 LLM 的输出流，一边实时比对输出 DiffLine，支持流式渲染 diff。

---

## 7. 搜索替换核心（search/replace）

**文件**: `core/edit/searchAndReplace/performReplace.ts`

### 7.1 `executeFindAndReplace()`

```
执行流程:
  1. findSearchMatches(fileContent, oldString)
     - 共 6 层模糊匹配策略:
       a) exactMatch — 精确匹配
       b) trimmedMatch — trim 后匹配
       c) whitespaceIgnoredMatch — 忽略空白
       d) prefixTrimmedMatch — 仅第一行 trim
       e) multiLineTrimmedMatch — 多行 trim
       f) emptySearch — 空字符串搜索（用于插入）
  2. adjustReplacementIndentation()
     - 根据匹配到的实际缩进调整 new_string 的缩进
  3. 反向替换（为了保持位置正确）
```

### 7.2 缩进调整

```typescript
function adjustReplacementIndentation(fileContent, match, oldString, newString) {
  // 计算匹配位置的实际缩进 matchedIndent
  // 计算 oldString 的期望缩进 oldIndent
  // 调整 newString 中每行的缩进：
  //   - 第 1 行：去掉 oldIndent（因为文件中的缩进已存在）
  //   - 后续行：oldIndent → matchedIndent
}
```

### 7.3 `executeMultiFindAndReplace()`

依次对 `edits[]` 数组中的每个 edit 执行 `executeFindAndReplace()`，结果作为下一个 edit 的输入。

---

## 8. Vertical Diff Manager (VS Code 渲染层)

**文件**: `extensions/vscode/src/diff/vertical/manager.ts`

负责在 VS Code 编辑器中**可视化渲染 diff**。

### 8.1 核心方法

| 方法 | 用途 | 触发场景 |
|------|------|---------|
| `streamDiffLines(diffStream, instant, streamId)` | 流式 diff 渲染 | 策略 1/2 瞬时应用 + streamDiffLines |
| `instantApplyDiff(oldContent, newContent, streamId)` | 瞬时 diff 渲染 | search/replace、generateAppliedContent |
| `streamEdit({input, llm, range, ...})` | LLM 辅助编辑 + 流式渲染 | handleNonInstantDiff 流式路径 |

### 8.2 流式工作流程

```typescript
async streamDiffLines(diffStream, instant, streamId) {
  // 1. 设置 diff 可见状态
  vscode.commands.executeCommand("setContext", "continue.diffVisible", true);
  
  // 2. 检查是否已有 handler（重复编辑）
  const existingHandler = this.getHandlerForFile(fileUri);
  if (existingHandler) {
    // 累积 diff — 在已有 diff 基础上叠加新编辑
    const diffLines = [];  // 收集流中的所有 DiffLine
    const newContent = getNewContentFromDiffLines(diffLines);
    reapplyCumulativeDiff({ handler, baseFileContent, newContent, streamId, toolCallId });
    return;
  }
  
  // 3. 创建新的 diff handler
  const diffHandler = this.createVerticalDiffHandler(fileUri, startLine, endLine, {
    instant,
    onStatusUpdate: (status, numDiffs, fileContent) => 
      webviewProtocol.request("updateApplyState", { streamId, status, numDiffs, fileContent, ... }),
    baseFileContent: editor.document.getText(),
    streamId,
  });
  
  // 4. 运行 diff 流 → handler 逐行渲染
  this.logDiffs = await diffHandler.run(diffStream);
  
  // 5. 启用用户修改监听
  this.enableDocumentChangeListener();
}
```

### 8.3 瞬时工作流程

```typescript
async instantApplyDiff(oldContent, newContent, streamId) {
  // 1. Myers diff 比较新旧内容
  const myersDiffs = myersDiff(oldContent, newContent);
  
  // 2. 检查累积
  // ...
  
  // 3. 创建 handler + myers diff 渲染
  await diffHandler.reapplyWithMyersDiff(myersDiffs);
  
  // 4. 滚动到第一个改动行
  editor.revealRange(getFirstChangedLine(myersDiffs, 0));
  
  // 5. 通知 GUI: 完成
  webviewProtocol.request("updateApplyState", { streamId, status: "done", ... });
}
```

### 8.4 用户审查与完成

用户通过 VS Code 的 CodeLens（Accept/Reject 按钮）操作：

```
processDiff(action, sidebar, ide, core, verticalDiffManager)
  │
  ├─ action = "accept"
  │   ├─ verticalDiffManager.clearForfileUri(fileUri, true)
  │   ├─ editOutcomeTracker.recordEditOutcome(streamId, true)
  │   └─ ide.saveFile(fileUri)
  │
  └─ action = "reject"
      ├─ verticalDiffManager.clearForfileUri(fileUri, false)
      ├─ core.invoke("cancelApply", undefined)  // 取消应用
      ├─ editOutcomeTracker.recordEditOutcome(streamId, false)
      └─ ide.saveFile(fileUri)  // 保存（恢复原始内容）
```

完成后发送 `updateApplyState({status: "closed", ...})` 给 GUI。

---

## 9. Agent 循环续流

### 9.1 `handleApplyStateUpdate` 状态机

**文件**: `gui/src/redux/thunks/handleApplyStateUpdate.ts`

```
ApplyState 状态机:
  not-started → streaming → done → closed
                              ↘  (用户操作)

关键事件:
  status = "done" + 是 edit tool:
    → acceptToolCall(toolCallId)       — 标记 tool call 完成
    → updateToolCallOutput(Edit Pending Review) — 隐藏的 context item
    → streamResponseAfterToolCall()    — 不阻塞，继续 agent loop
    
  status = "closed" + accepted:
    → logToolUsage(accepted, true)      — 记录使用
    → updateToolCallOutput(Edit Success)   — 通知模型编辑成功
    → streamResponseAfterToolCall()     — 继续 agent loop
```

### 9.2 非阻塞编辑设计

**V0.5 实现**（`item16-terminal-agent-subagent-runtime.md`）：

1. ApplyState `status === "done"` 时，GUI 将 edit tool call 标记为完成
2. 工具输出写入隐藏 context item：`Edit Pending Review`，告知模型编辑已应用但 diff 等待审查
3. agent loop 继续下一轮，不等待用户 accept/reject
4. `status === "closed"` 时，记录用户操作结果，模型仍可继续工作

### 9.3 `streamResponseAfterToolCall()`

```typescript
async streamResponseAfterToolCall({ toolCallId, depth }) {
  // 1. 找到对应的 tool call state
  // 2. 检查是否所有 tool call 都完成
  // 3. 将已完成 tool call 的输出渲染为 tool 消息
  const newMessages = toolStatesToStream.map(tc => ({
    role: "tool",
    content: renderContextItems(tc.output),
    toolCallId: tc.toolCallId,
  }));
  dispatch(streamUpdate(newMessages));
  
  // 4. 如果全部完成 → 继续 agent loop
  if (areAllToolsDoneStreaming(assistantMessage)) {
    await dispatch(streamNormalInput({ depth: depth + 1 }));
  }
}
```

---

## 10. 快模型适配

**特定模型优化**（`ApplyManager.ts`）：

```typescript
// Gemini Mercury 等极快模型跳过流式
private modelIsTooFastForStreaming(model): boolean {
  return [/mercury/].some((r) => r.test(model));
}
```

快速模型走 `handleNonInstantDiff` 的**非流式路径**：
1. 累积 LLM 完整输出
2. Myers diff 一次性比较
3. `instantApplyDiff` 渲染

---

## 11. 编辑流 key-Value 总结

| 维度 | edit_existing_file | single_find_and_replace | multi_edit |
|------|-------------------|------------------------|------------|
| 输入 | filepath + changes (稀疏) | filepath + old_string + new_string | filepath + edits[] |
| 文件解析 | 路径匹配（相对/打开文件） | 同左 | 同左 |
| 内容来源 | LLM 生成的稀疏编辑 | 代码内精确替换 | 代码内精确替换 |
| 传给 ApplyManager | `text = changes` | `text = 完整新文件` | `text = 完整新文件` |
| isSearchAndReplace | false | true | true |
| Apply 策略 | applyCodeBlock() 3 种 | instantApplyDiff (myers) | 同左 |
| Diff 类型 | 流式/LLM 辅助 | 瞬时 | 瞬时 |
| 用户操作 | Accept/Reject | Accept/Reject | Accept/Reject |
| Agent 续流 | 非阻塞（done 时续流） | 非阻塞（done 时续流） | 非阻塞（done 时续流） |

---

## 12. 关键文件索引

| 功能 | 文件路径 |
|------|---------|
| 工具定义 | `core/tools/definitions/editFile.ts` |
| 工具注册 | `core/tools/builtIn.ts` |
| 客户端路由 | `gui/src/util/clientTools/callClientTool.ts` |
| edit 实现 | `gui/src/util/clientTools/editImpl.ts` |
| S&R 实现 | `gui/src/util/clientTools/singleFindAndReplaceImpl.ts` |
| multi_edit 实现 | `gui/src/util/clientTools/multiEditImpl.ts` |
| Apply 协调 | `extensions/vscode/src/apply/ApplyManager.ts` |
| Apply 入口 | `gui/src/redux/thunks/handleApplyStateUpdate.ts` |
| 3 种策略选择 | `core/edit/lazy/applyCodeBlock.ts` |
| Unified diff 解析 | `core/edit/lazy/unifiedDiffApply.ts` |
| 确定性 apply | `core/edit/lazy/deterministic.ts` |
| LLM lazy apply | `core/edit/lazy/streamLazyApply.ts` |
| Lazy apply prompt | `core/edit/lazy/prompts.ts` |
| 流式 diff 生成 | `core/edit/streamDiffLines.ts` |
| LLM apply prompt | `core/llm/templates/edit/gpt.ts` |
| Myers diff | `core/diff/myers.ts` |
| 流式 diff 比对 | `core/diff/streamDiff.ts` |
| S&R 执行 | `core/edit/searchAndReplace/performReplace.ts` |
| S&R 匹配 | `core/edit/searchAndReplace/findSearchMatch.ts` |
| Vertical diff 渲染 | `extensions/vscode/src/diff/vertical/manager.ts` |
| Diff 完成处理 | `extensions/vscode/src/diff/processDiff.ts` |
| Agent 续流 | `gui/src/redux/thunks/streamResponseAfterToolCall.ts` |
| Apply abort 管理 | `core/edit/applyAbortManager.ts` |
| AST 查找工具 | `core/edit/lazy/findInAst.ts` |
