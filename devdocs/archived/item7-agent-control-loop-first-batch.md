# Agent 控制循环第一批实施记录

> 实施日期: 2026-04-22 至 2026-04-30
> 状态: 第一批已完成；后续 A/B 能力仍保留在 `plan-items/item7-agent-enhancement.md`

## 已完成范围

第一批目标是最小可用 agent 控制闭环：先计划、工具失败可恢复、改后验证、结果结构化、长任务止损。

| 项                                | 状态   | 实现口径                                                                                              | 核心文件                                                                       |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| S-3 Sub-agent 结构化结果协议 v2   | 已完成 | 输出 Status、Summary、Evidence、Files Modified、Verification、Failure Reason、Next Recommended Action | `core/tools/implementations/subAgent.ts`、`core/tools/definitions/subAgent.ts` |
| S-5 + A-7 瞬时错误重试 + 失败分类 | 已完成 | transient 自动退避重试；permission/permanent 反馈模型修正；错误输出带 failure class                   | `gui/src/util/toolRetry.ts`、`gui/src/redux/thunks/callToolById.ts`            |
| S-4 编辑后强制验证门              | 已完成 | edit tool 成功后自动调用 `get_problems`，验证结果进入同一 tool output turn                            | `gui/src/redux/thunks/callToolById.ts`                                         |
| S-1a 计划执行边界拦截             | 已完成 | 当前 agent run 未创建 todo 时，首个非 `manage_todo_list` tool call 被拦截并回注补计划提示             | `gui/src/redux/thunks/callToolById.ts`、`gui/src/redux/slices/sessionSlice.ts` |
| S-2a 预算止损                     | 已完成 | 默认 200 轮 + 8h wall-clock；超限写入结构化 budget stop message                                       | `gui/src/redux/thunks/agentBudget.ts`、`streamNormalInput.ts`、`uiSlice.ts`    |

## 当前行为

- `hasPlanForCurrentRun` 在 agent run 开始时重置，防止旧会话计划绕过当前任务 gate。
- transient retry 在 core tool IPC error 和 structured tool error 两条路径上生效。
- 编辑后验证是 runtime gate，不依赖模型是否主动调用验证工具。
- budget stop 会保留 todo 进度、耗时、迭代数和建议下一步，便于用户接续。
- sub-agent 结果的失败态和未完成态可由父 agent 读取，不再只能读自由文本。

## 不在第一批范围

- S-1b 步骤归属全链路传播。
- S-2b phase-aware whitelist / 阶段状态机。
- A-6 Tool 边界 checkpoint/resume。
- A-8 主 agent 证据化结果卡片。
- A-9 完整执行树与步骤面板。
- A-10 仓库级验证画像与模板。
- B-11 并行子任务 DAG 调度。
- B-12 运行回放与差异审阅面板。
