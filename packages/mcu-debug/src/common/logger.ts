import fs from 'fs';
import os from 'os';
import path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';
import { MESSAGE } from 'triple-beam';
import { CliArgs } from '../cli/options';

/**
 * Central application logger. Platform-agnostic — no transports are added here.
 * Each entry point (CLI, VS Code extension) adds its own transports on startup.
 *
 * Usage:
 *   import { logger } from '../common/logger';
 *   logger.info('something happened', { key: 'value' });
 *   logger.error('failed', { error: e });
 */
export const logger = winston.createLogger({
    level: 'info',
});
export class CustomTransport extends Transport {
    private callback: (info: winston.Logform.TransformableInfo) => void;
    private streams: NodeJS.WritableStream[] = [];
    constructor(opts: Transport.TransportStreamOptions & { callback: (info: winston.Logform.TransformableInfo) => void }) {
        super(opts);
        this.callback = opts.callback;
    }

    log(info: winston.Logform.TransformableInfo, callback: () => void) {
        setImmediate(() => this.emit('logged', info));

        // Symbol.for('message') is where format.json() (and format.printf() etc.)
        // deposits the final serialised string — no need to stringify yourself.
        // const str = (info[Symbol.for('message')] as string) + '\n';
        const str = (info[MESSAGE] as string) + '\n';
        for (const stream of this.streams) {
            try {
                stream.write(str);
            } catch (err) {
                this.streams = this.streams.filter(s => s !== stream);
                logger.error(`Failed to write to log stream: ${err instanceof Error ? err.message : String(err)}`);
            }
        };
        callback();
    }

    addStream(stream: NodeJS.WritableStream) {
        this.streams.push(stream);
        stream.on('close', () => {
            this.streams = this.streams.filter(s => s !== stream);
        });
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

const wrapInRed = (text: string) => `\x1b[31m${text}\x1b[0m`; // red for errors
const wrapInOrange = (text: string) => `\x1b[33m${text}\x1b[0m`; // orange for warnings
const wrapInGreen = (text: string) => `\x1b[32m${text}\x1b[0m`; // green for info

export function createTransports(cliArgs: CliArgs, consoleLogLevel: string): CustomTransport {
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
                        switch (color) {
                            case 'red': msg = wrapInRed(msg); break;
                            case 'orange': msg = wrapInOrange(msg); break;
                            case 'green': msg = wrapInGreen(msg); break;
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
        cliArgs.logFile = `${os.tmpdir()}/mcu-debug-logs/${process.pid}.log`;
    };
    const logDir = path.dirname(cliArgs.logFile);
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (err) {
        logger.error(`Failed to create log directory ${logDir}: ${err instanceof Error ? err.message : String(err)}`);
        return customTransport;
    }
    try {
        const stream = fs.createWriteStream(cliArgs.logFile, { flags: 'w' });
        customTransport.addStream(stream);
        stream.on('error', (err) => {
            logger.error(`Log file stream error: ${err instanceof Error ? err.message : String(err)}`);
        });
    } catch (err) {
        logger.error(`Failed to create log file ${cliArgs.logFile}: ${err instanceof Error ? err.message : String(err)}`);
        return customTransport;
    }
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
