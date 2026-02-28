#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MCU_DEBUG_PKG = path.join(ROOT, "packages", "mcu-debug", "package.json");
const MCU_DEBUG_PROXY_PKG = path.join(ROOT, "packages", "mcu-debug-proxy", "package.json");

function fail(message) {
    console.error(message);
    process.exit(1);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, json) {
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + "\n");
}

function isLikelySemver(version) {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function parseArgs(argv) {
    const args = argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const positional = args.filter((arg) => !arg.startsWith("--"));

    if (positional.length !== 1) {
        fail("Usage: node ./scripts/bump-extensions-version.js <version> [--dry-run]");
    }

    const version = positional[0].trim();
    if (!isLikelySemver(version)) {
        fail(`Invalid version \"${version}\". Expected semver-like format, e.g. 0.2.0 or 1.0.0-beta.1`);
    }

    return { version, dryRun };
}

function main() {
    const { version, dryRun } = parseArgs(process.argv);

    const mcuPkg = readJson(MCU_DEBUG_PKG);
    const proxyPkg = readJson(MCU_DEBUG_PROXY_PKG);

    const oldMcuVersion = mcuPkg.version;
    const oldProxyVersion = proxyPkg.version;

    mcuPkg.version = version;
    proxyPkg.version = version;

    if (!dryRun) {
        writeJson(MCU_DEBUG_PKG, mcuPkg);
        writeJson(MCU_DEBUG_PROXY_PKG, proxyPkg);
    }

    const mode = dryRun ? "[dry-run] " : "";
    console.log(`${mode}Updated extension versions:`);
    console.log(`  packages/mcu-debug/package.json: ${oldMcuVersion} -> ${version}`);
    console.log(`  packages/mcu-debug-proxy/package.json: ${oldProxyVersion} -> ${version}`);
}

main();
