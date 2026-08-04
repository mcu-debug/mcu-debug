// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for the multi-proxy serial refactor. Each test stands up one
// or more in-process fake proxies that speak the control protocol over TCP, then
// drives the real ProxyConnection / SerialPortManager against them. No hardware
// and no real `mdbg proxy` are involved — the proxy is faked at the wire.

import test from "node:test";
import assert from "node:assert/strict";
import * as net from "net";
import { EventEmitter } from "events";

import {
    ProxyConnection,
    SerialPortManager,
    ProxyResolver,
} from "../common/serial-manager";
import { setHostAdapter } from "../common/host-adapter";
import { HostConfig, ConfigurationArguments } from "../adapter/servers/common";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface CreatedView {
    device: string;
    tcpPort: number;
}

// Records every host-adapter interaction the manager makes so tests can assert
// on views created and picker items shown, without a real VS Code / CLI surface.
class StubHostAdapter {
    createdViews: CreatedView[] = [];
    quickPickItems: any[] = [];
    debugMessage(_m: string) { }
    showError(_m: string) { }
    showWarning(_m: string) { }
    showInfo(_m: string) { }
    getRemoteName(): string | undefined { return undefined; }
    getExtensionPath(): string { return "/tmp/ext"; }
    createSerialPortView(device: string, _cfg: any, _isNew: boolean, tcpPort: number) {
        this.createdViews.push({ device, tcpPort });
        const emitter = new EventEmitter();
        return {
            emitter,
            setTcpPort() { },
            setLogFile() { },
            setInputMode() { },
            notifyConnected() { },
            notifyReconnected() { },
            notifyDisconnected() { },
        } as any;
    }
    showQuickPick(items: any[], _opts: any) {
        this.quickPickItems = items;
        return Promise.resolve(undefined);
    }
}

function avail(path: string, description = ""): any {
    return { path, description, vid: null, pid: null, serial: null };
}

function makeParams(path: string): any {
    // transport is overwritten by ProxyConnection; the rest are just placeholders.
    return {
        path,
        baud_rate: 115200,
        data_bits: 8,
        stop_bits: "One",
        parity: "None",
        flow_control: "None",
        transport: "direct",
    };
}

function frame(streamId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt8(streamId, 0);
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

// A minimal proxy that implements just enough of the control protocol for the
// client to connect, subscribe, list, and open ports.
class FakeProxy {
    private server: net.Server;
    port = 0;
    sockets: net.Socket[] = [];
    opens: any[] = []; // captured serial.open params (incl. the transport the client chose)
    private nextTcp = 40000;
    // Per-socket outgoing queue. Every frame is enqueued whole and drained in
    // order, so when splitWrites is on we can chop a single frame into separate
    // TCP segments WITHOUT another frame's bytes ever landing between the halves
    // (frame atomicity — what the real funnel guarantees).
    private queues = new Map<net.Socket, { chunks: Buffer[]; draining: boolean }>();

    constructor(private availablePorts: any[], private opts: { splitWrites?: boolean } = {}) {
        this.server = net.createServer((socket) => {
            this.sockets.push(socket);
            let buf = Buffer.alloc(0);
            socket.on("data", (data) => {
                buf = Buffer.concat([buf, Buffer.from(data)]);
                while (buf.length >= 5) {
                    const streamId = buf.readUInt8(0);
                    const len = buf.readUInt32LE(1);
                    if (buf.length < 5 + len) { break; }
                    const payload = buf.subarray(5, 5 + len);
                    buf = buf.subarray(5 + len);
                    if (streamId === 0) {
                        this.onControl(socket, JSON.parse(payload.toString("utf-8")));
                    }
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

    close() {
        for (const s of this.sockets) { s.destroy(); }
        this.server.close();
    }

    /** Push an unsolicited event (availableChanged / portError) to every client. */
    emitEvent(obj: any) {
        for (const s of this.sockets) {
            if (!s.destroyed) { this.enqueue(s, frame(0, Buffer.from(JSON.stringify(obj)))); }
        }
    }

    private reply(socket: net.Socket, obj: any) {
        this.enqueue(socket, frame(0, Buffer.from(JSON.stringify(obj))));
    }

    private enqueue(socket: net.Socket, fullFrame: Buffer) {
        let q = this.queues.get(socket);
        if (!q) { q = { chunks: [], draining: false }; this.queues.set(socket, q); }
        if (this.opts.splitWrites && fullFrame.length > 6) {
            q.chunks.push(fullFrame.subarray(0, 3), fullFrame.subarray(3));
        } else {
            q.chunks.push(fullFrame);
        }
        this.drain(socket, q);
    }

    private drain(socket: net.Socket, q: { chunks: Buffer[]; draining: boolean }) {
        if (q.draining) { return; }
        q.draining = true;
        const step = () => {
            const chunk = q.chunks.shift();
            if (!chunk || socket.destroyed) { q.draining = false; return; }
            socket.write(chunk);
            setTimeout(step, this.opts.splitWrites ? 3 : 0);
        };
        step();
    }

    private onControl(socket: net.Socket, msg: any) {
        const seq = msg.seq;
        switch (msg.method) {
            case "serial.subscribeAvailable":
                this.reply(socket, { seq, success: true, data: {} });
                this.emitEvent({ event: "serial.availableChanged", params: { ports: this.availablePorts, revision: 1 } });
                break;
            case "serial.listAvailable":
                this.reply(socket, { seq, success: true, data: { "serial.listAvailable": { ports: this.availablePorts } } });
                break;
            case "serial.listOpen":
                this.reply(socket, { seq, success: true, data: { "serial.listOpen": { ports: [] } } });
                break;
            case "serial.open": {
                this.opens.push(msg.params);
                // Always answer with a direct tcp_port (no channel_id) so no
                // real funnel TCP server is spun up in the manager during tests.
                const openInfo = { path: msg.params.path, tcp_port: this.nextTcp++, channel_id: null };
                this.reply(socket, { seq, success: true, data: { "serial.open": openInfo } });
                break;
            }
            case "serial.close":
                this.reply(socket, { seq, success: true, data: {} });
                break;
            default: // heartbeat and anything else
                this.reply(socket, { seq, success: true, data: {} });
                break;
        }
    }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > ms) { throw new Error("waitFor timed out"); }
        await new Promise((r) => setTimeout(r, 10));
    }
}

const stub = new StubHostAdapter();
setHostAdapter(stub as any);

function localCfg(port: number): HostConfig {
    return { enabled: true, type: "local", pvtNetworkMode: "local", pvtProxyHost: "127.0.0.1", pvtProxyPort: port } as any;
}
function sshCfg(port: number, sshHost = "pi@lab"): HostConfig {
    return { enabled: true, type: "ssh", sshHost, pvtNetworkMode: "ssh", pvtProxyHost: "127.0.0.1", pvtProxyPort: port } as any;
}

function launchArgs(port: number, hostConfig: HostConfig): ConfigurationArguments {
    return {
        serialConfig: { enabled: true, ports: [makeParams("/dev/ttyACM0")] },
        hostConfig,
    } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("two proxies coexist: no sibling teardown, composite keys, per-proxy transport", async (t) => {
    const fakeA = new FakeProxy([avail("/dev/ttyACM0", "local board")]);
    const fakeB = new FakeProxy([avail("/dev/ttyACM0", "remote board"), avail("/dev/ttyUSB0", "remote 2")]);
    await fakeA.listen();
    await fakeB.listen();

    // A resolver that routes an ssh request to fakeB and everything else to fakeA.
    const resolver: ProxyResolver = async (hc) => (hc?.sshHost ? sshCfg(fakeB.port, hc.sshHost) : localCfg(fakeA.port));

    const mgr = new SerialPortManager(resolver);
    t.after(() => { mgr.dispose(); fakeA.close(); fakeB.close(); });

    // Open /dev/ttyACM0 on the local proxy, then the SAME path on the ssh proxy.
    await mgr.createSerialPorts(launchArgs(fakeA.port, localCfg(fakeA.port)));
    await mgr.createSerialPorts(launchArgs(fakeB.port, sshCfg(fakeB.port)));

    // Each proxy received exactly its own open — B did not steal A's socket.
    assert.equal(fakeA.opens.length, 1, "fakeA should have one open");
    assert.equal(fakeB.opens.length, 1, "fakeB should have one open");
    assert.ok(!fakeA.sockets[0].destroyed, "fakeA socket must stay alive after B connects (no sibling teardown)");
    assert.ok(!fakeB.sockets[0].destroyed, "fakeB socket alive");

    // Transport is derived per-connection from topology (Step 6).
    assert.equal(fakeA.opens[0].transport, "direct", "local proxy → direct");
    assert.equal(fakeB.opens[0].transport, "funnel", "ssh proxy → funnel");

    // Same device path on two proxies → two distinct views (composite keys, Step 2).
    // A bare-path key would have reused one view and created only one.
    const acmViews = stub.createdViews.filter((v) => v.device === "/dev/ttyACM0");
    assert.equal(acmViews.length, 2, "same path on two proxies must produce two views");
});

test("available ports aggregate across connections, each tagged with its source", async (t) => {
    stub.createdViews = [];
    stub.quickPickItems = [];
    const fakeA = new FakeProxy([avail("/dev/ttyACM0", "local board")]);
    const fakeB = new FakeProxy([avail("/dev/ttyACM0", "remote board"), avail("/dev/ttyUSB0")]);
    await fakeA.listen();
    await fakeB.listen();

    const resolver: ProxyResolver = async (hc) => (hc?.sshHost ? sshCfg(fakeB.port, hc.sshHost) : localCfg(fakeA.port));
    const mgr = new SerialPortManager(resolver);
    t.after(() => { mgr.dispose(); fakeA.close(); fakeB.close(); });

    await mgr.createSerialPorts(launchArgs(fakeA.port, localCfg(fakeA.port)));
    await mgr.createSerialPorts(launchArgs(fakeB.port, sshCfg(fakeB.port)));

    // Both connections should have received their availableChanged snapshots.
    await waitFor(() => mgr.getAllAvailablePorts().length === 3);
    const all = mgr.getAllAvailablePorts();

    const local = all.filter((s) => s.label === "local");
    const remote = all.filter((s) => s.label === "ssh:pi@lab");
    assert.equal(local.length, 1, "one port from local");
    assert.equal(remote.length, 2, "two ports from ssh remote");
    assert.deepEqual(local.map((s) => s.port.path), ["/dev/ttyACM0"]);
    assert.deepEqual(remote.map((s) => s.port.path).sort(), ["/dev/ttyACM0", "/dev/ttyUSB0"]);

    // The picker shows all three, tagged by source, with duplicate paths disambiguated.
    await mgr.listAvailablePortsCmd();
    assert.equal(stub.quickPickItems.length, 3, "picker aggregates all sources");
    const acmDescriptions = stub.quickPickItems
        .filter((i) => i.label === "/dev/ttyACM0")
        .map((i) => i.description);
    assert.equal(acmDescriptions.length, 2, "both ttyACM0s are shown");
    assert.ok(acmDescriptions.some((d: string) => d.startsWith("local")), "one tagged local");
    assert.ok(acmDescriptions.some((d: string) => d.startsWith("ssh:pi@lab")), "one tagged ssh");
});

test("control frames split across TCP writes are reassembled", async (t) => {
    const fake = new FakeProxy([avail("/dev/ttyACM0")], { splitWrites: true });
    await fake.listen();

    const conn = new ProxyConnection("split", { onPortError() { } }, "local");
    t.after(() => { conn.dispose(); fake.close(); });

    const ok = await conn.connect(localCfg(fake.port));
    assert.equal(ok, true, "connect succeeds even though every reply is split mid-frame");
    // subscribe reply + availableChanged both arrived split; the snapshot landed.
    await waitFor(() => conn.getCurrentSerialPorts().length === 1);
    assert.equal(conn.getCurrentSerialPorts()[0].path, "/dev/ttyACM0");
});

test("portError is delegated with the originating connection", async (t) => {
    const fake = new FakeProxy([avail("/dev/ttyACM0")]);
    await fake.listen();

    const errors: Array<{ conn: ProxyConnection; path: string; kind: string; msg: string }> = [];
    const conn = new ProxyConnection("errconn", {
        onPortError(c, path, kind, msg) { errors.push({ conn: c, path, kind, msg }); },
    }, "local");
    t.after(() => { conn.dispose(); fake.close(); });

    await conn.connect(localCfg(fake.port));
    fake.emitEvent({ event: "serial.portError", params: { path: "/dev/ttyACM0", kind: "disconnected", msg: "unplugged" } });

    await waitFor(() => errors.length === 1);
    assert.equal(errors[0].conn, conn, "delegate receives the source connection (Step 2)");
    assert.equal(errors[0].path, "/dev/ttyACM0");
    assert.equal(errors[0].kind, "disconnected");
    assert.equal(errors[0].msg, "unplugged");
});

test("funnel stream-id space is per-connection (channel 100 on A ≠ channel 100 on B)", async (t) => {
    const fakeA = new FakeProxy([]);
    const fakeB = new FakeProxy([]);
    await fakeA.listen();
    await fakeB.listen();

    const connA = new ProxyConnection("A", { onPortError() { } }, "local");
    const connB = new ProxyConnection("B", { onPortError() { } }, "ssh:host");
    t.after(() => { connA.dispose(); connB.dispose(); fakeA.close(); fakeB.close(); });

    await connA.connect(sshCfg(fakeA.port));
    await connB.connect(sshCfg(fakeB.port));

    // Same channel id on both connections must yield independent servers on
    // independent local ports — the stream-id namespace is not shared.
    const sA = connA.ensureStreamServer("127.0.0.1", "/dev/x", 100);
    const sB = connB.ensureStreamServer("127.0.0.1", "/dev/x", 100);
    await waitFor(() => sA.getPort() > 0 && sB.getPort() > 0);
    assert.notEqual(sA.getPort(), sB.getPort(), "channel 100 on A and B are distinct servers");
    // Re-fetching the same channel on A returns the same server (idempotent).
    assert.equal(connA.ensureStreamServer("127.0.0.1", "/dev/x", 100), sA);
});
