import fs from 'fs';
import { BinaryFormatter } from "../common/binary-encoding";
import { HrTimer, RTTConsoleDecoderOpts, TextEncoding } from "../adapter/servers/common";
import { magentaWrite } from "../common/ansi-helpers";
import { logger } from "../common/logger";
import { SocketIOSource } from "../common/swo/sources/socket";
import { LineBuffer, trimBrackets } from "../common/utils";

export class CLIRTTTerminal {
    private hrTimer: HrTimer = new HrTimer();
    private binaryFormatter: BinaryFormatter | null = null;
    private source: SocketIOSource | null = null;
    private prefix: string;
    private lineBuffer: LineBuffer;
    private logFd: number = -1;

    constructor(public options: RTTConsoleDecoderOpts, src: SocketIOSource, private readonly kind: string = "RTT") {
        this.prefix = trimBrackets(this.options.label || `RTT#${options.port}`);
        this.prefix = `[${this.prefix}]`;
        if (this.options.iencoding !== TextEncoding.UTF8 && this.options.iencoding !== TextEncoding.ASCII && this.options.type !== "binary") {
            logger.warn(`RTT Console ${this.options.label}: Ignoring text encoding ${this.options.iencoding} for CLI mode. Setting to UTF-8.`, { source: 'DA', isConsole: true });
            this.options.iencoding = TextEncoding.UTF8;
        }
        this.lineBuffer = new LineBuffer(this.prefix, (source, line) => {
            const ts = options.timestamp ? this.hrTimer.createDateTimestamp() + " " : "";
            logger.info(`${source} ${ts}${line}`, { source: this.kind, isConsole: true });
        });
        this.binaryFormatter = new BinaryFormatter(this!, this.options.encoding, this.options.scale);
        this.connectToSource(src);
    }

    private connectToSource(src: SocketIOSource) {
        const doConnected = () => {
            logger.info(`${this.prefix} connected to RTT source.`, { source: 'DA', isConsole: true });
            this.source = src;
            this.openLogFile();
        }
        this.hrTimer = new HrTimer();
        if (src.connected) {
            doConnected();
            return;
        }
        src.once("disconnected", () => {
            logger.info(`${this.prefix} disconnected from RTT source.`, { source: 'DA', isConsole: true });
        });
        src.on("error", (e) => {
            const code: string = e.code;
            if (code === "ECONNRESET") {
                // Server closed the connection. We are done with this session
            } else if (code === "ECONNREFUSED") {
                // We expect 'ECONNREFUSED' if the server has not yet started after all the retries
                magentaWrite(`${e}\n.`, (str) => logger.error(str, { source: 'DA', isConsole: true }));
            } else {
                magentaWrite(`${e}\n`, (str) => logger.error(str, { source: 'DA', isConsole: true }));
            }
        });
        src.on("data", (data) => {
            this.onData(data);
        });

        if (src.connError) {
            this.source = src;
            magentaWrite(`${src.connError.message}\n`, (str) => logger.error(str, { source: 'DA', isConsole: true }));
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
            magentaWrite(`Error writing data: ${e}\n`, (str) => logger.error(str, { source: 'DA', isConsole: true }));
        }
    }

    private writeLogFile(data: string) {
        if (this.logFd >= 0) {
            fs.writeSync(this.logFd, data);
        }
    }

    writeToTerminal(data: string) {
        const str = `${this.prefix} ${data}`;
        this.writeLogFile(str + "\n");
        logger.info(str, { source: this.kind, isConsole: true });
    }

    send(data: string) {
        const str = `${this.prefix} ${data}`
        this.writeLogFile(str + "\n");
        logger.info(str, { source: this.kind, isConsole: true });
    }

    private openLogFile() {
        if (this.logFd < 0 && this.options.logfile) {
            try {
                this.logFd = fs.openSync(this.options.logfile, "w");
            } catch (e: any) {
                const msg = `Could not open file ${this.options.logfile} for writing. ${e.toString()}`;
                console.error(msg);
                magentaWrite(msg, (str) => logger.error(str, { source: 'DA', isConsole: true }));
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
                magentaWrite(`Error: closing file ${e}\n`, (str) => logger.error(str, { source: 'DA', isConsole: true }));
            }
            this.logFd = -1;
        }
    }
}
