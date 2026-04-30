# 待实施：#8-roadmap Git 历史正式化

> 评估级别: A 级（高价值 + 中成本）
> 状态: ❌ 未开始

## 背景

`GitCommitContextProvider` 存在于代码库中，但已标记为 `deprecated`，文档中推荐使用 Git MCP 替代。

## 方案选项

### 选项 A: 复活 deprecated provider

- 文件: `core/context/providers/GitCommitContextProvider.ts`
- 工作量: ~50 行修改（取消废弃标记，修复 API 适配问题）
- 风险: 可能存在被废弃的原因（兼容性/性能问题）

### 选项 B: 接入 Git MCP（推荐）

- 在配置中启用 [mcp-server-git](https://github.com/modelcontextprotocol/servers/tree/main/src/git)
- Agent 通过 MCP tool call 访问 git log, blame, diff
- 工作量: 配置文档 + 集成测试，无代码改动

### 选项 C: 新建 git_history tool

- `core/tools/implementations/gitHistory.ts`
- 调用 `child_process.exec('git log --oneline -20')` 等
- 工作量: ~100 行

## 核心价值

- 了解最近变更历史（"上次谁改了这个文件"）
- 理解为何某段代码这样写（commit message 上下文）
- Agent 调试时可比较"改动前后"的差异

## 建议

优先走选项 B（Git MCP），工程量最小，维护成本最低。等 MCP 生态稳定后再决定是否内化为 core tool。
