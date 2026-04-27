import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { HrTimer } from "./adapter/servers/common";

export class MCUDebugChannel {
    private static vscodeDebugChannel: vscode.OutputChannel;
    private static globalHrTimer = new HrTimer();
    private static logStream: fs.WriteStream | undefined;

    public static createDebugChannel() {
        if (!MCUDebugChannel.vscodeDebugChannel) {
            MCUDebugChannel.vscodeDebugChannel = vscode.window.createOutputChannel("Mcu-debug");
        }
        if (!MCUDebugChannel.logStream) {
            try {
                const logDir = path.join(os.tmpdir(), "mcu-debug-helper", "extension-logs");
                fs.mkdirSync(logDir, { recursive: true });
                const ts = Math.floor(Date.now() / 1000);
                const logFile = path.join(logDir, `mcu-debug-extension_${process.pid}-${ts}.log`);
                MCUDebugChannel.logStream = fs.createWriteStream(logFile, { flags: "a" });
                MCUDebugChannel.debugMessage(`Debug log started, writing to ${logFile}`); // also log to vscode channel
            } catch (_e) {
                // ignore
            }
        }
    }

    public static debugMessage(msg: string): void {
        const ts = MCUDebugChannel.globalHrTimer.createDateTimestamp();
        const line = ts + " " + msg;
        MCUDebugChannel.logStream?.write(line + "\n");
        MCUDebugChannel.vscodeDebugChannel?.appendLine(line.replace(/\n/g, ' '));
    }
}
