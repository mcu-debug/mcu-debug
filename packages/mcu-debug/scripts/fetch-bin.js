#!/usr/bin/env node
// fetch-bin: populate the Rust helper binaries for contributors who don't build the Rust side.
//
// The published MCU-Debug extension already ships the version-matched `mdbg` binaries. When it's
// installed, its `bin/` directory is sitting unzipped on disk — so we just copy it into the repo.
// No download, no unzip, no network. If the extension isn't installed, we say so and stop: if you
// haven't installed MCU-Debug, you're not set up to work on it yet.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXT_ID = "mcu-debug.mcu-debug";
const repoBinDir = path.join(__dirname, "..", "bin"); // packages/mcu-debug/bin
const proxyBinDir = path.join(__dirname, "..", "..", "mcu-debug-proxy", "bin"); // mirror target

/** Roots where VS Code / forks keep installed extensions, most-preferred first. */
function extensionRoots() {
    const home = os.homedir();
    const roots = [];
    if (process.env.VSCODE_EXTENSIONS) roots.push(process.env.VSCODE_EXTENSIONS);
    for (const d of [
        ".vscode",
        ".vscode-insiders",
        ".vscode-oss", // VSCodium
        ".vscode-server", // Remote-SSH / WSL / Dev Containers
        ".vscode-server-insiders",
    ]) {
        roots.push(path.join(home, d, "extensions"));
    }
    return roots.filter((r) => {
        try {
            return fs.statSync(r).isDirectory();
        } catch {
            return false;
        }
    });
}

/** Compare two semver-ish core versions (major.minor.patch). Returns >0 if a is newer. */
function cmpVersion(a, b) {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

/** Find the installed extension directory with the highest version, across all roots. */
function findInstalledExtension() {
    const re = new RegExp(`^${EXT_ID.replace(".", "\\.")}-(\\d+\\.\\d+\\.\\d+.*)$`);
    let best = null;
    for (const root of extensionRoots()) {
        let entries;
        try {
            entries = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const name of entries) {
            const m = name.match(re);
            if (!m) continue;
            const version = m[1];
            const dir = path.join(root, name);
            if (!best || cmpVersion(version, best.version) > 0) {
                best = { dir, version, root };
            }
        }
    }
    return best;
}

function copyDir(src, dst) {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
}

function main() {
    const found = findInstalledExtension();
    if (!found) {
        console.error(
            `\nCould not find an installed "${EXT_ID}" extension.\n\n` +
                "fetch-bin copies the Rust helper binaries out of the installed extension, so install\n" +
                "MCU-Debug from the VS Code Marketplace (or OpenVSX) first, then re-run:\n\n" +
                "    npm run fetch-bin\n",
        );
        process.exit(1);
    }

    const srcBin = path.join(found.dir, "bin");
    if (!fs.existsSync(srcBin)) {
        console.error(`\nInstalled extension ${found.version} has no bin/ directory at:\n  ${srcBin}\n`);
        process.exit(1);
    }

    console.log(`Using installed ${EXT_ID} v${found.version}`);
    console.log(`  from: ${found.dir}`);
    copyDir(srcBin, repoBinDir);
    console.log(`  ->   ${repoBinDir}`);

    // Mirror to the proxy package's bin, matching what build-rust.js does after a local build.
    try {
        copyDir(srcBin, proxyBinDir);
        console.log(`  ->   ${proxyBinDir}`);
    } catch (e) {
        console.warn(`  (skipped proxy bin mirror: ${e instanceof Error ? e.message : e})`);
    }

    console.log("\nDone. The extension will use these binaries until you build the Rust side yourself.");
}

main();
