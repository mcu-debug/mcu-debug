// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for stream lifetimes in ProxyClient/RemoteServer: closing one consumer
// must not close the others, and a consumer that goes away on its own must be reported to
// the Agent so it can release its own connection to the gdb-server.
//
// A fake proxy speaks the control protocol over TCP and answers startStream/duplicateStream
// the way the real Agent does. No `mdbg proxy` and no gdb-server are involved. Real loopback
// sockets are used for the consumers, because the bug being pinned is about which of them
// survives.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "net";

import { ProxyClient, PortReservedInfo, RemoteServer } from "../adapter/proxy-client";

function frame(streamId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt8(streamId, 0);
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

/** The id the fake hands out for a duplicateStream, mirroring the Agent minting a fresh one. */
const DUP_STREAM_ID = 11;

class FakeProxy {
    private server: net.Server;
    port = 0;
    sockets: net.Socket[] = [];
    /** Every control request received, in order, so a test can assert what was sent. */
    seen: { method: string; params: any }[] = [];

    constructor() {
        this.server = net.createServer((socket) => {
            this.sockets.push(socket);
            let buf = Buffer.alloc(0);
            socket.on("data", (data) => {
                buf = Buffer.concat([buf, Buffer.from(data)]);
                while (buf.length >= 5) {
                    const len = buf.readUInt32LE(1);
                    if (buf.length < 5 + len) {
                        break;
                    }
                    const msg = JSON.parse(buf.subarray(5, 5 + len).toString("utf-8"));
                    buf = buf.subarray(5 + len);
                    this.seen.push({ method: msg.method, params: msg.params });
                    socket.write(frame(0, Buffer.from(JSON.stringify(this.reply(msg)))));
                }
            });
            socket.on("error", () => {});
        });
    }

    private reply(msg: any): any {
        // startStream keeps the requested id; duplicateStream gets a fresh one, as the Agent does.
        if (msg.method === "startStream" || msg.method === "duplicateStream") {
            const stream_id = msg.method === "duplicateStream" ? DUP_STREAM_ID : msg.params.stream_id;
            return {
                seq: msg.seq,
                success: true,
                data: { streamStatus: { stream_id, status: "Connected", msg_seq: msg.seq } },
            };
        }
        return { seq: msg.seq, success: true, data: {} };
    }

    methods(name: string): { method: string; params: any }[] {
        return this.seen.filter((r) => r.method === name);
    }

    listen(): Promise<number> {
        return new Promise((resolve) => {
            this.server.listen(0, "127.0.0.1", () => {
                this.port = (this.server.address() as net.AddressInfo).port;
                resolve(this.port);
            });
        });
    }

    close() {
        for (const s of this.sockets) {
            s.destroy();
        }
        this.server.close();
    }
}

function makeClient(): any {
    const session: any = {
        args: { debugFlags: { anyFlags: false }, name: "test", cwd: process.cwd() },
        handleMsg: () => {},
    };
    return new ProxyClient(session, {} as any);
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

async function freePort(): Promise<number> {
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
}

const ORIGINAL_STREAM_ID = 3;

/**
 * Build the state a session reaches once its gdb port is serving two consumers: a listener on a
 * local port, the original consumer, and a duplicate. Uses the real connection path -- the
 * `net.createServer` callback, `startStream` and `duplicateStream` -- so the ids and bookkeeping are
 * arrived at the way a session arrives at them.
 */
async function twoConsumers(): Promise<{
    fake: FakeProxy;
    client: any;
    server: RemoteServer;
    localPort: number;
    first: net.Socket;
    second: net.Socket;
    cleanup: () => void;
}> {
    const fake = new FakeProxy();
    await fake.listen();
    const client = makeClient();
    assert.equal(await client.connectToProxy("127.0.0.1", fake.port), true);

    const localPort = await freePort();
    const pInfo = new PortReservedInfo(2331, ORIGINAL_STREAM_ID, "gdbPort", "ready");
    const portDef: any = { name: "gdbPort", localPort, remotePort: 2331 };
    const server = new RemoteServer(client, portDef, pInfo);

    client.clientStreams.set(ORIGINAL_STREAM_ID, server);
    client.streamIdToPortInfo.set(ORIGINAL_STREAM_ID, pInfo);
    await server.initialize();

    const first = net.createConnection({ host: "127.0.0.1", port: localPort });
    await new Promise<void>((resolve) => first.once("connect", () => resolve()));
    await waitFor(() => fake.methods("startStream").length === 1, "startStream");

    const second = net.createConnection({ host: "127.0.0.1", port: localPort });
    await new Promise<void>((resolve) => second.once("connect", () => resolve()));
    await waitFor(() => fake.methods("duplicateStream").length === 1, "duplicateStream");
    await waitFor(() => client.clientStreams.has(DUP_STREAM_ID), "the duplicate to be registered");

    return {
        fake,
        client,
        server,
        localPort,
        first,
        second,
        cleanup: () => {
            first.destroy();
            second.destroy();
            server.close();
            fake.close();
        },
    };
}

/** True when a fresh connection to `port` is accepted, i.e. the listener is still bound. */
async function accepts(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createConnection({ host: "127.0.0.1", port });
        probe.once("connect", () => {
            probe.destroy();
            resolve(true);
        });
        probe.once("error", () => resolve(false));
    });
}

test("closing a duplicate stream leaves the original consumer and the listener alone", async () => {
    // The bug: handleStreamClosed called RemoteServer.close(), which destroys every socket on the
    // listener and unbinds the local port -- so the live-watch GDB stopping took the primary GDB
    // down with it. Only the duplicate may go.
    const rig = await twoConsumers();
    try {
        rig.client.handleStreamClosed(DUP_STREAM_ID);

        await waitFor(() => rig.second.destroyed, "the duplicate's socket to be destroyed");
        assert.equal(rig.first.destroyed, false, "the original consumer must survive");
        assert.equal(await accepts(rig.localPort), true, "the listener must still be bound");
        assert.equal(rig.client.clientStreams.has(ORIGINAL_STREAM_ID), true, "the original must stay registered");
        assert.equal(rig.client.clientStreams.has(DUP_STREAM_ID), false, "the duplicate must be forgotten");
    } finally {
        rig.cleanup();
    }
});

test("closing the original stream takes the listener down", async () => {
    // Pins today's behaviour so the split above cannot change it by accident. The listener belongs
    // to the original stream's port reservation, so that one does dismantle everything. Making it
    // re-openable instead is a separate decision (gdb-rsp.md item 15c).
    const rig = await twoConsumers();
    try {
        rig.client.handleStreamClosed(ORIGINAL_STREAM_ID);

        await waitFor(() => rig.first.destroyed && rig.second.destroyed, "both consumers to be destroyed");
        assert.equal(await accepts(rig.localPort), false, "the listener must be unbound");
    } finally {
        rig.cleanup();
    }
});

test("closing the original also releases the duplicates on its listener", async () => {
    // The listener belongs to the original, so taking it down takes every duplicate on it down
    // too -- locally. The Agent is told about the original by *sending* us this event; it knows
    // nothing about the duplicates, and each one it still believes in holds a connection to the
    // gdb-server and a -gdb-max-connections slot with it. close() sets endingSession before
    // destroying sockets, so cleanupSocket cannot be what reports them.
    const rig = await twoConsumers();
    try {
        rig.client.handleStreamClosed(ORIGINAL_STREAM_ID);

        await waitFor(() => rig.fake.methods("closeStream").length === 1, "a closeStream request");
        const ids = rig.fake.methods("closeStream").map((r) => r.params.stream_id);
        assert.deepEqual(ids, [DUP_STREAM_ID], "only the duplicate needs reporting");
    } finally {
        rig.cleanup();
    }
});

test("a consumer that goes away on its own is reported to the agent", async () => {
    // The Agent cannot see this: the consumer's socket terminates on the client side. Without the
    // report it keeps its own connection to the gdb-server open for a reader that has left, which for
    // a duplicated gdb stream holds a -gdb-max-connections slot for the rest of the session.
    const rig = await twoConsumers();
    try {
        rig.second.destroy();

        await waitFor(() => rig.fake.methods("closeStream").length === 1, "a closeStream request");
        assert.equal(rig.fake.methods("closeStream")[0].params.stream_id, DUP_STREAM_ID);
        assert.equal(rig.first.destroyed, false, "the original consumer must be unaffected");
        assert.equal(await accepts(rig.localPort), true, "the listener must still be bound");
    } finally {
        rig.cleanup();
    }
});

test("a close we performed ourselves is not reported back to the agent", async () => {
    // handleStreamClosed runs because the Agent told us the stream is gone. Reporting it back would
    // be asking for a close that already happened. closeStream() and close() both unregister the
    // consumer before destroying its socket, which is what keeps cleanupSocket quiet.
    const rig = await twoConsumers();
    try {
        rig.client.handleStreamClosed(DUP_STREAM_ID);
        await waitFor(() => rig.second.destroyed, "the duplicate's socket to be destroyed");
        await new Promise((r) => setTimeout(r, 50)); // let any stray request arrive

        assert.equal(rig.fake.methods("closeStream").length, 0, "no closeStream should have been sent");
    } finally {
        rig.cleanup();
    }
});
