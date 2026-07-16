import { createInitialTransports, CustomTransport, logger } from '../common/cli-logger';
import { CliArgs } from "./cli-options";
import { CLIConfigLoader } from './cli-config-loader';
import { CliAdapter } from './cli-adapter';
import { setHostAdapter } from '../common/host-adapter';
import { CliSessionDriver } from './cli-driver';

export function validateCliArgs(args: CliArgs): boolean {
    if (!args.config) {
        logger.error("Debug configuration is required. Use -c or --config to specify it.");
        return false;
    }
    return true;
}

async function main() {
    const { cliArgs } = await import("./cli-options");
    const customTransport = createInitialTransports(cliArgs, cliArgs.debug ? 'debug' : 'info');

    if (!validateCliArgs(cliArgs)) {
        process.exit(1);
    }
    logger.debug("Args: " + process.argv.join(' '));
    const adapter = new CliAdapter(cliArgs);
    setHostAdapter(adapter);
    const configLoader = new CLIConfigLoader(cliArgs, logger, false);
    const config = await configLoader.loadConfiguration(cliArgs);
    if (!config) {
        // Errors are already logged in loadConfiguration, so we just exit here.
        process.exit(1);
    }

    if (cliArgs.dumpConfig) {
        console.log(JSON.stringify(config, null, 2));
        process.exit(0);
    }

    const session = new CliSessionDriver(cliArgs, customTransport, adapter, config);
    session.startSession(cliArgs);
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

