# Continue zkdev 分支 vs 业界主流 (Cursor / GitHub Copilot / Codeium) 差距分析

> 分析时间: 2026-03-24 | 基准: Continue v1.3.19 zkdev 分支优化后状态

## 已追平的能力

| 能力 | 业界状态 | zkdev 状态 |
|------|---------|------------|
| FIM 多文件模板 | Cursor/Copilot 使用专有多文件格式 | ✅ qwenCoderMultifileFimTemplate（`<\|file_sep\|>` 原生格式） |
| 多源上下文收集 | LSP + 最近编辑 + diff + 剪贴板 | ✅ 全部具备 |
| 缓存前置快速路径 | 标配 | ✅ cache check 在 context collection 之前 |
| 自适应防抖 | Copilot 有 adaptive throttle | ✅ 30-200ms 自适应 |
| Suffix 去重 | 标配 | ✅ trimSuffixOverlap |
| Snippet 稳定排序 (prefix cache 友好) | Cursor 有 | ✅ sortByFilepath |
| Completion 后预取 | Cursor 有 speculative prefetch | ⚠️ 有但默认关闭 |

---

## 差距 1: 无 Speculative Decoding / 多候选排序 — 差距巨大

- **优先级**: P1
- **预估收益**: 高
- **实施难度**: 中（需 sglang 支持 n>1）

Cursor 和 Copilot 的核心优势不是单次补全快，而是**一次生成多个候选并排序**：

- **Copilot**: 后端生成 3-5 个候选，按 log-probability + 启发式 rerank，只展示最佳
- **Cursor**: Tab 候选用小模型快速生成草稿，大模型验证/修正（speculative decoding 变体）
- **zkdev**: 单候选 + temperature=0，没有多样性，没有排序

**实际影响**: 用户看到的是"第一次生成的结果"，没有"从几个候选里选最好的"这一层。补全质量上限被单次生成的随机性约束。

**补全路径**: 需要 temperature > 0 + n > 1 + reranking 逻辑。但 sglang 的 n > 1 支持需要确认。

---

## 差距 2: 上下文窗口默认太小 — 差距明显

- **优先级**: P0
- **预估收益**: 高
- **实施难度**: 低（改参数）

| 方案 | 默认 prompt token |
|------|-----------------|
| Cursor | 8K-16K (按模型自适应) |
| Copilot | ~4K-8K |
| Codeium | ~8K |
| **zkdev 默认** | **1024** |
| zkdev ZKDEV preset | 8192 |

默认 1024 token 意味着：
- prefix 仅 ~307 tokens（约 20-30 行代码）
- suffix 仅 ~205 tokens（约 15 行）
- snippet 空间几乎为零

这对非 zkdev 环境的用户来说，补全质量会明显不如竞品。ZKDEV preset 的 8192 是合理的，但它不是默认值。

**建议**: 默认值至少提到 2048-4096，让大部分现代模型受益。

---

## 差距 3: 无语义/向量检索增强 — 差距显著

- **优先级**: P0
- **预估收益**: 高
- **实施难度**: 高（需接入 indexing）

- **Cursor**: 使用 codebase indexing + embedding 检索语义相关代码段
- **Copilot**: 有 "neighboring tabs" + repository-level 理解
- **Codeium**: 专门的 code graph + embedding pipeline
- **zkdev**: 仅 LSP gotoDefinition + tree-sitter AST 静态分析 + 最近打开文件

当前的上下文来源本质上都是**局部的**（当前文件的 import、光标附近的 AST 路径、最近编辑过的范围）。缺乏对整个 repo 的**语义理解**。

已有 `core/indexing/` 模块（CodebaseIndexer、LanceDbIndex 等），但未接入 autocomplete 链路。

**实际影响**: 在大型项目中，如果需要引用几个文件之外的 API/类型/模式，当前系统完全依赖 LSP 定义跳转能找到它。LSP 找不到 → 补全缺少关键上下文。

---

## 差距 4: 无 Ghost Text 多步导航 — 体验差距

- **优先级**: P1
- **预估收益**: 中高
- **实施难度**: 中（需 UI 层改动）

- **Cursor**: Tab 键不只是接受补全，还能"跳到下一个编辑点"（Next Edit Prediction）并预填充
- **Copilot**: 有 Next Edit Suggestions (preview) 功能
- **zkdev**: NextEdit 框架有（GenericFimNextEditProvider），但默认未与 autocomplete 联动，且 qwen3-coder 支持未验证

当前 NextEdit 的问题不是代码不存在，而是：
- 它走的是独立的 `llm.chat()` 路径，不是 FIM
- 没有和 autocomplete 的 Tab 键体验融合
- 没有 "Tab Tab Tab" 连续跳转的流畅感

---

## 差距 5: 无用户行为反馈闭环

- **优先级**: P2
- **预估收益**: 中
- **实施难度**: 中

- **Copilot**: 收集 accept/reject/partial accept 信号，用于训练和调参
- **Cursor**: 类似，且用 feedback 调整 reranking
- **zkdev**: 有 `telemetryUserTracker.ts` 记录 accept/reject，但**没有闭环**——数据只是记录，不回馈到模型选择、temperature 调整、或候选排序

---

## 差距 6: 无 streaming partial display 优化

- **优先级**: P3
- **预估收益**: 低
- **实施难度**: 中（VSCode API 限制）

- **Copilot/Cursor**: 流式显示部分结果，边生成边展示（用户看到文字逐渐出现）
- **zkdev**: `showWhateverWeHaveAtXMs` 机制存在（300ms 后展示当前已有内容），但这是**全有或全无**的展示，不是真正的流式 ghost text 更新

---

## 差距 7: 无跨文件编辑预测

- **优先级**: P2
- **预估收益**: 中
- **实施难度**: 高

- **Cursor**: 编辑一个文件后，自动在相关文件中提供配套修改建议
- **zkdev**: `SimilarEditDetector` 仅在**当前文件内**搜索相似位置，不跨文件

---

## 差距 8: 无模型路由/分级策略

- **优先级**: P3
- **预估收益**: 中低
- **实施难度**: 高

- **Copilot**: 根据场景复杂度选择不同模型（简单补全用快模型，复杂推理用强模型）
- **Cursor**: 小模型快速补全 + 大模型复杂场景的分级策略
- **zkdev**: 单一模型，没有路由

---

## 优先级总览

| 优先级 | 差距 | 预估收益 | 实施难度 |
|--------|------|---------|---------|
| **P0** | #2 默认 maxPromptTokens 太小 (1024) | 高 | 低 |
| **P0** | #3 无向量/语义检索增强上下文 | 高 | 高 |
| **P1** | #1 无多候选 + reranking | 高 | 中 |
| **P1** | #4 NextEdit 未与 Tab 体验融合 | 中高 | 中 |
| **P2** | #5 无用户行为闭环 | 中 | 中 |
| **P2** | #7 无跨文件编辑预测 | 中 | 高 |
| **P3** | #8 无模型路由分级 | 中低 | 高 |
| **P3** | #6 无 streaming ghost text | 低 | 中 |

## 结论

当前 zkdev 分支在**单次补全的基础工程**（缓存、防抖、模板、后处理）上已经做得比较扎实，但在**补全质量的上限**（多候选排序、语义检索）和**连续编辑体验**（NextEdit 融合、跨文件预测）上，与 Cursor/Copilot 还有本质代差。最大的短板不是延迟，而是**上下文理解的深度和候选选择的智能程度**。

---

## 生产环境讨论 (2026-03-24)

> **生产环境**: 8×4090 + sglang + qwen3-coder-30b-a3b-instruct, 400 用户, 50 月活
> **潜在资源**: 可申请 4×A100

### 议题 1: Speculative Decoding / 多候选 — 收益 vs 成本

**用户观点**: 当前有几张 A100 可用。是否值得部署更小的 coder 模型做 speculative model + 更大模型做 review/复杂推理？

### 议题 2: 上下文窗口 4K vs 8K — 平衡点

**用户观点**: 增加上下文窗口带来的质量提升，是否抵得过服务器负载增加导致的延迟降低收益？需要找平衡值。ZKDEV preset 已经是 8192。后续会在生产环境实测。

### 议题 3: 语义/向量检索 — 替代方案

**用户观点**: Continue 官方宣称 indexing 要被废弃，不想自己维护这部分。embedding 语义检索带来的收益跟增加的研发机器 IO 负载是否平衡合理？是否有替代方案？

### 议题 4: NextEdit Tab 融合 — 必要性

**用户观点**: 这个功能的适用场景和频次有多高？相比开发改动成本、风险、测试成本，确实需要吗？

### 议题 5: 用户行为反馈闭环 — 资源限制

**用户观点**: 没有充足的模型 RL 资源。当前只收集补全速度、accept/unaccept 来评估整体趋势。

### 议题 6: Streaming Ghost Text — 暂不考虑

**用户观点**: 对质量、速度、稳定性收益不大，忽略。

### 议题 7: 跨文件编辑预测 — 与 Agent 重合？

**用户观点**: 跨文件编辑预测与 agent 能力是否重合？main 分支上更新了很多 agent 能力。如果重合的话，跨文件编辑多倾向于重构，研发一般倾向用 agent。

### 议题 8: 模型路由/分级 — 场景区分可行性

**用户观点**: 结合 #1 讨论。场景复杂度方便区分吗？本地就能通过指标区分吗？还是要借助 llm.chat 额外增加对话？

---

## 讨论结论 & 行动项 (2026-03-24)

> 基于生产环境约束: 8×4090 / 400 用户 / sglang + qwen3-coder-30b

### 值得做

| 行动 | 理由 | 工作量 | 状态 |
|------|------|--------|------|
| maxPromptTokens 默认调到 4096 | 性价比最高的质量提升，1024 严重不足 | 改一个数字 | ✅ 已实施 |
| 增强已打开 Tab 文件 snippet 权重 | 替代 embedding 的零成本方案，Copilot neighboring tabs 同类策略 | 小改动 | ✅ 已实施 |
| 生产环境 A/B 测 4K vs 8K | 用数据决策 | 运维侧 | 待实测 |
| 按语言/文件大小维度拆分 accept rate 统计 | 发现低 accept 场景，零模型成本 | 小改动 | 待排期 |
| A100 部署大模型做 chat/agent | 补全 vs 对话天然路由，比 autocomplete 内路由合理 | 运维侧 | 待排期 |

### 不做 / 暂缓

| 议题 | 结论 | 理由 |
|------|------|------|
| #1 Speculative Decoding | 暂不做 | qwen3-coder-30b 是 MoE (3B 激活)本身很快，speculative 省不了多少；额外占卡不值 |
| #3 Embedding 语义检索 | 不自建 | indexing 被官方废弃；IO 负载 vs 收益不平衡；增强 LSP/Tab 替代 |
| #4 NextEdit Tab 融合 | 暂缓 | 频次低(10-20%)、UI 改动大、测试风险高；等 main 分支稳定后跟进 |
| #5 RL 反馈闭环 | 保持现状 | 无 RL 资源；当前 accept rate 趋势统计够用 |
| #6 Streaming Ghost Text | 不做 | VSCode API 限制，收益低 |
| #7 跨文件编辑预测 | 不做 | 与 agent 能力重合；重构场景用户倾向用 agent |
| #8 模型路由/分级 | 不做 | 本地指标无法可靠区分复杂度；llm.chat 分类延迟翻倍；"补全用30b/对话用大模型"已是天然路由 |
| #1 n=2 parallel sampling | 可选实测 | 如果 sglang throughput 影响可控，低成本提升质量。需实测确认 |

---

## 上下文关联性分析 & 优先级重排 (2026-03-24)

> 基于已有上下文源的关联强度分析，重新排列 snippet 优先级。

### 上下文源关联强度评估

| 上下文源 | 信号类型 | 关联强度 | 旧优先级 | 新优先级 | 说明 |
|---|---|---|---|---|---|
| caretWindow | 局部语法 | ★★★★★ | 最高(先扣预算) | 不变 | 光标前后代码，所有系统核心 |
| recentlyEditedRanges | 修改意图 | ★★★★★ | 4 | **1** | 用户刚改过的代码是最强的任务上下文信号 |
| recentlyVisitedRanges | 注意力/光标 | ★★★★ | 3 | **2** | 光标停留位置的±30行代码，实现"Tab文件+光标"融合 |
| recentlyOpenedFiles | 工作集 | ★★★★ | 2 | **3** | 降为回退：无光标数据的Tab文件取全文(pruneFromBottom) |
| **importDefinitions (base)** | **语法结构** | ★★★★ | 99 | 不变 | **LSP gotoDefinition: 解析 import 语句→跳转到类型/接口/函数签名定义** |
| **rootPathContext (base)** | **语法结构** | ★★★★ | 99 | 不变 | **tree-sitter AST: 分析当前文件引用的符号→LSP 取定义代码** |
| diff | 任务范围 | ★★★ | 5 | **98** | 常常太大太杂，降至最低(仅在base前) |
| clipboard | 用户意图不稳定 | ★★ | 1 | **90(禁用)** | 信噪比低，默认关闭 |

> **关于语法关联（import/AST）在 prompt 中的位置**：importDefinitions 和 rootPathContext 都在 `base` snippets 中（优先级99），虽然数字最大但不代表不重要——它们在所有行为上下文（编辑/光标/Tab）分配完后填入剩余 token 预算，确保始终包含代码结构信号。具体实现见 `ImportDefinitionsService.ts`（import→gotoDefinition）和 `RootPathContextService.ts`（AST 符号→gotoDefinition）。

### 核心设计："Tab文件+光标"自动融合

利用已有 `RecentlyVisitedRangesService`（VSCode层追踪光标位置±20行）+ snippet去重机制：

1. **visitedRanges(优先级2)** 先处理 → 为已访问Tab文件添加**光标附近代码**
2. **openedFiles(优先级3)** 后处理 → `formatOpenedFilesContext` 中去重跳过已被visitedRanges覆盖的文件
3. **效果**: 有光标数据的Tab → 取光标附近内容；无光标数据的Tab → 取文件头部内容

### 配套变更

| 变更 | 文件 | 说明 |
|---|---|---|
| `maxRecentFiles: 3→5` | RecentlyVisitedRangesService.ts | 追踪更多文件的光标位置 |
| `numSurroundingLines: 20→30` | RecentlyVisitedRangesService.ts | 4096 token 预算下扩大光标上下文范围 |
| `editedRanges+visitedRanges 同文件不互斥` | filtering.ts | 编辑片段(小)+光标上下文(大)互补，不相互覆盖 |
| `defaultNumFilesUsed: 5→7` | formatOpenedFilesContext.ts | 4096 token预算下纳入更多Tab文件 |
| `recencyWeight: 0.6→0.7` | formatOpenedFilesContext.ts | 强化最近打开文件优先级 |
| `minTokensInSnippet: 125→200` | formatOpenedFilesContext.ts | 每个文件分到更有意义的内容量 |
| `maxPromptTokens: 1024→4096` | parameters.ts | 基础预算翻4倍 |

### 不做

| 项目 | 理由 |
|---|---|
| 兄弟文件启发式 (`*.test.ts` ↔ `*.ts`) | 优先级不够，现有Tab+光标已覆盖多数场景 |
| git blame 热文件分析 | IO/计算成本高，收益不确定 |