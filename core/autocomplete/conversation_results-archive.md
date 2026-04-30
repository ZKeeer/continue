# Opus 4.6 × GPT 5.4 联合代码审查结论

> 审查对象：Continue v1.3.19 autocomplete 模块，zkdev 分支  
> 审查提交：`aa8cc5534`、`6850e498a`  
> 达成时间：2026-03-24  
> 经过：2 轮对话后双方确认无残余分歧

---

## 一、共识总表

| #   | 问题                                          | 事实判断                      | 归因                                                 | 最终优先级                       |
| --- | --------------------------------------------- | ----------------------------- | ---------------------------------------------------- | -------------------------------- |
| 1   | 缓存键错位                                    | ✅ 成立                       | **上游引入**（`bd353e06d` 已存在），zkdev 继承并放大 | **高优**（最先修复）             |
| 2   | 超时无取消                                    | ✅ 成立                       | zkdev 引入                                           | **高优**                         |
| 3   | 参数泛化                                      | ✅ 成立                       | zkdev 引入                                           | **高优**                         |
| 4   | SimilarEditDetector 排除 identical completion | ✅ 成立                       | zkdev 引入；设计意图有合理性但依赖缓存前提           | **中高优**（待 #1 修复后可降级） |
| 5   | NextEdit autodetect 泛化                      | ✅ 成立                       | zkdev 引入                                           | **中优**                         |
| 6   | Prefetch 缺少成本约束                         | ✅ 成立                       | zkdev 引入                                           | **中优**                         |
| 7   | EditIntentDetector 无门控                     | ✅ 成立                       | zkdev 引入                                           | **中优**                         |
| 8   | README 过度宣称                               | ✅ 成立                       | zkdev 引入                                           | **中优**                         |
| 9   | temperature=0                                 | ✅ 事实成立，行业惯例支持方向 | zkdev 引入                                           | **低优**（策略说明不足）         |
| 10  | truncateAtBlockBoundary 命名误导              | ✅ 成立                       | zkdev 引入                                           | **低优**                         |

---

## 二、关键共识要点

### 1. 全部 10 个技术事实均成立

双方确认：GPT 5.4 在 REVIEW.md 中提出的每一个代码层面的技术事实，经 Opus 4.6 逐行代码验证后，全部成立。

### 2. Issue #1 的归因修正

**原表述**（GPT 5.4 初版）：zkdev 搞乱了缓存键语义  
**修正后表述**（双方一致）：缓存键错位是上游 `bd353e06d` 已有的缺陷（READ 用 `helper.prunedPrefix`，WRITE 用 `outcome.prefix`），zkdev 未识别该问题，并在其上继续建设了 PrefetchService 和 SimilarEditDetector，放大了影响面。

> 问题不是"谁第一个写坏了它"，而是"这个分支是否在错误前提上继续扩建"。

### 3. Issue #9 降级理由

`temperature=0` 在 autocomplete 场景是业界普遍做法（GitHub Copilot、Codeium、TabNine 等均使用低 temperature 或 0）。此改动方向本身合理，问题仅在于缺少对代价（多样性损失、接受率影响）的说明。降为低优。

### 4. 实验分支的双维度评价

- **工程质量维度**：不因分支身份降级。默认值污染、无门控、README 过度宣称等，是代码/文档自身的工程问题。
- **部署风险维度**：实验分支可适当降级，因为直接影响用户的外溢风险被分支隔离部分缓解。

特别地：

- Issue #3（参数泛化）维持高优 — 因为修改全局默认值影响的是语义定义，不仅是局部行为
- Issue #8（README 过度宣称）维持中优 — 文档误导效果不依赖代码是否被部署执行

### 5. Issue #4 的条件性判断

SimilarEditDetector 排除 identical completion 的设计，可能是为了避免与缓存命中机制重复工作。但在缓存键错位（Issue #1）尚未修复的前提下，这个设计假设不成立，导致最高频使用场景被封堵。

> 这是一个建立在缓存可用前提上的脆弱设计；当该前提不成立时，问题就从设计取舍升级为行为缺口。

---

## 三、建议的修复路线

### Phase 1（阻塞性）— 修复缓存基础

- **修复 Issue #1**：明确区分 `documentPrefix`（真实编辑器前缀）、`promptPrefix`（模板编译后 prompt 前缀）、`cacheKeyPrefix`（缓存复用键）
- 确保缓存 READ 和 WRITE 使用同一种稳定、可重建的 key
- SimilarEditDetector 必须基于真实文件内容，而非 prompt 拼装结果

### Phase 2（高优）— 取消语义与参数治理

- **修复 Issue #2**：为 LSP 调用添加并发控制或取消机制，停止将 `Promise.race` 超时等同于性能优化
- **修复 Issue #3**：将 A100/sglang/qwen3-coder 特化参数从全局默认值下沉到 model/provider profile 或 capability-based preset

### Phase 3（中优）— 门控与边界

- **Issue #5**：将 NextEdit 匹配从 `"qwen"` 收缩到已验证的具体模型，或加白名单/实验开关
- **Issue #6**：给 Prefetch 加实验开关、速率限制、命中率统计闭环
- **Issue #7**：给 EditIntentDetector 加 `TabAutocompleteOptions` 中的实验开关
- **Issue #4**：在 Issue #1 修复后重新评估 identical completion 排除逻辑的合理性

### Phase 4（文档与命名）

- **Issue #8**：修正 README，区分"已验证收益"、"推测收益"、"待验证假设"
- **Issue #9**：补充 temperature=0 的策略说明和代价讨论
- **Issue #10**：将 `truncateAtBlockBoundary` 重命名或在文档中明确标注为行级启发式而非 AST 分析

---

## 四、总体评价（双方一致）

zkdev 分支中有若干正确的方向判断：

- autocomplete 的主瓶颈在上下文收集阶段，这个诊断是对的
- qwen 多文件 FIM 模板值得做
- 缓存检查前置的思路本身也对
- 预取、相似编辑检测、编辑意图检测等方向具有工程价值

但"方向对"不等于"实现可以直接进入主路径"。当前代码的核心问题是：

1. **基础前提错误**：整个缓存/预测体系建立在一个失配的缓存键语义上
2. **边界管理不足**：新功能缺少实验开关、门控条件和可观测性
3. **环境特化当作通用默认**：A100 + sglang + qwen3-coder 的实验数据被编码为全局行为
4. **文档超前于代码**：README 把假设写成了结论

修复路线的核心原则：**先修基础前提错误，再修建立在该前提上的优化层和叙述层。**

---

_本文档由 Opus 4.6 根据双方对话内容整理，GPT 5.4 在对话中明确确认同意此共识。_
