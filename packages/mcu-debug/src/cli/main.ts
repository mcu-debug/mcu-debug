import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { logger } from '../common/logger';
import { CliArgs } from "./options";
import { loadConfiguration } from './config-loader';
import { CliAdapter, setHostAdapter } from './cli-adapter';
import { CliSessionDriver } from './session-driver';
import { HrTimer } from '../adapter/servers/common';


const timer = new HrTimer();

// Maps the winston level name to a custom label for console output.
// 'simple' and 'printf' formats use info.level, which after colorize() contains
// ANSI codes wrapping the original name. Use Symbol.for('level') to get the raw name.
const levelLabels: Record<string, string> = {
    error: 'Error',
    warn: 'Warn ',
    info: 'Info ',
    debug: 'Debug',
};

// Strip internal console-only fields so they don't appear in file/JSON output.
const stripConsoleFields = winston.format((info) => {
    delete (info as any).isConsole;
    delete (info as any).color;
    delete (info as any).skipConsole;
    return info;
});

const wrapInRed = (text: string) => `\x1b[31m${text}\x1b[0m`; // red for errors
const wrapInOrange = (text: string) => `\x1b[33m${text}\x1b[0m`; // orange for warnings
const wrapInGreen = (text: string) => `\x1b[32m${text}\x1b[0m`; // green for info

export function createLogger(logFile: string, logLevel: string) {
    // Console: human-readable, only what the user needs to see
    logger.add(
        new winston.transports.Console({
            level: logLevel === 'debug' ? 'debug' : 'info',
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
                    const extra = Object.keys(meta).length > 0
                        ? ' ' + JSON.stringify(meta)
                        : '';
                    return `${level}: ${message}${extra}`;
                }),
            ),
        }),
    );

    if (!logFile) return;
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch (err) {
        logger.error(`Failed to create log directory: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    try {
        fs.writeFileSync(logFile, ''); // Clear existing log file on startup
    } catch (err) {
        logger.error(`Failed to clear log file: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    // File: JSON, everything — perfect for post-mortem analysis
    logger.add(
        new winston.transports.File({
            filename: logFile,
            level: 'debug',   // capture all including mi:tx / mi:rx
            format: winston.format.combine(
                stripConsoleFields(),
                winston.format.timestamp(),
                winston.format.json()   // structured; mi content in 'mi' field, not 'message'
            ),
        }));
}

export function validateCliArgs(args: CliArgs): boolean {
    if (!args.config) {
        logger.error("Debug configuration is required. Use -c or --config to specify it.");
        return false;
    }
    return true;
}

async function main() {
    const { cliArgs } = await import("./options");
    createLogger(cliArgs.logFile || 'mcu-debug.log', cliArgs.logLevel || 'info');

    if (!validateCliArgs(cliArgs)) {
        process.exit(1);
    }
    const adapter = new CliAdapter(cliArgs);
    setHostAdapter(adapter);
    const config = await loadConfiguration(cliArgs, adapter.getSettings());

    const session = new CliSessionDriver(cliArgs, adapter, config);
    session.startSession(cliArgs);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // const { startDebugSession } = require("./debug-session");
    // startDebugSession(cliArgs);
}

process.on("uncaughtException", (err) => {
    const msg = err?.stack ?? err?.message ?? "unknown error";
    logger.error("Caught exception: " + msg);
    process.exit(1);
});

process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
    const detail = reason instanceof Error && reason.stack ? reason.stack : reason?.toString() ?? String(reason);
    logger.error("Unhandled Rejection: " + detail + " promise: " + promise.toString());
});

try {
    main();
} catch (error) {
    logger.error("An unexpected error occurred: " + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
}
