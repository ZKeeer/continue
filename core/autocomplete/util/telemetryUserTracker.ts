declare var require: any;
declare var Buffer: any;

const os: any = require("os");
const http: any = require("http");
const { execSync } = require("child_process");

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
}

export class TelemetryTracker {
    private static instance: TelemetryTracker;
    private cachedIDE: string | null = null; // ✅ 全局缓存 IDE 类型
    private cachedPID: number = 0;

    public static getInstance(): TelemetryTracker {
        if (!TelemetryTracker.instance) {
            TelemetryTracker.instance = new TelemetryTracker();
        }
        return TelemetryTracker.instance;
    }

    public trackEvent(action: string, completionId?: string, label?: string, time?: number): void {
        const pid = (globalThis as any).process?.pid ?? 0;
        const ide = this.getIDE(pid);

        const event: TelemetryEvent = {
            action,
            pid,
            username: os.userInfo && os.userInfo().username ? os.userInfo().username : "unknown",
            hostname: os.hostname ? os.hostname() : "unknown",
            timestamp: new Date().toISOString(),
            time: time ?? -1,
            completionId,
            label,
            ide
        };

        this.sendEventAsync(event);
    }

    /** ✅ 仅在 PID 变化时重新检测 IDE 类型 */
    private getIDE(pid: number): string {
        if (this.cachedIDE && this.cachedPID === pid) {
            return this.cachedIDE;
        }

        this.cachedPID = pid;

        try {
            const ppid = (globalThis as any).process?.ppid ?? 0;
            let cmdline = "";

            if (ppid) {
                const platform = os.platform();
                if (platform === "linux" || platform === "darwin") {
                    cmdline = execSync(`cat /proc/${ppid}/cmdline`, { encoding: "utf8" });
                } else if (platform === "win32") {
                    // /value output has newlines, so normalize
                    const out = execSync(`wmic process where processid=${ppid} get commandline /value`, { encoding: "utf8" });
                    cmdline = out.replace(/\r?\n|\r/g, " ");
                }
            }

            cmdline = cmdline.toLowerCase();

            if (cmdline.includes("PyCharm") || cmdline.includes("pycharm")) {
                this.cachedIDE = "pycharm";
            } else if (cmdline.includes("clion") || cmdline.includes("Clion")) {
                this.cachedIDE = "clion";
            }else if (cmdline.includes("code") || cmdline.includes("vscode")) {
                this.cachedIDE = "vscode";
            } else if (cmdline.includes("cursor")) {
                this.cachedIDE = "cursor";
            } else if (cmdline.includes("continue-binary")) {
                this.cachedIDE = "continue-bin";
            } else {
                this.cachedIDE = "unknown";
            }
        } catch (e) {
            this.cachedIDE = "unknown";
        }

        return this.cachedIDE;
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
                    : data.length
            }
        };

        const req = http.request(options, (res: any) => {
            res.on && res.on("data", () => {});
            res.on && res.on("end", () => {});
        });
        req.on("error", () => {});

        req.setTimeout && req.setTimeout(5000, () => {
            try {
                req.destroy();
            } catch (_) {}
        });

        req.write(data);
        req.end();
    }
}
