# 第二轮优化：压缩质量优化

> 实施日期: 2026-04-16（第一轮之后）
> 状态: ✅ 已完成

## 压缩输入预处理 — `core/util/conversationCompaction.ts`

- **问题**: 压缩时将所有消息（包括 thinking、大文件读取结果）原样发给摘要模型，浪费大量 token
- **方案**:
  1. 跳过 `role === "thinking"` 消息（模型内部推理对摘要无价值）
  2. 截断 `role === "tool"` 内容到 2000 字符（大文件/终端输出只保留摘要级别的内容）
  3. 截断处添加 `...[truncated, N chars omitted]` 标记
- **新增常量**: `MAX_TOOL_CONTENT_CHARS_FOR_COMPACTION = 2000`
- **新增函数**: `truncateForCompaction()` — 超长内容截断并添加标记
- **改动文件**: `core/util/conversationCompaction.ts`
