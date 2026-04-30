# 详细方案：#1 getProblems 升级为 Agent Tool

> 评估日期: 2026-04-20
> 状态: ✅ 已完成（含 VS Code + IntelliJ 全栈）

## 现状分析

| 层级                         | VS Code                                | IntelliJ                                                | 说明                                |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| IDE 方法 `getProblems()`     | ✅ `vscode.languages.getDiagnostics()` | ✅ `DocumentMarkupModel.allHighlighters`                | 双端已完整实现                      |
| IPC 消息协议                 | ✅ `core/protocol/ide.ts`              | ✅ `IdeProtocolClient.kt`                               | 消息桥已通                          |
| `@problems` context provider | ✅ 可用                                | ❌ 被显式过滤（代码注释: "not supported in jetbrains"） | IntelliJ 底层有但 provider 层被禁用 |
| Agent Tool（模型主动调用）   | ❌ 不存在 → **✅ 已实现**              | ❌ 不存在 → **✅ 已实现**                               | 本次实现                            |

## 核心价值

1. **自动验证循环**：agent 改完代码后主动调用 → 发现编译错误 → 自动修复（当前是"盲改"）
2. **定向修 bug**：用户说"帮我修编译错误"→ agent 精准拿到 error message + 位置
3. **重构验证**：rename/重构后检查是否有遗漏引用导致的 type error
4. **竞品对标**：Copilot/Claude Code 中模型最频繁主动调用的 tool 之一

## 实现文件

**新增文件**:

- `core/tools/definitions/getProblems.ts` — Tool 定义，readonly，allowedWithoutPermission，可选 filepath 参数
- `core/tools/implementations/getProblems.ts` — 调用 `extras.ide.getProblems(filepath)`，按文件分组，输出 markdown 格式

**修改文件**:

- `core/tools/builtIn.ts` — 枚举新增 `GetProblems = "get_problems"`
- `core/tools/definitions/index.ts` — 导出 `getProblemsTool`
- `core/tools/callTool.ts` — 导入 `getProblemsImpl` + switch case
- `core/tools/index.ts` — 注册到 `getBaseToolDefinitions()`

## 实现方案（参考）

### Tool 参数定义

```json
{
  "name": "get_problems",
  "description": "Get compiler/linter errors and warnings. Call with no arguments to get all problems, or specify a filepath to get problems for a specific file. Use this after editing files to verify changes compile correctly.",
  "parameters": {
    "type": "object",
    "properties": {
      "filepath": {
        "type": "string",
        "description": "Optional. Absolute path to check for problems. If omitted, returns problems for all open files."
      }
    }
  }
}
```

### 实现逻辑

```typescript
// core/tools/implementations/getProblems.ts
export const getProblemsImpl: ToolImpl = async (args, extras) => {
  const { ide } = extras;
  const filepath = args.filepath as string | undefined;
  const problems = await ide.getProblems(filepath);

  if (problems.length === 0) {
    return [
      {
        name: "No Problems",
        description: "No errors or warnings found.",
        content: "No problems detected.",
      },
    ];
  }

  const formatted = problems
    .map(
      (p) =>
        `${p.filepath}:${p.range.start.line + 1}:${p.range.start.character} [${p.severity}] ${p.message}`,
    )
    .join("\n");

  return [
    {
      name: "Problems",
      description: `Found ${problems.length} problem(s)`,
      content: formatted,
    },
  ];
};
```

## 工作量

| 步骤          | 文件                                        | 改动量      |
| ------------- | ------------------------------------------- | ----------- |
| 枚举定义      | `core/tools/builtIn.ts`                     | +1 行       |
| Tool 实现     | `core/tools/implementations/getProblems.ts` | 新建 ~30 行 |
| 注册          | `core/tools/implementations/index.ts`       | +2 行       |
| 参数 schema   | tool 定义处                                 | ~15 行      |
| IntelliJ 解禁 | `core/config/loadContextProviders.ts`       | 删除 ~5 行  |
| **总计**      |                                             | **~50 行**  |

## 后续组合：验证循环

getProblems tool 完成后，可通过 system message / rules 实现自动验证循环：

```
After editing any file, always call getProblems to check for compilation errors.
If errors are found, fix them before proceeding to the next task.
```

这等效于 Copilot 的 `get_errors` tool 行为，无需额外代码。
