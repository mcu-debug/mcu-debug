// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as assert from "assert";
import * as net from "net";
import { test } from "node:test";

import { probeProxyAlive, quoteRemotePath } from "../common/proxy";

/** Frame a control-channel payload the way the Rust agent does: u8 stream_id, u32LE len, JSON. */
function frame(obj: unknown, streamId = 0): Buffer {
    const payload = Buffer.from(JSON.stringify(obj), "utf-8");
    const header = Buffer.alloc(5);
    header.writeUInt8(streamId, 0);
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

/** Listens on loopback and hands each connection to `onConn`. Resolves with the bound port. */
async function withServer(
    onConn: (socket: net.Socket) => void,
    body: (port: number) => Promise<void>,
): Promise<void> {
    const server = net.createServer(onConn);
    const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
        await body(port);
    } finally {
        server.close();
    }
}

test("probeProxyAlive: agent answering heartbeat is alive", async () => {
    await withServer(
        (socket) => {
            socket.on("data", () => socket.write(frame({ seq: 1, success: true, message: null, data: "heartbeat" })));
        },
        async (port) => {
            assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), true);
        },
    );
});

test("probeProxyAlive: reply split across packets is still read", async () => {
    await withServer(
        (socket) => {
            socket.on("data", () => {
                const buf = frame({ seq: 1, success: true, message: null, data: "heartbeat" });
                // Header split from body, and the header itself torn — the case a naive
                // "first chunk is the whole reply" reader gets wrong.
                socket.write(buf.subarray(0, 2));
                setTimeout(() => socket.write(buf.subarray(2, 7)), 10);
                setTimeout(() => socket.write(buf.subarray(7)), 20);
            });
        },
        async (port) => {
            assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), true);
        },
    );
});

test("probeProxyAlive: nothing listening is dead", async () => {
    // Bind and immediately release, so the port is almost certainly unused.
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), false);
});

test("probeProxyAlive: accepts then closes without answering is dead", async () => {
    // What `ssh -L` does when the remote refuses the channel: our connect() succeeds,
    // then the connection is dropped. The bug this whole probe exists to catch.
    await withServer(
        (socket) => socket.destroy(),
        async (port) => {
            assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), false);
        },
    );
});

test("probeProxyAlive: accepts but never answers times out as dead", async () => {
    const held: net.Socket[] = [];
    await withServer(
        (socket) => held.push(socket), // hold it open, say nothing
        async (port) => {
            const started = Date.now();
            assert.equal(await probeProxyAlive("127.0.0.1", port, 300), false);
            assert.ok(Date.now() - started >= 250, "should have waited for the timeout");
        },
    );
    held.forEach((s) => s.destroy());
});

test("probeProxyAlive: unrelated process that grabbed the port is not our agent", async () => {
    // A recycled port with something else on it. A banner is data, but it is not a
    // matching heartbeat response, so it must not count as alive.
    await withServer(
        (socket) => socket.write("SSH-2.0-OpenSSH_9.6\r\n"),
        async (port) => {
            assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), false);
        },
    );
});

test("probeProxyAlive: response to a different seq does not count", async () => {
    await withServer(
        (socket) => {
            socket.on("data", () => socket.write(frame({ seq: 99, success: true, message: null, data: "heartbeat" })));
        },
        async (port) => {
            assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), false);
        },
    );
});

test("probeProxyAlive: an error response is not alive-enough", async () => {
    await withServer(
        (socket) => {
            socket.on("data", () => socket.write(frame({ seq: 1, success: false, message: "nope", data: null })));
        },
        async (port) => {
            assert.equal(await probeProxyAlive("127.0.0.1", port, 2000), false);
        },
    );
});

test("probeProxyAlive: sends a well-formed heartbeat on the control channel", async () => {
    let received: Buffer = Buffer.alloc(0);
    await withServer(
        (socket) => {
            socket.on("data", (d: Buffer) => {
                received = Buffer.concat([received, d]);
                socket.write(frame({ seq: 1, success: true, message: null, data: "heartbeat" }));
            });
        },
        async (port) => {
            await probeProxyAlive("127.0.0.1", port, 2000);
        },
    );
    assert.equal(received.readUInt8(0), 0, "stream_id must be the control channel");
    const len = received.readUInt32LE(1);
    assert.equal(received.length, 5 + len, "declared length must match the payload");
    assert.deepEqual(JSON.parse(received.subarray(5).toString("utf-8")), { seq: 1, method: "heartbeat" });
});

// ── quoteRemotePath ───────────────────────────────────────────────────────────
// Exercised through the exported helper because the remote command it builds is the
// only thing standing between us and a Windows `ssh.serverPath` host.

test("quoteRemotePath: a Windows path with spaces survives as one argument", () => {
    assert.equal(quoteRemotePath("C:\\Program Files\\mcu-debug\\mdbg.exe"), '"C:\\Program Files\\mcu-debug\\mdbg.exe"');
});

test("quoteRemotePath: double quotes, so cmd.exe honours them too", () => {
    // Single quotes are not quoting to cmd.exe; it would treat them as part of the name.
    const q = quoteRemotePath("/opt/mcu debug/mdbg");
    assert.ok(q.startsWith('"') && q.endsWith('"'), `expected double quotes, got ${q}`);
    assert.ok(!q.includes("'"), "must not use single quotes");
});

test("quoteRemotePath: a ~-relative path keeps its tilde unquoted", () => {
    // Tilde expansion only happens on an unquoted tilde; quoting the whole thing would
    // make the remote shell look for a file literally named "~/...".
    assert.equal(quoteRemotePath("~/.mcu-debug/bin/mdbg"), '~/".mcu-debug/bin/mdbg"');
});

test("quoteRemotePath: the built-in default still expands and still quotes", () => {
    const q = quoteRemotePath("~/my tools/mdbg");
    assert.equal(q, '~/"my tools/mdbg"');
    assert.ok(q.startsWith("~/"), "tilde must remain outside the quotes to expand");
});
