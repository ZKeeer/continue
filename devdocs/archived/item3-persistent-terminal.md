# 详细方案：#3 终端持久化会话

> 评估日期: 2026-04-20
> 状态: ✅ 已完成

## 问题分析

当前 `runTerminalCommand` **每次调用 spawn 一个全新 shell 子进程**，命令执行完进程退出。工具描述中明确写了：

> "The shell is not stateful and will not remember any previous commands."
> — `core/tools/definitions/runTerminalCommand.ts`

**具体表现**：

- `cd /some/dir` → 下一次调用又回到默认目录
- `export MY_VAR=foo` → 下一次调用变量丢失
- `source venv/bin/activate` → 下一次调用 venv 未激活

## 实现文件

**新增文件**:

- `core/tools/implementations/persistentShell.ts` — `PersistentShell` 类
  - 通过 `child_process.spawn` 创建持久化 shell（Windows: powershell, Unix: $SHELL）
  - 基于 marker 的命令输出检测
  - 120s 命令超时
  - Session 级别单例模式（Map by cwd）
  - 支持 streaming output 回调

**修改文件**:

- `core/tools/implementations/runTerminalCommand.ts` — 当 `waitForCompletion && extras.onPartialOutput` 时优先使用持久化 shell 路径，失败时 fallback 到传统 spawn

## 架构设计

```
┌────────────────────────────────────────────────┐
│  TerminalSessionManager (extension host 侧)     │
│  ├─ sessions: Map<sessionId, PTYSession>        │
│  │   └─ PTYSession {                            │
│  │       pty: node-pty.IPty                     │
│  │       outputBuffer: string[]                 │
│  │       lastActivity: timestamp                │
│  │       cwd: string                            │
│  │   }                                          │
│  ├─ createSession(cwd?) → sessionId             │
│  ├─ sendCommand(sessionId, cmd) → output        │
│  ├─ getOutput(sessionId, since?) → output       │
│  └─ destroySession(sessionId)                   │
└────────────────────────────────────────────────┘
```

## PersistentShell 实现骨架

```typescript
export class TerminalSessionManager {
  private sessions = new Map<string, PTYSession>();

  getOrCreateSession(sessionId = DEFAULT_SESSION, cwd?: string): PTYSession {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/bash";
    const ptyProcess = pty.spawn(shell, [], {
      cwd: cwd || process.cwd(),
      cols: 120,
      rows: 30,
    });
    // ...
  }

  async sendCommand(
    sessionId: string,
    command: string,
    timeout = 120_000,
  ): Promise<string> {
    const session = this.getOrCreateSession(sessionId);
    const marker = `__CMD_DONE_${Date.now()}__`;
    session.pty.write(`${command}; echo ${marker}\r`);
    // 等待 marker 出现或超时
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(session.outputBuffer.slice(startLen)),
        timeout,
      );
      const check = setInterval(() => {
        if (session.outputBuffer.includes(marker)) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(/* output between startLen and marker */);
        }
      }, 100);
    });
  }
}
```

## 难点与解决方案

| 难点                         | 解决方案                                                |
| ---------------------------- | ------------------------------------------------------- |
| node-pty 在某些环境编译失败  | 设为可选依赖，编译失败时 fallback 到原有 spawn 逻辑     |
| 输出分割（区分本次 vs 历史） | 用唯一 marker（`__CMD_DONE_<timestamp>__`）标记命令结束 |
| PTY 输出含 ANSI 转义码       | `strip-ansi` 库清理后返回纯文本                         |
| session 泄漏                 | idle 超时 + VS Code `onDidCloseTerminal` 事件清理       |

## 竞品对比

| 能力         | Copilot                           | Claude Code         | Continue 当前     |
| ------------ | --------------------------------- | ------------------- | ----------------- |
| 有状态 shell | ✅ PTY session + send_to_terminal | ✅ bash tool 持久化 | ✅ 已实现         |
| 后台进程管理 | ✅ async mode                     | ⚠️ 手动 & + 检查    | ⚠️ GUI 有简陋标记 |
| 交互式输入   | ✅ send_to_terminal               | ⚠️ 有限             | ❌ 无 stdin       |

## 工作量

| 组件                      | 改动量      |
| ------------------------- | ----------- |
| TerminalSessionManager 类 | ~120 行     |
| runTerminalCommand 适配   | ~40 行      |
| IDE 接口 + messenger 路由 | ~30 行      |
| 工具描述更新              | ~10 行      |
| **V1 总计**               | **~200 行** |
