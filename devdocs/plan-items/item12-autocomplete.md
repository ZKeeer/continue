# 待实施：#12 Autocomplete 质量提升

> 评估级别: B 级（高价值 + 高成本）
> 状态: ❌ 未开始

## 现状评估

Continue 的 autocomplete 架构完整：

- `core/autocomplete/` — 完整的补全流水线
- `core/nextEdit/` — NextEdit（±5行预测编辑）
- 多模型支持（Ollama/Codestral/Tab-9 等）

但在实际使用中**延迟和质量落后一档**，主要原因：

1. 使用本地/开源模型时推理速度慢
2. Context 构建不如 Copilot 精准（前缀/后缀截取策略）
3. 无 speculative decoding / 草稿模型加速

## 关键差距分析

### 1. 延迟

| 方案                    | 原理                                  | 工作量               |
| ----------------------- | ------------------------------------- | -------------------- |
| 更激进的缓存            | 缓存相同前缀的补全结果                | ~50 行               |
| 取消正在进行的旧请求    | 用户继续输入时立即取消上一个请求      | ~30 行（可能已实现） |
| 模型预热                | 应用启动时发送 dummy 请求预热推理引擎 | ~20 行               |
| 草稿模型（Draft Model） | 小模型快速生成候选，大模型验证        | ~200 行，需模型配置  |

### 2. 质量

| 问题           | 改进方向                             | 工作量 |
| -------------- | ------------------------------------ | ------ |
| 前缀截取太激进 | 保留更多前缀上下文（sliding window） | ~30 行 |
| 后缀利用不足   | FIM（Fill-in-Middle）suffix 质量优化 | ~50 行 |
| 重复代码过多   | 过滤与现有代码重复度高的补全         | ~40 行 |

## 现有相关文件

- `core/autocomplete/completionProvider.ts` — 主流水线
- `core/autocomplete/context/getTabAutocompleteDocs.ts` — Context 构建
- `core/autocomplete/filtering/streamTransforms.ts` — 输出过滤
- `core/autocomplete/caching/AutocompleteCache.ts` — 缓存实现

## 建议优先级

1. **取消正在进行的旧请求**（低成本，高收益，改善体验感知）
2. **前缀/后缀截取策略优化**（中成本，提升补全相关性）
3. **草稿模型支持**（高成本，推迟到有专项投入时）

## 战略建议

**不建议追赶 Cursor 的补全质量**：Cursor 有专有 Tab-3 模型，投入产出比极差。重点应放在：

- 配置文档（如何选择最佳本地补全模型）
- 延迟优化（体验感知提升）
- 与 Rules 系统深度结合（项目级补全上下文）
