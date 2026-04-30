# Sub-Agent Runtime 增强实施记录

> 实施日期: 2026-04-22 至 2026-04-30
> 状态: 已完成；原 `plan-items/item7-subagent-enhancement.md` 已归档
> 对应提交: `06b1acf0f stabilize terminal agent subagent runtime`、`a0b8f4b8b stabilize reasoning history and subagent routing`

## 已完成能力

| 能力                         | 状态   | 核心文件                                                                                |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------- |
| Sub-agent role 模型选择      | 已完成 | `core/tools/implementations/subAgent.ts`                                                |
| 可选 `model` 参数            | 已完成 | `core/tools/definitions/subAgent.ts`、`core/tools/implementations/subAgent.ts`          |
| 5 分钟 wall-clock 超时       | 已完成 | `core/tools/implementations/subAgent.ts`                                                |
| 工作区路径注入               | 已完成 | `core/tools/implementations/subAgent.ts`                                                |
| `allowedTools` 白名单        | 已完成 | `core/tools/definitions/subAgent.ts`、`core/tools/implementations/subAgent.ts`          |
| 结构化 V2 结果协议           | 已完成 | `parseStructuredResult`、`buildResultContent`                                           |
| Incomplete / Failed 状态区分 | 已完成 | max-iteration 和 timeout 路径均合成 V2 结果                                             |
| Files Modified 统计          | 已完成 | `EditExistingFile`、`CreateNewFile`、`MultiEdit`、`SingleFindAndReplace`                |
| 运行中进度摘要               | 已完成 | onPartialOutput 输出 `tool_name(key_param=value)`                                       |
| 执行层保底路由               | 已完成 | `gui/src/redux/thunks/subAgentToolRouter.ts`、`callToolById.ts`、`streamNormalInput.ts` |

## 执行层保底路由

`sub_agent` 不再作为普通 function 暴露给主模型竞争。主模型仍选择原始探索类工具；GUI 在执行边界确定性包装为 `sub_agent`。

当前路由白名单：

- `grep_search`
- `file_glob_search`
- `codebase`
- `get_problems`
- `view_repo_map`
- `view_subdirectory`

包装后的子 agent 只获得原始工具和可用时的 `manage_todo_list`，避免无关写工具进入执行面。

## Review 跟进结果

2026-04-22 review 中列出的 5 条问题已按最小改法落地或由后续实现覆盖：

| Review 项                                     | 当前状态                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Apply fallback 选区编辑按整文件 diff          | 已修正：`ApplyManager.ts` 在 fallback 中按选区拼回完整文件后再做 Myers diff                    |
| OpenAI tool call `index` 与过滤后数组下标串错 | 已修正：`sessionSlice.ts` 保存 `providerIndex`，后续无 id delta 按原始 provider index 匹配     |
| Sub-agent max iteration 仍标记 Completed      | 已修正：max iteration 输出 `Sub-Agent Incomplete`，V2 failureReason/nextRecommendedAction 齐全 |
| Files Modified 漏 `SingleFindAndReplace`      | 已修正：`FILE_WRITE_TOOLS` 包含 `SingleFindAndReplace`                                         |
| GUI 可见性只有工具名列表                      | 已降级并实现基础可见性：运行中显示工具名 + 关键参数摘要；完整执行树仍属于后续 A-9              |

## 仍属于后续路线图

- 完整执行树与步骤面板。
- 主 agent / sub-agent 统一证据卡片。
- 并行子任务 DAG 调度。
- Tool boundary checkpoint/resume。
