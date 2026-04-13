# 自动补全质量诊断：7 个核心问题根因分析 (2026-04-08)

## 日志来源

- **VS Code**: `jn-vscode-20260408215000.txt` — VS Code Insiders + continue-1.3.39
- **PyCharm**: `jn-pycharm-20260408215300.log` — PyCharm CE 2024.3 + binary core
- **sglang 服务**: `http://autocomplete.sglang.ai.infra/v1/completions`
- **模型**: `Qwen3-Coder-30B-A3B-Instruct` / `Qwen3-Coder-Next-AWQ-8bit`

## 日志统计摘要

### PyCharm (38秒内, 13:17:30 → 13:18:08)

| 指标                            | 数值    |
| ------------------------------- | ------- |
| 总请求数 (StreamRaw)            | 11      |
| 成功返回 (Result)               | 4       |
| 被 abort / 空结果 (EmptyResult) | 7       |
| **成功率**                      | **36%** |
| 平均成功补全长度                | 30 字符 |
| abort 次数                      | 5       |
| rawLen=0 的请求                 | 7       |

### VS Code (同一时段)

| 指标                      | 数值                      |
| ------------------------- | ------------------------- |
| abort 错误 (llm_fetch)    | ~10+                      |
| rawLen=0 或 1             | 大量                      |
| PostReject reason=isBlank | 5+                        |
| 成功返回有内容 (rawLen>1) | 2 (rawLen=138, rawLen=12) |

### 关键时间序列异常

**异常 1: 13:17:50 PyCharm abort 级联** — 3 个请求在 1 秒内连续触发并互相取消：

```
13:17:50 ba6a97f1 → abort → rawLen=0 → PostReject isBlank
13:17:50 11f61bc1 → abort → rawLen=0 → PostReject isBlank
13:17:52 ac9f5028 →         rawLen=0 → PostReject isBlank (被下一个请求占用 sglang 队列)
```

**异常 2: VS Code 双重 error 日志** — 每次 abort 产生两条 error（`llm_fetch` + `llm_stream_complete`）：

```
ERR: The operation was aborted. {"context":"llm_fetch","url":"http://autocomplete.sglang.ai.infra/v1/completions",...}
ERR: The operation was aborted. {"context":"llm_stream_complete","model":"Qwen3-Coder-30B-A3B-Instruct",...}
```

根因：`GeneratorReuseManager.ts:49` 创建了 **第二个 AbortController**，与 `CompletionProvider.ts:237` 的形成二级 abort。

**异常 3: `mock:///` URI 出现在 PyCharm prompt** — `<|file_sep|>mock:///bpp_case_tools.py`，JetBrains 虚拟文件 scheme 未被正规化。

---

## 问题 1: 服务器端 abort 数量过多，影响性能

### 根因链

```
用户连续击键
  → debounce 定时器重置
  → 但前一个请求已通过 debounce，正在 sglang 流式推理
  → GeneratorReuseManager.getGenerator() 发现 prefix 不匹配
  → ListenableGenerator.cancel() 触发 AbortController.abort()
  → fetch 发送 TCP RST 到 sglang
  → GPU 推理白做 → KV cache 占用直到 sglang GC
```

### 代码路径

| 步骤                      | 文件                       | 位置 | 说明                                              |
| ------------------------- | -------------------------- | ---- | ------------------------------------------------- |
| 1. 创建主 AbortController | `CompletionProvider.ts`    | L237 | 存入 `_abortControllers` Map                      |
| 2. 创建副 AbortController | `GeneratorReuseManager.ts` | L49  | 包装到 ListenableGenerator                        |
| 3. prefix 不匹配触发取消  | `GeneratorReuseManager.ts` | L49  | `_createListenableGenerator()` 中取消旧 generator |
| 4. abort 传播到 fetch     | `llm/index.ts`             | L492 | catch 并 log，级别为 **error**                    |
| 5. 二次 log               | `llm/index.ts`             | L818 | `_streamComplete` 的 catch 再 log 一次            |

### 影响量化

每次 abort：

- 浪费 sglang GPU 推理（prefill + 已生成 decode 步）
- 占用 sglang KV cache slot（8K token prompt ≈ 几十 MB 显存）直至清理
- 产生 **2 条 error 日志**（`llm_fetch` + `llm_stream_complete`）
- 网络往返开销（TCP 建连 + RST）

### 修复方案

**方案 A (P0): 降低 abort 日志级别**

文件: `core/llm/index.ts` L492 附近

```typescript
// 当前: Logger.error(e, { context: "llm_fetch", ... });
// 改为:
if (isAbortError(e)) {
  Logger.debug("Autocomplete request aborted", { context: "llm_fetch", ... });
} else {
  Logger.error(e, { context: "llm_fetch", ... });
}
```

同理修改 `_streamComplete` 的 catch (L818)。

**方案 B (P1): 在 debounce 阶段即 abort 前一请求**

当前流程：debounce 超时后才检查 `currentRequestId !== requestId`，此时前一请求可能已在 LLM 端推理。建议在 `delayAndShouldDebounce()` 发现新请求来时，立即 abort 前一请求的 AbortController。

**方案 C (P2): 集成 sglang /abort API**

abort 时不仅客户端终止，还调用 sglang 的 abort endpoint 释放服务端 KV cache。

---

## 问题 2: 自动补全多数情况出不来，PyCharm 最常见

### PyCharm 特有根因 (相比 VS Code 额外的 4 个因素)

#### 2a. JetBrains 缺少 abort 信号传播 (最关键)

**文件**: `extensions/intellij/.../ContinueCompletionService.kt`

```kotlin
// 当前: 不传 AbortSignal，无法从 IDE 端取消 core 请求
coreMessenger?.request("autocomplete/complete", requestInput, null) { }
```

当 JetBrains 端 `withTimeoutOrNull(modelTimeout * 3)` 超时返回 null 后，core 端的 LLM 请求 **仍在运行**。下次击键触发新请求时，新旧请求在 sglang 上并发竞争，导致队列拥堵。

**VS Code 对比**: `AbortController` 从 `CompletionProvider` 一路传到 `fetch(url, { signal })`，超时后清理干净。

#### 2b. 固定间隔 debouncer

**文件**: `extensions/intellij/.../Debouncer.kt`

```kotlin
// JetBrains: 简单固定延迟
fun debounce(action: suspend () -> Unit) {
    debounceJob?.cancel()
    debounceJob = coroutineScope.launch { delay(interval); action() }
}
```

**VS Code**: `AutocompleteDebouncer.ts` 有自适应延迟：

- 快速打字 (<80ms) → 150-200ms 延迟（合并请求）
- 正常打字 → 80ms
- 停顿 (>200ms) → 30ms（快速响应）

JetBrains 没有这种自适应能力，快速打字时发出更多无效请求。

#### 2c. `mock:///` URI 导致路径解析失败

JetBrains 对虚拟文件返回 `mock:///` scheme。`ImportDefinitionsService` 和 `ContextRetrievalService` 使用 `fileURLToPath()` 处理 → 对 `mock:///` 抛异常 → import 定义加载失败。

#### 2d. 文档仅 ±5 行增量同步

**文件**: `extensions/intellij/.../DocumentChangeTracker.kt`

```kotlin
val paddedStart = Math.max(0, startLine - 5)
val paddedEnd = Math.min(document.lineCount - 1, endLine + 5)
```

core 可能持有过期文件内容。

### 通用根因 (VS Code 也存在)

#### 2e. `noDoubleNewLine()` 过滤器杀死补全

**文件**: `core/autocomplete/filtering/streamTransforms/lineStream.ts` L664

```typescript
export async function* noDoubleNewLine(lines: LineStream): LineStream {
  let isFirstLine = true;
  for await (const line of lines) {
    if (line.trim() === "" && !isFirstLine) {
      return; // ← 见到空行就终止整个 pipeline！
    }
    isFirstLine = false;
    yield line;
  }
}
```

Python 中语句间常有空行 (PEP 8 风格)。LLM 输出: `line1 + \n + \n + line2` → 经过该过滤器后只剩 `line1`（可能只有一个换行符或空白） → rawLen=1 → `PostReject reason=isBlank`。

这是日志中大量 `rawLen=0` / `rawLen=1` + `PostReject isBlank` 的 **主要来源**。

#### 2f. sglang prefill 延迟 vs modelTimeout 竞争

prompt 长度 ~8000 tokens，sglang prefill 可能需要 200-500ms。`showWhateverWeHaveAtXMs(modelTimeout)` 从 pipeline **开始**计时。如果 prefill 期间没有 token 到达，for-await 循环自然退出返回空结果。

### 修复方案

**方案 A (P0): 修复 `noDoubleNewLine()`**

改为 **允许单个空行**，仅在连续双空行时停止：

```typescript
export async function* noDoubleNewLine(lines: LineStream): LineStream {
  let isFirstLine = true;
  let lastLineWasEmpty = false;

  for await (const line of lines) {
    const isEmpty = line.trim() === "";
    if (isEmpty && lastLineWasEmpty && !isFirstLine) {
      return; // 连续两个空行才停止
    }
    if (isEmpty && !isFirstLine) {
      lastLineWasEmpty = true;
      yield line;
      continue;
    }
    lastLineWasEmpty = false;
    isFirstLine = false;
    yield line;
  }
}
```

**方案 B (P1): PyCharm 增加 abort 信号传播**

在 `ContinueCompletionService.kt` 中传递取消信号给 core，使 `withTimeoutOrNull()` 超时后能通知 core 停止 LLM 请求。

**方案 C (P1): PyCharm debouncer 改为自适应**

参照 `AutocompleteDebouncer.ts` 实现，根据打字速度动态调整延迟。

---

## 问题 3: 自动补全出半截（语句不完整）

### 根因 1 (主要): `showWhateverWeHaveAtXMs()` 超时截断

**文件**: `core/autocomplete/filtering/streamTransforms/lineStream.ts` L643

```typescript
export async function* showWhateverWeHaveAtXMs(
  lines: LineStream,
  ms: number,
): LineStream {
  const startTime = Date.now(); // ← 计时从 pipeline 开始！
  let firstNonWhitespaceLineYielded = false;

  for await (const line of lines) {
    yield line;
    if (!firstNonWhitespaceLineYielded && line.trim() !== "") {
      firstNonWhitespaceLineYielded = true;
    }
    const isTakingTooLong = Date.now() - startTime > ms;
    if (isTakingTooLong && firstNonWhitespaceLineYielded) {
      break; // ← 超时截断
    }
  }
}
```

**问题**: `startTime` 在 pipeline 开始计时，包含了 sglang prefill 等待时间。对于 8000 token prompt，prefill 可能 200-400ms。如果 `modelTimeout=300ms`，实际留给 decode 生成的窗口只有 0-100ms。

**日志证据**: PyCharm 第一个请求生成 `if response.status_code != 20` (38 chars, 缺 `0:`)，streamMs=2440ms（使用了另一个模型 Qwen3-Coder-Next-AWQ-8bit）。

### 根因 2: `noDoubleNewLine()` 空行截断

LLM 输出两行代码中间有空行 → 第一行之后的空行触发 return → 只显示第一行。

### 根因 3: Stop token 意外命中

当前 stop tokens 包含 `/src/`、`#- coding: utf-8`、` ``` `。如果 Python 代码中出现文件路径包含 `/src/`，会意外截断。

### 修复方案

**方案 A (P0): 修改计时起点**

```typescript
export async function* showWhateverWeHaveAtXMs(
  lines: LineStream,
  ms: number,
): LineStream {
  let startTime: number | null = null; // ← 延迟到首 token
  let firstNonWhitespaceLineYielded = false;

  for await (const line of lines) {
    if (startTime === null) {
      startTime = Date.now(); // ← 从 LLM 首 token 到达开始计时
    }
    yield line;
    if (!firstNonWhitespaceLineYielded && line.trim() !== "") {
      firstNonWhitespaceLineYielded = true;
    }
    const isTakingTooLong = Date.now() - startTime > ms;
    if (isTakingTooLong && firstNonWhitespaceLineYielded) {
      break;
    }
  }
}
```

**方案 B (P1): 审查 `/src/` stop token**

`/src/` 可能在 Python 文件路径中出现（如 `from src.utils import ...`），考虑移除或改为仅在行首匹配。

---

## 问题 4: 单行补全多、多行补全少

### 根本原因: `noDoubleNewLine()` 过滤器

Python 代码风格要求函数体内语句间有空行 (PEP 8)。LLM 生成的多行代码几乎必然包含空行：

```python
# LLM 生成:
x = compute_value()
                        # ← 空行 (Python 惯例)
y = process(x)         # ← 永远不会显示给用户
return y
```

`noDoubleNewLine()` 见到空行就 `return` → 只允许第一行通过。

### 次要原因: `shouldCompleteMultiline()` 分类器

**文件**: `core/autocomplete/classification/shouldCompleteMultiline.ts`

- 如果在单行注释 `//` 内 → 强制单行
- 如果 IntelliSense 补全项被选中 → 强制单行
- 语言特定规则可能限制多行

### 修复方案

同上问题 2 方案 A — 修改 `noDoubleNewLine()` 允许单个空行。这是解决单行/多行比例失调的 **核心修复**。

---

## 问题 5: Prompt 中没有 git diff 内容

### 根本原因: 代码中被故意禁用

**文件**: `core/autocomplete/snippets/getAllSnippets.ts` L235

```typescript
[], // racePromise(getDiffSnippets(ide)) // temporarily disabled, see https://github.com/continuedev/continue/pull/5882,
```

v1 (`getAllSnippets`) 和 v2 (`getAllSnippetsWithoutRace`) 版本均被禁用。

### 禁用原因 (PR #5882)

1. **大 diff 无用**: diff 越大，与当前光标位置补全的关联性越低
2. **大小不可预测**: 无法在获取前估计 diff 大小，可能挤占高价值上下文
3. **JetBrains 卡顿**: 生成/缓存大 diff 导致 IDE 卡住 (#5819)
4. **token 预算浪费**: diff 优先级低 (priority=98)，但可能消耗大量预算

即使启用，`filtering.ts` 也限制 diff 最多占 30% 预算：

```typescript
const maxKeyTokens =
  key === "diff" ? Math.floor(getRemainingTokenCount(helper) * 0.3) : Infinity;
```

### 影响

用户的 git diff 上下文完全丢失。对于理解"用户当前在改什么"的意图推断能力降低。日志中始终 `diff=0(0t)`。

### 修复方案

**方案 A (P1): 有限度恢复 diff snippets**

恢复 diff，但限制范围：

1. 只取当前文件的 diff（不取整个 repo 的 diff）
2. token 预算硬限 200 tokens
3. 超过 200ms 超时丢弃

```typescript
// getAllSnippets.ts
const diffSnippets = await racePromise(
  getDiffSnippetsForCurrentFile(ide, helper.filepath), // 仅当前文件
  200, // 200ms 超时
);
```

**方案 B (P2): 利用已有的 recentlyEditedRanges 替代**

`recentlyEditedRanges` 已经捕获了用户最近的编辑内容，与 diff 有 ~70% 重叠。可以增加 `editedRanges` 的 token 预算从 25% 到 30%，部分弥补 diff 缺失。

---

## 问题 6: Prompt 中缺少调用函数的签名/入参/返回值

### 根本原因: ImportDefinitionsService 在当前环境基本不工作

日志中始终 `import=0(0t)`。

### 失败链路分析

```
ImportDefinitionsService._getFileInfo()
  → tree-sitter parse (需要 import-queries/python.scm)
  → 如缺失 → return { imports: {} }

  → query.matches() 提取 import 符号
  → ide.gotoDefinition() 解析每个符号
    → binary 模式走 IPC → 延迟高 → 150ms 超时后返回空

  → cache.get() 返回 undefined
    → ImportDefinitionsService 是异步预热 (onDidChangeActiveTextEditor)
    → 第一次请求时 cache 可能还没准备好

外层:
  → getAllSnippetsWithoutRace() 中
  → racePromise(contextRetrievalService.getSnippetsFromImportDefinitions(helper), 200)
  → 整个 import 解析超过 200ms → 全部丢弃返回空数组
```

### 设计局限

即使 ImportDefinitionsService 完全正常工作，它也**仅覆盖**：

- import 语句中声明的符号

**不覆盖** (当前完全缺失)：

- 当前函数体中调用的其他函数的签名
- 局部/内置函数的定义
- 返回值类型信息
- 参数说明和 docstring
- 类方法的 self 引用

### 修复方案

**方案 A (P0): 确保 import cache 预热完成**

在 `getSnippetsFromImportDefinitions()` 中，如果 cache 未就绪，同步执行一次 `_getFileInfo()` 而非返回空：

```typescript
public async getSnippetsFromImportDefinitions(helper: HelperVars) {
  let fileInfo = this.importDefinitionsService.get(helper.filepath);
  if (!fileInfo) {
    // Cache miss: 同步执行一次，但加超时保护
    fileInfo = await Promise.race([
      this.importDefinitionsService._getFileInfo(helper.filepath),
      new Promise(r => setTimeout(() => r(null), 300)),
    ]);
  }
  // ... 继续处理
}
```

**方案 B (P1): 增加 gotoDefinition 超时**

将 `ImportDefinitionsService.ts` 中的 150ms 超时改为 300ms（binary/IPC 模式下 150ms 太短）。

**方案 C (P2): 扩展到函数体内调用的函数**

目前只处理 import 语句声明的符号。可扩展为：

1. 从 prefix/suffix 中提取被调用的函数名（通过简单正则或 tree-sitter）
2. 对每个函数名尝试 gotoDefinition
3. 提取定义处的函数签名（def 行 + docstring 首行）作为上下文 snippet

---

## 问题 7: Qwen3 tokenizer 中可用 token 分析

### 完整 token 列表 (151643-151668)

来源: [Qwen3-Coder-30B-A3B-Instruct/tokenizer_config.json](https://www.modelscope.cn/models/Qwen/Qwen3-Coder-30B-A3B-Instruct/resolve/master/tokenizer_config.json)

| ID     | Token                    | Special | 当前状态        | 建议                     |
| ------ | ------------------------ | ------- | --------------- | ------------------------ |
| 151643 | `<\|endoftext\|>`        | Yes     | stop token ✓    | —                        |
| 151644 | `<\|im_start\|>`         | Yes     | stop token ✓    | —                        |
| 151645 | `<\|im_end\|>`           | Yes     | stop token ✓    | —                        |
| 151646 | `<\|object_ref_start\|>` | Yes     | 未使用          | 不需要 (多模态)          |
| 151647 | `<\|object_ref_end\|>`   | Yes     | 未使用          | 不需要 (多模态)          |
| 151648 | `<\|box_start\|>`        | Yes     | 未使用          | 不需要 (多模态)          |
| 151649 | `<\|box_end\|>`          | Yes     | 未使用          | 不需要 (多模态)          |
| 151650 | `<\|quad_start\|>`       | Yes     | 未使用          | 不需要 (多模态)          |
| 151651 | `<\|quad_end\|>`         | Yes     | 未使用          | 不需要 (多模态)          |
| 151652 | `<\|vision_start\|>`     | Yes     | 未使用          | 不需要 (多模态)          |
| 151653 | `<\|vision_end\|>`       | Yes     | 未使用          | 不需要 (多模态)          |
| 151654 | `<\|vision_pad\|>`       | Yes     | 未使用          | 不需要 (多模态)          |
| 151655 | `<\|image_pad\|>`        | Yes     | 未使用          | 不需要 (多模态)          |
| 151656 | `<\|video_pad\|>`        | Yes     | 未使用          | 不需要 (多模态)          |
| 151657 | **`<tool_call>`**        | No      | **未使用**      | **应加为 stop token**    |
| 151658 | `</tool_call>`           | No      | 未使用          | 可加为 stop token        |
| 151659 | `<\|fim_prefix\|>`       | No      | stop token ✓    | —                        |
| 151660 | `<\|fim_middle\|>`       | No      | stop token ✓    | —                        |
| 151661 | `<\|fim_suffix\|>`       | No      | stop token ✓    | —                        |
| 151662 | `<\|fim_pad\|>`          | No      | stop token ✓    | —                        |
| 151663 | `<\|repo_name\|>`        | No      | stop + prompt ✓ | —                        |
| 151664 | `<\|file_sep\|>`         | No      | stop + prompt ✓ | —                        |
| 151665 | `<tool_response>`        | No      | 未使用          | 可加为 stop token        |
| 151666 | `</tool_response>`       | No      | 未使用          | 可加为 stop token        |
| 151667 | **`<think>`**            | No      | **未使用**      | **必须加为 stop token!** |
| 151668 | **`</think>`**           | No      | **未使用**      | **必须加为 stop token!** |

### 关键发现

#### `<think>` / `</think>` — 必须阻止

Qwen3 系列引入了思考链 (Chain-of-Thought) 功能。在 FIM 模式下，如果模型意外进入思考模式，会生成：

```
<think>
Let me analyze the code structure...
The function needs to handle error cases...
</think>
actual_code_here
```

这些思考内容会混入补全结果，导致：

1. 用户看到大段无意义推理文字
2. 256 token 的 maxTokens 被思考内容耗尽
3. 超时截断 → 显示不完整的思考内容

#### `<tool_call>` — 应阻止

防止模型在补全中生成工具调用语法，如：

```
<tool_call>
<function=search_code>
<parameter=query>error handling</parameter>
</function>
</tool_call>
```

### 修复方案

**方案 (P0): 在 `qwenCoderMultifileFimTemplate` 和 `qwenCoderFimTemplate` 添加 stop tokens**

**文件**: `core/autocomplete/templating/AutocompleteTemplate.ts`

```typescript
// qwenCoderMultifileFimTemplate.completionOptions.stop 添加:
stop: [
  // 现有 tokens...
  "<|endoftext|>",
  "<|fim_prefix|>",
  "<|fim_middle|>",
  "<|fim_suffix|>",
  "<|fim_pad|>",
  "<|repo_name|>",
  "<|file_sep|>",
  "<|im_start|>",
  "<|im_end|>",
  // 新增:
  "<think>",       // Qwen3 思考链 — 防止推理内容混入补全
  "</think>",      // 思考链结束
  "<tool_call>",   // 工具调用 — 防止生成工具调用语法
],
```

同理修改 `qwenCoderFimTemplate`。

---

## 修复优先级总表

### P0 — 必须立即修复

| #   | 修复项                                                  | 文件                      | 预期效果                          |
| --- | ------------------------------------------------------- | ------------------------- | --------------------------------- |
| 1   | 添加 `<think>`, `</think>`, `<tool_call>` 为 stop token | `AutocompleteTemplate.ts` | 防止思考链/工具调用混入补全       |
| 2   | 修改 `noDoubleNewLine()` 允许单个空行                   | `lineStream.ts`           | 多行补全率预计从 ~10% 提升到 ~40% |
| 3   | `showWhateverWeHaveAtXMs()` 计时改为从首 token 到达开始 | `lineStream.ts`           | 半截补全率预计下降 50%+           |

### P1 — 影响大，需要设计

| #   | 修复项                                      | 文件                           | 预期效果                                 |
| --- | ------------------------------------------- | ------------------------------ | ---------------------------------------- |
| 4   | PyCharm 端增加 abort 信号传播               | `ContinueCompletionService.kt` | 减少 sglang 无效推理                     |
| 5   | 确保 ImportDefinitionsService 预热/增加超时 | `ImportDefinitionsService.ts`  | import 定义上下文从 0 变为 5-10 snippets |
| 6   | abort error 日志降级为 debug                | `llm/index.ts`                 | 减少 ~80% 的 error 日志噪声              |
| 7   | 有限度恢复 diff snippets (仅当前文件)       | `getAllSnippets.ts`            | 恢复编辑意图上下文                       |

### P2 — 优化项

| #   | 修复项                       | 文件                          | 预期效果                   |
| --- | ---------------------------- | ----------------------------- | -------------------------- |
| 8   | PyCharm debouncer 改为自适应 | `Debouncer.kt`                | 减少快速打字时的无效请求   |
| 9   | sglang `/abort` API 集成     | `llm/index.ts` + sglang 配置  | 释放 abort 后的 KV cache   |
| 10  | 修复 `mock:///` URI 处理     | `ImportDefinitionsService.ts` | PyCharm 虚拟文件上下文恢复 |
| 11  | 审查 `/src/` stop token      | `getStopTokens.ts`            | 减少文件路径中的意外截断   |

## 变更文件清单 (所有问题)

| 文件                                                         | 涉及问题 | 变更内容                                               |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------ |
| `core/autocomplete/templating/AutocompleteTemplate.ts`       | #7       | 添加 `<think>`, `</think>`, `<tool_call>` stop tokens  |
| `core/autocomplete/filtering/streamTransforms/lineStream.ts` | #2,#3,#4 | 修改 `noDoubleNewLine()` + `showWhateverWeHaveAtXMs()` |
| `core/autocomplete/snippets/getAllSnippets.ts`               | #5       | 有条件恢复 diff snippets                               |
| `core/autocomplete/context/ImportDefinitionsService.ts`      | #6       | 预热保障 + 超时容错                                    |
| `core/llm/index.ts`                                          | #1       | abort 日志降级为 debug                                 |
| `core/autocomplete/templating/getStopTokens.ts`              | #3       | 审查 `/src/` stop token                                |
| `extensions/intellij/.../ContinueCompletionService.kt`       | #2       | 添加 abort signal                                      |
| `extensions/intellij/.../Debouncer.kt`                       | #2       | 自适应 debounce                                        |

## 验证清单

- [ ] 添加 stop tokens 后，用 Qwen3-Coder 触发补全，确认不出现 `<think>` 内容
- [ ] 修改 `noDoubleNewLine()` 后，验证 Python 代码补全可产出多行（在同一测试场景复现）
- [ ] 修改 `showWhateverWeHaveAtXMs()` 计时后，对比补全完整性（半截率应下降）
- [ ] 在 PyCharm 同一场景重新测试，对比成功率（目标: 从 36% 提升到 60%+）
- [ ] 观察 sglang 日志，确认 abort 数量下降
- [ ] 确认 `import=0(0t)` 变为 `import>0` 在 cache 预热后的请求中

---

## gpt 评审结论 (2026-04-08)

### 总评

这份分析不是“完全没有抓到根因”，相反，它抓到了 3 个非常关键的真实问题：

1. `noDoubleNewLine()` 会在第一个空行处直接终止流式输出，这确实会系统性压制多行补全。
2. `showWhateverWeHaveAtXMs()` 的计时起点过早，确实会把 prefill 等待时间算进展示窗口。
3. JetBrains 端当前没有把取消语义传到 core，固定 debounce 也确实比 VS Code 更容易制造无效请求。

但它也有几处“方向对、归因过度”或“优先级排错”的地方，所以我不建议按当前文档原样执行全部优先级。

综合判断：

- 根因分析准确度：中上
- 方案方向：大体合理
- P0/P1 排序：需要重排

### 已证实或基本成立的结论

#### 1. `noDoubleNewLine()` 是真实根因，而且权重很高

这条判断是成立的。当前实现见到首个非首行空行就直接 `return`，不是“跳过空行”，而是结束整个流式管线。这会直接导致：

- 多行补全被截成单行
- 第一行后刚好是空白时出现 `rawLen=0/1`
- Python 这类常带空行的输出明显受害

这条可以保留为高优先级修复项。

#### 2. `showWhateverWeHaveAtXMs()` 计时起点过早

这条也成立。当前实现从 pipeline 启动就开始记时，而不是从首 token 到达开始记时，所以如果模型 prefill 较慢，真正留给 decode 的窗口会非常短。

不过这里还有一个文档没有指出的更直接问题：当前管线实际传入的是 `modelTimeout`，而不是 `showWhateverWeHaveAtXMs` 这个单独配置项。也就是说，现在不仅起点早，而且用的还是更短的那个超时值。这一点比文档里的表述更关键。

#### 3. JetBrains 缺少取消传播和自适应 debounce

这两条基本成立：

- `ContinueCompletionService.kt` 用 `withTimeoutOrNull(...)` 包了等待逻辑，但没有把取消继续传到 core 的 autocomplete 请求。
- `Debouncer.kt` 是固定 delay，而 VS Code 侧是自适应 delay。

所以它判断“PyCharm 更容易制造无效请求、旧请求更容易残留”是合理的。

#### 4. diff snippets 当前确实被硬禁用

这一点是事实判断，没有问题。文档说 prompt 里缺 diff，是因为代码里两条路径都直接写成了空数组，这个结论准确。

### 部分成立，但没有完全打到根上的结论

#### 5. `import=0(0t)` 的问题存在，但文档没抓到最直接根因

文档把重点放在：

- tree-sitter import query
- `gotoDefinition()` 150ms 超时
- binary / IPC 模式慢
- racePromise 200ms 截断

这些都可能影响结果，但还不是最直接的主因。

当前实现里，autocomplete 取 import snippets 时优先只是读 cache；如果 cache miss，通常就是直接空结果。也就是说，更直接的主因其实是“cache miss 没有同步兜底初始化”，而不是先去扩展函数体调用或大幅重写 import 分析链路。

所以这块更合理的顺序应该是：

1. 先做 cache miss 同步初始化兜底
2. 再评估 150ms 是否太短
3. 最后再考虑扩展到函数体内被调用函数

文档的方案 A 是对的，但文档正文里对“失败链”的重心放偏了。

#### 6. abort 双 error 日志现象对，但“第二个 AbortController 就是根因”这个说法太满

文档观察到每次 abort 会打两条日志，这个现象没问题。

但把根因收敛成“GeneratorReuseManager 新建了第二个 AbortController，因此形成二级 abort”，证据不够。当前 abort 来源至少有几层：

- request 级 abort controller
- logging service 的全局 cancel
- generator reuse 时取消旧 generator
- stream filtering 中的 full stop

而双 error 日志更直接的原因，是 `llm/index.ts` 里本来就有两处 catch 在打日志：一次 `llm_fetch`，一次 `llm_stream_complete`。所以“把 abort 降级成 debug”是合理方案，但“只改 debounce 阶段立即 abort 前一请求”并不能单独解释或解决全部问题。

### 归因不准确，修复落点需要改的结论

#### 7. `mock:///` 的问题存在，但文档把责任落错了层

文档写的是：

- `ImportDefinitionsService` / `ContextRetrievalService` 调用了 `fileURLToPath()`
- `mock:///` 会在这里抛异常

这一条不准确。当前 autocomplete 这条链路里，这两层更多是用 URI scheme 和 workspace dirs 做匹配；并不是在这里直接把 `mock:///` 转成系统路径。

另外，多文件 prompt 模板在遇到非 `file://` URI 时，会把 URI 原样写进 prompt。所以你在 prompt 里看到 `mock:///bpp_case_tools.py`，至少一部分只是“URI 没正规化就被展示出来”，并不等于这一层一定已经解析失败。

更合理的判断应该是：

- `mock:///` 暴露出 JetBrains URI 规范化缺失
- 它会影响 workspace 命中、路径展示和部分下游逻辑
- 但修复落点不应简单写成 `ImportDefinitionsService.ts`

更可能的修复位置是：

- JetBrains 侧上报给 core 之前先正规化 URI
- 或 core 在 snippet/template 层对非 `file://` URI 做降级处理

### 优先级被高估的方案

#### 8. Qwen `<think>` / `<tool_call>` stop token 不应列为当前 P0 第一优先级

加 stop token 不是坏方案，我同意它是合理增强项。

但文档把它列为 P0 第一项，优先级过高。原因是：

- 当前 autocomplete 后处理里已经对 qwen3 的 `<think>...</think>` 做了剥离
- 现有日志里更明显的问题来源是空行截断、过早超时、JetBrains 请求管理，而不是 think block 污染

所以这更像是“稳健性增强”，不是本轮问题的主根因修复。

#### 9. “恢复当前文件 diff”是合理增强，但不应排在核心稳定性修复前面

当前没有 diff snippets，确实损失了一部分编辑意图上下文。

但从现象上看，你眼前最痛的问题是：

- 大量空结果
- 多行补全出不来
- 补全半截
- JetBrains abort/残留请求

相比之下，diff 缺失更像“质量增强项”，不应排在这些基础稳定性问题之前。

### 我建议的优先级重排

#### 建议 P0

1. 修 `noDoubleNewLine()`，允许单个空行
2. 修 `showWhateverWeHaveAtXMs()` 的计时起点，改成首 token 开始计时
3. 把 StreamTransformPipeline 里传入的超时值从 `modelTimeout` 改为真正的 `showWhateverWeHaveAtXMs`
4. 把 abort 类错误从 error 降为 debug，先把日志噪声压下去，便于继续观察

#### 建议 P1

5. JetBrains autocomplete 请求增加取消传播
6. ImportDefinitions cache miss 时同步初始化兜底
7. 视结果再决定是否把 `gotoDefinition()` 超时从 150ms 提高到 300ms
8. 审查 `/src/` stop token 是否存在误伤

#### 建议 P2

9. JetBrains debouncer 改为自适应
10. 处理 `mock:///` URI 规范化
11. 有限恢复 diff snippets
12. 为 Qwen 增加 `<think>` / `<tool_call>` stop tokens

### 最终结论

如果只问两个问题：

1. 这份分析有没有分析到根本原因？
2. 给的方案合不合理？

我的结论是：

- 有分析到一部分根本原因，尤其是 `noDoubleNewLine()`、过早超时、JetBrains 取消传播缺失，这几条是抓到主干了。
- 但没有完全闭环，特别是 `mock:///`、abort 根因、`import=0` 的主因、Qwen stop token 优先级，这几块有明显过度推断或排序失准。
- 方案整体方向可用，但必须重排优先级；否则容易先做增强项，真正影响成功率和完整性的主问题反而还在。

一句话总结：

## 这不是一份“错得离谱”的分析，而是一份“抓到 60%-70% 主因，但仍需要工程化校正优先级和修复落点”的分析。

## opus 自我重新评估 (2026-04-09)

基于 GPT 评审意见，我逐条重新验证了代码，以下是我的修正判断。

### 一、完全接受的批评 (GPT 正确)

#### 1. `<think>` stop token 不应为 P0 #1

**GPT 意见**: 后处理已经有 `<think>` 剥离，stop token 优先级过高。

**代码验证**: 在 [postprocessing/index.ts](../autocomplete/postprocessing/index.ts#L151-L155) 中确认：

```typescript
if (llm.model.includes("qwen3")) {
  // Qwen3 always starts from special thinking markers
  completion = completion.replace(/<think>.*?<\/think>/s, "");
  completion = completion.replace(/<\/think>/, "");
}
```

**我的修正**: 完全接受。后处理已在最终输出阶段 strip `<think>` 块，所以模型即使生成了思考链内容，用户也看不到。将此项从 P0 #1 降至 P2 #12。

但保留一个 nuance：stop token 可以在 **生成阶段** 提前终止，避免模型浪费 token 在思考链上——这对延迟有正面影响，但确实不是当前"补全为空/截断"的根因。

#### 2. `modelTimeout` 被当作 `showWhateverWeHaveAtXMs` 的超时值

**GPT 意见**: 文档没有指出更直接的问题——当前管线用的是 `modelTimeout` 而非单独配置项。

**代码验证**: 在 [StreamTransformPipeline.ts](../autocomplete/filtering/streamTransforms/StreamTransformPipeline.ts#L75) 中确认：

```typescript
const timeoutValue = helper.options.modelTimeout; // L75
// ...
showWhateverWeHaveAtXMs(lineGenerator, timeoutValue!); // L77
```

**我的修正**: 完全接受。这是我遗漏的关键发现。问题是 **双重的**：

- (a) 计时从 pipeline 启动开始（我发现了这一点）
- (b) 使用的值是 `modelTimeout`（通常较短），而非专用的展示超时

将此项纳入 P0，与我原有的"计时起点"修复合并为一个更完整的修复项。

#### 3. abort 双日志的归因过度

**GPT 意见**: 双 error 日志的更直接原因是 `llm/index.ts` 有两处 catch 在打日志，不是"第二个 AbortController"。

**代码验证**: 在 [llm/index.ts](../../core/llm/index.ts) 中确认两处 catch：

- L507 (`fetch()` 方法) — `Logger.error(e, { context: "llm_fetch", ... })`
- L813 (`streamComplete()` 方法) — `Logger.error(e as Error, { context: "llm_stream_complete", ... })`

同一个 AbortError 从底层 fetch 抛出后，被两层 catch 各记录一次。

**我的修正**: 接受。GeneratorReuseManager 的第二个 AbortController 确实存在，但它不是双日志的直接原因。双日志是因为错误在调用链上冒泡时被两个不同层级的 catch 各捕获一次。修复方案（降级为 debug）不变，但根因描述需要纠正。

#### 4. `mock:///` 修复落点错误

**GPT 意见**: 修复不应简单写成 `ImportDefinitionsService.ts`，更合理的位置是 JetBrains URI 规范化或 core template 层降级。

**代码验证** (通过 sub-agent):

- [AutocompleteTemplate.ts](../autocomplete/templating/AutocompleteTemplate.ts#L87) 中 `getFileName()` 只检查 `startsWith("file://")` → `mock:///` 原样写入 prompt
- [core/util/uri.ts](../../core/util/uri.ts#L24) 中 `findUriInDirs()` 做 scheme 匹配 → `mock:///` 与 `file://` workspace 不匹配 → 被跳过
- `fileURLToPath()` 在 `core/util/filesystem.ts` 中，会对 `mock:///` 抛异常，但不在 ImportDefinitionsService 直接调用链上

**我的修正**: 接受。`mock:///` 的影响是一个 **URI 规范化缺失** 的系统性问题，不是某个具体 Service 的 bug。正确的修复落点是：

- **首选**: JetBrains 端在 URI 上报前规范化为 `file://`
- **兜底**: core template 层对非 `file://` URI 做降级处理（如提取路径部分）

### 二、部分接受，但有 nuance

#### 5. `import=0(0t)` 的最直接根因

**GPT 意见**: 最直接主因是 "cache miss 没有同步兜底"，不是 tree-sitter/gotoDefinition 链路。

**我的修正**: 部分接受。GPT 指出的 "先做 cache miss 同步兜底" 作为修复优先顺序是正确的，这是投入产出比最高的第一步。但我认为 tree-sitter/gotoDefinition 链路的分析并非无用——它解释了 **为什么 cache 永远是空的**：

1. ImportDefinitionsService 在 `onDidChangeActiveTextEditor` 时异步填充 cache
2. 如果填充失败（gotoDefinition 超时、binary IPC 延迟），cache 就始终为空
3. autocomplete 请求来时，读 cache → 空 → `import=0`

所以完整的修复链应该是：

1. **P1**: cache miss 时做同步兜底初始化（GPT 建议的，我接受）
2. **P1**: 评估 gotoDefinition 150ms→300ms（保留）
3. **P2**: 扩展到函数体内调用（保留为长期项）

#### 6. diff 恢复的优先级

**GPT 意见**: 应排在稳定性修复之后。

**我的修正**: 接受。原来放在 P1 #7，现降至 P2。当前最痛的问题（空结果、截断、abort 噪声）都与 diff 无关。

### 三、维持原判断

#### 7. `noDoubleNewLine()` 是真实根因

GPT 完全认同此项。维持 P0 不变。

#### 8. JetBrains 取消传播和自适应 debounce

GPT 基本认同。维持 P1 不变。

#### 9. `/src/` stop token 需审查

GPT 将此排入 P1。我接受提升（原为附带提及）。

---

### 修正后的优先级总表

#### P0 — 必须立即修复（直接影响补全成功率和完整性）

| #   | 修复项                                                                    | 文件                         | 预期效果                          |
| --- | ------------------------------------------------------------------------- | ---------------------------- | --------------------------------- |
| 1   | 修改 `noDoubleNewLine()` 允许单个空行                                     | `lineStream.ts`              | 多行补全率预计从 ~10% 提升到 ~40% |
| 2   | `showWhateverWeHaveAtXMs()` 计时改为从首 token 到达开始                   | `lineStream.ts`              | 半截补全率预计下降 50%+           |
| 3   | StreamTransformPipeline 传入的超时值从 `modelTimeout` 改为 **独立配置项** | `StreamTransformPipeline.ts` | 给 decode 阶段更完整的时间窗口    |
| 4   | abort error 日志降级为 debug                                              | `llm/index.ts`               | 消除 ~80% 日志噪声，便于后续调试  |

#### P1 — 影响大，需要设计

| #   | 修复项                                  | 文件                           | 预期效果                      |
| --- | --------------------------------------- | ------------------------------ | ----------------------------- |
| 5   | JetBrains autocomplete 请求增加取消传播 | `ContinueCompletionService.kt` | 减少 sglang 无效推理          |
| 6   | ImportDefs cache miss 时同步兜底初始化  | `ImportDefinitionsService.ts`  | import 定义上下文从 0 变为 >0 |
| 7   | 评估 gotoDefinition 超时 150ms→300ms    | `ImportDefinitionsService.ts`  | 提高 cache 填充成功率         |
| 8   | 审查 `/src/` stop token 是否存在误伤    | `getStopTokens.ts`             | 减少 Python 路径中的意外截断  |

#### P2 — 优化项

| #   | 修复项                                            | 文件                                | 预期效果                      |
| --- | ------------------------------------------------- | ----------------------------------- | ----------------------------- |
| 9   | JetBrains debouncer 改为自适应                    | `Debouncer.kt`                      | 减少快速打字时的无效请求      |
| 10  | JetBrains URI 规范化 (`mock:///` → `file://`)     | JetBrains 扩展层 / core template 层 | PyCharm 虚拟文件上下文恢复    |
| 11  | 有限恢复 diff snippets（仅当前文件）              | `getAllSnippets.ts`                 | 恢复编辑意图上下文            |
| 12  | 为 Qwen 添加 `<think>` / `<tool_call>` stop token | `AutocompleteTemplate.ts`           | 减少无效 token 生成，改善延迟 |

### 与原方案的主要变更

| 变更                  | 原判断                   | 修正后               | 原因                               |
| --------------------- | ------------------------ | -------------------- | ---------------------------------- |
| `<think>` stop token  | P0 #1                    | P2 #12               | 后处理已 strip，非当前问题根因     |
| `showWhatever` 超时值 | 未提及                   | P0 #3 (新增)         | GPT 发现的盲点：用了 modelTimeout  |
| abort 双日志根因      | 第二个 AbortController   | 两层 catch 冒泡      | 代码验证确认                       |
| `mock:///` 修复位置   | ImportDefinitionsService | JetBrains URI 规范化 | sub-agent 验证确认影响链是系统性的 |
| `import=0` 修复优先序 | gotoDefinition 链路为主  | cache miss 兜底优先  | 投入产出比更高                     |
| diff 恢复             | P1 #7                    | P2 #11               | 属于质量增强，不是稳定性修复       |

### 对 GPT "60%-70% 准确度" 评价的回应

我认为这个评价基本公允。具体来说：

- **抓对了的 (~70%)**: `noDoubleNewLine()`、计时起点过早、JetBrains 取消传播、diff 硬禁用、`/src/` stop token — 这些根因判断和代码定位都准确
- **方向对但归因偏了 (~20%)**: `import=0` 链路分析方向正确但修复起点选错、abort 双日志现象对但原因归错
- **优先级排错 (~10%)**: `<think>` stop token 列为 P0 #1 是最大的排序失误

最关键的教训：**在提出修复优先级前，应该先验证是否已有缓解措施**。如果我在写报告前先 grep 了 `<think>` 在 postprocessing 中的处理，就不会把它列为 P0 #1。
