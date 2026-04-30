# 第三轮优化：IntelliJ 侧适配 + Qwen 模型支持

> 实施日期: 2026-04-17
> 状态: ✅ 已完成

## 改动内容

### IntelliJ readFile 超时 — `extensions/intellij/.../IntelliJIde.kt`

- 新增 `READ_FILE_TIMEOUT_MS = 30_000L` 常量
- `readFile()` 包裹 `withTimeout` + `Dispatchers.IO`（使阻塞调用可被协程取消）
- 超时返回空字符串并打印日志

### IntelliJ writeFile 错误可见 — `extensions/intellij/.../file/FileUtils.kt`

- `writeFile()` 中的 `return LOG.warn(...)` 改为 `throw IllegalArgumentException/IllegalStateException`
- 错误信息包含原始 URI 便于排查
- Core 侧 callTool catch 块可将错误反馈给模型自修复

### IdeProtocolClient 异常时 respond — `extensions/intellij/.../IdeProtocolClient.kt`

- catch 块末尾加 `respond(null)`
- 防止任何 IDE 操作异常导致 Core 的 request Promise 永久挂起

### findFile VFS 缓存优先 — `extensions/intellij/.../file/FileUtils.kt`

- `findFile()` 先用 `findFileByUrl()`（内存缓存，不阻塞）
- 找不到才 fallback 到 `refreshAndFindFileByUrl()`
- 已加载文件场景下避免昂贵的 VFS 磁盘刷新

### Ripgrep 硬超时 + 进程杀死 — `extensions/intellij/.../IntelliJIde.kt`

- 新增 `execWithTimeout()` 方法：`Process.waitFor(timeout)` + `destroyForcibly()`
- 用 `CompletableFuture.supplyAsync` 在独立线程消费 stdout 防止管道缓冲区死锁
- `getFileResults()` 和 `getSearchResults()` 使用此方法替代 `ExecUtil.execAndGetOutput`

### getDocumentSymbols dumb mode 保护 — `extensions/intellij/.../IntelliJIde.kt`

- `getDocumentSymbols()` 在 `DumbService.isDumb` 时直接返回空列表
- 避免项目索引期间 PSI 访问异常

### Qwen 模型 tool call 支持 — `core/llm/toolSupport.ts`

- `openai` provider 的 tool support 检测中加入 `lower.includes("qwen")` 匹配
- 用 `provider: openai` + 自定义 `apiBase` 指向 sglang 端点时，模型名含 "qwen" 即可启用 tool call

---

## 改动文件清单

| 文件                                           | 改动类型 | 描述                                        |
| ---------------------------------------------- | -------- | ------------------------------------------- |
| `extensions/intellij/.../IntelliJIde.kt`       | 修改     | readFile 超时 + execWithTimeout + dumb mode |
| `extensions/intellij/.../file/FileUtils.kt`    | 修改     | writeFile 抛异常 + findFile 缓存优先        |
| `extensions/intellij/.../IdeProtocolClient.kt` | 修改     | 异常时 respond(null) 防 Core 挂起           |
| `core/llm/toolSupport.ts`                      | 修改     | openai provider 加 Qwen tool support        |
