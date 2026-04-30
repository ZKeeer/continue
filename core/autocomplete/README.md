# Autocomplete 共享上下文架构实施方案

> 本文档用于定义 autocomplete / NextEdit 共享上下文层的目标架构、设计约束、实施阶段与待决策事项。

---

## 一、问题定义与优化目标

> 当前 context collection 已明显收敛，但 debounce 后仍存在可复用上下文重复收集的问题。
> 本节用于界定现状瓶颈，以及为什么需要共享上下文层与多队列方案。

### 当前瓶颈定位

经过对完整 pipeline 的审计，debounce 后的耗时分布如下：

| 阶段                        | 当前耗时 | 瓶颈原因                                                     |
| --------------------------- | -------- | ------------------------------------------------------------ |
| HelperVars.create()         | 40-200ms | file read + AST parse（虽有 LRU 缓存，但首次仍需全量 parse） |
| getAllSnippetsWithoutRace() | 0-200ms  | racePromise 200ms 上限，LSP gotoDefinition 是主要来源        |
| getSnippets(filtering)      | 10-20ms  | token counting + budget allocation + dedup                   |
| prompt build                | 5-20ms   | 模板渲染                                                     |

**核心发现**: context collection 的 100-300ms 中，~90% 的工作内容在相邻击键之间几乎不变。

### 速度侧剩余空间（有限，~15-25ms）

| 编号 | 优化项                                | 成本   | 预期收益    | 说明                                                                              |
| ---- | ------------------------------------- | ------ | ----------- | --------------------------------------------------------------------------------- |
| S1   | `getRemainingTokenCount` 一次计算复用 | 改变量 | ~2-5ms/req  | `countTokens(prunedCaretWindow)` 在整个 filtering 过程中不变，但被重复调用 2-3 次 |
| S2   | 粗粒度 token 估算做早期淘汰           | 小改动 | ~3-8ms/req  | 用 `content.length / 4` 粗估做 ±20% 快速筛选，边界情况才精确 tokenize             |
| S3   | 跨请求 token counting 模块级 LRU      | 中改动 | ~5-10ms/req | 快速连续输入时相邻请求的 prunedCaretWindow 高度重叠                               |
| S4   | Lazy 初始化实验性 context service     | 小改动 | ~1-3ms 启动 | 默认关闭的 EditIntentDetector 等服务仍在构造函数中创建                            |

**结论**: 速度侧剩余空间有限，contextCollection 已非主瓶颈，主瓶颈已转移至 LLM 推理 (stream_completion_ms)。

### 质量侧剩余空间（明显）

| 编号 | 优化项                           | 成本   | 预期收益 | 说明                                                                         |
| ---- | -------------------------------- | ------ | -------- | ---------------------------------------------------------------------------- |
| Q1   | `BASE_FLOOR_RATIO` 15% → 25%     | 改一行 | 中高     | editedRanges+visitedRanges 内容多时，import definitions 被挤压，导致符号幻觉 |
| Q2   | GotoDefinitionCache 增加内容感知 | 小改动 | 中       | 3 分钟 TTL 内文件编辑后缓存不失效，返回旧的类型/接口定义                     |
| Q3   | 改进 AST-boundary 截断正则       | 小改动 | 中       | `truncateAtBlockBoundary()` 不处理 `}` 闭括号和缩进级别，截断后代码不完整    |
| Q4   | 重叠去重阈值 50% → 35%           | 改一行 | 低       | 50% 下仍允许较多重复内容浪费 token budget                                    |

### 整体判断

| 维度     | 剩余空间                                      | 核心瓶颈                                            |
| -------- | --------------------------------------------- | --------------------------------------------------- |
| **速度** | 有限 (~15-25ms)，contextCollection 已非主瓶颈 | LLM 推理 (stream_completion_ms)                     |
| **质量** | **明显空间**                                  | import/类型定义被挤压、snippet 截断不完整、缓存过时 |

**但真正的突破性优化不在这些小修小补——而是架构层面的变革。**

---

## 二、目标架构：共享上下文层 + 多队列前置 Context Architecture

### 核心观察（用户洞察）

> 用户的常见编辑场景就是：键盘的回车、方向键、PgUp/PgDown/Home/End 移动，鼠标点击和跨文件移动。这些动作累积起来就是一个时间序列的 history。
>
> 能不能全局记录这些 history，把 context collection 放到 debounce 之前？过了 debounce 后只需要做两件事：1. 添加 prefix/suffix/middle 2. 过滤需要的 historical actions & files & content。
>
> 甚至过滤动作也可以放到 debounce 之前——保证 queue 长度，history 就会自动过滤。
>
> 用户光标不会大范围跳来跳去，所以全局的 history 是相对变动不大的，只有 prefix/suffix/middle 是动态变化的。

### 当前架构 vs 新架构

**当前**:

```
击键 → debounce(30-200ms) → [HelperVars(40-200ms) + getAllSnippetsWithoutRace(0-200ms) + filtering(10-20ms)] → prompt → LLM
                              ↑ contextCollectionMs: 100-300ms (每次从零收集)
```

**新方案**:

```
[后台持续运行 — 事件驱动]
  onDidChangeTextDocument    → update editedRangesQueue      (同步, <1ms)
  onDidChangeTextEditorSelection → update visitedRangesQueue (同步, <1ms, 零 IO)
  onDidChangeActiveTextEditor → update openedFilesQueue      (同步, <1ms)
                              → 后台异步 warm importQueue    (100-300ms)
                              → 后台异步 warm AST/cache      (供 rootPath 动态派生)
  onDidSaveTextDocument      → 后台异步 refresh importQueue  (imports)
                              → 后台异步 refresh AST/cache   (rootPath 仍动态派生)

击键 → debounce(30-200ms) → [prefix/suffix(~10ms) + queue.takeUpTo(~2ms) + rootPath动态派生(缓存命中时 ~<10ms) + O(1)格式化(~1ms)] → prompt → LLM
                              ↑ contextCollectionMs: ~15-25ms
```

### 共享分层（实施版）

为兼容现有能力并降低迁移风险，新架构按三层落地：

1. **共享上下文层**：Queue 管理、warming 状态机、AST / 文件内容缓存、importDefinitions 预热、recentlyEdited / recentlyVisited / openedFiles 的统一入队接口。该层同时服务 autocomplete 与 NextEdit。
2. **autocomplete 消费层**：prefix/suffix 构建、snippet budget 分配、queue 取用、prompt 拼接。
3. **NextEdit 消费层**：editable region 计算、partial-file / full-file diff prompt 生成、prefetch / jump / chain 状态机。NextEdit 不直接感知 queue 细节，但必须复用共享上下文层。

### 多 IDE 适配原则

QueueManager 等共享基础设施位于 `core/` 层，只暴露纯数据接口与状态管理，不直接绑定 VS Code API。VS Code、PyCharm 等 IDE 通过各自 adapter 层把事件转换为统一的 queue push / warm 调用。

### 第一版落地范围（V1）

第一版优先落地最稳定、最可验证的部分：

1. `editedRangesQueue`
2. `visitedRangesQueue`
3. `openedFilesQueue`
4. `importQueue`
5. AST / 文件内容缓存增强

`rootPath` 在 V1 中**不锁死为 queue 化方案**。第一版保持“基于共享 AST/cache 的动态派生”，在 Phase C 再根据 benchmark 决定是否进一步 queue 化。

---

## 三、设计约束

以下约束由用户明确提出，贯穿整个设计：

1. **多队列分类**: 不同 snippet 类型用不同 queue，按 prompt 比重设置 queue 容量
2. **Push 前整理**: 内容在 push 到 queue 之前就已经被整理好（原始内容 + 元数据 + token 粗估值），debounce 后零整理直接取用
3. **操作隔离**: 用户不同操作只影响对应 queue（小范围光标移动不更新文件级结构上下文，如 `importQueue` / AST cache）
4. **后台同步**: 文件相关的光标/键鼠活动会触发对应 queue 的后台处理和变动
5. **冷启动保守**: IDE 打开后不急于预热，不使用旧数据。不退化到 prefix-only；但当 `edited/visited/opened` 已 ready 时允许先出 `core-ready` 补全，`import/rootPath` 完整 ready 后再出 `full-ready` 补全
6. **纯内存不落盘**: queue 及所有相关内容不持久化，丢了就丢了，保证处理速度
7. **共享上下文优先**: 新架构首先是共享 context substrate 重构，而不是仅 autocomplete 路径重构；必须兼容现有 NextEdit
8. **多 IDE 兼容**: 事件采集通过 IDE adapter 层接入，不能把 VS Code 事件模型固化到 `core/`
9. **rootPath 延后决策**: importDefinitions 已确定 queue 化；rootPath 第一版保持动态派生，Phase C 再决定是否 queue 化
10. **openedFiles 窗口化**: `openedFilesQueue` 默认只存“文件头部声明区 + 光标附近窗口”，单条 entry token cap 固定为 `openedFiles` queue 容量的 50%，大文件禁止全文入队

---

## 四、Queue 数据结构

### QueueEntry

```typescript
interface QueueEntry {
  filepath: string; // 来源文件路径
  content: string; // 原始代码内容（未经模板格式化，格式化在组装时 O(1) 拼接）
  startLine: number; // 起始行号
  endLine: number; // 结束行号
  tokenCount: number; // push 时保存粗估值（如 Math.ceil(content.length / 3.5)），第一版不依赖模型 tokenizer
  timestamp: number; // push 时间戳，用于 FIFO 淘汰
  snippetType: string; // code | comment | definition | diff
}
```

**关于模板格式化**: entry 存原始内容 + 元数据（filepath 等），**不**预绑定模型格式。组装时按当前模型做 O(1) string concat:

- qwen-coder: `` `<|file_sep|>${filepath}\n${content}` ``
- 其他模型: `` `// Path: ${filepath}\n${content}` ``

这样切换模型无需重新填充 queue。

**关于 `tokenCount`**: 第一版使用粗估值做 budget 近似分配，以换取 push 时 O(1) 成本。该值并非模型无关的精确 token 数，后续如 telemetry 证明预算偏差明显，再升级为按 `modelKey` 的懒计算缓存。

### SnippetQueue 类

- **有界 token 容量**: 按 prompt 比重设置，超配 ~120%（确保 takeUpTo 有足够内容）
- **FIFO ring buffer 语义**: push 时超容量 → evict 最旧条目
- **push 时去重**: 检查 filepath + lineRange 重叠 >50% → 替换(update)而非追加(push)
- **takeUpTo(budget)**: 从新到旧取条目，累加 tokenCount 直到 budget 耗尽，返回条目列表

### Queue 分配（V1，基于 maxPromptTokens=4096）

prefix(~1200) + suffix(~800) ≈ 2000 tokens → snippet budget ≈ 2000 tokens

| Queue 名称      | Prompt 比重 | Budget (tokens) | 超配容量 (120%) | 典型条目数 |
| --------------- | ----------- | --------------- | --------------- | ---------- |
| `editedRanges`  | 25%         | 500             | 600             | 3-5        |
| `visitedRanges` | 25%         | 500             | 600             | 5-8        |
| `openedFiles`   | 10%         | 200             | 240             | 3-5        |
| `importQueue`   | 15%         | 300             | 360             | 5-8        |
| `diff`          | 10%         | 200             | 240             | 1-3        |

另预留 `rootPathReserve ≈ 15%` 预算，用于 debounce 后基于 AST/cache 做动态派生；V1 中不作为独立 queue 落地。

> 注：实际 snippet budget 在 debounce 后根据 prefix/suffix 实际长度动态计算，
> queue 的超配确保有足够内容供 takeUpTo 截取。

---

## 五、用户操作 → Queue 更新映射

### 同文件内操作

| 操作                        | 影响的 Queue    | 处理逻辑                                  |
| --------------------------- | --------------- | ----------------------------------------- |
| 输入字符                    | 无              | 只影响 prefix/suffix（debounce 后动态取） |
| Enter / 换行                | `editedRanges`  | 扩展当前编辑范围                          |
| Backspace / Delete          | `editedRanges`  | 调整当前编辑范围                          |
| Undo / Redo                 | `editedRanges`  | 重新评估编辑范围                          |
| Arrow 键 (小范围, ±5行内)   | **无**          | 仍在已有 visitedRange 窗口内，不更新      |
| Arrow 键 (跨出当前窗口)     | `visitedRanges` | 添加新位置 ±30 行上下文                   |
| PgUp / PgDown / Home / End  | `visitedRanges` | 总是添加新位置 ±30 行上下文               |
| 鼠标点击 (同文件, 不同位置) | `visitedRanges` | 同 PgUp/PgDown                            |
| 选择文本 (无 copy)          | **无**          | 不影响 queue                              |

**判定逻辑**: 光标移动事件需 debounce (100ms 稳定后才更新 visitedRanges)，
避免 PgDn 连按时每一步都触发无意义更新。

### 跨文件操作

| 操作                  | 影响的 Queue    | 处理逻辑                                                                    |
| --------------------- | --------------- | --------------------------------------------------------------------------- |
| **切换 Tab 到文件 B** | `visitedRanges` | 添加文件 B 光标位置 ±30 行                                                  |
|                       | `openedFiles`   | 文件 B 移到队列头部                                                         |
|                       | `importQueue`   | **后台异步**: 解析文件 B 全量 imports → gotoDefinition → push 定义 snippets |
|                       | `AST/cache`     | **后台异步**: 解析文件 B AST，供后续 rootPath 动态派生复用                  |
|                       | `editedRanges`  | **不变**（保留所有文件的最近编辑）                                          |
| **保存文件 A**        | `importQueue`   | **后台异步**: 刷新文件 A 的 import 定义（imports 可能变了）                 |
|                       | `AST/cache`     | **后台异步**: 刷新文件 A 的 AST / 相关缓存                                  |
|                       | 其他 queue      | 不变                                                                        |
| **关闭 Tab**          | `openedFiles`   | 移除该文件条目                                                              |
|                       | 其他 queue      | 该文件条目自然被 FIFO 淘汰，不主动清理                                      |
| **新建文件**          | 同切换 Tab      | 文件内容为空，import/AST 为空集                                             |

### 特殊操作

| 操作              | 影响的 Queue       | 处理逻辑                          |
| ----------------- | ------------------ | --------------------------------- |
| 复制文本          | clipboard (如启用) | 更新条目。默认 disabled           |
| Git commit/pull   | diff (如启用)      | 刷新 diff snippets。默认 disabled |
| IDE 窗口失焦/聚焦 | 无                 | 不影响 queue                      |

---

## 六、Debounce 后组装流程（零整理）

```
debounce 通过:
  ① 构建 prefix (光标前文本)                        ← ~5ms
  ② 构建 suffix (光标后文本)                        ← ~2ms
  ③ 计算 prefixTokens, suffixTokens                 ← ~5ms (唯一需要实时 tokenize 的)
  ④ snippetBudget = maxPromptTokens - prefixTokens - suffixTokens

  ⑤ 按比重分配各 queue budget:
     editedBudget   = snippetBudget * 0.25
     visitedBudget  = snippetBudget * 0.25
     openedBudget   = snippetBudget * 0.10
     importBudget   = snippetBudget * 0.15
     diffBudget     = snippetBudget * 0.10
     rootPathReserve = snippetBudget * 0.15

  ⑥ 从各 queue 取用 (每个 ~O(1)):
     editedSnippets   = editedRangesQueue.takeUpTo(editedBudget)
     visitedSnippets   = visitedRangesQueue.takeUpTo(visitedBudget)
     openedSnippets    = openedFilesQueue.takeUpTo(openedBudget)
     importSnippets    = importQueue.takeUpTo(importBudget)
     diffSnippets      = diffQueue.takeUpTo(diffBudget)

  ⑦ 若仍有结构预算，则从 AST/cache 动态派生 rootPath context:
     rootPathSnippets = getRootPathContextFromCache(rootPathReserve + leftover)

  ⑧ O(1) 格式化拼接:
     - 对每个 entry 做模型相关的模板包装 (~0.1ms/entry)
     - 拼接 prompt = formatted_snippets + prefix + suffix (FIM 模板)

  总耗时: ~15-25ms (prefix/suffix tokenize 主导)
```

**对比当前**: 当前 ⑤-⑦ 对应 `getAllSnippetsWithoutRace()` (0-200ms) + `getSnippets/filtering` (10-20ms) = 总计 10-220ms。新方案同样步骤仅 **~2-5ms**。

---

## 七、冷启动策略

### 核心原则

- IDE 打开后**什么都不做**（不预热，不用任何旧数据/缓存）
- 用户的修改意图不一定延续上次，上次的 AST 等信息不适用于本次
- 不退化到 prefix-only；但采用分层 readiness，避免因为 import/rootPath warming 阻塞全部补全
- 保证日常使用体验——正常工作流下 warming 几乎无感

### 时间线

```
IDE 打开
  → 什么都不做（所有 queue 为空）

用户首次打开文件 A (比如从文件树点击)
  → 同步 (即时):
    · visitedRanges queue: 光标位置 ±30 行 (document.getText, 零 IO)
    · openedFiles queue: 文件头部声明区 + 光标附近窗口
    · core-ready: edited/visited/opened 已可用于补全
  → 后台异步:
    · AST 解析 (~10-100ms)
    · Import 解析 + gotoDefinition (~100-300ms)
    · 填充 importQueue + AST/cache
  → 标记文件 A: "warming"

用户在 warming 期间输入
  → core-ready == true → 可以先出补全（visited/edited/opened 可用，import/rootPath 尚不完整）

queue 就绪 (warming 完成)
  → full-ready
  → 后续输入获得完整 import/rootPath 上下文
```

### warming 状态机

```
null → (用户打开文件) → core-ready + warming → full-ready
                                              ↓ (用户切走)
                                           保持缓存状态（自然淘汰）
```

### 典型 warming 延迟

| 场景                      | 预计延迟  | 用户感知                              |
| ------------------------- | --------- | ------------------------------------- |
| 打开小文件 (<500行)       | 100-200ms | 几乎无感（多数已 full-ready）         |
| 打开中型文件 (500-2000行) | 200-400ms | 首次输入可能为 core-ready 补全        |
| 打开大文件 (>2000行)      | 300-600ms | 前 1-2 次输入可能缺少 import/rootPath |
| 切回已 ready 的文件       | 0ms       | 即时可用（数据在内存中）              |

---

## 八、后台执行模型

### 核心原则：不阻塞 UI 线程

所有 queue push 操作 O(1) 同步完成，
push 前的数据准备（AST 解析、gotoDefinition）在后台异步执行：

```
VSCode 事件 → 事件处理器(同步, <1ms)
  ├─ visitedRanges: document.getText(range) → push → 完成 (<1ms, 零磁盘 IO)
  ├─ editedRanges: 更新范围元数据 → push → 完成 (<1ms)
  ├─ openedFiles: 提取文件头部声明区 + 光标附近窗口 → push → 完成 (<1ms, 零磁盘 IO)
  └─ import / AST-cache: 启动异步任务 → 任务完成后写入共享上下文层

异步 warming 任务:
  - 用 AbortController 管理生命周期
  - 切文件时取消前一文件的未完成 warming
  - 同一文件 300ms 内只启动一次（自带 debounce）
```

### 并发控制

- 最多 **1 个文件**的 warming 任务同时运行
- 新的 tab switch 取消上一个尚未完成的 warming（AbortController.abort()）
- gotoDefinition 调用复用已有的并发限制 (`MAX_PENDING_SNIPPET_REQUESTS=3`)
- warming 的 gotoDefinition 使用已有的 `GotoDefinitionCache`，热文件切回时接近零成本

---

## 九、涉及文件（按实施阶段）

### Phase 1: Queue 基础设施

| 文件                                        | 操作     | 说明                                                          |
| ------------------------------------------- | -------- | ------------------------------------------------------------- |
| `core/autocomplete/context/SnippetQueue.ts` | **新建** | 有界 token 容量 queue: push/takeUpTo/dedup/evict              |
| `core/autocomplete/context/QueueManager.ts` | **新建** | 共享上下文层：持有 queue、warming 状态机、readiness、缓存接口 |

### Phase 2: 事件驱动更新

| 文件                                                                 | 操作 | 说明                                                                             |
| -------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `extensions/vscode/src/autocomplete/completionProvider.ts`           | 修改 | 注册 `onDidChangeActiveTextEditor` / `onDidSaveTextDocument` 事件 → 触发 warming |
| `extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts` | 修改 | push 到 `visitedRangesQueue` 而非内部 LRU 缓存                                   |
| `extensions/vscode/src/autocomplete/recentlyEdited.ts`               | 修改 | push 到 `editedRangesQueue` 而非内部缓存                                         |
| `core/autocomplete/context/ImportDefinitionsService.ts`              | 修改 | 新增 `warmForFile(filepath, fileContent)` — 全文件 import 预解析                 |
| `core/autocomplete/util/ast.ts`                                      | 修改 | 复用已有 AST LRU，warming 时主动 parse 提高命中率                                |

### Phase 3: autocomplete 集成（V1）

| 文件                                           | 操作 | 说明                                                                             |
| ---------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `core/autocomplete/CompletionProvider.ts`      | 修改 | 替换 `getAllSnippetsWithoutRace` 主路径 → 共享上下文层 + readiness + prompt 组装 |
| `core/autocomplete/snippets/getAllSnippets.ts` | 弱化 | 不再作为 autocomplete 主路径，可保留作为 NextEdit / 参考实现                     |
| `core/autocomplete/templating/filtering.ts`    | 简化 | priority/budget/dedup 下放到 queue 机制，仅保留必要格式化与动态补充逻辑          |

### Phase 4: NextEdit 接入共享上下文层

| 文件                                                   | 操作 | 说明                                                                                    |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------- |
| `core/nextEdit/context/autocompleteContextFetching.ts` | 修改 | 从 QueueManager 共享上下文层获取 context，替换其当前的 `getAllSnippetsWithoutRace` 调用 |
| `core/nextEdit/NextEditProvider.ts`                    | 修改 | 接入共享上下文层，但保持 editable region / prefetch / jump / chain 逻辑不变             |

### Phase 5: HelperVars 轻量化 + rootPath Phase C 决策

| 文件                                                                    | 操作          | 说明                                                   |
| ----------------------------------------------------------------------- | ------------- | ------------------------------------------------------ |
| `core/autocomplete/util/HelperVars.ts`                                  | 修改          | AST 从 QueueManager 取缓存，file content 从内存取      |
| `core/autocomplete/context/root-path-context/RootPathContextService.ts` | 评估/可能修改 | Phase C 再决定保持动态派生，还是引入 rootPath queue 化 |

---

## 十、预期收益

| 指标                           | 当前          | 优化后          | 说明                                     |
| ------------------------------ | ------------- | --------------- | ---------------------------------------- |
| **contextCollectionMs (典型)** | 100-300ms     | **~15-25ms**    | 核心收益：消除 debounce 后的 LSP/IO 等待 |
| **contextCollectionMs (极端)** | 300ms+        | **~30ms**       | racePromise 不再被触发                   |
| HelperVars 初始化              | 40-200ms      | ~5-20ms         | AST 缓存命中率大幅提升                   |
| snippet 收集                   | 0-200ms       | **~1-2ms**      | 纯内存 queue.takeUpTo()                  |
| **端到端 (不含 LLM)**          | **150-500ms** | **~50-80ms**    |                                          |
| 后台 warming 开销              | 0             | 100-400ms/event | 非阻塞用户交互                           |

---

## 十一、验证计划

1. `[Autocomplete SubTimings]` 日志对比 `contextCollectionMs`: 目标 100-300ms → 15-25ms
2. warming 延迟测量: tab switch → queue ready 的时间
3. `core-ready` 时输入 → 确认可出补全，且不退化到 prefix-only
4. `full-ready` 后输入 → 确认补全正常且质量优于 core-ready
5. 快速连续 tab switch → 确认只有最后一个文件被 warming
6. 长时间使用 → 内存占用监控（queue 条目总量）
7. 生产 accept rate: 部署后 3 天窗口对比
8. IDE 重启 → 确认所有 queue 为空（不用旧数据）
9. NextEdit 接入后回归验证：editable region / prefetch / jump / chain 行为不退化
10. 多 IDE 验证：VS Code 与 PyCharm adapter 接入后事件语义一致

---

## 十二、不做的事

- **不落盘**: SQLite、文件缓存都不用，纯内存
- **不跨会话持久化**: IDE 重启 = 全部 queue 为空
- **冷启动不用旧数据**: 即使上次 IDE 关闭前有缓存也不恢复
- **不退化到 prefix-only**: 在 `core-ready` 下允许先出补全，但不回退到纯 prefix/suffix 补全
- **不在 debounce 后做 snippet 整理/过滤/dedup**: 全部前置到 push 时
- **不预绑定模型格式到 queue 内容**: 存原始代码，组装时 O(1) 格式化

---

## 十三、待进一步讨论

> 以下均为工程参数或二阶段优化候选，不属于架构方向争议。

1. **rootPath Phase C 决策门槛**: rootPath 动态派生在常见文件上中位耗时 <10ms、P95 <25ms 时，维持动态派生；若 P95 明显超出此范围且成为 debounce 后主耗时，进入 queue 化路线评估
2. **editedRanges 跨文件保留上限**: V1 默认最多保留最近 5 个存在编辑的文件，单文件内 FIFO 淘汰 + 2 分钟 staleTime（沿用已有逻辑）；若实际使用中 5 个偏多或偏少，按 telemetry 调整
3. **质量侧 Q1-Q4 二阶段优化**: 共享上下文层落地后的二阶段优化候选，V1 不做；待新架构稳定后重新测量收益再决定取舍

---

## 附录: 已有的可复用基础设施

| 组件                           | 位置                                           | 复用方式                                             |
| ------------------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| `RecentlyVisitedRangesService` | `extensions/vscode/src/autocomplete/`          | 已有光标追踪，改为 push 到 queue                     |
| `RecentlyEditedTracker`        | `extensions/vscode/src/autocomplete/`          | 已有编辑追踪，改为 push 到 queue                     |
| `GotoDefinitionCache`          | `core/autocomplete/context/`                   | 3min TTL, 500 条目，warming 直接复用                 |
| AST LRU 缓存                   | `core/autocomplete/util/ast.ts`                | 模块级 Map(20 文件, content-aware)，warming 主动填充 |
| `RootPathContextService` LRU   | `core/autocomplete/context/root-path-context/` | 100 条目 node hash 缓存                              |
| `openedFilesLruCache`          | `core/autocomplete/util/`                      | LRU(10) 追踪打开文件                                 |
| `document.getText(range)`      | VSCode API                                     | 零磁盘 IO，直接从编辑器内存读取                      |

---

## 十四、TODO

1. **将默认模式调整为 autocomplete**：安装 Continue 后，首次初始化不要再按模型能力默认启用 NextEdit；默认保持普通 autocomplete，仅在用户显式开启 `enableNextEdit` 后进入 NextEdit 模式。
