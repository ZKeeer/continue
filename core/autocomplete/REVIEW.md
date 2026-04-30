---

## 增量复审

复审对象：

- `d26810f76b23b037bfd818a57a09f1e879a94d28`
- `e6411a83613799dedc3d745c7aa661d182e7d1a0`

复审目标：确认这两次“修复 review 问题”的提交，是否真的把前一轮高优问题收敛掉，还是在修复过程中又引入了新的行为级风险。

结论先说：**这两次提交确实修掉了一部分前述问题，但还没有到“可以放心盖章”的程度。** 当前至少还存在 3 个需要继续处理的行为级问题，其中前两个会直接影响 autocomplete 的稳定性和命中效果。

### 复审结论

1. `d26810f76b23b037bfd818a57a09f1e879a94d28` 修正了缓存 read/write 主键错位、恢复了默认参数、给 prefetch / edit-intent / similar-edit 加了实验开关，方向是对的。
2. `e6411a83613799dedc3d745c7aa661d182e7d1a0` 引入 `GotoDefinitionCache` 以复用 LSP definition 结果，思路也成立。
3. 但实现层面仍然残留了 3 个问题：
    - 并发限制器会因为超时后底层请求不 settle 而永久泄漏槽位，最终把所有 snippet 来源短路为空。
    - prefetch 路径只修了 raw prefix，没有把 raw suffix 一并打通，prompt 语义仍然半旧半新。
    - 新增的 `GotoDefinitionCache` 只按 `filepath:line:character` 缓存 10 分钟，没有任何文档版本或内容变更维度，容易复用过期 definition 结果。

换句话说：**这不是“修复失败”，但也不是“review 已清零”。** 当前状态更像是第一轮修复完成后，又暴露出第二轮应当继续收敛的实现问题。

### 新发现

#### 1. 高优先级：`racePromise` 的并发限制器会永久泄漏槽位，最终让上下文抓取长期退化为空

这次提交试图修正“超时不取消底层请求”的问题，在 `snippets/getAllSnippets.ts` 中加了全局并发上限：

- `_pendingSnippetRequests`
- `MAX_PENDING_SNIPPET_REQUESTS = 3`
- 超过上限后直接返回 `[]`

问题在于，这个计数器只在底层 `promise` **真正 settle** 时才会减一：

```ts
const cleanup = () => {
   _pendingSnippetRequests = Math.max(0, _pendingSnippetRequests - 1);
};
promise.then(cleanup, cleanup);
return Promise.race([promise, timeoutPromise]);
```

如果某个 `gotoDefinition` 或 IO 调用长期挂住，`Promise.race` 会很快超时返回，但底层 promise 永远不 resolve / reject，那么 cleanup 就永远不会执行。

后果是：

1. 只要累计 3 个挂住请求，`_pendingSnippetRequests` 就会卡在上限。
2. 之后所有 `racePromise(...)` 都会直接返回空数组。
3. autocomplete 会长期退化成“没有上下文 snippet”的状态，除非进程重启或底层 promise 偶然结束。

这不是小瑕疵，而是新的熔断型回归。它确实限制了后台堆积，但方式是“几个坏请求把整套上下文系统一起锁死”。

涉及位置：

- `snippets/getAllSnippets.ts`

建议：

- 槽位释放应当绑定“race 生命周期”，而不是只绑定底层 promise 的最终 settle。
- 如果还要跟踪底层未完成任务，应该拆分“前台预算计数”和“后台挂起计数”，不要共用一个 hard gate。
- 最好补一个测试：模拟底层 promise 永不 settle，连续调用 4 次，验证第 4 次之后系统不会永久 short-circuit。

#### 2. 高优先级：prefetch 路径对 raw prefix/raw suffix 只修了一半，prompt 语义仍不一致

这次提交新增了：

- `documentPrefix`
- `documentSuffix`

并把正常缓存写入从 `outcome.prefix` 改成了 `outcome.documentPrefix`，这一步是对的。

但 prefetch 只在一半地方切到了 raw 文档语义：

- `newPrefix = outcome.documentPrefix ?? outcome.prefix`

而后续仍然继续使用：

- `_buildPrefetchPrompt(newPrefix, outcome.suffix, ...)`
- `postprocessCompletion({ prefix: newPrefix, suffix: outcome.suffix, ... })`

问题在于：对正常生成路径来说，`outcome.suffix` 仍然是**模板编译后的 suffix**，并不是新增的 raw `documentSuffix`。

这会导致 prefetch prompt 落在一种“prefix 用 raw 文档，suffix 用 compiled prompt”的混合状态。对于会在 `compilePrefixSuffix` 阶段包装前后文的模板，这等于把已经编译过的 suffix 再送进模板逻辑一次，语义并不稳定。

结果是：

1. 主缓存路径的 key 虽然修正了，但 prefetch 生成出来的内容仍可能建立在错误 prompt 上。
2. 命中率问题可能从“完全打不中”变成“有时命中，但质量和可复现性不稳定”。
3. 这说明缓存语义修复还没有贯穿整个预测链路。

涉及位置：

- `CompletionProvider.ts`
- `PrefetchService.ts`

建议：

- prefetch 应全面切换为 `documentPrefix` + `documentSuffix` 语义。
- 如果确实需要 compiled suffix，就必须把字段命名和职责写清楚，不能让 `outcome.suffix` 同时承担“日志字段”和“raw 文档字段”两种含义。
- 最好补一个模板级测试，覆盖多文件 FIM 模板下 prefetch prompt 的前后缀一致性。

#### 3. 中高优先级：`GotoDefinitionCache` 的 key 过于静态，会把过期 definition 结果跨编辑状态复用

新提交引入了一个独立缓存：

- `GotoDefinitionCache`
- key = `filepath:line:character`
- TTL = 10 分钟

它被同时接入：

- `ImportDefinitionsService`
- `RootPathContextService`

这里的问题不是“不能缓存 definition”，而是这个 key 把 `gotoDefinition` 当成了纯位置函数，但实际它明显依赖：

- 当前文档内容
- import 状态
- 符号重命名后的索引状态
- 未保存缓冲区内容
- 工作区索引刷新结果

也就是说，同一个 `filepath:line:character`，在用户编辑前后完全可能对应不同 definition 结果。现在缓存键感知不到这些变化，只能靠 10 分钟 TTL 被动过期。

这会导致：

1. context retrieval 继续返回旧的 import/root-path snippets。
2. 用户在重命名、改 import、移动符号定义后，autocomplete 上下文可能长时间不更新。
3. 这类错误不会报错，只会表现为“补全怎么越来越不对”，最难排查。

涉及位置：

- `context/GotoDefinitionCache.ts`
- `context/ImportDefinitionsService.ts`
- `context/root-path-context/RootPathContextService.ts`

建议：

- 至少把缓存作用域降到单次文档会话或单次 context retrieval 生命周期，而不是跨编辑态共享 10 分钟。
- 如果要跨请求共享，需要引入文档版本、文件 mtime、或 IDE 提供的 buffer version 作为 key 维度。
- 最少也该补一个测试：同一位置在 import/definition 变化后，不应继续命中旧 definition。

### 复审后的整体判断

如果把状态分层来看，我的判断是：

1. **第一层，原始高优问题里最危险的一批确实开始被修。** 这点应当肯定。
2. **第二层，修复过程还不够彻底。** 特别是缓存语义和超时/并发控制，仍然存在“主路径修了，旁路没修完”的现象。
3. **第三层，新增的 definition 缓存带来了新的正确性风险。** 它解决的是成本问题，但代价是可能缓存过期语义。

因此这两次提交更准确的评价是：

**属于“有效推进，但尚未收尾”的修复提交。**

如果要给 Opus 4.6 一个简洁结论，我会写成：

- `d26810f76b23b037bfd818a57a09f1e879a94d28`：修复方向基本正确，但并发限制与 prefetch 语义仍有高优残留问题。
- `e6411a83613799dedc3d745c7aa661d182e7d1a0`：`GotoDefinitionCache` 思路成立，但当前 key/失效策略过于粗糙，存在中高优正确性风险。
# Autocomplete 优化代码审查

审查对象：

- `aa8cc553460b3aac3707b6e49261e811c1f27a65`
- `6850e498a760341f3301b157f821021865a2dc83`

审查目标：结合当前 `README.md` 中宣称的优化效果，以及 `plan.md` 中的设计意图，判断这两次提交是否真的提升了 autocomplete，而不是把局部实验、主观推断和未验证的想法直接塞进公共主路径。

结论先说：方向不全错，但实现明显不够收敛。这里面有几处不是“可能还可以再优化”，而是“逻辑上就站不住”。如果把这类代码当成性能优化提交出去，那就是在拿线上用户给实验结论垫背。

---

## 总体结论

这两次提交主要有四类问题：

1. **缓存键语义被搞乱了**：真实编辑器状态、模板编译后的 prompt 前缀、预测缓存前缀被混在一起使用。
2. **所谓超时保护只是放弃等待，不是取消工作**：表面 latency 下降，实际后台负载和 LSP 压力可能更糟。
3. **能力探测和默认参数严重过度泛化**：针对 `qwen3-coder + sglang + A100` 的实验性调参，被硬塞成全局默认行为。
4. **新增“聪明功能”缺少基本约束**：prefetch、similar edit、generic next edit 都有明显的错误命中或静默失效风险。

换句话说，这不是一组已经打磨好的优化；这更像是“在特定机器上感觉不错，于是把实验结论编码成默认逻辑”。这种代码最容易在作者机器上赢麻了，在别人环境里开始制造诡异行为。

---

## 主要问题

### 1. 高优先级：预测缓存和相似编辑缓存的 key 语义错误，核心优化路径很可能根本打不中

这是最严重的问题。

当前真实请求的缓存查询是基于 `helper.prunedPrefix`：

- `CompletionProvider.ts` 中读取缓存：`cache.get(helper.prunedPrefix)`

但写缓存时却使用了 `outcome.prefix`：

- 正常 completion 写入：`cache.put(outcome.prefix, outcome.completion)`
- prefetch 写入：`cache.put(newPrefix, processed)`，其中 `newPrefix = outcome.prefix + outcome.completion`
- similar edit 写入：`cache.put(pred.predictedPrefix, pred.predictedCompletion)`，而 `predictedPrefix` 也是从“拼出来的内容”推导的

问题在于，`outcome.prefix` 不是稳定的“真实文档前缀”，而是**已经经过模板层改写后的 prefix**。这在多文件 FIM 模板中尤为明显：prefix 可能已经带上：

- snippet 拼接内容
- `<|repo_name|>`
- `<|file_sep|>`
- 注释包装或路径头部

也就是说：

- 读缓存时用的是“真实编辑位置前缀”
- 写缓存时用的是“prompt 编译后的前缀”

这两者不是一个东西。

结果：

1. README 里宣称的“accept 后第二次补全缓存 0ms 命中”，没有可靠实现基础。
2. SimilarEditDetector 拿到的所谓 `fileContent = outcome.prefix + outcome.completion + outcome.suffix` 也不是实际文件内容，而是带 prompt 包装的伪内容。
3. qwen 多文件模板越激进，这个 bug 越明显，因为 prefix 被污染得越彻底。

这不是命中率低一点的问题，这是**缓存键定义错位**。优化建立在错误的 key 语义上，结论不可信。

涉及位置：

- `CompletionProvider.ts`
- `PrefetchService.ts`
- `templating/index.ts`

建议：

- 明确区分三种概念：
  - `documentPrefix`: 真实编辑器前缀
  - `promptPrefix`: 模板编译后发送给模型的前缀
  - `cacheKeyPrefix`: 专门用于 autocomplete 结果复用的前缀
- 缓存系统只允许使用一种稳定、可证明可重建的 key。
- Similar edit 检测必须基于真实文件内容，而不是 prompt 拼装结果。

---

### 2. 高优先级：所谓“超时保护”没有取消底层请求，只是把慢请求藏到后台

这类代码最容易骗过性能统计。

提交里大量加入了这种模式：

```ts
await Promise.race([
  slowCall(),
  new Promise((resolve) => setTimeout(() => resolve([]), 150)),
]);
```

看起来它把 1000ms 变成了 150ms，实际上不是。它只是让当前调用栈“不再等”，**并没有停止 slowCall 本身**。

这在以下位置都存在：

- `ImportDefinitionsService.ts`
- `RootPathContextService.ts`
- `snippets/getAllSnippets.ts`

问题在于这些 slowCall 大多是：

- `gotoDefinition`
- 文件读取
- 其他 IDE/LSP 交互

如果这些调用不支持真正的 abort/cancel，那么这次提交做的不是性能优化，而是：

1. 让主线程更早返回一个空结果；
2. 同时让语言服务继续在后台忙已经无用的工作；
3. 在用户连续输入时堆积更多失效请求；
4. 最终把后续真正需要的请求拖慢。

如果作者只看“本次函数返回耗时”，那这看起来很漂亮；如果看 IDE/LSP 的实际工作量和连续输入场景，它可能更糟。

这是非常典型的“把 latency 指标优化成幻觉”的写法。

建议：

- 如果底层 API 支持取消，就传递 `AbortSignal` 或等价取消句柄。
- 如果底层不支持取消，至少做并发上限控制，避免旧请求无限堆积。
- 不要把“超时后忽略结果”写成“性能优化已完成”。这只是 fallback，不是优化。

---

### 3. 高优先级：这批默认参数是环境特化，不是公共默认值

`parameters.ts` 里把默认值改成了：

- `maxPromptTokens: 8192`
- `prefixPercentage: 0.45`
- `maxSuffixPercentage: 0.25`
- `debounceDelay: 120`
- `modelTimeout: 300`
- `showWhateverWeHaveAtXMs: 500`
- `experimental_enableStaticContextualization: true`

README 自己已经写明这些调参是针对：

- `sglang`
- `qwen3-coder-30b-a3b-instruct`
- `A100`

那问题就很直接：为什么这种环境绑定的实验值会被写成全局默认？

这不是 profile，也不是 model-specific preset，而是**直接修改了所有用户的基础行为**。

风险包括：

1. 小上下文模型会被塞更长 prompt，质量和延迟都可能变差。
2. 本地 CPU / 消费级 GPU / 远程高延迟 provider 会被更高 token 预算拖垮。
3. static contextualization 默认打开，会把额外解析与上下文构建成本扩散到所有环境。
4. `showWhateverWeHaveAtXMs` 拉高后，用户可能更晚看到首个可用建议。

你可以说“在我的机器上更好”，但这类改动进公共默认值之前，至少要回答：

- 为什么这不是 model-specific override？
- 为什么这不是 provider-specific preset？
- 为什么这不是 opt-in experimental flag？

现在的实现方式更像是在仓库里硬编码作者设备的配置文件。

建议：

- 恢复保守默认值。
- 把这批参数下沉到 qwen/sglang/A100 组合的 profile 或 capability-based preset。
- 至少基于模型上下文长度、provider 类型、是否本地部署做分支，而不是一刀切。

---

### 4. 中高优先级：SimilarEditDetector 把最常见的批量编辑场景直接排除了

这个实现最荒唐的地方在于：它口头上在做“相似编辑检测”，代码里却明确把“完全相同的重复编辑”排除了。

核心逻辑里有这样一条：

```ts
if (a.completion.trim() === b.completion.trim()) return false;
```

而现实里最常见的批量编辑恰恰是：

- 多个函数都加同一个参数
- 多个位置都插入同一条日志
- 多个类都加同一个修饰符
- 多个条件分支都补同一段保护代码

这些场景下，completion 经常就是完全一样的文本。

也就是说，这个 detector 恰好把最典型、最有价值的触发场景过滤掉了，只保留“结构相似但 completion 不同”的少数情况。README 对它的宣传明显比实际能力大得多。

另外，这个模块还有两个设计问题：

1. 它只在**当前文件**内搜相似位置，和 README 对“多点编辑模式”的暗示相比，能力被说大了。
2. 它依赖非常粗糙的 identifier 替换，容易在重名、遮蔽、语法差异下生成看似合理但实际上错误的 completion。

建议：

- 不要排除 identical completion，除非你能证明这是噪声而不是主流场景。
- 至少把 README 改成和实际能力一致，不要把 heuristic 吹成模式学习。
- 在没有更强约束前，不要自动往缓存里注入批量预测结果。

---

### 5. 中优先级：Generic NextEdit 的能力探测明显过度泛化

`autodetect.ts` 新增了对 qwen 系列的通用 NextEdit 支持，只要模型名里带 `qwen` 就可能被视为支持。

这过于草率。

当前链路是：

1. `modelSupportsNextEdit()` 里匹配到 `qwen`
2. `NextEditProviderFactory` fallback 到 `GenericFimNextEditProvider`
3. 真正请求时走 `llm.chat([prompts[1]], token, { stream: false })`

问题是：

- 这不是在检查“该模型是否在当前 provider 上稳定支持 NextEdit”
- 这只是检查“名字里像不像 qwen”

这会导致几类假阳性：

1. qwen 但并不适合当前 prompt 结构的模型
2. qwen 但当前 provider/chat 接口不稳定的部署
3. qwen 但其实只验证过 autocomplete FIM，没验证过 NextEdit chat 路径的模型

README 说的是“为 qwen3-coder 启用 NextEdit”，代码做的是“给整条 qwen 家族开绿灯”。这不是一个精度级别的事。

更直接地说：你验证的是一个模型，代码放开的却是一整个品牌名。

建议：

- 从“qwen 全家桶”收缩到经过验证的具体模型或 capability 标志。
- 如果必须做 fallback，也应该是显式实验开关，而不是默认 capability。
- 没有稳定测试之前，不要把“generic provider 能跑”写成“模型支持 NextEdit”。这两句话不是一回事。

---

### 6. 中优先级：Prefetch 设计缺少成本约束，容易把“提升体感”变成“额外持续负载”

Prefetch 的设计思路本身没问题，但当前实现太乐观。

它在用户 accept 后：

- 延迟 50ms
- 重新取 LLM
- 构造 prompt
- 发起一次新的生成
- 最多生成 256 tokens
- 最后写缓存

这意味着：**每次接受补全，几乎都附带一次后台额外推理请求**。

如果环境是：

- 本地模型
- 有限 GPU
- 墙内高延迟 provider
- 多文件编辑快速 accept 的重度用户

那 prefetch 很可能不是免费收益，而是持续的额外负载。

更糟的是，目前几乎没有看到这几个关键保护：

- 基于 accept 率/命中率的自适应启停
- provider 或模型级别的 prefetch allowlist
- 并发预算控制
- 对“prefetch 实际命中率”的日志闭环

README 把它写得像白送性能，但实现更像“无差别后台 speculative request”。这在算力便宜时叫优化，在算力贵时叫浪费。

建议：

- 先把 prefetch 做成实验开关。
- 至少统计：prefetch 触发次数、真正命中次数、无效请求比例。
- 对本地模型和高延迟 provider 默认关闭。

---

### 7. 中优先级：EditIntentDetector 的收益证据不足，更像 prompt 噪声注入器

这个模块的核心做法是：

- 扫最近编辑内容
- 匹配若干关键词模式
- 生成一句 `Current editing pattern: ...`
- 把这句话作为 static snippet 注入 prompt

问题不在于它“粗糙”，而在于它**粗糙但进入了主路径**。

这类自然语言提示是否有益，至少应该有下面之一：

- 明确的离线评估
- A/B 数据
- 至少是少量回归 case 对比

现在看不到这些证据。

而且它的风险很直接：

1. 检测错了，就往 prompt 注入错误意图。
2. 检测对了，也未必比直接给模型原始编辑上下文更有价值。
3. 它消耗的是高价值 token 预算，不是免费提示。

这类 heuristic 如果只在实验分支里玩一玩还行，直接合进默认 snippet pipeline，不够克制。

建议：

- 没有证据前，把它关到实验开关后面。
- 至少限制只在高置信度场景下注入。
- 把 README 里的“准确率提升”措辞改成“尝试增强信号”，别把启发式规则写成已验证收益。

---

### 8. 中优先级：README 中多处“优化完成”的表述，证据强度明显高于代码本身

文档里最刺眼的一点，不是它乐观，而是它太快下结论。

几个典型例子：

- “cache hit 延迟从 200-1600ms+ 降至 ~10ms”
- “prefetch 后第二次补全延迟 ~0ms”
- “similar edit 后续位置 ~0ms 延迟”
- “qwen3-coder 可使用 NextEdit UI”

这些表述的问题在于：

1. 代码里没有形成闭环验证。
2. 某些路径连缓存 key 语义都还没理顺。
3. 某些功能只是“可以尝试跑”，不是“已稳定支持”。

如果 README 是作者私人实验笔记，这没什么；如果 README 想作为项目内设计说明，那这种写法会误导后续维护者，以为这些收益已经被证明了。

直白一点：

这里有些段落像是在给提交写庆功稿，不像在写工程文档。

建议：

- 区分“已验证收益”“推测收益”“待验证假设”。
- 没有统计闭环的地方，不要写成确定结论。
- 文档语气收敛一点，能减少很多后续维护成本。

---

## 次要问题

### 9. `temperature=0` 的改动带有策略倾向，但没有说明对多样性和接受率的代价

把默认 temperature 改为 0，确实可能提升缓存命中率，但这本质上是拿**多样性**去换**复用率**。这不是单向收益。

如果目标是 autocomplete 的确定性，这个方向可以讨论；但提交里几乎只强调缓存命中，没有正面讨论：

- 会不会让补全更僵硬？
- 会不会降低探索性候选？
- 对不同 provider 的行为是否一致？

这不一定是错，但它不是“无需解释的优化”。

---

### 10. `truncateAtBlockBoundary()` 名字比能力强，容易给维护者错误心理预期

README 把它描述成“AST 边界 snippet 截断”，但实现本质上只是**按行正则猜测块边界**，并不是真正的 AST 边界。

这会造成两个问题：

1. 命名和文档给人错误的可靠性预期。
2. 维护者以后可能以为它具备比实际更强的语义稳定性。

如果它只是轻量 heuristic，那就老老实实按 heuristic 叫，别往 AST 上蹭。

---

## 建议的修复顺序

如果要把这两次提交收敛成可接受的工程变更，建议按下面顺序处理：

1. **先修缓存键语义**
   - 区分 document prefix 和 prompt prefix
   - 修复 prefetch/similar edit 的缓存命中基础
2. **再修取消语义和并发控制**
   - 停止把“race timeout”当真正优化
3. **把环境特化调参从全局默认值里剥离**
   - 做成 model/provider/profile 级策略
4. **把 prefetch / edit intent / similar edit / generic next edit 全部挂到实验开关后**
   - 没有闭环数据前，不该默认放大影响面
5. **补测试和日志闭环**
   - 缓存命中率
   - prefetch 真命中率
   - next edit 实际成功率
   - false positive / false trigger 统计

---

## 最终评价

这两次提交里有一些合理的方向判断：

- autocomplete 的主瓶颈确实在上下文收集，不在 prompt build
- qwen 多文件 FIM 模板确实值得做
- 缓存检查前置这个思路本身也对

但“方向对”不等于“实现可以直接进主路径”。

当前代码最大的问题不是野心太大，而是**对自己过于自信**：

- 把环境特化结论写成公共默认值
- 把 fallback 写成性能优化
- 把 heuristic 写成能力增强
- 把未验证收益写成 README 里的既成事实

如果这是实验分支，我会说“有一些值得继续验证的想法”；
如果这是准备长期维护的公共代码，我的评价是：

**收敛度不够，边界不清，证据不足，太早宣布胜利。**

更难听一点：

**这不像在做稳健的 autocomplete 工程，更像是在把一轮实验兴奋期的想法直接焊进主干代码。**

在作者自己的 A100 上，也许这些改动“感觉很快”；
在通用产品代码里，这种写法更像未来故障单的预约单。
