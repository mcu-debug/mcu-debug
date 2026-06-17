#!/usr/bin/env node
// Cross-platform wrapper for build-binaries.sh.
// On non-Windows: delegates to the bash script.
// On Windows (no WSL required): runs cargo directly via native toolchain.
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const mode = process.argv[2] || "dev";
const root = path.resolve(__dirname, "../../..");

if (process.platform !== "win32") {
    const script = path.join(root, "scripts", "build-binaries.sh");
    const result = spawnSync("bash", [script, mode], { cwd: root, stdio: "inherit", shell: false });
    process.exit(result.status ?? 1);
}

// ── Windows native path ────────────────────────────────────────────────────
// Only the 'dev' build is supported natively; 'prod' requires a Unix host.
if (mode !== "dev") {
    console.error(`Error: '${mode}' builds are only supported on macOS and Linux (requires bash).`);
    process.exit(1);
}

const rustDir = path.join(root, "packages", "mdbg");
const binDir = path.join(root, "packages", "mcu-debug", "bin");
const proxyBinDir = path.join(root, "packages", "mcu-debug-proxy", "bin");
const target = "x86_64-pc-windows-msvc";
const binName = "mdbg.exe";
const prettier = path.join(root, "node_modules", ".bin", "prettier.cmd");
const sharedDir = path.join(root, "packages", "shared");

function run(cmd, args, opts) {
    const result = spawnSync(cmd, args, { cwd: rustDir, stdio: "inherit", shell: false, ...opts });
    if (result.error) {
        console.error(result.error.message);
        process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Dev build (Windows native): building for host platform (debug)");

// Generate TypeScript exports via ts_rs
console.log("Generating TypeScript exports...");
run("cargo", ["test", "--lib", "da_helper::helper_requests::tests::ensure_ts_exports", "--quiet"]);
run("cargo", ["test", "--lib", "proxy_helper::proxy_server::tests::ensure_ts_exports", "--quiet"]);

// Format generated TS files with prettier (best-effort)
if (fs.existsSync(prettier)) {
    console.log("Formatting generated TypeScript exports...");
    spawnSync(prettier, ["--write", "--print-width", "120", path.join(sharedDir, "dasm-helper"), path.join(sharedDir, "proxy-protocol"), path.join(sharedDir, "serial-helper")], {
        stdio: "inherit",
        shell: true, // .cmd files require shell:true on Windows
    });
}

// Ensure the rustup target is installed
const targetCheck = spawnSync("rustup", ["target", "list", "--installed"], { cwd: rustDir, shell: false });
const installed = targetCheck.stdout ? targetCheck.stdout.toString() : "";
if (!installed.split("\n").some((l) => l.trim() === target)) {
    console.log(`Adding rust target: ${target}`);
    spawnSync("rustup", ["target", "add", target], { cwd: rustDir, stdio: "inherit", shell: false });
}

// Build
console.log(`Building debug helper for target: ${target}`);
run("cargo", ["build", "--bin", "mdbg", "--target", target]);

// Copy artifacts
const srcBin = path.join(rustDir, "target", target, "debug", binName);
fs.mkdirSync(binDir, { recursive: true });
if (fs.existsSync(srcBin)) {
    fs.copyFileSync(srcBin, path.join(binDir, binName));
    console.log(`Wrote: ${path.join(binDir, binName)}`);
} else {
    console.warn(`Warning: artifact not found: ${srcBin}`);
}

// Sync proxy binaries
fs.mkdirSync(proxyBinDir, { recursive: true });
for (const entry of fs.readdirSync(binDir)) {
    const src = path.join(binDir, entry);
    const dst = path.join(proxyBinDir, entry);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const sub of fs.readdirSync(src)) {
            fs.copyFileSync(path.join(src, sub), path.join(dst, sub));
        }
    } else {
        fs.copyFileSync(src, dst);
    }
}
console.log(`Synchronized helper binaries to: ${proxyBinDir}`);
console.log(`Dev build complete. Main binary: ${path.join(binDir, binName)}`);
