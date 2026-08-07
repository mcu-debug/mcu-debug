// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for ProxyClient's control-command plumbing: timeout ownership,
// pendingPromises hygiene, and error attribution. A fake proxy speaks the control
// protocol over TCP; no real `mdbg proxy` and no gdb-server are involved.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "net";

import { ProxyClient } from "../adapter/proxy-client";

function frame(streamId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt8(streamId, 0);
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

/** Answers control commands per policy: silence, error, or success. */
class FakeProxy {
    private server: net.Server;
    port = 0;
    sockets: net.Socket[] = [];

    constructor(private opts: { silent?: string[]; errors?: Record<string, string> } = {}) {
        this.server = net.createServer((socket) => {
            this.sockets.push(socket);
            let buf = Buffer.alloc(0);
            socket.on("data", (data) => {
                buf = Buffer.concat([buf, Buffer.from(data)]);
                while (buf.length >= 5) {
                    const len = buf.readUInt32LE(1);
                    if (buf.length < 5 + len) { break; }
                    const msg = JSON.parse(buf.subarray(5, 5 + len).toString("utf-8"));
                    buf = buf.subarray(5 + len);
                    if (this.opts.silent?.includes(msg.method)) { continue; }
                    const errMsg = this.opts.errors?.[msg.method];
                    const reply = errMsg !== undefined
                        ? { seq: msg.seq, success: false, message: errMsg }
                        : { seq: msg.seq, success: true, data: {} };
                    socket.write(frame(0, Buffer.from(JSON.stringify(reply))));
                }
            });
            socket.on("error", () => { });
        });
    }

    listen(): Promise<number> {
        return new Promise((resolve) => {
            this.server.listen(0, "127.0.0.1", () => {
                this.port = (this.server.address() as net.AddressInfo).port;
                resolve(this.port);
            });
        });
    }

    /** Drop every client connection without answering — simulates the proxy dying. */
    dropClients() {
        for (const s of this.sockets) { s.destroy(); }
    }

    close() {
        this.dropClients();
        this.server.close();
    }
}

// ProxyClient only reads session.args and logs through session.handleMsg.
function makeClient(): any {
    const session: any = {
        args: { debugFlags: { anyFlags: false }, name: "test", cwd: process.cwd() },
        handleMsg: () => { },
    };
    return new ProxyClient(session, {} as any);
}

async function connect(client: any, port: number): Promise<void> {
    assert.equal(await client.connectToProxy("127.0.0.1", port), true, "fake proxy must accept the connection");
}

test("a control command that is never answered times out, names itself, and leaks nothing", async (t) => {
    const fake = new FakeProxy({ silent: ["neverAnswered"] });
    await fake.listen();
    const client = makeClient();
    t.after(() => fake.close());

    await connect(client, fake.port);
    const before = client.pendingPromises.size;

    const cmd = { seq: client.nextSeq++, method: "neverAnswered" };
    const err = await client.sendControlCommand(cmd, 60).then(() => null, (e: Error) => e);

    assert.ok(err, "must reject");
    assert.match(err.message, /timed out after 60ms/, "reports a timeout");
    assert.match(err.message, /neverAnswered/, "names the method that hung");
    assert.match(err.message, new RegExp(`seq ${cmd.seq}`), "names the seq that hung");
    assert.equal(client.pendingPromises.size, before, "the timed-out entry must not be left behind");
});

test("an error reply is reported as the proxy's error, not as a timeout", async (t) => {
    const fake = new FakeProxy({ errors: { startGdbServer: "no such device" } });
    await fake.listen();
    const client = makeClient();
    t.after(() => fake.close());

    await connect(client, fake.port);
    const err = await client
        .sendControlCommand({ seq: client.nextSeq++, method: "startGdbServer" }, 2000)
        .then(() => null, (e: Error) => e);

    assert.ok(err, "must reject");
    assert.equal(err.message, "no such device", "surfaces the proxy's own message");
    assert.doesNotMatch(err.message, /timed out/, "a proxy error is not a timeout");
    assert.equal(client.pendingPromises.size, 0, "answered entry is removed");
});

test("a successful command settles and removes its pending entry", async (t) => {
    const fake = new FakeProxy();
    await fake.listen();
    const client = makeClient();
    t.after(() => fake.close());

    await connect(client, fake.port);
    await client.sendControlCommand({ seq: client.nextSeq++, method: "initialize" }, 2000);
    assert.equal(client.pendingPromises.size, 0, "no entry left after a normal response");
});

// Previously nothing cleared pendingPromises on teardown, so a dropped socket left every
// in-flight caller waiting on a promise that could never settle.
test("a dropped socket fails in-flight commands instead of hanging them", async (t) => {
    const fake = new FakeProxy({ silent: ["slowOne"] });
    await fake.listen();
    const client = makeClient();
    t.after(() => fake.close());

    await connect(client, fake.port);
    // No timeout at all: the socket closing is the only thing that can settle this.
    const inFlight = client.sendControlCommand({ seq: client.nextSeq++, method: "slowOne" }, 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.pendingPromises.size, 1, "command is in flight");

    fake.dropClients();
    const err = await inFlight.then(() => null, (e: Error) => e);

    assert.ok(err, "must reject rather than hang forever");
    assert.match(err.message, /Proxy connection closed/);
    assert.equal(client.pendingPromises.size, 0, "map is drained on close");
});

test("commands sent after the socket is gone reject immediately and name themselves", async (t) => {
    const fake = new FakeProxy();
    await fake.listen();
    const client = makeClient();
    t.after(() => fake.close());

    await connect(client, fake.port);
    fake.dropClients();
    await new Promise((r) => setTimeout(r, 30));

    const err = await client
        .sendControlCommand({ seq: client.nextSeq++, method: "endSession" }, 2000)
        .then(() => null, (e: Error) => e);

    assert.ok(err, "must reject");
    assert.match(err.message, /not connected/);
    assert.match(err.message, /endSession/, "names the command that could not be sent");
    assert.equal(client.pendingPromises.size, 0, "no entry created for a command that never went out");
});
