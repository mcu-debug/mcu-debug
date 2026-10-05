#!/usr/bin/env node
// Run the Rust test suite, then sync the ts-rs generated TypeScript into packages/shared.
//
// `cargo test` runs the ts-rs export tests as part of the suite. They write to a staging dir
// (TS_RS_EXPORT_DIR in packages/mdbg/.cargo/config.toml), not to packages/shared, so a bare
// `cargo test` leaves the committed files alone -- but it also does not update them. This
// script is the step that does: scripts/sync-ts-exports.js formats the staged files with
// prettier and copies over only the ones that changed.
//
// Syncing runs whether or not the tests passed: the export tests are independent of the
// rest, and a Rust type change should reach the TS side even while another test is failing.
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SYNC = path.join(ROOT, "scripts", "sync-ts-exports.js");

// Run from the crate directory, NOT the repo root with --manifest-path. Cargo
// discovers .cargo/config.toml by walking up from the *current directory*; the manifest
// path does not affect it. packages/mdbg/.cargo/config.toml sets TS_RS_EXPORT_DIR, so
// running from elsewhere silently exports the bindings into packages/mdbg/bindings/
// instead of the staging dir -- tests pass, nothing looks wrong, and the shared types
// are simply never regenerated (the sync below then fails, saying so).
const args = process.argv.slice(2);
spawnSync(process.execPath, [SYNC, "clean"], { stdio: "inherit" });
const test = spawnSync("cargo", ["test", "--lib", ...args], {
    cwd: path.join(ROOT, "packages", "mdbg"),
    stdio: "inherit",
    shell: false,
});

// A filtered run exports only some types, so only an unfiltered one can tell what is stale.
const sync = spawnSync(process.execPath, [SYNC, ...(args.length === 0 ? ["--report-stale"] : [])], { stdio: "inherit" });
if (sync.status !== 0) {
    // Never mask a test result behind a sync problem — say so and move on.
    console.error(`\nWarning: could not sync generated TypeScript (exited ${sync.status ?? "null"}).`);
}

process.exit(test.status ?? 1);
