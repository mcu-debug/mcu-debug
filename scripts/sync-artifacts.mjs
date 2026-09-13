import process from "process";
import os from "os";
import { execSync } from "child_process";

function usage(exitCode) {
    console.log(`Usage: node sync-artifacts.js [--push | --pull] [--dry-run]`);
    process.exit(exitCode);
}

function parseArgs() {
    const opts = { doPush: false, doPull: false, dryRun: false };
    for (const arg of process.argv.slice(2)) {
        switch (arg) {
            case "-h":
            case "--help":
                usage(0);
                break;
            case "--push":
                opts.doPush = true;
                break;
            case "--pull":
                opts.doPull = true;
                break;
            case "--dryrun":
            case "--dry-run":
                opts.dryRun = true;
                break;
            default:
                if (arg.startsWith("-")) {
                    console.error(`Unknown option '${arg}'`);
                    usage(1);
                }
                if (opts.notesPath) {
                    console.error(`Unexpected extra argument '${arg}'`);
                    usage(1);
                }
        }
    }
    if (!opts.doPush && !opts.doPull) {
        if (os.platform() === "darwin") {
            // This is our primary dev. platform
            opts.doPush = true;
        } else {
            // These are our test machines/platforms
            opts.doPull = true;
        }
    }
    if (opts.doPush && opts.doPull) {
        // Technically we can allow it but why would you want to push and pull at the same time?
        console.error("Cannot specify both --push and --pull at the same time.");
        usage(1);
    }
    return opts;
}

function execSyncWithEcho(command, options = {}) {
    console.log(`Executing command: ${command}`);
    execSync(command, options);
}

function commandExists(command) {
    try {
        // 'command -v' works on macOS/Linux; 'where' works on Windows
        const cmd = process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
        execSync(cmd, { stdio: "ignore" });
        return true;
    } catch (e) {
        return false;
    }
}

function main() {
    if (!commandExists("rsync")) {
        console.error("rsync is not installed or not found in PATH.");
        process.exit(1);
    }
    const opts = parseArgs();
    if (process.env.MDBG_ARTIFACTS_PATH) {
        console.log(`Syncing artifacts from ${process.env.MDBG_ARTIFACTS_PATH}`);
        const dryRun = opts.dryRun ? "--dry-run" : "";
        if (opts.doPush) {
            execSyncWithEcho(`rsync -avr ${dryRun} --exclude=.DS_Store --delete --progress ./dist "${process.env.MDBG_ARTIFACTS_PATH}"`, { stdio: "inherit" });
        }
        if (opts.doPull) {
            execSyncWithEcho(`rsync -avr ${dryRun} --progress "${process.env.MDBG_ARTIFACTS_PATH}" ./dist/`, { stdio: "inherit" });
        }
    } else {
        console.log("No artifacts path specified with MDBG_ARTIFACTS_PATH.");
    }
}

main();
