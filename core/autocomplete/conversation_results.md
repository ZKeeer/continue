# GPT 5.4 × Opus 4.6 对话共识结论

> 生成日期：2026-03-24
> 讨论对象：Continue v1.3.19 zkdev 分支 autocomplete 优化方案
> 讨论轮次：Round 1 + Round 2，共 2 轮后全部收敛

---

## Round 1 共识（已实现方案审查）

### 1. 总体评价

zkdev 分支的方案在方向判断和生产取舍上是靠谱的。需要修正的是：文档中几处过时描述，以及后续优先级应从"大而全的行业对标"收缩到"先修 cache/IO/token/结构上下文"这四个更便宜、更确定见效的点。

### 2. 速度方向建议（按优先级）

| #   | 行动                                                                      | 状态                       |
| --- | ------------------------------------------------------------------------- | -------------------------- |
| 1   | 消掉 `selection change → readFile(full file)` 热 IO                       | **Round 2 已给出具体方案** |
| 2   | 给 `countTokens()` 做请求级 memoization                                   | 待实施                     |
| 3   | 给 AST / tree path 做短生命周期缓存                                       | 待实施                     |
| 4   | 做 `n=2` 低温候选 + 轻量 reranker 实验（不要直接上 speculative decoding） | 待实施                     |

### 3. 稳定性方向建议

| #   | 行动                                                            | 状态                      |
| --- | --------------------------------------------------------------- | ------------------------- |
| 1   | cache key 升级为 suffix-aware，不只看 prefix                    | **Round 1 Review 已修复** |
| 2   | 不要在共享 llm 对象上原地改写 completionOptions                 | **Round 1 Review 已修复** |
| 3   | snippet 并发限制应做 source-level 隔离，不是全局 hard gate      | **Round 1 Review 已修复** |
| 4   | GotoDefinitionCache 只允许停留在 snippet context 层，不继续扩散 | **已约束**                |

### 4. 质量方向建议

| #   | 行动                                                                            | 状态                       |
| --- | ------------------------------------------------------------------------------- | -------------------------- |
| 1   | 给 base 结构上下文保底 token 预算                                               | **Round 2 详细方案已定**   |
| 2   | 重新评估 snippet source annotation 成本与收益                                   | **Round 2 结论：默认关闭** |
| 3   | 用"半语义启发式"替代 embedding（测试/实现对、同目录 siblings、import 相关文件） | 待实施                     |
| 4   | 把 accept/reject 数据做配置闭环（不必等 RL，先做策略闭环）                      | 待实施                     |

### 5. 差距项判断

| 差距项                      | 共识判断                                           |
| --------------------------- | -------------------------------------------------- |
| 无 speculative / 多候选排序 | 成立，但不排最前；更适合低成本 n=2 实测            |
| 默认上下文窗口太小          | 已修复（1024→4096），不再是差距                    |
| 无语义检索                  | 成立，但不建议直接跳 embedding；用半语义启发式替代 |
| NextEdit 未融入 Tab         | 成立，产品体验层问题                               |
| 无反馈闭环                  | 成立，适合做配置/策略闭环而非 RL                   |
| 无 streaming ghost text     | 成立，但优先级低，暂不投入                         |
| 无跨文件编辑预测            | 成立，与 agent 重叠度高，暂缓合理                  |
| 无模型路由                  | 成立，现阶段不值得做                               |

---

## Round 2 共识（最新 3 次提交审查）

### 审查对象

- `08f88efbc` — 上下文关联性优化：snippet 优先级重排 + maxPromptTokens 1024→4096 + Tab+光标融合
- `f7a250d6d` — numSurroundingLines 20→30, editedRanges+visitedRanges 同文件互补去重
- `b488e70d0` — snippet source annotation（每个 snippet 头部加语言感知注释标注来源）

### 共识 #1：snippet source annotation — 默认关闭

**结论**：annotation 思路未经证实，应降为实验功能，默认关闭。

**GPT 5.4 理由**：

- 模型未被训练识别 `// recent edit` 等人为标注格式
- 对短 snippet 而言，一行注释的 token 边际成本不小
- 人为把"任务说明"嵌入代码 snippet 内部，噪音确定注入但收益不确定

**Opus 4.6 补充**：

- 15 个 snippet × 5-15 token/注释 ≈ 75-225 token（4096 预算的 ~2-5%）
- 部分加、部分不加（收缩策略）不如统一关闭干净 — 避免模型看到不一致的标注模式
- 等有离线评测（如 HumanEval infilling pass rate 对比）再考虑开启

**行动**：

```
1. 给 annotateSnippetSource 加 experimental_snippetAnnotation flag，默认 false
2. 保留代码但不默认执行
3. 后续通过离线评测验证效果后再决定是否开启
```

### 共识 #2：优先级重排方向正确，需加 base 保底预算

**结论**：editedRanges(1) > visitedRanges(2) > openedFiles(3) 的重排方向成立，但必须给 base（import/rootPath/static）留最低 token 保底。

**共识分析**：

- 编辑 > 光标 > Tab 的优先级排序反映真实的任务相关性
- 但 base priority=99 在 token 紧张时会导致结构信号（定义、类型、接口）被系统性饿死
- 尤其在 TS/Java/Python 强类型项目中，缺失定义上下文会显著降低补全质量

**行动**：

```typescript
// 在 getSnippets() 循环前：
const totalSnippetBudget = getRemainingTokenCount(helper);
const BASE_FLOOR_RATIO = 0.15; // 15% ≈ 614 token @ 4096 budget
const baseFloor = Math.floor(totalSnippetBudget * BASE_FLOOR_RATIO);

// 循环中 key !== "base" 时，限制总消耗不超过 totalSnippetBudget - baseFloor
// 确保 base 至少拿到 baseFloor token
```

### 共识 #3：visitedRanges 核心修复 = readFile → document.getText(range)

**结论**：30 行窗口本身不是问题，真正问题是每次 selection change 时做全文件 IO。修复采集方式后，30 行可保留。

**GPT 5.4 分析**：

- 贵的不是 "30 行"，而是"为了取 30 行先把整文件读一遍再 split 再 slice"
- 叠加 maxRecentFiles=5 × maxSnippetsPerFile=3，高频光标移动时持续刷新大量快照
- 真正有效信息密度不一定因此提高

**Opus 4.6 具体方案**：

```typescript
// 当前（需修改）：
const fileContents = await this.ide.readFile(filepath);
const lines = fileContents.split("\n");
const relevantLines = lines
  .slice(startLine, endLine + 1)
  .join("\n")
  .trim();

// 修改为（零磁盘 IO）：
const range = new vscode.Range(
  startLine,
  0,
  endLine,
  event.textEditor.document.lineAt(endLine).text.length,
);
const relevantLines = event.textEditor.document.getText(range).trim();
```

**优势**：零磁盘 IO（直接读内存文档模型）、零全文解析、行号实时同步。

### 共识 #4：同文件互补方向正确，需升级到 overlap-aware dedup

**结论**：允许 editedRanges + visitedRanges 同文件共存是正确方向，不应回退为同文件互斥。但当前仅做 filepath-level dedup 不够精细，需要引入行范围元数据和重叠检测。

**当前问题**：

- 只检查 `editedRangesFilepaths.has(snippet.filepath)` 来放行
- 不检查行范围重叠 — 最坏情况 edited 100-130 行 + visited 90-150 行有 30 行完全重复

**行动**：

```
1. 扩展 AutocompleteCodeSnippet 类型，增加 startLine / endLine 字段
2. editedRanges 处理时记录每个文件的已覆盖行范围
3. visitedRanges 处理时计算与已覆盖范围的重叠比例：
   - 重叠 > 50% → 跳过
   - 重叠 ≤ 50% → 保留（或仅保留非重叠部分）
```

---

## 执行优先级排序

按"成本低 × 收益确定"排列：

| 优先级 | 行动                               | 类型 | 预期效果                            |
| ------ | ---------------------------------- | ---- | ----------------------------------- |
| P0     | annotation 加 flag 默认关闭        | 质量 | 节省 ~2-5% token 预算               |
| P0     | readFile → document.getText(range) | 速度 | 消除 selection change 上的全文件 IO |
| P1     | base 加 15% token floor            | 质量 | 防止结构上下文被饿死                |
| P1     | overlap-aware dedup                | 质量 | 减少 edited+visited 冗余            |
| P2     | countTokens() 请求级 memoization   | 速度 | 减少重复 tokenize 开销              |
| P2     | AST/tree path 短生命周期缓存       | 速度 | 减少重复 parse 开销                 |
| P3     | n=2 多候选 + 轻量 reranker 实验    | 质量 | 提升 top-1 命中率                   |
| P3     | 半语义启发式（测试↔实现对等）     | 质量 | 无 embedding 成本的上下文增强       |
| P4     | accept/reject 配置闭环             | 质量 | 数据驱动的策略调优                  |

---

## 对话状态

- **Round 1**：✅ 达成一致，无遗留分歧
- **Round 2**：✅ 达成一致，无遗留分歧
- **对话结束**：GPT 5.4 和 Opus 4.6 双方确认所有议题已收敛
