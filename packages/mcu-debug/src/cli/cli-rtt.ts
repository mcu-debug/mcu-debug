import fs from 'fs';
import { BinaryFormatter } from "../common/binary-encoding";
import { HrTimer, RTTConsoleDecoderOpts, TextEncoding } from "../adapter/servers/common";
import { AnsiHelpers } from "../common/ansi-helpers";
import { logger } from "../common/cli-logger";
import { SocketIOSource } from "../common/swo/sources/socket";
import { LineBuffer, trimBrackets } from "../common/utils";

export class CLIRTTTerminal {
    private hrTimer: HrTimer = new HrTimer();
    private binaryFormatter: BinaryFormatter | null = null;
    private prefix: string;
    private lineBuffer: LineBuffer;
    private logFd: number = -1;
    private static existingPrefixes = new Set<string>();

    constructor(public options: RTTConsoleDecoderOpts, private source: SocketIOSource, private readonly kind: string = "RTT") {
        this.prefix = trimBrackets(this.options.label || `RTT#${options.port}`);
        let counter = 1;
        const basePrefix = this.prefix;
        while (CLIRTTTerminal.existingPrefixes.has(this.prefix)) {
            this.prefix = `${basePrefix}-${counter}`;
            counter++;
        }
        CLIRTTTerminal.existingPrefixes.add(this.prefix);
        this.prefix = `[${this.prefix}]`;
        if (this.options.iencoding !== TextEncoding.UTF8 && this.options.iencoding !== TextEncoding.ASCII && this.options.type !== "binary") {
            if (this.options.iencoding) {
                logger.warn(`RTT Console ${this.options.label}: Ignoring text encoding ${this.options.iencoding} for CLI mode. Setting to UTF-8.`, { source: 'DA', isConsole: true, color: 'yellow' });
            }
            this.options.iencoding = TextEncoding.UTF8;
        }
        this.lineBuffer = new LineBuffer(this.prefix, (source, line) => {
            line = line.trimEnd();
            const ts = options.timestamp ? HrTimer.createDateTimestamp() + " " : "";
            logger.info(`${source} ${ts}${line}`, { source: this.kind, isConsole: true });
        });
        this.binaryFormatter = new BinaryFormatter(this!, this.options.encoding, this.options.scale);
        this.connectToSource(this.source);
    }

    public getStatus(): "connected" | "not-connected" {
        return this.source.connected ? "connected" : "not-connected";
    }

    public getPrefix(): string {
        return this.prefix;
    }

    private connectToSource(src: SocketIOSource) {
        const doConnected = () => {
            logger.info(`${this.prefix} type=${this.options.type} connected to RTT source.`, { source: 'DA', isConsole: true, color: 'green' });
            this.openLogFile();
        }
        this.hrTimer = new HrTimer();
        if (src.connected) {
            doConnected();
            return;
        }
        src.once("disconnected", () => {
            logger.info(`${this.prefix} disconnected from RTT source.`, { source: 'DA', isConsole: true, color: 'yellow.bold' });
        });
        src.on("error", (e) => {
            const code: string = e.code;
            if (code === "ECONNRESET") {
                // Server closed the connection. We are done with this session
            } else if (code === "ECONNREFUSED") {
                // We expect 'ECONNREFUSED' if the server has not yet started after all the retries
                logger.error(`${e} for ${this.prefix}, will retry...`, { source: 'DA', isConsole: true, color: 'red' });
            } else {
                logger.error(`${e} for ${this.prefix}`, { source: 'DA', isConsole: true, color: 'red' });
            }
        });
        src.on("data", (data) => {
            this.onData(data);
        });

        if (src.connError) {
            this.source = src;
            logger.error(`${src.connError.message} for ${this.prefix}`, { source: 'DA', isConsole: true, color: 'red' });
        } else if (src.connected) {
            this.source = src;
            this.openLogFile();
        } else {
            src.once("connected", () => {
                doConnected();
            });
        }
    }

    onData(data: string | Buffer) {
        try {
            if (this.options.type === "binary") {
                this.binaryFormatter!.writeBinary(data);
            } else {
                this.lineBuffer.push(data.toString(this.options.iencoding));
            }
        } catch (e) {
            logger.error(`Error writing data for ${this.prefix}: ${e}`, { source: 'DA', isConsole: true, color: 'red' });
        }
    }

    private writeLogFile(data: string) {
        if (this.logFd >= 0) {
            fs.writeSync(this.logFd, data);
        }
    }

    send(data: string) {
        let str = `${this.prefix} ${data}`
        this.writeLogFile(str);
        str = str.trimEnd();
        logger.info(str, { source: this.kind, isConsole: true });
    }

    private openLogFile() {
        if (this.logFd < 0 && this.options.logfile) {
            try {
                this.logFd = fs.openSync(this.options.logfile, "w");
            } catch (e: any) {
                const msg = `Could not open file ${this.options.logfile} for writing. ${e.toString()}`;
                console.error(msg);
                logger.error(msg, { source: 'DA', isConsole: true, color: 'red' });
            }
        } else if (this.logFd >= 0 && !this.options.logfile) {
            // It is already open but new connection does not want logging anymore
            this.closeLogFd();
        }
    }

    private closeLogFd() {
        if (this.logFd >= 0) {
            try {
                fs.closeSync(this.logFd);
            } catch (e) {
                logger.error(`Error: closing file ${this.options.logfile} for ${this.prefix}: ${e}`, { source: 'DA', isConsole: true, color: 'red' });
            }
            this.logFd = -1;
        }
    }
}
