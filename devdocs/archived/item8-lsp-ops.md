# 详细方案：#8 LSP 符号操作（findReferences / rename / gotoDefinition）

> 评估日期: 2026-04-20
> 状态: ✅ 已完成（含 IntelliJ 全栈适配）

## 现状分析（实施前）

| 方法                       | VS Code IDE 实现 | IntelliJ IDE 实现            | Agent Tool |
| -------------------------- | ---------------- | ---------------------------- | ---------- |
| `gotoDefinition(location)` | ✅ L85           | ❌ throw NotImplementedError | ❌         |
| `getReferences(location)`  | ✅ L118          | ❌ throw NotImplementedError | ❌         |
| `rename(symbol, newName)`  | ❌ 接口不存在    | ❌ 接口不存在                | ❌         |

## 实现文件

**新增文件**（6个，3定义 + 3实现）:

- `core/tools/definitions/findReferences.ts`
- `core/tools/definitions/gotoDefinition.ts`
- `core/tools/definitions/renameSymbol.ts`
- `core/tools/implementations/findReferences.ts`
- `core/tools/implementations/gotoDefinition.ts`
- `core/tools/implementations/renameSymbol.ts`

**IDE 全栈适配（renameSymbol 贯穿整个通信链路）**:

- `core/index.d.ts` — 新增 `rename` 接口定义
- `core/protocol/ide.ts` — 新增消息协议
- `messageIde.ts` → `reverseMessageIde.ts` → `filesystem.ts` → `config/types.ts`
- VS Code: `VsCodeIde.ts` + `VsCodeMessenger.ts`
- IntelliJ: `MessageTypes.kt` → `protocol/ide.kt` → `types.kt` → `IdeProtocolClient.kt` → `IntelliJIde.kt`

## 价值评估

- **findReferences**：重命名/重构前查所有引用点，比 grep 精确（不匹配注释/字符串中的同名词）
- **rename**：语义级跨文件重命名（含 import 路径更新），比 sed/replace 安全
- **gotoDefinition（作为 tool）**：agent 看到函数调用想了解实现 → 精确跳转而非模糊搜索

## IntelliJ 底层实现骨架

```kotlin
// IntelliJIde.kt — gotoDefinition 实现
override suspend fun gotoDefinition(location: Location): List<Location> = withContext(Dispatchers.EDT) {
    if (DumbService.isDumb(project)) return@withContext emptyList()
    val psiFile = findPsiFile(location.uri) ?: return@withContext emptyList()
    val offset = getOffset(psiFile, location.position)
    val element = psiFile.findElementAt(offset) ?: return@withContext emptyList()
    val resolved = element.reference?.resolve() ?: return@withContext emptyList()
    listOf(psiElementToLocation(resolved))
}

// getReferences 实现
override suspend fun getReferences(location: Location): List<Location> = withContext(Dispatchers.IO) {
    if (DumbService.isDumb(project)) return@withContext emptyList()
    val psiFile = findPsiFile(location.uri) ?: return@withContext emptyList()
    val offset = getOffset(psiFile, location.position)
    val element = psiFile.findElementAt(offset) ?: return@withContext emptyList()
    val results = ReferencesSearch.search(element, ProjectScope.projectScope(project))
    results.mapNotNull { ref -> psiElementToLocation(ref.element) }
}
```

## IPC 缓冲区扩容（同批）

- `ContinueNuProcess.kt` / `ContinueSocketProcess.kt` / `ContinueProcessHandler.kt` — buffer 256KB → 8MB
- 背景：大型 LSP 响应（多引用结果）可能超过原有缓冲区限制

## 工作量

| Phase               | 改动量         | 前置条件          |
| ------------------- | -------------- | ----------------- |
| VS Code tool 包装   | ~150 行 TS     | 无                |
| IntelliJ 底层实现   | ~300 行 Kotlin | IntelliJ 开发环境 |
| IDE 接口 + 消息协议 | ~100 行 TS     | 无                |
| **总计**            | **~550 行**    |                   |
