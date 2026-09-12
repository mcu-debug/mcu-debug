import fs, { mkdirSync } from 'fs';
import path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';
import { MESSAGE } from 'triple-beam';
import { AnsiHelpers } from './ansi-helpers';
import { BinaryRingBuffer } from './ring-buffer';

/**
 * Central application logger for CLI. Platform-agnostic — no transports are added here.
 * Transports are added dynamically by main and other modules, and can be accessed via
 * CustomTransport.getInstance() if needed.
 *
 * Usage:
 *   import { logger } from '../common/cli-logger';
 *   logger.info('something happened', { key: 'value' });
 *   logger.error('failed', { error: e });
 */
export const logger = winston.createLogger({
    level: 'info',
});

/**
 * This is a custome transport that winston can write to, which then forwards the log messages to multiple
 * streams. It can manage multiple streams and streams can be added, replaced, or removed at runtime w/o modifyimg
 * winston transports.
 */
export class CustomTransport extends Transport {
    private static _instance: CustomTransport | null = null;
    private callback: (info: winston.Logform.TransformableInfo) => void;
    private pathMap: { [path: string]: NodeJS.WritableStream } = {};
    public usingDefaultLogFile: string | undefined;
    public readonly timeCreated = new Date().toISOString().replace(/[:.]/g, '-');   // e.g. 2024-06-01T12-34-56-789Z
    // 10KB replay window handed to each newly-connected socket client. Deliberately small: it only
    // has to bridge "session started" -> "client connected". The log file is the unbounded archive,
    // and a bigger window would just cost an AI consumer context on telemetry it never asked for.
    private binaryRingBuffer = new BinaryRingBuffer(1024 * 10);
    constructor(opts: Transport.TransportStreamOptions & { callback: (info: winston.Logform.TransformableInfo) => void }) {
        super(opts);
        this.callback = opts.callback;
        CustomTransport._instance = this;
    }

    public static getInstance(): CustomTransport | null {
        return CustomTransport._instance;
    }

    public getRingBuffer(): BinaryRingBuffer {
        return this.binaryRingBuffer;
    }

    log(info: winston.Logform.TransformableInfo, callback: () => void) {
        setImmediate(() => this.emit('logged', info));

        // Symbol.for('message') is where format.json() (and format.printf() etc.)
        // deposits the final serialised string — no need to stringify yourself.
        // const str = (info[Symbol.for('message')] as string) + '\n';
        const str = (info[MESSAGE] as string) + '\n';
        for (const key of Object.keys(this.pathMap)) {
            const stream = this.pathMap[key];
            try {
                stream.write(str);
            } catch (err) {
                delete this.pathMap[key];
                logger.error(`Failed to write to log stream: ${err instanceof Error ? err.message : String(err)}`);
            }
        };
        this.binaryRingBuffer.writeBuffer(Buffer.from(str));
        callback();
    }

    addStream(stream: NodeJS.WritableStream, path: string) {
        this.pathMap[path] = stream;
        stream.on('close', () => {
            delete this.pathMap[path];
        });
    }

    replaceStream(oldPath: string, newPath: string) {
        if (oldPath && (oldPath === newPath)) {
            return;
        }
        try {
            mkdirSync(path.dirname(newPath), { recursive: true });
            const newStream = fs.createWriteStream(newPath, { flags: 'w' });
            newStream.on('error', (err) => {
                logger.error(`Log file stream error: ${err instanceof Error ? err.message : String(err)}`);
            });
            this.addStream(newStream, newPath);
        } catch (err) {
            logger.error(`Failed to add log stream with ${newPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (oldPath && this.pathMap[oldPath]) {
            this.pathMap[oldPath].end();
            delete this.pathMap[oldPath];
        }
    }

    removeStream(path: string) {
        if (this.pathMap[path]) {
            this.pathMap[path].end();
            delete this.pathMap[path];
        }
    }
}


const stripProps = (info: any) => {
    delete info.isConsole;
    delete info.color;
    delete info.skipConsole;
};


// Strip internal console-only fields so they don't appear in file/JSON output.
const stripConsoleFields = winston.format((info) => {
    stripProps(info);
    return info;
});

/** Clamp an arbitrary string to a winston level, falling back to `info`. */
export function normalizeLogLevel(level: string): string {
    return level in winston.config.npm.levels ? level : 'info';
}

/**
 * Add the human-readable console transport: what a person watching a terminal should see.
 *
 * Entries marked `isConsole` print as their bare message, optionally colourised; everything else
 * gets `level: message` plus whatever meta is left. `skipConsole` entries are dropped here and
 * survive only in the structured stream.
 */
export function createConsoleTransport(consoleLogLevel: string): void {
    logger.add(
        new winston.transports.Console({
            level: normalizeLogLevel(consoleLogLevel),
            format: winston.format.combine(
                winston.format((info) => (info as any).skipConsole ? false : info)(),
                winston.format.colorize(),
                winston.format.printf(({ level, message, mi, ...meta }) => {
                    if (meta.isConsole) {
                        const color = meta.color as string | undefined;
                        let msg: string = message as string;
                        if (typeof color === 'string') {
                            msg = AnsiHelpers.colorize(msg, color);
                        }
                        return `${msg}`;   // for console transport, just return the message without level or meta
                    }
                    stripProps(meta);
                    const extra = Object.keys(meta).length > 0
                        ? ' ' + JSON.stringify(meta)
                        : '';
                    return `${level}: ${message}${extra}`;
                }),
            ),
        }),
    );
}

/**
 * Add the structured transport: one JSON object per line, fanned out to whatever streams are
 * attached to it -- log files, the archive, connected socket clients. This is the stream machine
 * consumers read, which is why the console-only fields are stripped from it.
 *
 * Returns the transport so the caller can attach its own streams. Deciding *which* files those
 * are is host policy and deliberately not decided here.
 */
export function createCustomTransport(level: string): CustomTransport {
    const customTransport = new CustomTransport({
        level: normalizeLogLevel(level),
        format: winston.format.combine(
            stripConsoleFields(),
            winston.format.timestamp(),
            winston.format.json()
        ),
        callback: (_info) => { }        // We are not using this callback since we handle it in CustomTransport.log(), but winston requires it
    });
    logger.add(customTransport);
    return customTransport;
}

export function createGitIgnore(cwd?: string) {
    const gitIgnorePath = path.join(cwd || process.cwd(), '.mcu-debug', '.gitignore');
    const dir = path.dirname(gitIgnorePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(gitIgnorePath)) {
        const str = [
            "# This file is automatically generated by the MCU Debug Tools, only if it doesn't exist",
            "# Any customizations you make will remain",
            "",
            "# Ignore all files in this directory",
            "*",
            ""
        ].join("\n");
        fs.writeFileSync(gitIgnorePath, str);
        logger.debug(`Created .gitignore at ${gitIgnorePath}`);
    }
}
