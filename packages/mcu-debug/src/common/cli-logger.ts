import fs, { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';
import { MESSAGE } from 'triple-beam';
import { CliArgs } from '../cli/cli-options';
import { HrTimer } from '../adapter/servers/common';
import { AnsiHelpers } from './ansi-helpers';

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
    constructor(opts: Transport.TransportStreamOptions & { callback: (info: winston.Logform.TransformableInfo) => void }) {
        super(opts);
        this.callback = opts.callback;
        CustomTransport._instance = this;
    }

    public static getInstance(): CustomTransport | null {
        return CustomTransport._instance;
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


// Maps the winston level name to a custom label for console output.
// 'simple' and 'printf' formats use info.level, which after colorize() contains
// ANSI codes wrapping the original name. Use Symbol.for('level') to get the raw name.
const levelLabels: Record<string, string> = {
    error: 'Error',
    warn: 'Warn ',
    info: 'Info ',
    debug: 'Debug',
};


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

export function createInitialTransports(cliArgs: CliArgs, consoleLogLevel: string): CustomTransport {
    const consoleLevel = consoleLogLevel in winston.config.npm.levels ? consoleLogLevel : 'info';
    // Console: human-readable, only what the user needs to see
    logger.add(
        new winston.transports.Console({
            level: consoleLevel,
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
    const customTransport = createCustomTransport();

    if (!cliArgs.logFile) {
        cliArgs.logFile = `${process.cwd()}/.mcu-debug/cli.log`;
        customTransport.usingDefaultLogFile = cliArgs.logFile;
    };
    customTransport.replaceStream('', cliArgs.logFile);

    const archiveLog = `${process.cwd()}/.mcu-debug/archive/${HrTimer.createDateTimestamp()}.log`;
    customTransport.replaceStream('', archiveLog);
    return customTransport;
}

function createCustomTransport() {
    const customTransport = new CustomTransport({
        level: 'debug',
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
