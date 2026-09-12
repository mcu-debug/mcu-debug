import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConsoleTransport, createCustomTransport, createGitIgnore, CustomTransport, logger } from '../common/logger';
import { CliArgs } from "./cli-options";
import { CLIConfigLoader } from './cli-config-loader';
import { CliAdapter } from './cli-adapter';
import { setHostAdapter } from '../common/host-adapter';
import { CliSessionDriver } from './cli-driver';

/**
 * How much of `.mcu-debug/archive/` to keep. Two caps because either one alone fails: a count
 * cap lets a single runaway session leave tens of megabytes behind (a gdb-server that loses its
 * USB device can emit hundreds of errors a second), and a size cap alone could throw away a
 * week of small, useful sessions after one bad afternoon.
 *
 * Only `.log` bytes are counted. The notes snapshots are kilobytes and are the more valuable
 * artifact per byte, so they should never be what triggers a deletion.
 */
const ARCHIVE_KEEP_SESSIONS = 50;
const ARCHIVE_KEEP_BYTES = 64 * 1024 * 1024;

/** This session's own file inside the archive directory. */
function archivePathFor(transport: CustomTransport): string {
    return path.join(cliPaths().archiveDir, `${transport.timeCreated}.log`);
}

/** Everything the CLI keeps under the workspace, in one place. */
function cliPaths() {
    const base = path.join(process.cwd(), '.mcu-debug');
    return { base, defaultLog: path.join(base, 'cli.log'), archiveDir: path.join(base, 'archive') };
}

/**
 * Wire up logging for a CLI session.
 *
 * This lives here rather than alongside the logger because everything it decides is CLI policy:
 * that an unspecified log file defaults to `.mcu-debug/cli.log` under the working directory, and
 * that every session also gets a timestamped copy under `.mcu-debug/archive/`. The logger module
 * is shared with the VS Code extension, which answers both questions differently -- it had no
 * business importing `CliArgs`.
 *
 * The archive is a second stream on the same transport, so it receives byte-identical content to
 * the main log. Its value is that it survives the next session, which truncates `cli.log`.
 */
function createInitialTransports(cliArgs: CliArgs, consoleLogLevel: string): CustomTransport {
    const paths = cliPaths();
    createConsoleTransport(consoleLogLevel);
    const customTransport = createCustomTransport(consoleLogLevel);

    if (!cliArgs.logFile) {
        cliArgs.logFile = paths.defaultLog;
        customTransport.usingDefaultLogFile = cliArgs.logFile;
    }
    customTransport.replaceStream('', cliArgs.logFile);

    customTransport.replaceStream('', archivePathFor(customTransport));

    // Write the .gitignore here rather than from the pruning pass below. Pruning is deferred and
    // never runs for a short invocation -- `--dump-config`, a bad argument -- but those still
    // create log files, and a directory of logs that only becomes ignored after someone happens
    // to run a long session is worse than two syscalls on startup.
    try {
        createGitIgnore();
    } catch {
        // Never let housekeeping stop a debug session from starting.
    }
    return customTransport;
}

/**
 * The session an archive entry belongs to, or undefined when it is not one of ours.
 *
 * A session leaves two files behind, both named from the same timestamp: `<ts>.log` written by
 * the logger, and `<ts>-notes.json` written by NotesManager when the session records anything.
 */
function archiveSessionOf(name: string): string | undefined {
    if (name.endsWith('-notes.json')) {
        return name.slice(0, -'-notes.json'.length);
    }
    if (name.endsWith('.log')) {
        return name.slice(0, -'.log'.length);
    }
    return undefined;
}

/**
 * Trim the archive to {@link ARCHIVE_KEEP_SESSIONS} / {@link ARCHIVE_KEEP_BYTES}.
 *
 * Prunes whole **sessions**, not individual files. A session's log and its notes snapshot are a
 * matched pair; dropping one and keeping the other leaves you reading a log with no record of
 * what was concluded, or conclusions with no evidence behind them.
 *
 * Deliberately quiet and deliberately unable to fail the session: every filesystem call swallows
 * its error. A locked file on Windows, a directory someone deleted mid-run, a permissions
 * problem -- none is worth a message, because the only cost of skipping is that the next run
 * tries again.
 *
 * Archive names begin with an ISO timestamp, so a lexical sort is chronological and no stat is
 * needed to order them -- only to measure them.
 */
async function pruneArchive(archiveDir: string, currentSession: string): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.promises.readdir(archiveDir);
    } catch {
        return;     // no archive yet, or not readable
    }

    const bySession = new Map<string, string[]>();
    for (const name of entries) {
        const key = archiveSessionOf(name);
        if (!key) {
            continue;   // not ours -- never delete something we did not write
        }
        const group = bySession.get(key);
        if (group) {
            group.push(name);
        } else {
            bySession.set(key, [name]);
        }
    }

    let sessions = 0;
    let bytes = 0;
    for (const key of [...bySession.keys()].sort().reverse()) {
        const names = bySession.get(key)!;
        sessions++;
        for (const name of names.filter((n) => n.endsWith('.log'))) {
            try {
                bytes += (await fs.promises.stat(path.join(archiveDir, name))).size;
            } catch {
                // Gone or unreadable; it simply does not count toward the budget.
            }
        }
        if (key === currentSession) {
            continue;   // the session still writing
        }
        if (sessions <= ARCHIVE_KEEP_SESSIONS && bytes <= ARCHIVE_KEEP_BYTES) {
            continue;
        }
        for (const name of names) {
            try {
                await fs.promises.unlink(path.join(archiveDir, name));
            } catch {
                // Held open by another session, or already gone. Either way, leave it.
            }
        }
    }
}

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

    // Housekeeping, out of the way of starting a session. unref() so a short-lived invocation is
    // never held open waiting for it -- skipping a prune costs nothing, delaying an exit does.
    setTimeout(() => {
        void pruneArchive(cliPaths().archiveDir, customTransport.timeCreated)
            .catch(() => { /* housekeeping is never worth an error */ });
    }, 5000).unref();

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

