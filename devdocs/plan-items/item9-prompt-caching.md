# 待实施：#9 Prompt Caching 扩展

> 评估级别: A 级（高价值 + 中成本）
> 状态: ❌ 未开始

## 现状

| Provider   | Prompt Caching 支持 | 说明                                                             |
| ---------- | ------------------- | ---------------------------------------------------------------- |
| Anthropic  | ✅ 已实现           | `cache_control: ephemeral` 标记 system message 和长 user message |
| OpenRouter | ✅ 已实现           | 透传 Anthropic 格式                                              |
| OpenAI     | ❌ 未实现           | OpenAI 有自动 prompt caching（需 >1024 tokens 的相同前缀）       |
| Gemini     | ❌ 未实现           | Gemini 1.5+ 有 implicit caching                                  |

## 价值分析

在 agent 模式下，system message + tools 定义 + rules 等前缀内容在每轮 LLM 调用中重复发送，Prompt caching 可节省：

- 重复的 token 计费（Anthropic 缓存命中费用约为正常的 10%）
- 推理延迟（缓存命中时首 token 延迟降低 ~50%）

## 实现方案

### OpenAI 侧（自动 caching）

OpenAI 的 prompt caching 是**自动的**，只要满足以下条件：

- 消息前缀长度 ≥ 1024 tokens
- 相同前缀在 5 分钟内重复使用

**需要的改动**：

1. 确保 system message 始终放在消息序列的最前面（已满足）
2. 优化消息排列，使最长的固定前缀尽可能长（tools 定义 + rules 排序稳定化）
3. 在 telemetry 中记录缓存命中率

### Gemini 侧

- Gemini 1.5+ 有 `cachedContent` API
- 需要在 `core/llm/llms/Gemini.ts` 中实现显式缓存管理
- 工作量估算: ~100 行

## 相关文件

- `core/llm/llms/OpenAI.ts` — OpenAI provider（自动 caching 无需改动，但可添加监控）
- `core/llm/llms/Anthropic.ts` — 已有 `cache_control` 实现，可参考
- `core/llm/constructMessages.ts` — 消息构造，可优化前缀稳定性

## 工作量估算

| 任务                             | 改动量      |
| -------------------------------- | ----------- |
| 消息前缀稳定化（tools 定义排序） | ~20 行      |
| Gemini 显式 caching              | ~100 行     |
| 缓存命中 telemetry               | ~30 行      |
| **总计**                         | **~150 行** |
