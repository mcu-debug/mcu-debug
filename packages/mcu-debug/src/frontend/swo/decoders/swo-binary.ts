import * as vscode from "vscode";
import * as fs from "fs";
import { SWORTTDecoder } from "./common";
import { SWOBinaryDecoderConfig } from "../common";
import { decoders as DECODER_MAP } from "./utils";
import { Packet } from "../common";
import { HrTimer, TerminalInputMode } from "../../../adapter/servers/common";
import { ManagedTabConsole } from "../../views/ManagedTab";
import { SWOConsoleProcessor } from "./swo-console";

function parseEncoded(buffer: Buffer, encoding: string) {
    return DECODER_MAP[encoding] ? DECODER_MAP[encoding](buffer) : DECODER_MAP.unsigned(buffer);
}

export class SWOBinaryProcessor implements SWORTTDecoder {
    public readonly format: string = "binary";
    private port: number;
    private scale: number;
    private encoding: string;
    private terminal: ManagedTabConsole | null = null;
    private hrTimer: HrTimer = new HrTimer();
    private logFd: number = -1;
    private logfile: string = "";

    constructor(config: SWOBinaryDecoderConfig) {
        this.port = config.port;
        this.scale = config.scale || 1;
        this.encoding = (config.encoding || "unsigned").replace(".", "_");

        this.terminal = SWOConsoleProcessor.createTerminal(config, () => {
            this.dispose();
        });
        if (config.logfile) {
            this.logfile = config.logfile;
            try {
                this.logFd = fs.openSync(config.logfile, "w");
            } catch (e: any) {
                const msg = `Could not open file ${config.logfile} for writing. ${e.toString()}`;
                vscode.window.showErrorMessage(msg);
            }
        }
    }

    public softwareEvent(packet: Packet) {
        if (packet.port !== this.port) {
            return;
        }
        const hexvalue = packet.data.toString("hex");
        const decodedValue = parseEncoded(packet.data, this.encoding);
        const scaledValue = decodedValue * this.scale;
        const timestamp = this.hrTimer.createDateTimestamp();

        const str = `${timestamp} ${hexvalue} - ${decodedValue} - ${scaledValue}`;
        this.terminal?.send(str + "\n");

        if (this.logFd >= 0) {
            try {
                fs.writeSync(this.logFd, packet.data);
            } catch (e: any) {
                const msg = `Could not write to file ${this.logfile} for writing. ${e.toString()}`;
                vscode.window.showErrorMessage(msg);
                try {
                    fs.closeSync(this.logFd);
                } catch (closeErr) {
                    console.error("decoder.logCloseError", closeErr);
                }
                this.logFd = -1;
            }
        }
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
