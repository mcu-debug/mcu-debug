#!/usr/bin/env node
"use strict";

const { readFileSync, existsSync } = require("fs");
const { spawnSync } = require("child_process");
const { homedir } = require("os");
const { join } = require("path");

// ---------------------------------------------------------------------------
// Locate the VS Code extension via the config file it writes on every activation.
// The extension path changes on every update; config.json absorbs that churn.
// ---------------------------------------------------------------------------

const configPath = join(homedir(), ".mcu-debug", "config.json");

let config;
try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
    console.error(
        "\nmcu-debug: VS Code extension not found.\n" +
            "\nThe mcu-debug CLI requires the mcu-debug VS Code extension to be installed.\n" +
            "Install it from the VS Code marketplace and restart VS Code:\n" +
            "  https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug\n",
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Locate the Rust binary and the bundled Node controller inside the extension.
// ---------------------------------------------------------------------------

const isWindows = process.platform === "win32";
const binName = isWindows ? "mdbg.exe" : "mdbg";
const arch = process.arch === "x64" ? "x64" : "arm64";
const platform = isWindows ? "windows" : process.platform;
const binPath = join(config.extensionPath, "bin", `${platform}-${arch}`, binName);
const cliJsPath = join(config.extensionPath, "dist", "mcu-debug-cli.js");

if (!existsSync(binPath)) {
    console.error(
        `\nmcu-debug: binary not found at:\n  ${binPath}\n` + "\nYour mcu-debug extension installation may be incomplete.\n" + "Try reinstalling the extension from the VS Code marketplace.\n",
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Hand off to the Rust binary.
//   MCU_DEBUG_NODE   — the exact Node binary currently running this script.
//                      The Rust bootstrap uses this path to spawn mcu-debug-cli.js
//                      without any PATH search or nvm shim involvement.
//   MCU_DEBUG_CLI_JS — path to the bundled Node controller in the extension.
// ---------------------------------------------------------------------------

const result = spawnSync(binPath, process.argv.slice(2), {
    stdio: "inherit",
    env: {
        ...process.env,
        MCU_DEBUG_NODE: process.execPath,
        MCU_DEBUG_CLI_JS: cliJsPath,
    },
});

if (result.error) {
    console.error(`\nmcu-debug: failed to launch binary ${binPath}: ${result.error.message}\n`);
    process.exit(1);
}

if (result.signal) {
    // Child was killed by a signal — re-raise it on ourselves so the
    // parent process sees a signal death rather than exit code 1.
    // This is the correct Unix convention.
    process.kill(process.pid, result.signal);
    // kill() is async — exit(1) as a fallback if the signal doesn't land
    process.exit(1);
}

process.exit(result.status ?? 1);
