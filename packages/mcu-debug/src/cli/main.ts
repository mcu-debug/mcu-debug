
import winston from 'winston';
import { logger } from '../common/logger';
import { CliArgs } from "./options";
import { loadConfiguration } from './config-loader';
import { CliAdapter, setHostAdapter } from './cli-adapter';
import { CliSessionDriver } from './session-driver';

// Maps the winston level name to a custom label for console output.
// 'simple' and 'printf' formats use info.level, which after colorize() contains
// ANSI codes wrapping the original name. Use Symbol.for('level') to get the raw name.
const levelLabels: Record<string, string> = {
    error: 'Error',
    warn: 'Warn ',
    info: 'Info ',
    debug: 'Debug',
};

function setupTransports(args: CliArgs): void {
    const consoleFormat = winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
            const rawLevel = (info as any)[Symbol.for('level')] as string;
            const label = levelLabels[rawLevel] ?? rawLevel;
            // Replace the raw level text inside the ANSI-wrapped string from colorize()
            const coloredLabel = info.level.replace(rawLevel, label);
            return `${coloredLabel}: ${info.message}`;
        }),
    );
    logger.add(new winston.transports.Console({ format: consoleFormat }));

    if (args.logFile) {
        logger.add(new winston.transports.File({
            filename: args.logFile,
            format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        }));
    }

    logger.level = args.logLevel || 'info';
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
    setupTransports(cliArgs);

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
