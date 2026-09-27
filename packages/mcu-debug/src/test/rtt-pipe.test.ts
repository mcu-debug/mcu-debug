// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the `pipe` RTT decoder and the throughput measurement it exists to make possible.
//
// No probe, no gdb-server and no TCP: `RTTPipeSource` is a decorator over a source, so an
// upstream source that is never started and has `data` emitted on it by hand is exactly what it
// sees in a real session. The child process is real, because "does the program actually receive
// the bytes" is the thing being tested.

import test from "node:test";
import assert from "node:assert/strict";

import { setHostAdapter } from "../common/host-adapter";
import { SocketRTTSource } from "../common/swo/sources/socket";
import { RTTPipeSource } from "../common/rtt-pipe";
import { ThroughputMonitor, fmtBytes } from "../common/throughput-monitor";

/** Whatever the pipe reports to the debug console, so a test can read it back. */
const consoleLines: string[] = [];
setHostAdapter({
    debugConsoleMessage: (msg: string) => consoleLines.push(msg),
    debugMessage: (msg: string) => consoleLines.push(msg),
    showError: (msg: string) => consoleLines.push(`ERROR ${msg}`),
} as any);

/** An upstream RTT source that is never connected; `emit("data")` stands in for the socket. */
function fakeUpstream(channel = 0): SocketRTTSource {
    return new SocketRTTSource(channel, "1234");
}

/** A child process that copies stdin to stdout, spelled portably. */
function passthrough(): { program: string; args: string[] } {
    return { program: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"] };
}

async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

test("the pipe program receives the channel's bytes and its output becomes the source's data", async () => {
    const upstream = fakeUpstream(0);
    const pipe = new RTTPipeSource(upstream, { type: "pipe", port: 0, tcpPort: "1234", ...passthrough(), stats: false });
    await pipe.start();
    try {
        const seen: Buffer[] = [];
        pipe.on("data", (d: Buffer) => seen.push(d));

        upstream.emit("data", Buffer.from("hello "));
        upstream.emit("data", Buffer.from("world"));

        await waitFor(() => Buffer.concat(seen).toString() === "hello world", "the program's output");
    } finally {
        pipe.dispose();
    }
});

test("with no program the bytes pass through, so a pipe decoder is also a plain console", async () => {
    // This is what makes `{ "type": "pipe", "stats": true }` useful on its own: a terminal that
    // reports its rate, with nothing else in the path.
    const upstream = fakeUpstream(1);
    const pipe = new RTTPipeSource(upstream, { type: "pipe", port: 1, tcpPort: "1234", stats: false });
    await pipe.start();
    try {
        const seen: Buffer[] = [];
        pipe.on("data", (d: Buffer) => seen.push(d));
        upstream.emit("data", Buffer.from("raw"));
        assert.equal(Buffer.concat(seen).toString(), "raw");
    } finally {
        pipe.dispose();
    }
});

test('output "none" counts the bytes and emits nothing', async () => {
    // The measurement configuration: no program, no terminal, nothing downstream of the counter.
    const upstream = fakeUpstream(2);
    const pipe = new RTTPipeSource(upstream, { type: "pipe", port: 2, tcpPort: "1234", output: "none", stats: true });
    await pipe.start();
    try {
        let emitted = 0;
        pipe.on("data", () => emitted++);
        for (let i = 0; i < 10; i++) {
            upstream.emit("data", Buffer.alloc(1024));
        }
        assert.equal(emitted, 0, "nothing may be forwarded when there is no consumer");

        consoleLines.length = 0;
        pipe.dispose(); // flushes the window and the session average
        const stats = consoleLines.filter((l) => l.includes("stats"));
        assert.ok(stats.length >= 1, `expected a stats line, got ${JSON.stringify(consoleLines)}`);
        assert.ok(
            stats.some((l) => l.includes("10.00 KB")),
            `expected 10 KB to be reported, got ${JSON.stringify(stats)}`,
        );
    } finally {
        pipe.dispose();
    }
});

test("terminal input goes to the target, not to the pipe program", async () => {
    // The program is a decoder, not a shell. Sending it keyboard input would make the RTT down
    // channel unreachable for any channel that has a pipe on it.
    const upstream = fakeUpstream(3);
    const written: string[] = [];
    (upstream as any).write = (d: string) => written.push(d);
    const pipe = new RTTPipeSource(upstream, { type: "pipe", port: 3, tcpPort: "1234", ...passthrough(), stats: false });
    await pipe.start();
    try {
        pipe.write("go\n");
        assert.deepEqual(written, ["go\n"]);
    } finally {
        pipe.dispose();
    }
});

test("a program that cannot be started is reported and does not silently swallow the channel", async () => {
    const upstream = fakeUpstream(4);
    const pipe = new RTTPipeSource(upstream, { type: "pipe", port: 4, tcpPort: "1234", program: "no-such-program-xyzzy", args: [], stats: false });
    consoleLines.length = 0;
    await assert.rejects(() => pipe.start(), /no-such-program-xyzzy/);
    assert.ok(
        consoleLines.some((l) => l.startsWith("ERROR")),
        "the failure must reach the user",
    );
    pipe.dispose();
});

test("the upstream closing kills the child and reports the session average", async () => {
    const upstream = fakeUpstream(5);
    const pipe = new RTTPipeSource(upstream, { type: "pipe", port: 5, tcpPort: "1234", ...passthrough(), stats: true });
    await pipe.start();
    upstream.emit("data", Buffer.alloc(2048));

    consoleLines.length = 0;
    upstream.emit("disconnected");
    assert.ok(
        consoleLines.some((l) => l.includes("session average")),
        `expected a session average, got ${JSON.stringify(consoleLines)}`,
    );
});

test("an idle gap is not averaged into the window rate", () => {
    // The reason the window starts at its first byte rather than at the previous report. A
    // channel that is quiet and then bursts must not read as slow -- that is the opposite of what
    // happened, and it is the measurement being trusted to compare gdb-servers.
    const lines: string[] = [];
    const m = new ThroughputMonitor((msg) => lines.push(msg), "test", 0); // report on every record
    m.record(Buffer.alloc(1000));
    m.flush();
    assert.equal(lines.length, 1);
    // 1000 bytes in effectively no time: the rate must be large, not 1000/(seconds since start).
    const match = lines[0].match(/([\d.]+) (B|KB|MB)\/sec/);
    assert.ok(match, `no rate in ${lines[0]}`);
    assert.ok(match![2] !== "B", `rate collapsed to bytes/sec: ${lines[0]}`);
});

test("an idle monitor reports nothing rather than reporting zero", () => {
    const lines: string[] = [];
    const m = new ThroughputMonitor((msg) => lines.push(msg), "test");
    m.flush();
    assert.deepEqual(lines, [], "a flush with no data must be silent");
});

test("uptime spans the whole run, not just the last window", async () => {
    // It used to be reset at the start of every window, so it always read as one window length.
    const lines: string[] = [];
    const m = new ThroughputMonitor((msg) => lines.push(msg), "test", 0);
    m.record(Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 60));
    m.record(Buffer.alloc(10));
    m.flush();
    const last = lines[lines.length - 1];
    const match = last.match(/over ([\d.]+)s/);
    assert.ok(match, `no uptime in ${last}`);
    assert.ok(parseFloat(match![1]) >= 0.05, `uptime did not span the run: ${last}`);
});

test("byte counts are printed in units a person can read", () => {
    assert.equal(fmtBytes(512), "512 B");
    assert.equal(fmtBytes(70 * 1024), "70.00 KB");
    assert.equal(fmtBytes(3 * 1024 * 1024), "3.00 MB");
});
