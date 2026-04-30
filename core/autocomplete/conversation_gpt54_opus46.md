# GPT 5.4 vs Opus 4.6: Autocomplete 方案复核讨论

## 背景

- 讨论对象：Continue v1.3.19 zkdev 分支 autocomplete 方案、README 中已实现项、gap_vs_leaders.md 中的差距分析与行动建议
- 目标：不是互相背书，而是收敛到一份工程上站得住的共同结论
- 约束：只讨论当前代码、已落地实现、公开可验证的行业能力边界，以及在现有生产环境约束下可执行的演进路径

---

## Round 1

### GPT 5.4 发言

Opus 4.6，我先给出我的主结论：**你的方案大方向是对的，但当前文档里同时混杂了“准确判断”“过时状态”和“被高估的追平项”。如果要把它变成可执行的技术路线，需要把这三类东西拆开。**

我先给结论，再给依据。

#### 一、我同意的主判断

**1. 你把主要差距归到“上下文理解深度”和“候选选择智能度”，这个判断是对的。**

当前 zkdev 分支在基础工程层已经不算弱：

- FIM 主链路完整
- cache fast-path 已有
- adaptive debounce 已有基础实现
- suffix overlap 去重已做
- prompt 模板和 snippet 排序已有明显优化

这些都说明它不是“一个完全原始的 autocomplete”。

但你说它和 Cursor / Copilot 的本质代差，主要不在“能不能出一个补全”，而在：

- 能不能拿到更深的 repo 相关上下文
- 能不能在多个候选里选出更稳的一个
- 能不能把连续编辑体验做成产品能力，而不是零散 feature

这点我认同。

**2. 你对生产约束的取舍，大体是成熟的。**

尤其是下面这些判断，我认为是现实的：

- 不急着自建 embedding / indexing 链路
- 不急着做双模型 speculative decoding
- 不把跨文件编辑预测和 agent 能力硬性叠加
- 不把 model routing 变成一个额外的复杂系统

这些都不是“保守”，而是在尊重你给出的部署现实：`8×4090 + sglang + qwen3-coder-30b-a3b`。

在这个前提下，工程上最应该优先做的是：

- 低成本提升上下文有效性
- 降低无意义的 IO / token 计算 / LSP 成本
- 用可测的方式提升 accept rate，而不是引入很重的新系统

#### 二、我认为你文档里不够准确的地方

**3. “默认 maxPromptTokens 太小（1024）”这个现状判断，已经过时。**

当前代码里 `DEFAULT_AUTOCOMPLETE_OPTS.maxPromptTokens` 已经是 `4096`，不是 `1024`。这意味着：

- 你对“1024 明显不足”的原则判断是对的
- 但把它继续写成“当前默认仍是 1024”的现状描述，就不准确了

更准确的说法应该是：

**zkdev 已经把默认值提升到 4096，这一步方向正确；当前真正的问题不再是‘还停在 1024’，而是 4K 和 8K 在生产环境下的质量/延迟平衡还没有完成实测收敛。**

**4. “多源上下文收集已全部具备”说得太满。**

框架层面确实有：

- import definitions
- root path context
- recently edited
- recently visited
- recently opened
- clipboard
- diff

但当前主路径里，diff 实际上还是被临时关掉的，不是一个已稳定参与 prompt 的来源。所以把它写成“全部具备并在发挥作用”，会误导后续判断。

更准确的表述应该是：

**上下文源框架较完整，但并非所有源都已稳定接入当前主路径。**

**5. “自适应防抖已追平竞品”也是高估。**

现在的实现是一个合理的 lightweight adaptive debounce：

- 看最近 5 次按键间隔
- 用中位数判断快打、正常、停顿
- 返回 30/80/最多 200ms 左右的等待

这当然比固定 350ms 强，但它还不是那类成熟系统中的综合节流：

- 不看请求积压
- 不看最近 TTFT / TTFB
- 不看模型负载
- 不看上下文构建复杂度

所以我会把它定性为：

**已经具备基础版 adaptive debounce，但还不是行业头部那种完整调度策略。**

#### 三、我认为你漏掉的关键工程问题

**6. 当前 zkdev 的一个真实风险，不是 gap 文档里强调的那些“大功能没做”，而是“已有链路里仍有几个会直接拉低稳定性和质量上限的结构性问题”。**

我举几个最关键的：

**(a) cache 仍然是 prefix-only 语义。**

缓存实现里明确写着：

- 不同 suffix 目前会被视为同一个 prefix 命中空间

这在速度上有好处，但会带来两个代价：

- 同前缀、不同后文的请求可能误复用旧 completion
- 接受率下降时，你很难分清是模型问题还是缓存误命中问题

所以我认为你后续路线里应当明确加入：

**suffix-aware cache key 或 prefix + short suffix hash**

这比 speculative decoding 更基础。

**(b) RecentlyVisitedRangesService 在高频事件上做了重 IO。**

当前 VS Code 侧最近访问范围服务，是在 `onDidChangeTextEditorSelection` 上触发后再去 `readFile(filepath)`，然后自行切行窗口。

这件事的代价被低估了。因为 selection change 是最频繁的 UI 事件之一，而你在这个点上做的是“读整个文件”。

这意味着你即使不动模型，也已经在前置链路里埋了一个持续性 IO 热点。

这类问题比“要不要 speculative”现实得多，也该比它优先修。

**(c) 结构型上下文现在没有保底预算。**

你把：

- recentlyEditedRanges
- recentlyVisitedRanges
- recentlyOpenedFiles

都提到了更高优先级，这是合理的。

但 importDefinitions / rootPathContext / staticSnippet 全部落在 `base` 的最后一档，这意味着 token 紧张时，它们是最容易被饿死的一类上下文。

这个取舍不是一定错，但它有副作用：

- 行为信号更强
- 结构信号更弱
- 模型更知道“你最近在看什么”，但不一定知道“相关定义是什么”

如果没有给结构信号留出保底预算，质量上限会受影响，尤其在大型 TS / Java / Python 项目里更明显。

#### 四、我对你提出的差距项的逐条判断

**7. 我对你的差距项做一个简化判断。**

| 项目                        | 我的判断                                                    |
| --------------------------- | ----------------------------------------------------------- |
| 无 speculative / 多候选排序 | 成立，但在你当前环境里不应排最前；更适合做低成本 `n=2` 实测 |
| 默认上下文窗口太小          | 原判断方向对，但“当前仍是 1024”已过时                       |
| 无语义检索                  | 成立，但不建议直接跳到 embedding，自建成本过高              |
| NextEdit 未融入 Tab 体验    | 成立，而且这是产品体验层问题，不只是模型问题                |
| 无反馈闭环                  | 成立，但不等于必须做 RL；更适合做配置/策略闭环              |
| 无 streaming ghost text     | 成立，但优先级低，我同意暂不投入                            |
| 无跨文件编辑预测            | 成立，但和 agent 重叠度高，暂缓合理                         |
| 无模型路由                  | 成立，但现阶段不值得做                                      |

#### 五、我给出的额外建议

如果只按“速度、稳定性、质量”三条主线补充建议，我会这么排：

**速度**

1. 先消掉 `selection change -> readFile(full file)` 这类前置热 IO。
2. 给 `countTokens()` 做请求级 memoization。
3. 给 AST / tree path 做短生命周期缓存。
4. 先做 `n=2` 低温候选 + 轻量 reranker 实验，不要直接上 speculative decoding。

**稳定性**

1. cache key 升级为 suffix-aware，而不是只看 prefix。
2. 不要继续在共享 llm 对象上原地改写 completionOptions。
3. snippet 并发限制应做 source-level 隔离，而不是全局 hard gate。
4. `GotoDefinitionCache` 只允许停留在 snippet context 层，不能继续扩散使用边界。

**质量**

1. 给 `base` 结构上下文保底 token 预算。
2. 重新评估 snippet source annotation 的 token 成本与收益。
3. 用“半语义启发式”替代 embedding：测试/实现对、同目录 sibling files、最近 import 相关文件、被频繁引用的类型文件。
4. 把 accept/reject 数据做配置闭环，而不是把“无 RL 资源”理解成“无法闭环”。

#### 六、我的当前结论

如果把你的方案压缩成一句话，我会这样表述：

**Opus 4.6 的方案在方向判断和生产取舍上是靠谱的，但需要修正文档里几处过时现状，并把后续优先级从“大而全的行业对标”收缩到“先修 cache/IO/token/结构上下文这四个更便宜、也更确定能见效的点”。**

我先说到这里。等你回应后，我再针对你同意或不同意的点继续收敛。

gpt54: end of speaking

---

## Round 2: 最新变更审查（2026-03-24 下午）

### 背景

自 Round 1 以来，zkdev 分支又有以下提交：

1. **`08f88efbc`** — 上下文关联性优化：snippet 优先级重排 + maxPromptTokens 1024→4096 + Tab+光标融合
2. **`f7a250d6d`** — numSurroundingLines 20→30, editedRanges+visitedRanges 同文件互补去重
3. **`b488e70d0`** — snippet source annotation（每个 snippet 头部加语言感知注释标注来源：`// recent edit`, `# cursor context`, `-- definition` 等）

### 需要讨论的核心议题

1. **snippet source annotation 是否有价值？** — 在 `<|file_sep|>` 后加 `// recent edit` 等注释，qwen3-coder 是 instruct 模型（非 thinking），训练数据中没见过这类标注。用户质疑这是否有正面效果，还是纯粹噪音？
2. **优先级重排的合理性** — editedRanges(1) > visitedRanges(2) > openedFiles(3) > clipboard(90) > diff(98) > base(99)。GPT 5.4 在 Round 1 提到 base（import/AST 定义）可能被饿死，这个新排序是否加剧了问题？
3. **visitedRanges numSurroundingLines 20→30** — 每个光标位置取 ±30 行，5 文件 × 3 snippets = 最多 15 个 snippet × 60 行。在 4096 token 预算下是否过多？
4. **editedRanges+visitedRanges 同文件互补去重** — 允许同一文件同时有编辑片段和光标上下文，是否造成冗余？

请 GPT 5.4 先给出你的审查结论。

---

### Opus 4.6 开场

Round 2 的 4 个议题已列出。按规则，GPT 5.4 先发言。我在这里等待。

opus46: end of speaking

---

### GPT 5.4 发言

Opus 4.6，这一轮我先直接给结论：**这三次变更里，`08f88efbc` 和 `f7a250d6d` 的方向基本成立，但 `b488e70d0` 的 snippet source annotation 我持明显保留意见。四个议题里，我认为真正值得保留的是“优先级重排的大方向”和“editedRanges + visitedRanges 的互补思路”，最值得警惕的是“annotation 噪音”和“visitedRanges 的 IO/预算膨胀”。**

我按你列的四个议题逐条说。

#### 一、snippet source annotation 是否有价值

我的结论很直接：**有一点点潜在解释性价值，但当前实现大概率是得不偿失，至少不应该默认全量加在所有 code snippet 头部。**

理由有三层。

**1. 这不是模型天然熟悉的上下文格式。**

你说得对，qwen3-coder 的强项是代码和常见 FIM/多文件格式，不是这种人为加的一行“recent edit / cursor context / definition”标注。尤其当前已经有：

- 多文件 FIM token
- 文件路径
- snippet 自身代码内容

这时候再在每段 snippet 顶部补一行来源注释，并不是必然增益。模型未必真的把它当成“高价值结构化信号”，更可能只是把它当成又一行需要跨过去的自然语言噪音。

**2. 它会稳定吃掉 token 预算，而且这个预算来自最贵的地方。**

这个实现不是只给 static snippet 加标签，而是对 code snippet 普遍加一行注释。考虑到当前 snippet 很多是短片段：

- recentlyEditedRanges 本来就短
- visitedRanges 常常是局部窗口
- root/import definitions 有时只有几十行甚至更短

在这种情况下，多一行注释的边际成本并不小。你花出去的是 prompt 里最昂贵的 token，却未必换来稳定增益。

**3. 它还会改变代码分布本身。**

模型原本看到的是：

- 原始代码
- 原始多文件边界

现在变成：

- 一段注释标签
- 再接代码

这等于人为把“任务说明”嵌到代码 snippet 内部，而不是留在模板或独立 static guidance 里。这种做法最危险的地方在于：你不容易判断收益来自哪里，但噪音是确定注入的。

所以我的建议是：

**如果要保留 annotation，应该收缩使用范围，而不是默认对全部 code snippet 生效。**

我会更倾向这三种收缩策略之一：

1. 只给 `staticSnippet` 或极少数高歧义来源加标签
2. 只给 `recentlyEditedRanges` 和 `recentlyVisitedRanges` 加标签，不给 base definitions 加
3. 先做 A/B，再决定是否保留，而不是直接把它当成已成立优化

如果让我现在拍板，我会把这一项定性成：

**方向可讨论，但当前实现偏 noisy，默认开启的工程置信度不够。**

#### 二、优先级重排的合理性

我的结论是：**大方向正确，但当前排序过于“行为信号中心化”，确实加剧了 base 被饿死的风险。**

你把：

- editedRanges = 1
- visitedRanges = 2
- openedFiles = 3
- base = 99

这个重排背后的核心思想，我是认可的：

- 用户刚改过的内容，通常是最强任务信号
- 光标停留位置，比“只是打开过这个文件”更有价值
- opened files 更适合做工作集回退，不该比 cursor context 更靠前

这套逻辑是成立的。

但我的保留点也很明确：

**base 现在不是“后处理”，而是“最后捡剩饭”。**

这在 token 紧张时会带来结构性偏差：

- 模型更知道你最近在编辑什么
- 但不一定知道相关定义、接口、类型、调用约束是什么

在动态语言里这个问题没那么严重；在 TS/Java/Python 这类依赖定义与类型关系的代码里，会更明显。

所以我不反对这个排序，但我反对“完全不保底”的版本。更好的做法不是把 base 提前，而是：

**给 base 留一个固定预算下限。**

例如：

- 总 snippet token budget 中预留 15% 到 20% 给 base
- 行为信号仍然先排，但不能把结构信号吃到 0

这样你既保留了“编辑 > 光标 > Tab”的核心理念，又不至于把 import/rootPath/static 变成纯碰运气。

所以这条我的最终结论是：

**排序方向对，但需要加 base budget floor，否则它从“重排”滑向“结构信息系统性饿死”。**

#### 三、visitedRanges 的 ±30 行、5 文件、最多 15 个 snippet 是否过多

我的判断是：**从“单次 token 总量”看，不一定离谱；但从“前置采集成本”和“重复度”看，当前实现偏激进。问题不主要在 30 行这个数字，而在它叠加了高频 selection 事件和整文件读取。**

先拆开看。

**1. 30 行本身不是核心罪魁。**

在 4096 token 预算下，给 visitedRanges 扩到 ±30 行，不是显然错误。因为：

- 60 行代码在很多语言里也就几百 token
- 最终还会经过后续 token budget 裁剪
- 它不是“无上限拼进去”

如果只看 prompt 最终形态，30 行不算夸张。

**2. 真问题在于它和当前采集方式耦合得太差。**

现在 VS Code 侧是：

- 每次 selection change
- 调 `ide.readFile(filepath)`
- 再切出 ±30 行窗口

也就是说，真正贵的不是“30 行”，而是“为了取 30 行，先把整文件又读一遍”。

当你再把：

- maxRecentFiles = 5
- maxSnippetsPerFile = 3

叠上去，这个服务就容易在高频光标移动时持续刷新大量局部快照。最后的结果往往不是“上下文更强了”，而是：

- 采集更重
- 重复更多
- 真正有效信息密度不一定提高

**3. 所以我不会把这条问题定性为“30 改回 20”，而会定性成“先修采集方式，再谈窗口大小”。**

换句话说，我当前最不满意的不是 30，而是这个组合：

- selection event
- full file read
- per-file 多 snippet 堆叠

我的建议排序是：

1. 先把数据来源改成直接从 editor document 抓窗口文本，而不是 `readFile(full file)`
2. 然后再实测 20 vs 30
3. 最后再决定 `maxSnippetsPerFile` 是否真的需要到 3

如果在当前实现不变的前提下让我表态，我会说：

**30 行不是不可接受，但这版实现整体偏重，应该先减采集成本，再讨论是否保留 30。**

#### 四、editedRanges + visitedRanges 同文件互补是否造成冗余

这一点我的判断和上一轮一致，但比上一轮更明确：**这个思路本身是对的，且比“同文件强行互斥”更合理；问题不在“允许互补”，而在缺少更细的去重和配额约束。**

我认同它的设计动机：

- editedRanges 提供“刚改了什么”的精确信号
- visitedRanges 提供“这段代码周围还有什么”的局部上下文

这两个信号不是完全替代关系，而是天然互补关系。

所以如果两者同文件时强制只保留一个，反而会损失信息。

但是，我要加一个工程上的限定：

**允许同文件互补，不等于允许无约束叠加。**

当前缺的不是“是否放行”，而是更细粒度的控制，例如：

1. 同文件下 editedRanges 和 visitedRanges 的 token 合计上限
2. 如果 edited snippet 已经完全落在 visited window 中，就不要重复注入
3. 如果 visitedRanges 的窗口对 editedRanges 只有极小增量，就压缩或丢弃

也就是说，这条我不会批评它“方向错”，我会批评它“还差最后一层去重策略”。

所以我的结论是：

**允许同文件互补是正确修正，不该回退；但要补 overlap-aware dedup，而不是只做 filepath-aware dedup。**

#### 五、我对 Round 2 四个议题的最终归纳

如果压缩成最简短的共同判断，我这一轮会写成：

1. **snippet source annotation**：当前实现偏 noisy，收益未证，默认全量加标签不够稳妥。
2. **优先级重排**：方向正确，但应给 base 结构上下文留保底预算。
3. **visitedRanges 20→30**：数字本身不是核心问题，真正问题是高频 selection + full file read 的采集方式过重。
4. **editedRanges + visitedRanges 同文件互补**：思路正确，不应回退，但需要更细的 overlap-aware 去重和配额控制。

#### 六、我当前的收敛建议

如果你希望这轮能收敛到可执行动作，我建议优先顺序是：

1. 先审慎看待 `b488e70d0`：不要默认把 snippet annotation 当成已被证明的优化。
2. 给 `base` 加最小 token floor。
3. 把 RecentlyVisitedRangesService 从 full-file read 改成直接取 editor window 内容。
4. 给同文件 edited+visited 增加 overlap-aware dedup。

这四步里，前两步偏质量，后三步兼顾稳定性和速度。

我这一轮先到这里。等你回应后，我再判断我们能否在 Round 2 上达成一致口径。

gpt54: end of speaking

---

### Opus 4.6 回应

GPT 5.4，四个议题我逐条回应。先说结论：**四条我基本同意你的方向判断，只在具体执行细节上做补充和修正。这一轮应该可以收敛。**

#### 一、snippet source annotation — 同意收缩，补充具体行动

你的判断我完全接受：**当前实现默认对所有 code snippet 加标签，工程置信度不够。**

我补充一个你没展开的技术细节：当前 `annotateSnippetSource()` 是在 `getSnippets()` 的主循环里对每个 snippet 调用的，也就是说它不只影响 prompt 质量 — 它还改变了 `countTokens()` 的计算结果。每个 snippet 多一行注释 ≈ 多 5-15 token，在 15 个 snippet 的极端场景下，总计可吃掉 75-225 token，这在 4096 预算下是 ~2-5%。比例不大，但这 2-5% 来自一个收益未证的功能，不划算。

我的具体行动建议比你的三选一更明确：

**直接把 `b488e70d0` 的 annotation 功能整体放到 `experimental_snippetAnnotation` flag 后面，默认 false。** 不需要收缩使用范围、也不需要 A/B — 先关掉。等有了离线评测（比如用 HumanEval infilling 对比 annotation on/off 的 pass rate），再决定是否开启。

理由：这比"收缩到部分 snippet"更干净。部分加、部分不加反而引入不一致性 — 模型有时看到标签、有时看不到，更难学到稳定模式。要么全加要么全不加，而当前应该全不加。

**结论：同意你的判断。行动 = 加 flag，默认关闭。**

#### 二、优先级重排 — 同意加 base floor，补充实现方案

你的核心判断我同意：**排序方向对，但 base 需要保底预算。**

我要补充一个实际观察：在当前代码里，base 被排到 priority=99 不等于"完全吃不到"。`getSnippets()` 的处理逻辑是按 priority 顺序迭代，每类 snippet 从 `remainingTokenCount` 中扣除。在实践中：

- editedRanges 通常 2-5 个短片段（每个 ~30-60 行 → ~100-200 token）
- visitedRanges 通常 3-9 个片段（每个 ±30 行 → ~200 token）
- openedFiles 走 `formatOpenedFilesContext` 自适应裁剪

在 4096 token 预算下，前三类通常消耗 1500-2500 token，base 仍然能拿到 1000+ token。**base 真正被饿死的场景是：用户同时在多个文件高频编辑+跳转，导致 edited+visited 片段量爆炸。**

所以你说的保底是对的。我的具体实现方案：

```typescript
// 在 getSnippets() 的 for (const { key } of snippetOrder) 循环之前
const totalSnippetBudget = getRemainingTokenCount(helper);
const BASE_FLOOR_RATIO = 0.15;
const baseFloor = Math.floor(totalSnippetBudget * BASE_FLOOR_RATIO);

// 在循环中，当 key !== "base" 时，限制消耗不超过 totalSnippetBudget - baseFloor
// 当轮到 base 时，remainingTokenCount 至少还有 baseFloor
```

这样做的好处是不需要改排序，只需要在非 base 类型消耗时增加一个上界检查。15% floor 在 4096 预算下约 614 token，足够放入 2-3 个关键定义片段。

**结论：同意。行动 = 给非 base 类型加 ceiling，保证 base 至少拿到 15% 预算。**

#### 三、visitedRanges 采集方式 — 同意核心问题是 readFile，补充具体修复

你的分析精准：**30 行不是核心罪魁，`readFile(full file)` 才是。**

我补充一个你可能没注意到的代码细节：在 `cacheCurrentSelectionContext` 中，`event.textEditor.document` 已经是 VS Code 的 `TextDocument` 对象 — 它自带 `getText(range)` 方法，可以直接从内存中的文档模型取文本，完全不需要走 `ide.readFile()` 的 IO 路径。

当前代码：

```typescript
const fileContents = await this.ide.readFile(filepath);
const lines = fileContents.split("\n");
const relevantLines = lines
  .slice(startLine, endLine + 1)
  .join("\n")
  .trim();
```

修改后：

```typescript
const range = new vscode.Range(
  startLine,
  0,
  endLine,
  event.textEditor.document.lineAt(endLine).text.length,
);
const relevantLines = event.textEditor.document.getText(range).trim();
```

这个改法：

- 零磁盘 IO（直接读内存）
- 零全文解析（不需要 split 再 slice）
- 还能获得更精确的行范围（VS Code document model 的行号和内容是实时同步的）

修完这个之后，30 行 vs 20 行的 IO 成本差异就消失了。剩下的唯一考虑是 token 预算——但这已经被 `getSnippets()` 里的 `remainingTokenCount` 机制自然约束。

**结论：同意。行动 = 把 `readFile` 改成 `document.getText(range)`，30 行保留。**

#### 四、同文件互补去重 — 同意加 overlap-aware dedup

你的判断我完全同意：**允许互补是正确方向，但需要 overlap-aware dedup 而不只是 filepath-aware dedup。**

当前的 dedup 逻辑在 filtering.ts 里是：

```typescript
key === "recentlyVisitedRanges" && editedRangesFilepaths.has(snippet.filepath);
```

这只是"放行同文件 visitedRanges"，完全没检查行范围重叠。最坏情况：editedRanges 贡献了 file.ts 第 100-130 行，visitedRanges 又贡献了 file.ts 第 90-150 行 — 中间 30 行完全重复。

具体改法：需要在 editedRanges 处理阶段记录每个文件的已覆盖行范围（不只是 filepath），然后在 visitedRanges 处理时：

1. 检查新 snippet 的行范围与已覆盖范围的重叠比例
2. 如果重叠 > 50%，跳过
3. 如果重叠 ≤ 50%，只保留非重叠部分（或保留全部但记录增量度）

实现上需要 snippet 携带 `startLine`/`endLine` 元数据。当前 `AutocompleteCodeSnippet` 没有这个字段，需要扩展类型。这是一个合理的增量改动。

**结论：同意。行动 = 扩展 snippet 类型加行范围，实现 overlap-aware dedup。**

#### 五、Round 2 收敛判断

逐条对比：

| 议题                | GPT 5.4                        | Opus 4.6                           | 是否一致                              |
| ------------------- | ------------------------------ | ---------------------------------- | ------------------------------------- |
| annotation          | 默认开不稳妥，应收缩或关闭     | 加 flag 默认关闭                   | ✅ 一致（我更激进：直接关而不是收缩） |
| 优先级重排          | 方向对，加 base floor          | 方向对，加 15% base floor          | ✅ 一致（我补充了具体比例和实现）     |
| visitedRanges 30 行 | 先修采集方式再谈窗口大小       | 改 readFile→getText 后 30 行可保留 | ✅ 一致（我补充了具体代码改法）       |
| 同文件互补          | 方向对，加 overlap-aware dedup | 方向对，加行范围检查               | ✅ 一致（我补充了重叠比例阈值）       |

**四条全部方向一致，差异仅在执行细节层面。**

如果你认可以上收敛判断，我们可以直接进入 conversation_results.md 的编写。如果你对我的补充有异议，我们再开一轮。

opus46: end of speaking

---

### GPT 5.4 回应

Opus 4.6，这一轮我认为我们已经完成收敛了。你的回应不是在改方向，而是在把我给出的判断压实到可执行实现，这正是我希望看到的。我的结论是：**我接受你这一轮的四条补充，并同意把 Round 2 视为已达成一致。**

我逐条确认。

#### 一、annotation：我同意你比我更激进的处理方式

你建议不是“收缩使用范围”，而是：

- 加 `experimental_snippetAnnotation` flag
- 默认 `false`
- 在没有离线评测之前整体关闭

我接受这个版本，而且我认为它比“只对部分 snippet 加标签”更工程化。原因和你说的一样：

- 部分开启会制造上下文格式不一致
- 很难判断收益来自哪里
- 也更难建立稳定评测基线

所以这条我更新为：

**Round 2 共识 #1：`b488e70d0` 的 annotation 功能应置于实验开关之后，默认关闭。**

#### 二、base floor：我同意你给出的 15% 方案

我上一轮提出的是原则：base 不能吃剩饭，应该有预算下限。

你这一轮把它压成了具体方案：

- 用总 snippet budget 的 15% 作为 base floor
- 非 base 类型只能消耗 `totalSnippetBudget - baseFloor`
- 不改排序，只改预算约束

这个方案我认同，而且我认为它比“把 base priority 往前挪”更干净。因为你保留了：

- 编辑信号优先
- 光标信号次之
- 工作集回退再次之

同时又避免结构上下文被系统性饿死。

所以这条我更新为：

**Round 2 共识 #2：保留当前优先级重排，但给 base 结构上下文设置约 15% 的保底预算。**

#### 三、visitedRanges：我同意 30 行先不回退，先修采集方式

你补的这个细节是关键：`TextEditor.document.getText(range)` 已经能直接从内存文档模型取窗口内容，根本不需要：

- `ide.readFile(filepath)`
- `split("\n")`
- `slice(startLine, endLine + 1)`

这说明当前真正错误的不是“30 行偏大”，而是“为了取 30 行做了整文件 IO”。

我接受你的更新后结论：

- 先改采集方式
- 30 行先保留
- 再根据实际 accept rate / token 压力看是否需要从 30 回退到 20

所以这条我更新为：

**Round 2 共识 #3：visitedRanges 的核心修复是 `readFile -> document.getText(range)`，在此基础上 30 行可以先保留。**

#### 四、同文件互补：我同意你把它具体化为“行范围 + 重叠阈值”

这一条我们在原则上本来就没有分歧。你这一轮补上的是实现上的可落地性：

- 只用 filepath dedup 不够
- 需要给 snippet 加 `startLine` / `endLine`
- 再按 overlap ratio 做更细的保留 / 压缩 / 丢弃判断

我同意这条不应回退成“同文件互斥”，而应继续往更精细的 overlap-aware dedup 走。

所以这条我更新为：

**Round 2 共识 #4：保留同文件 editedRanges + visitedRanges 互补，但要引入行范围元数据和 overlap-aware dedup。**

#### 五、我对 Round 2 的最终确认

你给出的那张收敛表，我这边没有实质异议。为了让后续写 `conversation_results.md` 更直接，我把双方共同口径压缩成一句更短的版本：

1. `b488e70d0`：annotation 思路未证，应降为实验功能，默认关闭。
2. `08f88efbc`：优先级重排方向成立，但要给 base 留预算下限。
3. `f7a250d6d`：visitedRanges 扩窗本身可接受，真正该修的是 selection 事件上的整文件读取。
4. editedRanges + visitedRanges 同文件互补方向成立，但应从 filepath dedup 升级到 range-aware dedup。

#### 六、我的结论

从 GPT 5.4 一侧，我正式确认：

**我同意你这一轮对四个议题的收敛判断，认为 Round 2 已达成一致，不需要再开新一轮。**

按本对话规则，下一步应由你将 Round 1 和 Round 2 的共同结论整理写入 `conversation_results.md`，然后结束本次对话。

gpt54: end of speaking
