# Terminal、Agent Loop 与 Sub-Agent Runtime 实施记录

> 实施日期: 2026-04-30
> 状态: 已完成；原计划已从 `plan-items/` 归档
> 对应提交: `06b1acf0f stabilize terminal agent subagent runtime`

## 实现范围

本轮修正三个运行时契约：终端 shell/完成状态、agent 预算止损、sub-agent 模型选择与并行回收。

| 能力                              | 状态   | 核心实现                                                                                       |
| --------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Shell Runtime Contract            | 已完成 | `core/tools/implementations/shellRuntime.ts`、`core/tools/definitions/runTerminalCommand.ts`   |
| Terminal completion state machine | 已完成 | `persistentShell` 返回 `completionReason`；timeout / child-exit / child-error 有明确语义       |
| Terminal approval semantics       | 已完成 | `packages/terminal-security/src/evaluateTerminalCommandSecurity.ts` 按 tool-level policy 透传  |
| Agent iteration budget            | 已完成 | `gui/src/redux/thunks/agentBudget.ts`、`streamNormalInput.ts`；默认 200 轮，8h wall-clock 上限 |
| Sub-agent model enforcement       | 已完成 | `core/tools/implementations/subAgent.ts` 支持可选 `model` 和默认 subagent role 模型            |
| Sub-agent model context injection | 已完成 | `core/tools/definitions/subAgent.ts` 注入模型列表、默认项和 delegation rubric                  |
| Sub-agent parallel aggregation    | 已完成 | `callToolById` 支持 `deferContinuation`；同轮多个自动执行 tool call 只续流一次                 |
| Delegation rubric                 | 已完成 | sub-agent tool system description 增加委派规则和反例                                           |

## 当前代码口径

- Terminal 工具向模型暴露实际默认 shell 与语法提示，不再让模型误以为 Windows 命令默认 Bash。
- 持久 shell 区分 `marker`、`child-exit`、`child-error`、`timeout`、`idle-return`、`backgrounded` 等完成来源；timeout/protocol 失步后清理 shell。
- Terminal approval 的 `Automatic` 表示自动执行所有 command，`Ask First` 表示每次询问，`Excluded` 表示整个 tool 不暴露。
- Agent loop 使用单一可配置迭代预算，默认 200；超限时写入结构化 budget stop message 和 UI inline error。
- Sub-agent 模型选择顺序为：显式 `model`、`selectedModelByRole.subagent`、`modelsByRole.subagent[0]`、主 chat 模型 fallback。显式指定不存在模型时返回配置错误。
- 同轮多个 auto-approved tool call 使用并行执行 + 延迟 continuation 聚合，避免多个 continuation 竞态。

## 验证记录

实施时记录的目标验证：

| 命令                                                                                                            | 结果         |
| --------------------------------------------------------------------------------------------------------------- | ------------ |
| `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.vitest.ts --reporter=dot`         | 40/40 通过   |
| `npm.cmd --prefix core run vitest -- tools/implementations/runTerminalCommand.timeout.vitest.ts --reporter=dot` | 10/10 通过   |
| `npm.cmd --prefix packages/terminal-security run test -- test/terminalCommandSecurity.test.ts --reporter=dot`   | 8/8 通过     |
| `npm.cmd --prefix gui run test -- src/redux/thunks/streamNormalInput.budget.test.ts --reporter=dot`             | 3/3 通过统计 |
| `npm.cmd --prefix core run vitest -- tools/implementations/subAgent.vitest.ts --reporter=dot`                   | 7/7 通过     |
| `npm.cmd --prefix core run vitest -- config/yaml/models.vitest.ts --reporter=dot`                               | 8/8 通过     |
| `npm.cmd --prefix core run tsc:check`                                                                           | 通过         |
| `npm.cmd --prefix packages/terminal-security run build`                                                         | 通过         |
| `npm.cmd --prefix gui run tsc:check`                                                                            | 通过         |

历史记录中 `streamResponse_toolCalls.test.ts` 的失败集中在旧 action 序列预期与 S-1 plan gate 的前置状态不一致。该问题不再作为 item16 功能计划保留；如果需要继续处理，应作为 GUI thunk 测试维护项单独跟踪。

## 后续不在本项范围

- Terminal 产品化面板、长命令后台任务 UI。
- 完整 DAG 调度。
- Tool boundary checkpoint/resume。
