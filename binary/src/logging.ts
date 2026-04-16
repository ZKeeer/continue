import { getCoreLogsPath } from "core/util/paths";
import fs from "node:fs";

// [zkdev] Performance fix: replaced fs.appendFileSync with fs.createWriteStream.
// appendFileSync blocks the Node.js event loop on every console.log call (open + write + close),
// causing 1-50ms stalls per call. With ~10 calls per autocomplete request (including a 10-20KB
// prompt body dump), this was the root cause of debounce 900ms, prompt_build 100-220ms, and
// post_process jitter. WriteStream uses OS-level buffering and non-blocking writes.
export function setupCoreLogging() {
  const logFilePath = getCoreLogsPath();
  const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

  const logger = (message: any, ...optionalParams: any[]) => {
    const timestamp = new Date().toISOString().split(".")[0];
    const logMessage = `[${timestamp}] ${message} ${optionalParams.join(" ")}\n`;
    logStream.write(logMessage);
  };
  console.log = logger;
  console.error = logger;
  console.warn = logger;
  console.debug = logger;
  console.log("[info] Starting Continue core...");
}
