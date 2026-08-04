// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Integration test for `mdbg proxy --status` as an all-instance survey. Spawns
// real daemons into an isolated state dir and asserts the report lists every
// running instance (with `count`, not the old per-instance `ok`), and that a
// stale endpoint from a dead proxy is NOT reported as running.
//
// Runs via `npm run test:integration` (outside the fast `*.test.ts` glob).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const EXT_ROOT = path.resolve(__dirname, "../..");
const BIN = path.join(EXT_ROOT, "bin", "mdbg");
const HAVE_BIN = fs.existsSync(BIN);

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mdbg-status-"));
const env = { ...process.env, MDBG_PROXY_STATE_DIR: STATE_DIR };

function startInstance(name: string) {
    // Foreground launcher self-daemonizes and returns once the daemon is up.
    execFileSync(BIN, ["proxy", "--instance", name, "--port", "0"], { env, timeout: 10000, stdio: "ignore" });
}
function shutdownInstance(name: string) {
    try {
        execFileSync(BIN, ["proxy", "--shutdown", "--instance", name], { env, timeout: 8000, stdio: "ignore" });
    } catch { /* best effort */ }
}
function status(): { count: number; instances: Array<{ instance: string; pid: number; port: number; state: string }> } {
    return JSON.parse(execFileSync(BIN, ["proxy", "--status"], { env, timeout: 8000, encoding: "utf-8" }));
}
function shutdownAll(): { count: number; results: Array<{ instance: string; ok: boolean; message?: string }> } {
    return JSON.parse(execFileSync(BIN, ["proxy", "--shutdown", "--all"], { env, timeout: 8000, encoding: "utf-8" }));
}
async function waitForStatusCount(n: number, ms = 5000): Promise<void> {
    const start = Date.now();
    while (status().count !== n) {
        if (Date.now() - start > ms) { throw new Error(`status count did not reach ${n} (still ${status().count})`); }
        await new Promise((r) => setTimeout(r, 100));
    }
}

after(() => {
    shutdownInstance("alpha");
    shutdownInstance("beta");
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("proxy --status surveys all running instances", { skip: HAVE_BIN ? false : "mdbg binary not built" }, async () => {
    startInstance("alpha");
    startInstance("beta");

    const report = status();
    assert.equal(report.count, 2, `expected 2 running instances, got ${JSON.stringify(report)}`);
    assert.equal(report.count, report.instances.length, "count must equal the number of instances listed");
    const names = report.instances.map((i) => i.instance).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
    for (const inst of report.instances) {
        assert.ok(inst.pid > 0 && inst.port > 0, `instance has a live pid/port: ${JSON.stringify(inst)}`);
    }
});

test("proxy --shutdown --all drains every running instance", { skip: HAVE_BIN ? false : "mdbg binary not built" }, async () => {
    startInstance("alpha");
    startInstance("beta");
    assert.equal(status().count, 2, "two instances should be running before shutdown");

    const report = shutdownAll();
    assert.equal(report.count, 2, `expected to drain 2 instances, got ${JSON.stringify(report)}`);
    assert.deepEqual(report.results.map((r) => r.instance).sort(), ["alpha", "beta"]);
    assert.ok(report.results.every((r) => r.ok), "every drain request was accepted");

    // Idle proxies drain immediately; the survey should empty out.
    await waitForStatusCount(0);
});

test("proxy --status skips a stale endpoint from a dead proxy", { skip: HAVE_BIN ? false : "mdbg binary not built" }, async () => {
    startInstance("alpha");
    // Fabricate a stale instance: a dir with an endpoint.json pointing at a dead
    // pid/port. The survey must query it, get a refusal, and omit it.
    const ghostDir = path.join(STATE_DIR, "ghost");
    fs.mkdirSync(ghostDir, { recursive: true });
    fs.writeFileSync(path.join(ghostDir, "endpoint.json"), JSON.stringify({
        v: 1, instance: "ghost", pid: 999999, version: "0.1.9",
        port: 1, token: "x", state: "active", started_at_unix: 1,
    }));

    const report = status();
    const names = report.instances.map((i) => i.instance);
    assert.ok(names.includes("alpha"), "the live instance is reported");
    assert.ok(!names.includes("ghost"), `stale 'ghost' must not be reported as running: ${JSON.stringify(names)}`);
});
