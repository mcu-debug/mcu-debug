// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// The funnel stream listener is a byte pipe. These tests pin that bytes buffered
// before a client connects survive intact, and that the listener's port is not
// reported until it is actually bound.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "net";

import { ProxySerialTcpServer } from "../common/serial-manager";

// ProxySerialTcpServer only uses the connection for logging on this path.
const stubConn = { logInfo() { }, logError() { } } as any;

function collect(port: number, want: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const got: Buffer[] = [];
        let n = 0;
        const s = net.createConnection(port, "127.0.0.1");
        s.on("data", (chunk: string | Buffer) => {
            // No encoding is set on this socket, so chunks are always Buffers. Narrowing
            // rather than casting keeps the byte-for-byte assertion honest.
            const d = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary");
            got.push(d);
            n += d.length;
            if (n >= want) { s.end(); resolve(Buffer.concat(got)); }
        });
        s.on("error", reject);
    });
}

test("bytes buffered before a client connects survive byte-for-byte", async (t) => {
    const server = new ProxySerialTcpServer("127.0.0.1", "/dev/fake", 3, stubConn);
    t.after(() => server.close());

    // A valid multi-byte character deliberately split across two chunks, the way TCP
    // segmentation does it, plus bytes that are not valid UTF-8 at all (defmt frames,
    // binary RTT). `data.toString()` mangled both.
    const euro = Buffer.from("€", "utf-8"); // e2 82 ac
    const first = Buffer.concat([Buffer.from("boot: "), euro.subarray(0, 2)]);
    const second = Buffer.concat([euro.subarray(2), Buffer.from([0x00, 0xff, 0x80, 0xfe, 0x01])]);
    const expected = Buffer.concat([first, second]);

    // Nothing is connected yet -- this is the window the proxy's ring replay lands in.
    server.dataFromServer(first, 3);
    server.dataFromServer(second, 3);

    const port = await server.whenReady();
    assert.ok(port > 0, "whenReady must resolve the bound port");

    const received = await collect(port, expected.length);
    assert.deepEqual(received, expected, "buffered bytes must arrive unchanged");
});

test("whenReady resolves the same port getPort reports once bound", async (t) => {
    const server = new ProxySerialTcpServer("127.0.0.1", "/dev/fake", 4, stubConn);
    t.after(() => server.close());

    // The bug this guards: getPort() read immediately returns 0 because listen() is async,
    // which made the caller conclude "no TCP port assigned" and skip creating the view.
    assert.equal(server.getPort(), 0, "port is genuinely unknown before listen() binds");
    const port = await server.whenReady();
    assert.ok(port > 0);
    assert.equal(server.getPort(), port, "getPort agrees once bound");
});
