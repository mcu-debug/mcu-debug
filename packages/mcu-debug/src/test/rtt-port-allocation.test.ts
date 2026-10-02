// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Which TCP port each RTT channel is served on.
//
// Worth pinning because the allocator is the one place where "who serves this session" turns into
// something observable, and because the version this replaced had two faults that are invisible
// until a second channel exists: it handed the same port to every channel that needed one, and on
// the `ports[]` (advanced) path it used the channel *number* as the TCP port.

import test from "node:test";
import assert from "node:assert/strict";

import { RTTConfiguration, RTTServerHelper, RTTCommonDecoderOpts } from "../adapter/servers/common";

function config(over: Partial<RTTConfiguration> = {}): RTTConfiguration {
    return { enabled: true, decoders: [], ...over } as RTTConfiguration;
}

function dec(port: number, type = "console"): RTTCommonDecoderOpts {
    return { type, port } as RTTCommonDecoderOpts;
}

test("each channel gets its own port", async () => {
    // The fault this replaced: `ports[0]` went to every channel needing one, so two console
    // decoders on different channels collided on a single TCP port and the second never connected.
    const cfg = config({ decoders: [dec(0), dec(1), dec(2)], serve: { tcpPorts: { 0: 30000, 1: 30001, 2: 30002 } } });
    const helper = new RTTServerHelper();
    await helper.allocateRTTPorts(cfg, true);
    assert.deepEqual(
        cfg.decoders.map((d) => d.pvtTcpPort),
        ["30000", "30001", "30002"],
    );
    const used = new Set(cfg.decoders.map((d) => d.pvtTcpPort));
    assert.equal(used.size, 3, "no two channels share a port");
});

test("decoders watching the same channel share its port", async () => {
    // A console and a binary on channel 0 is a normal thing to configure, and they read one socket.
    const cfg = config({ decoders: [dec(0, "console"), dec(0, "binary")], serve: { tcpPorts: { 0: 30010 } } });
    const helper = new RTTServerHelper();
    await helper.allocateRTTPorts(cfg, true);
    assert.deepEqual(
        cfg.decoders.map((d) => d.pvtTcpPort),
        ["30010", "30010"],
    );
    assert.equal(Object.keys(helper.rttLocalPortMap).length, 1, "one channel, one port, however many decoders");
});

test("serve.tcpPorts is keyed by channel, not positional", async () => {
    // The parallel-array version could be misaligned, and the code that consumed it said so:
    // "Hopefully ports and tcpPorts are a matched set". Declaration order must not matter.
    const cfg = config({ decoders: [dec(5), dec(1)], serve: { tcpPorts: { 1: 30021, 5: 30025 } } });
    await new RTTServerHelper().allocateRTTPorts(cfg, true);
    assert.equal(cfg.decoders[0].pvtTcpPort, "30025", "channel 5 got channel 5's port");
    assert.equal(cfg.decoders[1].pvtTcpPort, "30021");
});

test("an advanced decoder's ports are real ports, not channel numbers", async () => {
    // The other fault this replaced: the `ports[]` path assigned `p.toString()` -- the channel
    // number itself -- so channel 0 became TCP port 0 and channel 1 became port 1.
    const cfg = config({ decoders: [{ type: "advanced", ports: [0, 1] } as RTTCommonDecoderOpts], serve: { tcpPorts: { 0: 30030, 1: 30031 } } });
    await new RTTServerHelper().allocateRTTPorts(cfg, true);
    assert.deepEqual(cfg.decoders[0].pvtTcpPorts, ["30030", "30031"]);
});

test("the side that is not serving allocates nothing", async () => {
    // With the `pvtRttConfig` swap gone there is one config object and one set of decoders, so the
    // guard is what keeps the two paths from writing over each other's ports.
    const builtin = config({ decoders: [dec(0)] });
    const serverHelper = new RTTServerHelper();
    await serverHelper.allocateRTTPorts(builtin, false);
    assert.equal(builtin.decoders[0].pvtTcpPort, undefined, "gdb-server path must not touch a builtin session");
    assert.deepEqual(serverHelper.rttLocalPortMap, {});

    const served = config({ engine: "gdb-server", decoders: [dec(0)] });
    const builtinHelper = new RTTServerHelper();
    await builtinHelper.allocateRTTPorts(served, true);
    assert.equal(served.decoders[0].pvtTcpPort, undefined, "builtin path must not touch a gdb-server session");
});

test("emitConfigures only fires for the side that is serving", async () => {
    // Otherwise each side would announce the ports the *other* side had just written onto the
    // shared decoder objects, giving two sources per channel both reading one socket.
    const cfg = config({ decoders: [dec(0)], serve: { tcpPorts: { 0: 30040 } } });
    const helper = new RTTServerHelper();
    await helper.allocateRTTPorts(cfg, true);

    const events: unknown[] = [];
    const sink = { emit: (_name: string, ev: unknown) => events.push(ev) } as never;
    assert.equal(helper.emitConfigures(cfg, sink, false), false, "the gdb-server does not serve this one");
    assert.equal(events.length, 0);
    assert.equal(helper.emitConfigures(cfg, sink, true), true);
    assert.equal(events.length, 1);
});

test("serve.tcpPort is a starting point and serve.tcpPorts wins over it", async () => {
    const cfg = config({ decoders: [dec(0), dec(1)], serve: { tcpPort: 31000, tcpPorts: { 1: 31999 } } });
    await new RTTServerHelper().allocateRTTPorts(cfg, true);
    assert.equal(cfg.decoders[1].pvtTcpPort, "31999", "the named channel is exact");
    const ch0 = parseInt(cfg.decoders[0].pvtTcpPort, 10);
    assert.ok(ch0 >= 31000, `channel 0 was sought from 31000, got ${ch0}`);
});

test("serve is ignored on the gdb-server path", async () => {
    // It describes ports *we* bind. J-Link picks its own telnet port; OpenOCD is told ports by
    // `rttCommands()`.
    const cfg = config({ engine: "gdb-server", decoders: [dec(0)], serve: { tcpPorts: { 0: 32000 } } });
    await new RTTServerHelper().allocateRTTPorts(cfg, false);
    assert.notEqual(cfg.decoders[0].pvtTcpPort, "32000");
});

test("a disabled or decoderless config allocates nothing", async () => {
    const helper = new RTTServerHelper();
    await helper.allocateRTTPorts(config({ enabled: false, decoders: [dec(0)] }), true);
    await helper.allocateRTTPorts(config({ decoders: [] }), true);
    assert.deepEqual(helper.rttLocalPortMap, {});
});

test("the real J-Link builtin sequence leaves one real port and one emit", async () => {
    // The order a session actually runs in: the server controller allocates during `startServer()`,
    // the builtin server allocates later from `setPort()`, and the server controller emits again
    // from `debuggerLaunchCompleted()`. All three share one `rttConfig` and one decoder array, so
    // this is where a missing guard shows up as either no port or two sources on one socket.
    const cfg = config({ engine: "builtin-rust", decoders: [dec(0, "pipe")], serve: { tcpPorts: { 0: 33000 } } });

    const serverHelper = new RTTServerHelper();
    await serverHelper.allocateRTTPorts(cfg, false, 19021); // J-Link's own base
    assert.equal(cfg.decoders[0].pvtTcpPort, undefined, "the gdb-server allocated nothing");
    assert.deepEqual(serverHelper.rttLocalPortMap, {}, "so it has no port to put on its command line");

    const builtinHelper = new RTTServerHelper();
    await builtinHelper.allocateRTTPorts(cfg, true);
    assert.equal(cfg.decoders[0].pvtTcpPort, "33000");

    const events: unknown[] = [];
    const sink = { emit: (_n: string, ev: unknown) => events.push(ev) } as never;
    builtinHelper.emitConfigures(cfg, sink, true);
    serverHelper.emitConfigures(cfg, sink, false); // debuggerLaunchCompleted
    assert.equal(events.length, 1, "exactly one source per channel");
});
