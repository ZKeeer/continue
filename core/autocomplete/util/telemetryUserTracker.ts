declare var require: any;
declare var Buffer: any;

const os: any = require("os");
const http: any = require("http");

import { Telemetry } from "../../util/posthog.js";

interface StageTimings {
  prepareLlmMs?: number;
  debounceMs?: number;
  contextCollectionMs?: number;
  promptBuildMs?: number;
  streamCompletionMs?: number;
  postProcessMs?: number;
}

interface TelemetryEvent {
  action: string;
  pid: number;
  username: string;
  hostname: string;
  timestamp: string;
  time: number;
  completionId?: string;
  label?: string;
  ide?: string;
  ideVersion?: string;
  extensionVersion?: string;
  stageTimings?: StageTimings;
}

export class TelemetryTracker {
  private static instance: TelemetryTracker;

  public static getInstance(): TelemetryTracker {
    if (!TelemetryTracker.instance) {
      TelemetryTracker.instance = new TelemetryTracker();
    }
    return TelemetryTracker.instance;
  }

  public trackEvent(
    action: string,
    completionId?: string,
    label?: string,
    time?: number,
    stageTimings?: StageTimings,
  ): void {
    const pid = (globalThis as any).process?.pid ?? 0;

    const event: TelemetryEvent = {
      action,
      pid,
      username:
        os.userInfo && os.userInfo().username
          ? os.userInfo().username
          : "unknown",
      hostname: os.hostname ? os.hostname() : "unknown",
      timestamp: new Date().toISOString(),
      time: time ?? -1,
      completionId,
      label,
      ide: Telemetry.ideInfo?.name ?? Telemetry.ideInfo?.ideType ?? "unknown",
      ideVersion: Telemetry.ideInfo?.version,
      extensionVersion: Telemetry.ideInfo?.extensionVersion,
      stageTimings,
    };

    this.sendEventAsync(event);
  }

  private sendEventAsync(event: TelemetryEvent): void {
    const data = JSON.stringify(event);

    const options = {
      hostname: "userinfo.ai.infra",
      port: 80,
      path: "/autocomplete",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": (globalThis as any).Buffer
          ? (globalThis as any).Buffer.byteLength(data)
          : data.length,
      },
    };

    const req = http.request(options, (res: any) => {
      res.on && res.on("data", () => {});
      res.on && res.on("end", () => {});
    });
    req.on("error", () => {});

    req.setTimeout &&
      req.setTimeout(5000, () => {
        try {
          req.destroy();
        } catch (_) {}
      });

    req.write(data);
    req.end();
  }
}
