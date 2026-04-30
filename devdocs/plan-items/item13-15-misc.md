# 待实施：C 级功能 (#13-#15)

> 评估级别: C 级（锦上添花）
> 状态: ❌ 未开始（暂不优先）

---

## #13 笔记本编辑（Notebook）

**描述**: 支持在 Jupyter Notebook (.ipynb) 中使用 agent 能力

**现状**: Continue 已有基础的 notebook 上下文读取（`core/util/ipython.ts`），但 agent 无法在 notebook 单元格中编辑/执行代码

**竞品**: Cursor/Copilot 都支持 notebook inline 编辑

**核心挑战**:

- Notebook 文件结构（JSON cells）不同于普通文本文件，editFile tool 不能直接使用
- 需要实现 cell 级别的 diff 和 apply
- 需要 VS Code Notebook API 适配

**工作量**: ~300 行（低优先级，受众小）

---

## #14 浏览器自动化

**描述**: Agent 可以控制浏览器（截图、点击、填表、抓取内容）

**竞品**:

- Copilot: `open_browser_page`, `click_element`, `screenshot_page` 等完整浏览器工具集
- Claude Code: 通过 bash + Playwright 间接支持
- Cursor: preview 阶段

**实现路径**:

1. 集成 Playwright（`npm install playwright`）
2. 包装为 tool：`open_browser`, `click`, `screenshot`, `get_page_content`
3. 需要 VS Code extension host 侧管理浏览器生命周期

**工作量**: ~400 行（大工程，依赖 Playwright 构建体积增大 ~50MB）

**建议**: 当前可通过 `runTerminalCommand` + 用户自行安装 Playwright 间接实现。完整支持推迟到有专项需求时。

---

## #15 专用测试执行

**描述**: 专门的 `run_tests` tool，能捕获测试失败详情并返回给 agent

**竞品**: Copilot 有 `test_failure` tool，能精确返回哪个测试失败、失败原因

**现状**: Continue 可通过 `runTerminalCommand` 执行 `npm test` / `pytest` 等，但：

- 输出格式不统一（Jest/pytest/JUnit 等格式各异）
- 无结构化的测试失败解析
- 无"只重跑失败用例"的快捷方式

**实现路径**:

1. 新增 `run_tests` tool，接受 `testCommand` + 可选的 `filter` 参数
2. 解析主流测试框架输出（Jest/pytest/go test/cargo test）
3. 返回结构化的 `{ total, passed, failed, failedTests: [{name, error, file, line}] }`

**工作量**: ~200 行（中等工作量，但可先用 `runTerminalCommand` 替代）

---

## 优先级建议

```
#13 笔记本编辑  ← 仅当有大量 data science 用户需求时
#14 浏览器自动化 ← 等 Continue 其他能力完善后
#15 测试执行    ← 短期内用 runTerminalCommand 配合 persistentShell 替代
```
