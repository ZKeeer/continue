/**
 * PersistentShell — maintains a long-running shell process for session-level
 * command persistence (cwd, env vars, shell state preserved across calls).
 */
import * as childProcess from "child_process";
import * as os from "os";
import { getShellRuntimeInfo } from "./shellRuntime";

const MARKER_PREFIX = "__CONTINUE_CMD_";
const HARD_TIMEOUT_MS = 300_000;
const IDLE_TIMEOUT_MS = 120_000;

export type TerminalCompletionReason =
  | "marker"
  | "child-exit"
  | "child-error"
  | "timeout"
  | "hard-timeout"
  | "idle-timeout"
  | "idle-return"
  | "backgrounded";

export interface CommandResult {
  output: string;
  exitCode: number;
  completionReason: TerminalCompletionReason;
}

type OnOutputCallback = (chunk: string) => void;

export class PersistentShell {
  private proc: childProcess.ChildProcess | null = null;
  private buffer = "";
  private pendingResolve: ((result: CommandResult) => void) | null = null;
  private currentMarker = "";
  private _cwd: string;
  private _isAlive = false;
  private onOutputCallback: OnOutputCallback | null = null;
  private refreshIdleTimeout: (() => void) | null = null;

  constructor(cwd?: string) {
    this._cwd = cwd || os.homedir();
  }

  get isAlive(): boolean {
    return this._isAlive;
  }

  get cwd(): string {
    return this._cwd;
  }

  /**
   * Start the persistent shell process.
   */
  start(): void {
    if (this._isAlive) return;

    const runtimeInfo = getShellRuntimeInfo();
    const isWindows = runtimeInfo.platform === "win32";
    const shell = runtimeInfo.shellPath;
    const args = isWindows ? ["-NoLogo", "-NoProfile", "-NonInteractive"] : [];

    this.proc = childProcess.spawn(shell, args, {
      cwd: this._cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "1",
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this._isAlive = true;

    this.proc.stdout?.on("data", (data: Buffer) => {
      this.onData(data.toString("utf8"));
    });

    this.proc.stderr?.on("data", (data: Buffer) => {
      this.onData(data.toString("utf8"));
    });

    this.proc.on("exit", () => {
      this._isAlive = false;
      if (this.pendingResolve) {
        this.pendingResolve({
          output: this.buffer,
          exitCode: -1,
          completionReason: "child-exit",
        });
      }
    });

    this.proc.on("error", (error) => {
      this._isAlive = false;
      if (this.pendingResolve) {
        this.pendingResolve({
          output: `${this.buffer}\n[Shell error: ${error.message}]`.trim(),
          exitCode: -1,
          completionReason: "child-error",
        });
      }
    });
  }

  /**
   * Run a command in the persistent shell.
   * Returns the output and exit code.
   * @param onOutput - Optional callback for streaming output chunks.
   */
  async runCommand(
    command: string,
    onOutput?: OnOutputCallback,
  ): Promise<CommandResult> {
    if (!this._isAlive || !this.proc?.stdin) {
      this.start();
    }

    if (!this.proc?.stdin) {
      throw new Error("Failed to start persistent shell");
    }

    return new Promise<CommandResult>((resolve) => {
      const marker = `${MARKER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.currentMarker = marker;
      this.buffer = "";
      this.onOutputCallback = onOutput || null;

      const isWindows = os.platform() === "win32";

      // Wrap command with exit code capture and end marker
      let wrappedCommand: string;
      if (isWindows) {
        wrappedCommand = `${command}\n$__ec = $LASTEXITCODE; if ($null -eq $__ec) { $__ec = 0 }; Write-Host "${marker}_EXIT_$__ec"\n`;
      } else {
        wrappedCommand = `${command}\necho "${marker}_EXIT_$?"\n`;
      }

      let hardTimeout: ReturnType<typeof setTimeout> | undefined;
      let idleTimeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: CommandResult) => {
        if (hardTimeout) {
          clearTimeout(hardTimeout);
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }
        this.pendingResolve = null;
        this.onOutputCallback = null;
        this.refreshIdleTimeout = null;
        resolve(result);
      };

      const finishTimeout = (
        completionReason: "hard-timeout" | "idle-timeout",
        message: string,
      ) => {
        if (this.pendingResolve) {
          this.pendingResolve({
            output: this.buffer + message,
            exitCode: -1,
            completionReason,
          });
          this.dispose();
        }
      };

      const resetIdleTimeout = () => {
        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }
        idleTimeout = setTimeout(() => {
          finishTimeout(
            "idle-timeout",
            "\n[No output for 120s; command killed]",
          );
        }, IDLE_TIMEOUT_MS);
      };

      this.pendingResolve = finish;
      this.refreshIdleTimeout = resetIdleTimeout;

      hardTimeout = setTimeout(() => {
        finishTimeout("hard-timeout", "\n[Command timed out after 300s]");
      }, HARD_TIMEOUT_MS);
      resetIdleTimeout();

      this.proc!.stdin!.write(wrappedCommand);
    });
  }

  /**
   * Kill the persistent shell.
   */
  dispose(): void {
    if (this.proc) {
      if (typeof this.proc.stdin?.destroy === "function") {
        this.proc.stdin.destroy();
      }
      if (typeof this.proc.stdout?.destroy === "function") {
        this.proc.stdout.destroy();
      }
      if (typeof this.proc.stderr?.destroy === "function") {
        this.proc.stderr.destroy();
      }
      this.proc.kill();
      this.proc.unref?.();
      this.proc = null;
    }
    this.pendingResolve = null;
    this.onOutputCallback = null;
    this.refreshIdleTimeout = null;
    this._isAlive = false;
  }

  private onData(data: string): void {
    if (!this.pendingResolve) return;

    this.buffer += data;
    this.refreshIdleTimeout?.();

    // Stream partial output (excluding marker lines)
    if (this.onOutputCallback) {
      const cleanChunk = data
        .split("\n")
        .filter((line) => !line.includes(this.currentMarker))
        .join("\n");
      if (cleanChunk.trim()) {
        this.onOutputCallback(cleanChunk);
      }
    }

    // Check for the end marker
    const markerPattern = `${this.currentMarker}_EXIT_`;
    const markerIndex = this.buffer.indexOf(markerPattern);

    if (markerIndex !== -1) {
      const afterMarker = this.buffer.slice(markerIndex + markerPattern.length);
      const exitCodeMatch = afterMarker.match(/^(-?\d+)/);
      const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

      // Extract output before the marker line
      const outputBeforeMarker = this.buffer.slice(0, markerIndex);
      // Remove lines that contain our marker
      const lines = outputBeforeMarker.split("\n");
      const cleanOutput = lines
        .filter((line) => !line.includes(this.currentMarker))
        .join("\n")
        .trim();

      this.pendingResolve({
        output: cleanOutput,
        exitCode,
        completionReason: "marker",
      });
    }
  }
}

// Session-level singleton per workspace
const shellInstances = new Map<string, PersistentShell>();

export function getSessionShell(cwd?: string): PersistentShell {
  const key = cwd || "__default__";
  let shell = shellInstances.get(key);
  if (!shell || !shell.isAlive) {
    shell = new PersistentShell(cwd);
    shell.start();
    shellInstances.set(key, shell);
  }
  return shell;
}

export function disposeSessionShell(cwd?: string): void {
  const key = cwd || "__default__";
  const shell = shellInstances.get(key);
  if (shell) {
    shell.dispose();
    shellInstances.delete(key);
  }
}

export function disposeAllShells(): void {
  for (const shell of shellInstances.values()) {
    shell.dispose();
  }
  shellInstances.clear();
}
