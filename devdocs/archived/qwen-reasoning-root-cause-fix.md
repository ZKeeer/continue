# Qwen Reasoning 修复 — 根因分析与方案重做

> 日期: 2026-04-30
> 状态: ✅ 已实施（替换了旧 strip+flatten 方案）
> 关联: `optimization_plan.md` § SGLang/Qwen reasoning 排查与修复

---

## 旧方案回顾

**方案**：strip 所有 thinking + 自定义 `<previous_tool_round>` XML 扁平化

**问题**：
- 所有 thinking 无条件删除 → tool-call assistant 也丢了 reasoning
- 自定义 XML 格式（`<previous_tool_round index="N">`）模型不理解语义
- 仅 Qwen/QwQ 触发，其他推理模型不受保护
- 是后处理补丁，没修根因

**文件**（已重写）：
- `core/llm/openaiHistoryPreprocessor.ts`
- `core/llm/openaiHistoryPreprocessor.test.ts`

---

## 根因

Qwen3.5 多轮 agent 场景下 reasoning 消失的根因是 few-shot 污染：

```
model 看到的历史 token 序列：
<|im_start|>assistant\n \n<tool_call>...</tool_call><|im_end|>     ← content=" " 无推理
<|im_start|>user\n<tool_response>result</tool_response><|im_end|>
<|im_start|>assistant\n \n<tool_call>...</tool_call><|im_end|>     ← content=" " 无推理
<|im_start|>user\n<tool_response>result</tool_response><|im_end|>
→ model 学到 "不需要 <think>，直接 <tool_call>"
```

触发链路：
1. 某个时刻 strip 了 history 中的 `thinking` 消息以节省 token
2. tool-call assistant 变成 `content=" "` + `tool_calls`
3. 重复 pattern 形成 few-shot 污染
4. 补丁 `openaiHistoryPreprocessor.ts` 用自定义 XML 扁平化绕过了问题（但没修根）

Qwen chat_template 已将 `role:"tool"` 正确转为 `<tool_response>` 标签，tool result 格式无问题。

---

## 新方案

### 策略A（源头修复）：选择性保留 reasoning

```
对于 thinking 消息 → 只有后面是 toolcall assistant 时才保留，否则 strip
对于 assistant 无 toolcall → strip reasoning 字段（省 token）
对于 assistant 有 toolcall → 保留 reasoning 字段（提供工具选择上下文）
```

### 策略B（混血格式 fallback）：Qwen-native 扁平化

当 toolcall assistant 缺 reasoning 时，扁平化为混血格式：

```
上一轮 agent 操作记录（纯文本摘要，不要当成真实 tool 消息）：

1. 调用 read_file({"filepath": "scripts/coverage.py"})
<tool_response>
# coding:utf-8...
</tool_response>
```

- 工具调用用纯文本描述（`1. 调用 xxx(args)`），避免 `<tool_call>` 标签误触发
- 工具结果用 `<tool_response>` 标签（Qwen3 tokenizer 中的特殊 token）
- 头部有明确免责声明（"纯文本摘要，不要当成真实 tool 消息"）

### 数据流

```
Chat 消息历史
  │
  ├── assistant 有 tool_calls + reasoning → 保留 reasoning → API
  │     Token: <|im_start|>assistant\n<think>...</think>\n<tool_call>...
  │
  ├── assistant 有 tool_calls 无 reasoning → 扁平化为混血格式 → API
  │     Token: <|im_start|>user\n上一轮 agent 操作记录...
  │
  └── assistant 无 tool_calls → strip reasoning 字段 → API
```

---

## 改动文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `core/llm/openaiHistoryPreprocessor.ts` | 重写 | 新函数：`selectivelyStripReasoning`、`hasReasoningAssignedToToolCallAssistant`、`flattenToolRound`（混血格式）、`flattenAndKeepRecent` |
| `core/llm/openaiHistoryPreprocessor.vitest.ts` | 重写 | 10 个测试用例覆盖：选择性 strip、混血格式、prefix-cache 稳定性、结构化保留 |
| `core/llm/index.ts` | 修改 | `prepareOpenAICompatibleMessagesForReasoning` 改为 `stripReasoning: false`；扩展推理模型列表（qwen/deepseek/o1/o3/o4/gpt-5） |
| `core/llm/llms/OpenAI.ts` | 回退 | 移除 `_convertArgs` 中冗余的 `prepareOpenAICompatibleMessagesForReasoning` 调用 |

---

## 关键决策

1. **非 toolcall 的 response 能裁剪 thinking**：是。非 toolcall assistant 的 `<think>` 是过渡过程，下轮模型会重生成。保留只浪费 token。
2. **toolcall 的 assistant 必须保留 reasoning**：是。reasoning 解释了为什么选这些工具，是 essential context。
3. **混血格式 vs 纯文本 vs 全原生**：选混血（文本描述 tool calls + `<tool_response>` 标签）。纯文本在没有 reasoning 的 fallback 场景下作为对话压缩格式使用。
4. **扩展模型范围**：从仅 Qwen 扩展到所有推理模型（包括 DeepSeek、OpenAI o 系列、GPT-5），因为 few-shot 污染理论上影响所有推理模型。

---

## 测试验证

使用 `core/autocomplete/console_log/reasoning-history-probe-20260430-015131` 中的探针数据进行回测：

- 00_base（结构化 tool 历史）：0 reasoning → 预期恢复到 18_ 测试水平（41+ reasoning chunks）
- 01-03（无历史）：保持已有良好表现
- 10-18（各变体）：混血格式应接近或超过 18_（41 chunks）的效果
