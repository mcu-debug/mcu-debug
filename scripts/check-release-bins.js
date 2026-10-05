#!/usr/bin/env node
// Verifies that the release `mdbg` binaries for every platform are present in a package's bin/.
// Usage: node scripts/check-release-bins.js <bin-dir>
//
// Runs from `vscode:prepublish` in place of building Rust there. `vsce package` always runs
// `vscode:prepublish`, and `package-extensions.sh` has already built the binaries by then; doing it
// again in prepublish compiled every target twice. Building is `npm run build:rust:prod`'s job,
// so a missing binary fails here instead of being silently rebuilt.
const fs = require("fs");
const path = require("path");

const binDir = process.argv[2];
if (!binDir) {
    console.error("Usage: node scripts/check-release-bins.js <bin-dir>");
    process.exit(2);
}

// Must match the target list in scripts/build-binaries.sh (prod).
const required = ["darwin-arm64/mdbg", "darwin-x64/mdbg", "linux-arm64/mdbg", "linux-x64/mdbg", "win32-x64/mdbg.exe"];

const missing = required.filter((rel) => !fs.existsSync(path.join(binDir, rel)));
if (missing.length > 0) {
    console.error(`Error: release binaries missing from ${path.resolve(binDir)}:`);
    for (const rel of missing) {
        console.error(`  - ${rel}`);
    }
    console.error("Build them with `npm run build:rust:prod`, or package with `npm run package`, which does.");
    process.exit(1);
}

// Existence is the hard requirement. Staleness is only a warning: a bare `vsce package` after a
// Rust edit is a legitimate thing to do while experimenting, but it should not go unnoticed.
const rustDir = path.join(__dirname, "..", "packages", "mdbg");
function newestMtime(p) {
    const st = fs.statSync(p);
    if (!st.isDirectory()) {
        return st.mtimeMs;
    }
    let newest = 0;
    for (const entry of fs.readdirSync(p)) {
        newest = Math.max(newest, newestMtime(path.join(p, entry)));
    }
    return newest;
}
const sourceMtime = Math.max(
    ...["src", "build.rs", "Cargo.toml", "Cargo.lock"]
        .map((rel) => path.join(rustDir, rel))
        .filter((p) => fs.existsSync(p))
        .map(newestMtime),
);
const stale = required.filter((rel) => fs.statSync(path.join(binDir, rel)).mtimeMs < sourceMtime);
if (stale.length > 0) {
    console.warn(`Warning: these binaries are older than the Rust sources in ${rustDir}:`);
    for (const rel of stale) {
        console.warn(`  - ${rel}`);
    }
    console.warn("Run `npm run build:rust:prod` if that was not intended.");
}
