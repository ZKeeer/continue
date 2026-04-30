# 待实施：#11 Composer 多文件 Diff 预览

> 评估级别: B 级（高价值 + 高成本）
> 状态: 🔄 部分完成（V0.5 edit pending diff 非阻塞续流已落地）

## 背景

Cursor 的 Composer 是一等公民功能：agent 完成多文件修改后，展示所有更改的统一 diff 预览，用户可以：

- 一键接受/拒绝全部更改
- 逐文件审查 diff
- 回退特定文件的更改

Continue 目前通过 `ApplyManager` 逐文件显示内联 diff，缺少统一的多文件全览视图。

## 2026-04-30 状态更新

已完成 V0.5：edit tool 写入文件后，agent 不再阻塞等待用户 accept/reject 当前 diff。

实现细节：

- VS Code extension 发送 `ApplyState.status === "done"` 后，GUI 认为 edit tool call 已完成，可以继续 agent loop。
- diff 仍保留在 IDE pending review 状态；用户后续可以逐文件 accept/reject。
- 用户后续触发 `closed` 事件时，不再重复续流。
- 模型收到隐藏工具输出 `Edit Pending Review`，知道文件已编辑且 diff 仍待用户审查。

已覆盖文件：

- `gui/src/redux/thunks/handleApplyStateUpdate.ts`
- `gui/src/redux/thunks/handleApplyStateUpdate.test.ts`

V0.5 只解决“每次 edit 后阻塞等待 review”的执行流问题。它不是完整 Composer 多文件 diff 面板。

## 现有基础

- `gui/src/components/ApplyState.tsx` — 单文件 diff 展示组件
- `gui/src/redux/slices/editModeState.ts` — 编辑状态管理
- `extensions/vscode/src/diff/` — VS Code diff provider 实现

## 设计方向

### V1: 对话末尾汇总面板

状态：未开始。V0.5 已提供 pending diff 的非阻塞执行基础，V1 仍需新增 UI 汇总面板。

Agent 完成 session 后，在对话末尾展示一个折叠面板：

- 列出所有被修改的文件（文件名 + 行数变化）
- 点击文件名打开 VS Code 内建 diff 视图
- "Accept All" / "Reject All" 按钮

**技术方案**：

- 在 `streamNormalInput` 完成 agent loop 后，收集所有 editFile tool call 的 filepath
- dispatch 到 Redux store 的 `editedFiles` slice
- 在 `ChatMessage` 末尾渲染 `<EditedFilesPanel>` 组件

### V2: 实时多文件 diff 视图

Agent 运行期间，侧边栏展示实时 diff 状态（类 Cursor 体验）。工作量大，需独立 UI 面板。

## 工作量估算

| 组件                                    | 改动量      |
| --------------------------------------- | ----------- |
| editedFiles Redux slice                 | ~50 行      |
| EditedFilesPanel 组件                   | ~80 行      |
| streamNormalInput 中收集 editFile calls | ~20 行      |
| "Accept All" / "Reject All" 逻辑        | ~60 行      |
| **V1 总计**                             | **~210 行** |

## 依赖

- 需要 Redux store 中能追踪 agent session 期间的所有 editFile 操作。V0.5 目前只在 tool output 中记录单次 edit 的 pending review 事实，尚未形成 session 级 edited files slice。
- 需要 VS Code side 保留原始文件内容（用于 diff 计算）
