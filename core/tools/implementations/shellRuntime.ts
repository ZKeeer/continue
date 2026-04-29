import os from "node:os";
import path from "node:path";

export type ShellType =
  | "powershell"
  | "cmd"
  | "bash"
  | "zsh"
  | "fish"
  | "sh"
  | "unknown";

export interface ShellRuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  shellPath: string;
  shellType: ShellType;
  commandSeparator: string;
  syntaxHint: string;
}

interface ShellRuntimeOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

function getDefaultShellPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    return "powershell.exe";
  }

  if (platform === "darwin") {
    return env.SHELL || "/bin/zsh";
  }

  return env.SHELL || "/bin/bash";
}

function classifyShell(shellPath: string): ShellType {
  const baseName = path.basename(shellPath).toLowerCase();

  if (baseName === "powershell.exe" || baseName === "powershell") {
    return "powershell";
  }
  if (baseName === "pwsh.exe" || baseName === "pwsh") {
    return "powershell";
  }
  if (baseName === "cmd.exe" || baseName === "cmd") {
    return "cmd";
  }
  if (baseName === "bash") {
    return "bash";
  }
  if (baseName === "zsh") {
    return "zsh";
  }
  if (baseName === "fish") {
    return "fish";
  }
  if (baseName === "sh") {
    return "sh";
  }

  return "unknown";
}

function buildSyntaxHint(info: Omit<ShellRuntimeInfo, "syntaxHint">): string {
  switch (info.shellType) {
    case "powershell":
      return `Default shell is PowerShell (${info.shellPath}). Prefer PowerShell syntax: use '${info.commandSeparator}' to separate commands, '$env:NAME' for environment variables, and 'Set-Location' or 'cd' for directories. If a command fails due to shell syntax, explicitly call another available shell/interpreter such as cmd /c, bash -lc, python, or node.`;
    case "cmd":
      return `Default shell is cmd (${info.shellPath}). Prefer cmd syntax: use '&' to separate commands, '%NAME%' for environment variables, and 'cd' for directories. If a command fails due to shell syntax, explicitly call another available shell/interpreter such as powershell -Command, bash -lc, python, or node.`;
    case "fish":
      return `Default shell is fish (${info.shellPath}). Prefer fish syntax: use '${info.commandSeparator}' to separate commands, 'set -x NAME value' for environment variables, and 'cd' for directories. If a command fails due to shell syntax, explicitly call another available shell/interpreter such as bash -lc, sh -c, python, or node.`;
    case "bash":
    case "zsh":
    case "sh":
      return `Default shell is ${info.shellType} (${info.shellPath}). Prefer POSIX-style shell syntax: use '${info.commandSeparator}' or '&&' to separate commands, 'export NAME=value' for environment variables, and 'cd' for directories. If a command fails due to shell syntax, explicitly call another available shell/interpreter such as bash -lc, sh -c, python, or node.`;
    case "unknown":
    default:
      return `Default shell is ${info.shellPath}. Prefer syntax compatible with that shell and use '${info.commandSeparator}' to separate commands when supported. If a command fails due to shell syntax, explicitly call another available shell/interpreter such as bash -lc, sh -c, python, or node.`;
  }
}

export function getShellRuntimeInfo(
  options: ShellRuntimeOptions = {},
): ShellRuntimeInfo {
  const platform = options.platform ?? os.platform();
  const arch = options.arch ?? os.arch();
  const env = options.env ?? process.env;
  const shellPath = getDefaultShellPath(platform, env);
  const shellType = classifyShell(shellPath);
  const commandSeparator = ";";
  const infoWithoutHint = {
    platform,
    arch,
    shellPath,
    shellType,
    commandSeparator,
  };

  return {
    ...infoWithoutHint,
    syntaxHint: buildSyntaxHint(infoWithoutHint),
  };
}

export function getTerminalShellRuntimeNote(
  info: ShellRuntimeInfo = getShellRuntimeInfo(),
): string {
  return `Shell runtime: ${info.syntaxHint} Local foreground commands may reuse a persistent shell in this session, but remote, background, or non-streaming commands may run in a fresh process; avoid relying on shell state unless it was just established in this tool session.`;
}

export function getShellCommand(
  command: string,
  info: ShellRuntimeInfo = getShellRuntimeInfo(),
): { shell: string; args: string[] } {
  if (info.platform === "win32") {
    if (info.shellType === "cmd") {
      return { shell: info.shellPath, args: ["/d", "/s", "/c", command] };
    }

    return {
      shell: info.shellPath,
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }

  const supportsLoginFlag =
    info.shellType === "bash" || info.shellType === "zsh";
  return {
    shell: info.shellPath,
    args: supportsLoginFlag ? ["-l", "-c", command] : ["-c", command],
  };
}
