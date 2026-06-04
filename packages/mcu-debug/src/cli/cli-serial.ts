import { TabState } from '@mcu-debug/shared';
import { SerialParams } from '@mcu-debug/shared/serial-helper/SerialParams';
import * as fs from 'fs';
import * as net from 'net';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { AnsiHelpers } from '../common/ansi-helpers';
import { logger } from '../common/cli-logger';
import { ISerialPortView, getHostAdapter } from '../common/host-adapter';
import { LineBuffer, trimBrackets } from '../common/utils';

export class CLISerialPortView implements ISerialPortView {
    public readonly emitter = new EventEmitter();
    private socket: net.Socket | null = null;
    private logFileStream: fs.WriteStream | null = null;
    private txtPrefix: string;
    private lineBuffer: LineBuffer;
    private static existingPrefixes = new Set<string>();

    constructor(private device: string, public serialConfig: SerialParams, doClear: boolean = false, private tcpPort: number = 0) {
        let label = serialConfig.label ? trimBrackets(serialConfig.label) : path.basename(device);
        let counter = 1;
        const baseLabel = label;
        while (CLISerialPortView.existingPrefixes.has(label)) {
            label = `${baseLabel}-${counter}`;
            counter++;
        }
        CLISerialPortView.existingPrefixes.add(label);
        this.txtPrefix = `[${label}]`;
        if (this.tcpPort) {
            this.restartSocket();
        }
        if (this.serialConfig.log_file) {
            this.setLogFile(this.serialConfig.log_file);
        }
        this.lineBuffer = new LineBuffer(this.txtPrefix, (source, line) => {
            line = line.trimEnd();
            const str = `${source} ${line}`;
            if (this.logFileStream) {
                this.logFileStream.write(str + "\n");
            }
            logger.info(str, { source: "serial", isConsole: true });
        });
    }

    public getStatus(): "connected" | "not-connected" {
        return this.socket && !this.socket.destroyed ? "connected" : "not-connected";
    }

    public getPrefix(): string {
        return this.txtPrefix;
    }

    public getDevice(): string {
        return this.device;
    }

    send(text: string): void {
        this.lineBuffer.push(text);
    }
    sendDA(text: string): void {
        logger.info(text, { source: "DA", isConsole: true });
    }

    setState(state: TabState): void {
        // No-op in CLI mode, but could be used to track connection state if desired
    }
    setLabel(label: string): void {
        // No-op in CLI mode, but could be used to prefix log messages if desired
    }
    setPlaceholderText(placeholderText: string): void {
        // No-op in CLI mode
    }

    onUserInput(text: string) {
        const outgoing = `${text}\r\n`;
        if (!outgoing) {
            return;
        }
        if (this.socket) {
            this.socket.write(outgoing);
        }
        if (this.logFileStream) {
            this.logFileStream.write(outgoing);
        }
    }

    onUserClose(): void {
        // This should not happen but we will have it here in case we create a way to close from CLI
        this.destroySocket();
        this.sendDA(AnsiHelpers.yellowFormat(`[${this.device} closed]\r\n`));
    }

    public notifyConnected(reason: string) {
        this.sendDA(AnsiHelpers.greenFormat(`[${this.device} connected] ${reason}\r\n`));
        this.setState({ kind: "active" });
    }

    public notifyDisconnected(reason: string) {
        this.destroySocket();
        this.sendDA(AnsiHelpers.yellowFormat(`[${this.device} disconnected: ${reason} — retrying...]\r\n`));
        this.setState({ kind: "inactive" });
    }

    public notifyReconnected() {
        this.sendDA(AnsiHelpers.greenFormat(`[${this.device} reconnected]\r\n`));
        this.setState({ kind: "active" });
    }

    setTcpPort(port: number) {
        if (this.tcpPort === port && this.socket && !this.socket.destroyed) {
            return;
        }
        this.tcpPort = port;
        this.restartSocket();
    }

    private destroySocket() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    private closeLogFile() {
        if (this.serialConfig.log_file) {
            this.logFileStream?.end(() => {
                getHostAdapter().debugMessage(`Closed log file stream for ${this.serialConfig.log_file}`);
            });
            this.logFileStream = null;
        }
    }

    public setLogFile(log_file: string | undefined) {
        if (this.serialConfig.log_file === log_file) {
            return;
        }
        this.serialConfig.log_file = log_file || "";
        this.closeLogFile();
        if (log_file) {
            this.logFileStream = fs.createWriteStream(log_file, { flags: "a" });
            if (!this.logFileStream) {
                getHostAdapter().debugMessage(`Failed to create log file stream for ${log_file}`);
                getHostAdapter().showError(`Failed to create log file stream for ${log_file}`);
            }
        }
    }

    public setInputMode(input_mode: string | undefined) {
    }

    restartSocket() {
        this.destroySocket();
        // The helper will create a TCP server for this serial port and report the port number back to us. Once we have the port number, we can connect to it.
        const socket = new net.Socket();
        socket.connect(this.tcpPort, "127.0.0.1");
        socket.on("connect", () => {
            getHostAdapter().debugMessage(`Connected to serial port ${this.device} at 127.0.0.1:${this.tcpPort}`);
            this.socket = socket;
        });
        socket.on("data", (data) => {
            this.send(data.toString());
        });
        socket.on("error", (err) => {
            getHostAdapter().debugMessage(`Error on serial port ${this.device} connection: ${err.message}`);
            this.destroySocket();
            this.notifyDisconnected(err.message);
        });
        socket.on("close", () => {
            getHostAdapter().debugMessage(`Connection to serial port ${this.device} closed`);
            this.destroySocket();
            this.notifyDisconnected("Connection closed");
        });
    }

    dispose() {
        this.destroySocket();
        this.closeLogFile();
        CLISerialPortView.existingPrefixes.delete(this.txtPrefix);
    }
}
