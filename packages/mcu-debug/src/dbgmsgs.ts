import * as vscode from "vscode";
import { HrTimer } from "./adapter/servers/common";

export class MCUDebugChannel {
    private static vscodeDebugChannel: vscode.OutputChannel;
    private static globalHrTimer = new HrTimer();

    public static createDebugChannel() {
        if (!MCUDebugChannel.vscodeDebugChannel) {
            const options: object = {
                log: true,
            };
            // (options as any).loglevel = vscode.LogLevel.Trace;
            MCUDebugChannel.vscodeDebugChannel = vscode.window.createOutputChannel("Mcu-debug");
            MCUDebugChannel.vscodeDebugChannel.hide();
        }
    }

    public static debugMessage(msg: string): void {
        if (MCUDebugChannel.vscodeDebugChannel) {
            const ts = MCUDebugChannel.globalHrTimer.createDateTimestamp();
            MCUDebugChannel.vscodeDebugChannel.appendLine(ts + " " + msg);
        }
    }
}
