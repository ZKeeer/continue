process.env.IS_BINARY = "true";
import { Command } from "commander";
import { Core } from "core/core";
import { LLMLogFormatter } from "core/llm/logFormatter";
import { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { IMessenger } from "core/protocol/messenger";
import { getCoreLogsPath, getPromptLogsPath } from "core/util/paths";
import fs from "node:fs";
import { IpcIde } from "./IpcIde";
import { IpcMessenger } from "./IpcMessenger";
import { setupCoreLogging } from "./logging";
import { TcpMessenger } from "./TcpMessenger";

const logFilePath = getCoreLogsPath();
fs.appendFileSync(logFilePath, "[info] Starting Continue core...\n");

const program = new Command();

program.action(async () => {
  try {
    let messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>;

    // 使用 IPC (stdin/stdout) 模式 + 异步写入队列解决 Windows 阻塞问题
    // TCP 模式已回退：abort 机制 + IpcMessenger 异步写入可解决根本问题
    const useTcp = false;

    if (useTcp) {
      setupCoreLogging();
      messenger = new TcpMessenger<ToCoreProtocol, FromCoreProtocol>();
      console.log("[binary] Waiting for TCP connection");
      await (
        messenger as TcpMessenger<ToCoreProtocol, FromCoreProtocol>
      ).awaitConnection();
      console.log("[binary] Connected via TCP");
    } else {
      setupCoreLogging();
      messenger = new IpcMessenger<ToCoreProtocol, FromCoreProtocol>();
    }
    const ide = new IpcIde(messenger);
    const promptLogsPath = getPromptLogsPath();

    const core = new Core(messenger, ide);
    new LLMLogFormatter(core.llmLogger, fs.createWriteStream(promptLogsPath));

    console.log("[binary] Core started");
  } catch (e) {
    fs.writeFileSync("./error.log", `${new Date().toISOString()} ${e}\n`);
    console.log("Error: ", e);
    process.exit(1);
  }
});

program.parse(process.argv);
