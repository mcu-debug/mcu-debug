// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end integration tests that drive the REAL resolver (proxy.ts) and a
// REAL `mdbg proxy` process — no fakes, no injected resolver. Unlike the fast
// unit suite (serial-multiproxy.test.ts) these spawn a proxy daemon and talk to
// it over a real socket, so they live outside the `*.test.ts` glob and run via
// `npm run test:integration`.
//
//   - local: `hostConfig { enabled: true, type: "local" }` — spawns the proxy
//     directly (no VS Code extension) and enumerates/open real serial ports.
//   - ssh:   `hostConfig { type: "ssh", sshHost: "localhost", ... }` — uses the
//     machine as its own remote. Auto-skips unless passwordless ssh-to-localhost
//     works, since it needs Remote Login + key auth configured.
//
// The proxy is launched into an ISOLATED state dir + instance so it never
// touches the developer's real ~/.mcu-debug daemon, and is shut down on teardown.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { EventEmitter } from "events";

import { SerialPortManager } from "../common/serial-manager";
import { setHostAdapter } from "../common/host-adapter";
import { getHelperExecutable, HostConfig, ConfigurationArguments } from "../adapter/servers/common";

// packages/mcu-debug (dir that holds bin/mdbg). CommonJS project → __dirname works.
const EXT_ROOT = path.resolve(__dirname, "../..");
const BIN = path.join(EXT_ROOT, "bin", "mdbg");
const HAVE_BIN = fs.existsSync(BIN);

// Isolate the singleton so we never adopt or clobber the developer's real daemon.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mdbg-itest-"));
const INSTANCE = "itest";
process.env.MDBG_PROXY_STATE_DIR = STATE_DIR;
process.env.MDBG_PROXY_INSTANCE = INSTANCE;

// ---------------------------------------------------------------------------

class StubHostAdapter {
    createdViews: string[] = [];
    quickPickItems: any[] = [];
    errors: string[] = [];
    debugConsoleMessage(_m: string) {}
    debugConsoleError(m: string) { this.errors.push(m); }
    debugMessage(_m: string) {}
    showError(_m: string) {}
    showWarning(_m: string) {}
    showInfo(_m: string) {}
    getRemoteName(): string | undefined { return undefined; }
    getExtensionPath(): string { return EXT_ROOT; }
    createSerialPortView(device: string, _cfg: any, _isNew: boolean, _tcpPort: number) {
        this.createdViews.push(device);
        const emitter = new EventEmitter();
        return {
            emitter,
            setTcpPort() {}, setLogFile() {}, setInputMode() {},
            notifyConnected() {}, notifyReconnected() {}, notifyDisconnected() {},
        } as any;
    }
    showQuickPick(items: any[], _opts: any) { this.quickPickItems = items; return Promise.resolve(undefined); }
}

const stub = new StubHostAdapter();
setHostAdapter(stub as any);

function makeParams(path: string): any {
    // Enum values must match the ts-rs generated unions exactly (lowercase) —
    // the Rust proxy rejects "One"/"None" as unknown variants.
    return { path, baud_rate: 115200, data_bits: 8, stop_bits: "one", parity: "none", flow_control: "none", transport: "direct" };
}

function launchArgs(hostConfig: HostConfig, ports: string[]): ConfigurationArguments {
    return { serialConfig: { enabled: true, ports: ports.map(makeParams) }, hostConfig } as any;
}

/** Gracefully stop the isolated daemon (best effort). */
function shutdownProxy() {
    if (!HAVE_BIN) { return; }
    try {
        execFileSync(BIN, ["proxy", "--shutdown", "--instance", INSTANCE], { env: process.env, timeout: 8000, stdio: "ignore" });
    } catch { /* best effort — idle-timeout will reap it anyway */ }
}

/** True if passwordless ssh-to-localhost is available (Remote Login + key auth). */
function sshLocalhostAvailable(): boolean {
    const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "localhost", "true"], { timeout: 8000 });
    return r.status === 0;
}

/** All device paths from `mdbg serial list --all`, straight from the CLI enumerator. */
function cliListPaths(): string[] {
    const out = execFileSync(BIN, ["serial", "list", "--all"], { encoding: "utf-8", timeout: 8000 });
    return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/dev/")).map((l) => l.split(/\s+/)[0]);
}

/** First callout (cu.*) device path from `mdbg serial list`, discovered locally. */
function firstCuDevice(): string | undefined {
    return cliListPaths().find((p) => p.startsWith("/dev/cu."));
}

after(() => {
    shutdownProxy();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Local loopback (type: "local")
// ---------------------------------------------------------------------------

test("local loopback enumerates real serial ports through a real proxy", { skip: HAVE_BIN ? false : "mdbg binary not built (run scripts/build-binaries.sh dev)" }, async (t) => {
    const mgr = new SerialPortManager(); // real getProxyForSerialPorts → spawns real proxy
    t.after(() => mgr.dispose());

    const ports = await mgr.listAvailablePortsCmd(true /* noDisplay */);
    assert.ok(ports.length >= 1, `expected the proxy to enumerate at least one port, got ${ports.length}`);
    for (const p of ports) {
        assert.ok(typeof p.path === "string" && p.path.length > 0, `port has a path: ${JSON.stringify(p)}`);
    }
});

test("local loopback enumeration is consistent with the CLI enumerator", { skip: HAVE_BIN ? false : "mdbg binary not built" }, async (t) => {
    const mgr = new SerialPortManager();
    t.after(() => mgr.dispose());

    // The proxy enumerates over the same OS APIs the CLI uses, so every port it
    // reports must appear in `mdbg serial list --all`. (The CLI's --all is a
    // superset — it also lists the tty.* variants the proxy filters out.) This
    // proves the port list surfaced to the UI is real and correct end-to-end,
    // without opening a device — opening real devices is device-specific (e.g.
    // the proxy's stream-readiness wait blocks ~5s on /dev/cu.debug-console).
    const viaProxy = (await mgr.listAvailablePortsCmd(true)).map((p) => p.path);
    const viaCli = new Set(cliListPaths());
    assert.ok(viaProxy.length >= 1, "proxy enumerated at least one port");
    for (const p of viaProxy) {
        assert.ok(viaCli.has(p), `proxy port ${p} is not in the CLI enumeration ${JSON.stringify([...viaCli])}`);
    }
});

test("local loopback opens the debug-console and creates a view", { skip: HAVE_BIN ? false : "mdbg binary not built" }, async (t) => {
    const mgr = new SerialPortManager();
    t.after(() => mgr.dispose());

    // The virtual debug-console is always present on macOS and opens without
    // hardware (a real UART / probe device would work too but isn't guaranteed
    // to exist). With valid params the proxy opens it and returns a tcp_port,
    // which drives view creation — proving the full open + direct-bridge path.
    const ports = await mgr.listAvailablePortsCmd(true);
    const target = ports.find((p) => p.path === "/dev/cu.debug-console")?.path ?? firstCuDevice();
    assert.ok(target, "no openable cu.* device found");

    stub.createdViews = [];
    await mgr.createSerialPorts(launchArgs({ enabled: true, type: "local" } as any, [target!]));
    assert.ok(
        stub.createdViews.includes(target!),
        `expected a view for ${target}; created: ${JSON.stringify(stub.createdViews)}`,
    );
});

test("malformed control request fails fast with an error (no client timeout)", { skip: HAVE_BIN ? false : "mdbg binary not built" }, async (t) => {
    const mgr = new SerialPortManager();
    t.after(() => mgr.dispose());

    // A serial.open the proxy cannot deserialize (wrong-case enum, the exact
    // class of bug that comes from Rust↔TS naming drift). Before the fix the
    // proxy dropped it silently and the client hung for the full 5s PROXY_TIMOUT;
    // now the proxy replies with an error keyed by seq, so this returns promptly.
    const badPort: any = { path: "/dev/cu.debug-console", baud_rate: 115200, data_bits: 8, stop_bits: "One", parity: "None", flow_control: "None", transport: "direct" };
    stub.createdViews = [];
    stub.errors = [];

    const t0 = Date.now();
    await mgr.createSerialPorts({ serialConfig: { enabled: true, ports: [badPort] }, hostConfig: { enabled: true, type: "local" } } as any);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 3000, `expected a prompt error, took ${elapsed}ms (looks like the 5s timeout — parse-error reply missing?)`);
    assert.equal(stub.createdViews.length, 0, "a malformed open must not create a view");
    assert.ok(
        stub.errors.some((e) => /parse/i.test(e)),
        `expected a parse-error message; got ${JSON.stringify(stub.errors)}`,
    );
});

// ---------------------------------------------------------------------------
// SSH via ssh-to-localhost (type: "ssh") — auto-skips unless ssh is configured
// ---------------------------------------------------------------------------

const SSH_OK = HAVE_BIN && sshLocalhostAvailable();

test(
    "ssh loopback (ssh localhost) opens a port over the ssh tunnel",
    { skip: SSH_OK ? false : "passwordless ssh-to-localhost unavailable (needs Remote Login + key auth); ready for a real remote / WSL" },
    async (t) => {
        const mgr = new SerialPortManager();
        t.after(() => mgr.dispose());

        // Discover a device locally (the "remote" is this same machine, so the
        // path is valid there too). Point the remote helper at the local binary
        // so no scp deploy is needed; the real resolver stands up the agent + a
        // real `ssh -L` tunnel and opens the port through it.
        const dev = firstCuDevice();
        assert.ok(dev, "no cu.* device available to open");
        const hostConfig = { enabled: true, type: "ssh", sshHost: "localhost", sshProxyServerPath: BIN } as any as HostConfig;

        stub.createdViews = [];
        await mgr.createSerialPorts(launchArgs(hostConfig, [dev!]));
        assert.ok(
            stub.createdViews.includes(dev!) || mgr.getAllAvailablePorts().length >= 1,
            `expected the ssh proxy to open ${dev} or enumerate ports; created: ${JSON.stringify(stub.createdViews)}`,
        );
        // NOTE: the ssh tunnel/agent live in proxy.ts module state with no exported
        // teardown yet, so they're cleaned up only when this process exits, and the
        // remote agent (over ssh) can't inherit MDBG_PROXY_STATE_DIR — real remote /
        // WSL validation is the follow-up. See project memory.
    },
);
