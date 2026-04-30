# zkdev 分支 - Autocomplete 优化总结

基于 Continue v1.3.19，针对 Python 无类型注解场景的 autocomplete 质量与性能优化。

## 概览

| 领域 | 优化项 | 提交 |
|------|--------|------|
| 兼容 | JetBrains PSI getDocumentSymbols 实现 | pending |
| 兼容 | JetBrains try-catch + 多语言 scope summary | pending |
| 性能 | AST cache 修复同文件光标移动的 cache miss | `e89a9fd7c` |
| 性能 | DocumentSymbol scope 检测替代阻塞式 tree-sitter | `47b685a57` |
| 性能 | renderPromptWithTokenLimit 快速 token 估算 | `c4612def6` |
| 性能 | SymbolKind enum 从 hardcode 迁移到运行时 .ts | `9e1196584` |
| 架构 | 共享上下文队列基础设施 (QueueManager) | `e5bde082c` |
| 质量 | Snippet source 标注 (语言感知注释) | `b488e70d0` |
| 质量 | Priority reorder, maxPromptTokens 4096, Tab+Cursor fusion | `08f88efbc` |
| 质量 | numSurroundingLines 20→30, editedRanges+visitedRanges 去重 | `f7a250d6d` |
| 质量 | prompt padding, rootPath fix, KV cache ordering | `75f006502` |
| 质量 | **Scope Summary: 类方法签名 + 调用目标定义注入** | `102bf88c8` |
| 修复 | DocumentSymbol null check + children tree 保持 | `3ca09c386` |
| 诊断 | RECENT_EDIT ±2 padding + treePath/completion 诊断日志 | `0c1107c9a` |

## 核心改动详解

### 1. Scope Summary Snippet (Step 1 + Step 2) — `102bf88c8`

**问题**：Python 无类型注解代码（如 `class DB` 无基类、`def xxx(self, **kwargs)` 无 type hint），原有 RootPathContext `.scm` 查询匹配不到任何结果（rootPath=0），导致 LLM 缺少类结构上下文。同时 ImportDefinitions 注入的是标准库源码（pymysql、smtplib 等），对补全几乎无用。

**方案**：在 `HelperVars` 中利用已缓存的 DocumentSymbol 树，零 IO 开销生成两类上下文：

- **Step 1 — Class Method Signature List**：提取当前光标所在类的所有方法签名行，让 LLM 了解类的完整结构。
- **Step 2 — Call Target Definitions**：扫描当前方法体中的 `self.xxx()` / `this.xxx()` 调用，找到同类兄弟方法定义，提取前 6 行作为上下文。

**注入路径**：生成的 `AutocompleteCodeSnippet` 加入 `rootPathSnippets` 数组，经过现有 filtering 管线的 "base" 组（priority=99, BASE_FLOOR_RATIO=15%），不需要修改过滤逻辑。

**修改文件**：
- `core/autocomplete/util/HelperVars.ts` — 新增 `getScopeSummarySnippet()` 方法
- `core/autocomplete/CompletionProvider.ts` — 调用 snippet 方法并注入 payload

**性能影响**：纯内存操作，预计 0-2ms，可能因替代低效 rootPath 查询而净减少延迟。

### 2. DocumentSymbol Scope 检测 — `47b685a57` + `3ca09c386`

用 VS Code 原生 `DocumentSymbol` API 替代每次击键时的 tree-sitter parse，将 scope 检测从阻塞式 AST 解析改为利用编辑器已有数据。引入 `ScopeCache` 基于 scope 签名缓存 treePath，避免重复解析。

### 3. 快速 Token 估算 — `7bac6b42d` + `c4612def6`

`prunePrefixSuffix` 和 `renderPromptWithTokenLimit` 中用字符长度 ÷ 4 的快速估算替代 `llama-tokenizer-js` 逐 token 计算，消除 40-100ms 的序列化开销。

### 4. 队列基础设施 — `e5bde082c`

`QueueManager` 以事件驱动方式预收集 recentlyEditedRanges、recentlyVisitedRanges 等 snippet，提供 queue fast path 跳过按需收集延迟。

### 5. Prompt 质量优化 — `08f88efbc` + `f7a250d6d` + `75f006502`

- maxPromptTokens 1024→4096
- numSurroundingLines 20→30
- Priority reorder: recentlyEditedRanges(1) > recentlyVisitedRanges(2) > openedFiles(3)
- KV cache 友好的 snippet 排序（base snippets 置底，稳定不变）
- editedRanges + visitedRanges 同文件互补去重

## 兼容性修复

### PyCharm / JetBrains 兼容 (`HelperVars.ts`)

**问题**：`IntelliJIde.kt` 中 `getDocumentSymbols` 直接 `throw NotImplementedError`。zkdev 新增的 `HelperVars.init()` 无 try-catch 直接 `await ide.getDocumentSymbols()`，导致 JetBrains 所有 autocomplete 请求抛异常失败。

**修复**：在 `getDocumentSymbols` 调用外包 try-catch，异常时 `symbols=[]`，回退到 background AST parse 路径（与无 DocumentSymbol 时行为一致）。

```typescript
let symbols: DocumentSymbol[] = [];
try {
  symbols = (await this.ide.getDocumentSymbols(this.filepath)) ?? [];
} catch {
  // IDE 不支持 getDocumentSymbols (e.g. JetBrains) — 跳过符号级 scope 检测
}
```

### 多语言兼容：getScopeSummarySnippet

**问题 1 — 类声明语法硬编码 Python**：`class Name:` 对 Java/C++/JS 等语言会输出错误语法。  
**修复**：`lang.name === "Python"` 时输出 `class Name:`，否则输出 `class Name {`。

**问题 2 — 注释符号硬编码 `#`**：Python `#`，但 Java/C++/JS/Go 等用 `//`，Haskell/Lua 用 `--`。  
**修复**：使用 `this.lang.singleLineComment || "#"` 动态选择注释前缀。

**问题 3 — C++ `this->` 调用未覆盖**：原 call pattern `/(?:self|this)\.(\w+)\s*\(/` 无法匹配 C++ 的 `this->method()`。  
**修复**：pattern 改为 `/(?:self|this)(?:->|\.)(\w+)\s*\(/g`，支持 `.` 和 `->` 两种语法。

| 语言 | 类头部 | 注释 | call pattern |
|------|--------|------|--------------|
| Python | `class Name:` | `#` | `self.method(` ✅ |
| Java / C# / Kotlin | `class Name {` | `//` | `this.method(` ✅ |
| C++ | `class Name {` | `//` | `this->method(` ✅ (新增) |
| JS / TS | `class Name {` | `//` | `this.method(` ✅ |
| Go / Rust | N/A (无 class) | — | N/A (snippet 返回 undefined) |

### JetBrains PSI 实现 `getDocumentSymbols`

**背景**：`DocumentSymbol.kind` 在 TypeScript 核心层（`core/index.d.ts`）自始至终是 LSP numeric 枚举（`Class=4, Method=5...`）。Kotlin `types.kt` 原先的 `kind: String` 是从未被实际序列化的占位符 bug（函数一直 throw），不存在"从字符串改成数字"的历史。

**改动（最小化，2个文件）**：

**`extensions/intellij/.../types.kt`**：
```kotlin
// 修复前
data class DocumentSymbol(val name: String, val kind: String, ...)
// 修复后
data class DocumentSymbol(
    val name: String,
    val kind: Int,                             // LSP SymbolKind numeric (Class=4, Method=5, ...)
    val range: Range,
    val selectionRange: Range,
    val children: List<DocumentSymbol>? = null // 层级结构，支持 class→method 嵌套
)
```

**`extensions/intellij/.../continue/IntelliJIde.kt`**：
- 实现 `getDocumentSymbols`：`withContext(Dispatchers.EDT)` + PSI 读取 + try-catch 保底
- 新增 `psiSymbolKind()`：**类名字符串匹配**，无需 import 任何语言插件（PyCharm/CLion/GoLand 语言插件 PSI 类均通过 simpleName 字符串识别）
- 新增 `psiToRange()`：PSI textRange → Continue Range（行列偏移）
- 新增 `psiCollectSymbols()`：递归 PSI 树，识别到的符号作为 DocumentSymbol，未识别的透明穿透（处理 C++ namespace 等包装层）

**设计要点**：

| 设计 | 理由 |
|------|------|
| 类名字符串匹配而非 import 语言插件类 | 单一 Kotlin 文件可以编译到所有 JetBrains IDE，无需分 product flavor |
| `depth > 4` 截断 | 防止深嵌套 PSI 树（如 anonymous class 内的 lambda 内的...）栈溢出 |
| `withContext(Dispatchers.EDT)` | PSI 访问需在 EDT 上，与文件中其他 PSI 操作保持一致 |
| `catch (_: Exception)` 返回空列表 | PSI 尚未 ready（IDE 启动/索引阶段）时静默降级，不影响 autocomplete |
| transparent wrapper 穿透 | C++ `namespace Foo { class Bar {} }` 中 namespace 节点不是 PsiNameIdentifierOwner，穿透后能找到 class |

**覆盖的 IDE / 语言**（精确类名匹配）：

| IDE | 语言 | PSI 类 | kind |
|-----|------|--------|------|
| IntelliJ IDEA | Java | `PsiClass`, `PsiMethod`, `PsiField` | 4 / 5 / 7 |
| IntelliJ IDEA | Kotlin | `KtClass`, `KtNamedFunction`, `KtProperty` | 4 / 11 / 6 |
| PyCharm | Python | `PyClass`, `PyFunction` | 4 / 11 |
| GoLand | Go | `GoTypeDeclaration`, `GoFunctionDeclaration` | 4 / 11 |
| CLion+ | C/C++ | 后缀模式 `*ClassDecl`, `*FunctionDecl`... | 22 / 11 |

## 已知限制

- rootPath `.scm` 查询仍只匹配类型注解（Python）和基类（class），未修改 — 由 Scope Summary 补偿
- `noDoubleNewLine` stream filter 可能截断 Python 多行补全（rawLen=1 → isBlank），属原始行为
- Abort 率 70-90% 是 VS Code CancellationToken 正常行为（每次击键取消前一请求）
- JetBrains `getDocumentSymbols` PSI 实现依赖 IDE 索引完成（启动阶段返回空列表，自动降级到 background AST parse）
- CLion C++ 的精确 PSI 类名因版本而异，当前使用后缀模式匹配，如发现遗漏可按需补充精确类名

## 构建

```bat
scripts\package-vscode-win.cmd --skip-installs --skip-gui
```

产出：`extensions/vscode/build/continue-win32-x64-1.3.19.*.vsix`
