#!/usr/bin/env node
// Edit VERSION here to update all packages in sync.
const VERSION = "0.1.3";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TARGETS = [
    { label: "packages/mcu-debug/package.json", path: path.join(ROOT, "packages", "mcu-debug", "package.json"), type: "json" },
    { label: "packages/mcu-debug-proxy/package.json", path: path.join(ROOT, "packages", "mcu-debug-proxy", "package.json"), type: "json" },
    { label: "packages/mcu-debug-helper/Cargo.toml", path: path.join(ROOT, "packages", "mcu-debug-helper", "Cargo.toml"), type: "cargo" },
];

function readVersion(target) {
    const content = fs.readFileSync(target.path, "utf8");
    if (target.type === "json") {
        return JSON.parse(content).version;
    }
    // Only look in the [package] section (before any other section header)
    const packageSectionEnd = content.search(/^\[(?!package\b)/m);
    const head = packageSectionEnd === -1 ? content : content.slice(0, packageSectionEnd);
    return (head.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
}

function writeVersion(target, version) {
    const content = fs.readFileSync(target.path, "utf8");
    if (target.type === "json") {
        const json = JSON.parse(content);
        json.version = version;
        fs.writeFileSync(target.path, JSON.stringify(json, null, 2) + "\n");
    } else {
        const packageSectionEnd = content.search(/^\[(?!package\b)/m);
        const head = packageSectionEnd === -1 ? content : content.slice(0, packageSectionEnd);
        const tail = packageSectionEnd === -1 ? "" : content.slice(packageSectionEnd);
        const newHead = head.replace(/^(version\s*=\s*)"[^"]+"$/m, `$1"${version}"`);
        fs.writeFileSync(target.path, newHead + tail);
    }
}

function main() {
    const check = process.argv.includes("--check");

    let allInSync = true;
    for (const target of TARGETS) {
        const current = readVersion(target);
        const inSync = current === VERSION;
        if (!inSync) allInSync = false;

        if (check) {
            const status = inSync ? "ok" : `MISMATCH (has ${current})`;
            console.log(`  ${target.label}: ${status}`);
        } else {
            writeVersion(target, VERSION);
            const changed = current !== VERSION ? `${current} -> ${VERSION}` : `${VERSION} (already current)`;
            console.log(`  ${target.label}: ${changed}`);
        }
    }

    if (check && !allInSync) {
        console.error(`\nVersion mismatch detected. Run node scripts/sync-versions.js to fix.`);
        process.exit(1);
    }
}

main();
