# Terminal、Agent Loop 与 Sub-Agent Runtime 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正终端 shell 契约、终端完成状态、agent 轮次预算和 sub-agent 调度，让主 agent 更稳定、更少等待，并能按配置使用 sub-agent 模型。

**Architecture:** 以 runtime contract 为边界收敛改动：终端工具暴露实际执行 shell 与完成原因；agent loop 保留 `200` 次迭代预算和 `8h` wall-clock 上限；sub-agent 允许主模型从 `roles: [subagent]` 模型中显式选择模型，未指定时按配置默认选择，无 subagent 模型时 fallback 到主 chat 模型。并行 sub-agent 采用同轮 tool calls 聚合回收，避免多个 continuation 竞态。

**Tech Stack:** TypeScript, Redux Toolkit thunks, Continue Core tool system, VS Code / IntelliJ IDE bridge, Vitest.

---

## 实施进度

| 任务                                        | 状态     | 当前记录                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1: Shell Runtime Contract              | 已完成   | 新增共享 shell runtime helper；terminal tool schema 与执行路径共用 shell 信息；已运行 `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.vitest.ts --reporter=verbose`，40/40 通过。                                                                    |
| Task 2: Terminal completion state machine   | 已完成   | `persistentShell` 已返回 `completionReason`；hard timeout 为 5min，idle timeout 为 2min；timeout / child-exit / child-error 会清理持久 shell；已运行 `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.timeout.vitest.ts --reporter=dot`，10/10 通过。 |
| Task 3: Terminal approval semantics         | 已完成   | evaluator 已改为 tool-level base policy 透传：Automatic 执行所有 command，Ask First 询问所有 command，Excluded 仍排除整个 tool；已运行 `npm.cmd --prefix packages/terminal-security run test -- test/terminalCommandSecurity.test.ts --reporter=dot`，8/8 通过。                   |
| Task 4: Agent iteration budget              | 已完成   | UI `agent.maxBudgetIterations` 默认 200；新增 8h wall-clock 上限；设置页已增加 Agent Iteration Budget；已运行 `npm.cmd --prefix gui run test -- src/redux/thunks/streamNormalInput.budget.test.ts --reporter=dot`，3/3 通过统计。                                                  |
| Task 5: Sub-agent default model enforcement | 已完成   | sub-agent tool 增加可选 `model`；显式模型必须匹配 subagent role 模型；未指定时使用 `selectedModelByRole.subagent ?? modelsByRole.subagent[0]`；无 subagent 模型时 fallback 到主 chat 模型；结果包含 `Model Used`。                                                                 |
| Task 6: Sub-agent model context injection   | 已完成   | sub-agent tool 注入模型名称与默认项，并说明可选 `model` 参数；配置加载后默认选中第一个 subagent 模型；子 agent 使用主模型当前可见 tool definitions，旧客户端未传入时 fallback 到 config tools。                                                                                    |
| Task 7: Sub-agent parallel aggregation      | 已完成   | `callToolById` 支持 `deferContinuation`；同轮多个 auto-approved tool calls 先并行写结果，再由 `streamResponseAfterToolCall` 批量写入 tool messages 并只触发一次 continuation。                                                                                                     |
| Task 8: Delegation rubric                   | 已完成   | sub-agent tool system description 注入高 token / 弱上下文依赖优先委派规则，以及单文件小改、顺序依赖、不允许委派时的反例规则。                                                                                                                                                      |
| Task 9: Verification                        | 部分完成 | 目标 core / terminal-security / budget / sub-agent / model 配置测试已有通过统计；`streamResponse_toolCalls.test.ts` 当前仍失败，原因与现有 S-1 计划 gate 测试前置状态不匹配有关，见下方验证记录。                                                                                  |

## Agent 验证记录

| 命令                                                                                                            | 结果                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.vitest.ts --reporter=dot`         | 通过：1 个测试文件，40/40 tests；退出状态 0。                                                                                                                                                                                                                                   |
| `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.timeout.vitest.ts --reporter=dot` | 通过：1 个测试文件，10/10 tests；退出状态 0。                                                                                                                                                                                                                                   |
| `npm.cmd --prefix packages/terminal-security run test -- test/terminalCommandSecurity.test.ts --reporter=dot`   | 通过：1 个测试文件，8/8 tests；退出状态 0。                                                                                                                                                                                                                                     |
| `npm.cmd --prefix gui run test -- src/redux/thunks/streamNormalInput.budget.test.ts --reporter=dot`             | 输出统计通过：1 个测试文件，3/3 tests；该命令的外层捕获未稳定拿到退出码。                                                                                                                                                                                                       |
| `npm.cmd --prefix core run vitest -- tools/implementations/subAgent.vitest.ts --reporter=dot`                   | 通过：1 个测试文件，7/7 tests；退出状态 0。                                                                                                                                                                                                                                     |
| `npm.cmd --prefix core run vitest -- config/yaml/models.vitest.ts --reporter=dot`                               | 通过：1 个测试文件，8/8 tests；退出状态 0。                                                                                                                                                                                                                                     |
| `npm.cmd --prefix gui run test -- src/redux/thunks/streamResponse_toolCalls.test.ts --reporter=verbose`         | 未通过：1 个测试文件，4 passed / 3 failed。失败集中在旧 action 序列预期：当前代码已有 S-1 `hasPlanForCurrentRun` gate，top-level `streamNormalInput` 会新增 `session/setAgentRunStartTime` 并重置计划状态，导致这些旧测试的非 todo tool call 被 `No Task Plan Found` 路径拦截。 |
| 编辑器诊断检查                                                                                                  | 通过：本轮变更涉及的 core/gui/terminal-security 目标文件未发现编辑器诊断错误。                                                                                                                                                                                                  |
| `npm.cmd --prefix core run tsc:check`                                                                           | 通过：退出状态 0；未发现 TypeScript 错误。                                                                                                                                                                                                                                      |
| `npm.cmd --prefix packages/terminal-security run build`                                                         | 通过：退出状态 0；`tsc` 构建完成。                                                                                                                                                                                                                                              |
| `npm.cmd --prefix gui run tsc:check`                                                                            | 通过：退出状态 0；未发现 TypeScript 错误。                                                                                                                                                                                                                                      |

## 用户测试记录

| 功能项                                      | 测试通过 | 测试结果 | 测试命令 / 场景 | 记录时间 | 备注 |
| ------------------------------------------- | -------- | -------- | --------------- | -------- | ---- |
| Shell Runtime Contract                      |          |          |                 |          |      |
| Terminal completion state machine           |          |          |                 |          |      |
| Terminal approval semantics                 |          |          |                 |          |      |
| Agent iteration budget                      |          |          |                 |          |      |
| Sub-agent model selection                   |          |          |                 |          |      |
| Sub-agent model context / delegation rubric |          |          |                 |          |      |
| Sub-agent parallel aggregation              |          |          |                 |          |      |
| GUI tool-call approval / continuation flow  |          |          |                 |          |      |
| Build / packaging                           |          |          |                 |          |      |

---

## 背景

当前问题集中在三个运行时契约不清晰的地方。

1. `run_terminal_command` 没有稳定告诉主模型命令实际运行在哪个 shell。Windows 上实际可能是 PowerShell，模型却经常生成 Bash 语法，例如 `&&`、`export`、`source`。命令失败后，如果 tool schema 仍强制模型继续使用同一种写法，会阻碍主模型自我修正。
2. 终端命令的输出、退出、超时和仍在运行状态没有统一语义。用户观察到命令已经出现 `Command exited with code -1`，但主 agent 仍等到 120 秒后才看到 timeout。无论该文本来自子进程输出还是 runner 状态，都说明当前 tool result 交付模型过晚，agent 无法及时重试或换方案。
3. sub-agent 已经存在，但主模型缺少委派规则和 sub-agent 模型信息。`roles: [subagent]` 只把模型放入 `modelsByRole.subagent`，如果 `selectedModelByRole.subagent` 为空，当前实现可能退回 chat 模型，导致小模型 subagent 配置没有实际生效。

本计划不追求完整终端产品化，只修正影响主 agent 效率和可靠性的最小错误抽象。

## 已确认决策

### Shell Runtime Contract

- 向主模型显示当前默认执行 shell 和语法提示。
- 不写“必须使用 PowerShell”或“禁止 Bash 语法”这类硬性措辞。
- 文案使用“默认由 X 执行；优先使用 X 语法；如失败，可显式调用其他可用 shell/interpreter”的表达。
- tool schema 和实际执行 shell 必须来自同一个 `ShellRuntimeInfo`，避免提示与执行不一致。

### Terminal 状态机

- 终端 runner 必须返回完成来源：`marker`、`child-exit`、`child-error`、`timeout`、`idle-return`、`backgrounded`。
- 已确认 child exit 或 marker exit 后必须立即返回 tool result 给主 agent。
- hard timeout 为 `5min`，idle timeout 为 `2min`；timeout 或协议失步后必须保护主 agent：结束本次 tool call、清理或重建持久 shell，不让后续命令继承脏状态。
- 普通非 0 exit 只表示命令失败，不表示持久 shell 损坏。

### Terminal approval

- `Automatic` 的语义改为自动执行所有 command。
- `Ask First` 才表示每次都询问。
- `Excluded` 仍表示整个 tool 不暴露给模型；不新增 terminal command blocklist，也不新增 `Automatic All`。

### Agent iteration budget

- 删除独立 `BUDGET_ITERATIONS`。
- 保留一个可配置的 `MAX_BUDGET_ITERATIONS`，默认 `200`。
- 保留一个宽松 wall-clock 上限：`8h`。
- GUI 提供配置入口；配置值驱动 agent loop 停止条件。

### Sub-agent 模型选择

- sub-agent tool 增加可选 `model` 参数，由主 LLM 从支持 `subagent` role 的模型中选择。
- 如果主 LLM 显式指定模型，该模型必须匹配 subagent role 模型；否则返回明确配置错误。
- 如果未指定模型，优先使用 `selectedModelByRole.subagent`，否则使用配置顺序中的第一个 `modelsByRole.subagent[0]`。
- 如果没有 subagent role 模型，则 fallback 到主 chat 模型。

### Sub-agent model context

- 主模型需要知道 subagent 模型名称，并可通过 `model` 参数选择其中一个。
- 未传 `model` 时，实际模型选择由代码执行：`selectedModelByRole.subagent ?? modelsByRole.subagent[0] ?? chatModel`。
- 不新增 subagent 专属配置字段；先用现有 model name/model/provider/roles 注入说明。

### Sub-agent tool visibility

- 子 agent 使用主 LLM 当前可见的 tool definitions。
- GUI 通过 `tools/call` 可选传入 `availableTools`；core 只在收到该字段时缩小 `config.tools`。
- IntelliJ / 旧客户端未传入 `availableTools` 时，core fallback 使用现有 `config.tools`，保持协议兼容。
- `allowedTools` 只能进一步缩小可用工具范围，不能扩大到主 LLM 不可见的工具。

### Sub-agent 并行回收

- 同一轮多个 `sub_agent` tool call 应并行执行。
- 所有结果写入 history 后，只触发一次主 agent continuation。
- 先做最小原型和测试，不引入完整 DAG 调度。

### Delegation rubric

- 强化主 agent 何时使用 sub-agent 的规则。
- 规则进入 agent/system tool description，使主模型在开始多路线调查时主动委派。
- 如果消耗token量大，而且与主Agent无强上下文依赖关系，启用subagent不影响任务质量，优先用sub-agent实现 tool call或者任务。

---

## 文件结构

### Terminal runtime

- Create: `core/tools/implementations/shellRuntime.ts`
  - 定义 `ShellRuntimeInfo`、shell 语法提示和平台 fallback。
- Modify: `core/tools/definitions/runTerminalCommand.ts`
  - 更新 tool description 和 system message，显示默认 shell 语法提示。
- Modify: `core/tools/implementations/runTerminalCommand.ts`
  - 使用 `ShellRuntimeInfo` 选择执行 shell，返回执行模式和完成原因。
- Modify: `core/tools/implementations/persistentShell.ts`
  - 返回 completion reason；timeout/protocol error 后重建 shell。
- Test: `core/tools/implementations/runTerminalCommand.vitest.ts`
  - 覆盖 shell info、非 0 exit、timeout、approval policy。

### Tool approval

- Modify: `packages/terminal-security/src/evaluateTerminalCommandSecurity.ts`
  - tool-level base policy 透传；`allowedWithoutPermission` 下所有 command 自动执行，`allowedWithPermission` 下所有 command 询问。
- Modify: `gui/src/pages/config/components/ToolPolicyItem.tsx`
  - 保留 `Excluded`、`Ask First`、`Automatic` 三态可见，文案与行为一致。
- Test: `packages/terminal-security/test/terminalCommandSecurity.test.ts`
  - 覆盖 Automatic、Ask First、Disabled 的动态策略结果。

### Agent iteration budget

- Modify: `gui/src/redux/thunks/streamNormalInput.ts`
  - 删除 `BUDGET_ITERATIONS`；使用 GUI 配置中的 `maxBudgetIterations`，并保留 `8h` wall-clock 上限。
- Modify: `gui/src/redux/slices/uiSlice.ts`
  - 增加 `agent.maxBudgetIterations` 或等价字段，默认 `200`，随 UI state 持久化。
- Modify: `gui/src/pages/config/*`
  - 在 GUI 增加 Agent 迭代预算配置入口。
- Test: `gui/src/redux/thunks/streamResponse_toolCalls.test.ts`
  - 覆盖默认 200、自定义值和超限停止。

### Sub-agent runtime

- Modify: `core/tools/implementations/subAgent.ts`
  - 模型选择支持可选 `model`；未指定时为 `selectedModelByRole.subagent ?? modelsByRole.subagent[0] ?? chatModel`；显式指定不存在的 subagent 模型时返回配置错误。
  - tool result 输出实际使用模型。
- Modify: `core/tools/definitions/subAgent.ts`
  - 注入 subagent 模型名称、可选 `model` 参数说明和 delegation rubric。
- Modify: `core/protocol/core.ts`, `core/core.ts`, `gui/src/redux/thunks/callToolById.ts`
  - `tools/call` 增加可选 `availableTools`，用于向 core 传递主 LLM 当前可见工具；字段可选以兼容 IntelliJ / 旧客户端。
- Modify: `core/config/yaml/loadYaml.ts`
  - 配置加载后可将 `modelsByRole.subagent[0]` 作为默认选中值，保持 browser config 与 runtime 一致。
- Test: `core/tools/implementations/subAgent.vitest.ts`
  - 覆盖 selected model、默认第一个模型、无模型错误。

### Sub-agent parallel aggregation

- Modify: `gui/src/redux/thunks/callToolById.ts`
  - 增加 `deferContinuation` 参数，允许 tool 执行后先不触发 `streamResponseAfterToolCall`。
- Modify: `gui/src/redux/thunks/streamNormalInput.ts`
  - 对同一轮 auto-approved tool calls 并行执行；所有结果完成后只 continuation 一次。
- Modify: `gui/src/redux/thunks/streamResponseAfterToolCall.ts`
  - 支持从多个 tool result 之后恢复主 agent。
- Test: `gui/src/redux/thunks/streamResponse_toolCalls.test.ts`
  - 覆盖两个 sub-agent 同轮并行，只触发一次后续 stream。

---

## 第一批任务

### Task 1: Shell Runtime Contract

**Files:**

- Create: `core/tools/implementations/shellRuntime.ts`
- Modify: `core/tools/definitions/runTerminalCommand.ts`
- Modify: `core/tools/implementations/runTerminalCommand.ts`
- Test: `core/tools/implementations/runTerminalCommand.vitest.ts`

- [ ] **Step 1: 写 ShellRuntimeInfo 测试**

  覆盖 Windows PowerShell、Unix `$SHELL`、未知 shell fallback。期望输出包含 `shellType`、`shellPath`、`commandSeparator` 和 `syntaxHint`。

- [ ] **Step 2: 实现 `shellRuntime.ts`**

  只表达实际默认执行 shell，不做强制禁止。Windows 默认提示 PowerShell 语法，Unix 使用 `$SHELL`。

- [ ] **Step 3: 将 shell info 注入 terminal tool 描述**

  文案使用：默认由当前 shell 执行；优先使用该 shell 语法；如果失败，可显式调用其他可用 shell/interpreter。

- [ ] **Step 4: 运行测试**

  Run: `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.vitest.ts`

  Expected: shell runtime tests pass；原有 terminal tests 不回归。

### Task 2: Terminal completion state machine

**Files:**

- Modify: `core/tools/implementations/persistentShell.ts`
- Modify: `core/tools/implementations/runTerminalCommand.ts`
- Test: `core/tools/implementations/runTerminalCommand.timeout.vitest.ts`

- [ ] **Step 1: 写 completion reason 测试**

  覆盖 marker 正常结束、非 0 exit、child error、timeout。

- [ ] **Step 2: 返回结构化 completion reason**

  tool output 内容保留用户可读文本，同时内部结果带 `completionReason`、`exitCode`、`executionMode`。

- [ ] **Step 3: timeout 后保护主 agent**

  timeout 后结束本次 tool call；如果使用持久 shell，dispose 并从 map 移除，下次命令重建。

- [ ] **Step 4: 非 0 exit 不重建 shell**

  普通失败立即返回给主 agent，允许下一轮重试或换命令。

- [ ] **Step 5: 运行 timeout 测试**

  Run: `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.timeout.vitest.ts`

  Expected: timeout case 不挂住测试进程；非 0 exit 立即 resolve。

### Task 3: Terminal approval semantics

**Files:**

- Modify: `packages/terminal-security/src/evaluateTerminalCommandSecurity.ts`
- Modify: `gui/src/pages/config/components/ToolPolicyItem.tsx`
- Test: `packages/terminal-security/test/terminalCommandSecurity.test.ts`

- [ ] **Step 1: 写 Automatic 行为测试**

  当 base policy 是 `allowedWithoutPermission`，所有 command 返回 `allowedWithoutPermission`。

- [ ] **Step 2: 写 Ask First 行为测试**

  当 base policy 是 `allowedWithPermission`，所有 command 返回 `allowedWithPermission`。

- [ ] **Step 3: 调整 evaluator**

  tool-level base policy 透传；不再设置 per-command disabled。

- [ ] **Step 4: 检查 GUI 三态文案**

  UI 显示 `Automatic`、`Ask First`、`Excluded`，含义与执行一致。

### Task 4: Agent iteration budget

**Files:**

- Modify: `gui/src/redux/thunks/streamNormalInput.ts`
- Modify: `gui/src/redux/slices/uiSlice.ts`
- Modify: `gui/src/pages/config/*`
- Test: `gui/src/redux/thunks/streamResponse_toolCalls.test.ts`

- [ ] **Step 1: 写默认预算测试**

  未设置时，agent loop 使用 `200` 作为最大迭代数。

- [ ] **Step 2: 写自定义预算测试**

  GUI state 设置为 `20` 时，第 21 轮停止并写入明确的预算停止消息。

- [ ] **Step 3: 删除独立 `BUDGET_ITERATIONS`，保留 8h wall-clock 上限**

  保留 GUI `maxBudgetIterations` 数据源，并保留宽松 `8h` wall-clock 上限。

- [ ] **Step 4: 增加 GUI 配置入口**

  默认值 `200`；用户输入保存到 UI state。

---

## 第二批任务

### Task 5: Sub-agent default model enforcement

**Files:**

- Modify: `core/tools/implementations/subAgent.ts`
- Modify: `core/config/yaml/loadYaml.ts`
- Test: `core/tools/implementations/subAgent.vitest.ts`

- [ ] **Step 1: 写模型选择测试**

  覆盖显式 `model` 选择、`selectedModelByRole.subagent` 优先、`modelsByRole.subagent[0]` 默认、没有 subagent 模型时 fallback 到主 chat 模型、显式指定不存在模型时返回配置错误。

- [ ] **Step 2: 实现默认选择**

  使用显式 `model`，否则 `selectedModelByRole.subagent ?? modelsByRole.subagent[0] ?? chatModel`。

- [ ] **Step 3: 限制 silent chat fallback 场景**

  只有未显式指定 `model` 且没有 subagent role 模型时 fallback 到 chat 模型；显式指定不存在模型时返回 `Sub-Agent Configuration Error`。

- [ ] **Step 4: tool result 显示实际模型**

  在 result content 中输出 `Model Used: <title>`。

### Task 6: Sub-agent model context injection

**Files:**

- Modify: `core/tools/definitions/subAgent.ts`
- Modify: `core/config/yaml/loadYaml.ts`
- Test: `core/config/yaml/models.vitest.ts`

- [ ] **Step 1: 写模型 inventory 测试**

  配置两个 `roles: [subagent]` 模型时，sub-agent tool 描述包含两个模型名称，并标记默认第一个。

- [ ] **Step 2: 注入最小模型信息**

  注入 `title`、`model`、`provider`、默认项，并在 schema 中提供可选 `model` 字段。

- [ ] **Step 3: 允许主模型选择 subagent 模型**

  主模型可传 `model`；未传时代码按默认规则选择。

### Task 7: Sub-agent parallel aggregation

**Files:**

- Modify: `gui/src/redux/thunks/callToolById.ts`
- Modify: `gui/src/redux/thunks/streamNormalInput.ts`
- Modify: `gui/src/redux/thunks/streamResponseAfterToolCall.ts`
- Test: `gui/src/redux/thunks/streamResponse_toolCalls.test.ts`

- [ ] **Step 1: 写并行回收测试**

  模拟同一轮两个 `sub_agent` tool calls。期望：两个 `tools/call` 并发触发，两个结果都进入 history，只调用一次 continuation。

- [ ] **Step 2: 增加 `deferContinuation`**

  `callToolById` 支持只执行 tool 并写结果，不立即 `streamResponseAfterToolCall`。

- [ ] **Step 3: 聚合同轮 tool calls**

  `streamNormalInput` 等待 `Promise.all` 完成后，对最后一个或聚合 API 触发一次 continuation。

- [ ] **Step 4: 防止非 sub-agent 工具回归**

  对普通单 tool call 保持现有行为。

### Task 8: Delegation rubric

**Files:**

- Modify: `core/tools/definitions/subAgent.ts`
- Modify: `gui/src/redux/util/getBaseSystemMessage.ts`
- Test: `gui/src/redux/thunks/streamResponse_toolCalls.test.ts`

- [ ] **Step 1: 添加委派规则**

  主 agent 在多路线调查、读取 3 个以上不相关文件、独立验证、可并行任务时应优先使用 sub-agent。

- [ ] **Step 2: 添加不委派规则**

  单文件小改、明确顺序依赖、用户要求主 agent 自己处理时不委派。

- [ ] **Step 3: 测试 prompt 包含规则**

  编译后的 agent system message 包含 delegation rubric 和 sub-agent 模型名称。

---

## 验证命令

按任务分批运行：

```powershell
npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.vitest.ts
npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.timeout.vitest.ts
npm.cmd --prefix packages/terminal-security run test -- test/terminalCommandSecurity.test.ts
npm.cmd --prefix core run vitest -- tools/implementations/subAgent.vitest.ts
npm.cmd --prefix core run vitest -- config/yaml/models.vitest.ts
npm.cmd --prefix gui run test -- src/redux/thunks/streamResponse_toolCalls.test.ts
```

最终合并前运行：

```powershell
npm.cmd --prefix core run tsc:check
npm.cmd --prefix packages/terminal-security run build
npm.cmd --prefix gui run build
```

## 验收标准

- LLM 在 terminal tool 描述中能看到默认 shell 和语法提示。
- PowerShell、Bash、Zsh/Fish 场景不再出现提示 shell 与执行 shell 不一致。
- 命令非 0 exit 后主 agent 立即拿到结果，不再等待 timeout。
- hard timeout 5min 或 idle timeout 2min 后持久 shell 被清理或重建，后续命令不继承脏状态。
- Terminal 设置为 `Automatic` 时，所有 command 不再要求 accept。
- Agent 默认最大迭代预算为 200，且可在 GUI 中自定义；wall-clock 上限为 8h。
- sub-agent 可显式选择支持 `subagent` role 的模型；未指定时使用默认 subagent 模型；无 subagent 模型时 fallback 到主 chat 模型。
- 主 agent system message 能看到 sub-agent 模型名称、可选 `model` 参数和委派规则。
- 子 agent 使用主 LLM 当前可见 tool definitions；IntelliJ / 旧客户端未传 `availableTools` 时 fallback 到 `config.tools`。
- 同一轮多个 sub-agent 并行执行，结果全部进入 history 后只触发一次主 agent continuation。
