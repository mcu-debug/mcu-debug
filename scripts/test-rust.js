#!/usr/bin/env node
// Run the Rust test suite, then reformat the ts-rs generated TypeScript.
//
// `cargo test` runs the `ensure_ts_exports` tests as part of the suite, which rewrite
// packages/shared/{dasm-helper,proxy-protocol,serial-helper} in raw ts-rs style. The
// committed files are prettier-formatted, so a bare `cargo test` always leaves a dozen
// whitespace-only modifications behind that look like real edits in `git diff`.
//
// Formatting here means the obvious command to reach for is also the safe one. The
// width must match build-binaries.sh's `format_ts_exports` (120, narrower than the
// project's 200) or the files churn between the two settings instead of settling.
//
// Formatting runs whether or not the tests passed: the files were regenerated either
// way, and leaving them dirty on failure is exactly when it is most confusing.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'packages', 'shared');
const GENERATED = ['dasm-helper', 'proxy-protocol', 'serial-helper'].map((d) => path.join(SHARED, d));
const PRINT_WIDTH = '120'; // keep in sync with scripts/build-binaries.sh

const args = process.argv.slice(2);
const test = spawnSync(
    'cargo',
    ['test', '--manifest-path', path.join(ROOT, 'packages', 'mdbg', 'Cargo.toml'), '--lib', ...args],
    { stdio: 'inherit', shell: false },
);

const prettier = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
const fmt = spawnSync(prettier, ['--write', '--print-width', PRINT_WIDTH, '--log-level', 'warn', ...GENERATED], {
    stdio: 'inherit',
    shell: false,
});
if (fmt.status !== 0) {
    // Never mask a test result behind a formatting problem — say so and move on.
    console.error(`\nWarning: could not format generated TypeScript (prettier exited ${fmt.status ?? 'null'}).`);
    console.error(`Run: ${prettier} --write --print-width ${PRINT_WIDTH} ${GENERATED.join(' ')}`);
}

process.exit(test.status ?? 1);
