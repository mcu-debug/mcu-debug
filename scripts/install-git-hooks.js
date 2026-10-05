#!/usr/bin/env node
// Hooks scripts/git-hooks/pre-push into this clone's .git/hooks/pre-push.
//
// Adds a line to the existing hook rather than setting core.hooksPath: this repo uses Git LFS,
// whose own pre-push/post-* hooks live in .git/hooks, and core.hooksPath would silently stop
// them from running. Safe to rerun; the line is only added once.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const hooksDir = execSync("git rev-parse --path-format=absolute --git-path hooks").toString().trim();
const hook = path.join(hooksDir, "pre-push");
const MARKER = "# mcu-debug: run tests";
// Run before LFS so a failing test stops the push before any LFS upload. stdin is the list of
// refs being pushed, which LFS reads; the tests do not need it, so they must not consume it.
const CALL = `${MARKER}\n"$(git rev-parse --show-toplevel)/scripts/git-hooks/pre-push" </dev/null || exit $?\n`;

let content = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : "#!/bin/sh\n";
if (content.includes(MARKER)) {
    console.log(`Already installed: ${hook}`);
    process.exit(0);
}
// Insert right after the shebang line.
const nl = content.indexOf("\n");
content = content.startsWith("#!") ? content.slice(0, nl + 1) + CALL + content.slice(nl + 1) : "#!/bin/sh\n" + CALL + content;
fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(hook, content, { mode: 0o755 });
fs.chmodSync(hook, 0o755);
console.log(`Installed test run into: ${hook}`);
