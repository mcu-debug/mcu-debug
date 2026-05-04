import * as vscode from "vscode";
import * as fs from "fs";
import { SWORTTDecoder } from "./common";
import { SWOBinaryDecoderConfig, SWOConsoleDecoderConfig } from "../common";
import { Packet } from "../common";
import { HrTimer, TerminalInputMode, TextEncoding } from "../../../adapter/servers/common";
import { getUUid, createTerminalUniqueName, ManagedTabConsole } from "../../views/ManagedTab";

export class SWOConsoleProcessor implements SWORTTDecoder {
    private position: number = 0;
    private timeout: any = null;
    public readonly format: string = "console";
    private port: number;
    private encoding: TextEncoding;
    private terminal: ManagedTabConsole | null = null;
    private timestamp: boolean = false;
    private hrTimer: HrTimer = new HrTimer();
    private logFd: number = -1;
    private logfile: string = "";

    constructor(config: SWOConsoleDecoderConfig) {
        this.port = config.port;
        this.encoding = config.encoding || TextEncoding.UTF8;
        this.timestamp = !!config.timestamp;
        this.terminal = SWOConsoleProcessor.createTerminal(config, () => {
            this.dispose();
        });
        if (config.logfile) {
            this.logfile = config.logfile;
            try {
                this.logFd = fs.openSync(config.logfile, "w");
            } catch (e: any) {
                const msg = `Could not open file ${config.logfile} for writing. ${e.toString()}`;
                this.logFd = -1;
                vscode.window.showErrorMessage(msg);
            }
        }
    }

    public static createName(config: SWOConsoleDecoderConfig | SWOBinaryDecoderConfig) {
        // Try to keep it small while still having enough info
        const enc = config.encoding ? `, enc:${config.encoding}` : "";
        const basic = `SWO:${config.label || ""}[port:${config.port}${enc}]`;
        return basic;
    }

    public static createTerminal(config: SWOConsoleDecoderConfig | SWOBinaryDecoderConfig, closeCallback: () => void): ManagedTabConsole {
        const baseName = SWOConsoleProcessor.createName(config);
        let [name, terminal, isNew] = createTerminalUniqueName<ManagedTabConsole>(baseName, (nm: string) => {
            const uuid = getUUid('SWO');
            const ret = new ManagedTabConsole(uuid, nm, "swo", "tx");
            return ret;
        });
        terminal.on("close", () => {
            closeCallback();
        });
        terminal.clear();
        terminal.setLabel(name);
        terminal.setState({ kind: "active" });
        return terminal;
    }

    private pushOutput(str: string) {
        if (this.terminal && str) {
            this.terminal.send(str);
        }
    }

    private createDateHeaderUs(): string {
        if (this.timestamp) {
            return this.hrTimer.createDateTimestamp() + " ";
        } else {
            return "";
        }
    }

    private logFileWrite(text: string) {
        if (this.logFd <= 0 || text === "") {
            return;
        }
        try {
            fs.writeSync(this.logFd, text);
        } catch (e: any) {
            const msg = `Could not write to file ${this.logfile}. ${e.toString()}`;
            vscode.window.showErrorMessage(msg);
            try {
                fs.closeSync(this.logFd);
            } catch (closeErr) {
                console.error("decoder.logCloseError", closeErr);
            }
            this.logFd = -1;
        }
    }

    public softwareEvent(packet: Packet) {
        if (packet.port !== this.port) {
            return;
        }
        let text = "";
        const letters = packet.data.toString(this.encoding);
        for (const letter of letters) {
            if (this.timeout) {
                clearTimeout(this.timeout);
                this.timeout = null;
            }

            if (letter === "\n") {
                text += "\n";
                this.pushOutput("\n");
                this.position = 0;
                continue;
            }

            if (this.position === 0) {
                const timestampHeader = this.createDateHeaderUs();
                text += timestampHeader;
                this.pushOutput(timestampHeader);
            }

            text += letter;
            this.pushOutput(letter);
            this.position += 1;

            if (this.timestamp && this.position > 0) {
                if (this.timeout) {
                    clearTimeout(this.timeout);
                }
                this.timeout = setTimeout(() => {
                    text += "\n";
                    this.pushOutput("\n");
                    this.position = 0;
                    this.timeout = null;
                }, 5000);
            }
        }
        this.logFileWrite(text);
    }

    public hardwareEvent(event: Packet) { }
    public synchronized() { }
    public lostSynchronization() { }

    public dispose() {
        this.close();
    }

    public close() {
        if (this.terminal) {
            this.terminal.setState({ kind: "inactive" });
            this.terminal.removeAllListeners();
            this.terminal = null;
        }
        if (this.logFd >= 0) {
            fs.closeSync(this.logFd);
            this.logFd = -1;
        }
    }
}
