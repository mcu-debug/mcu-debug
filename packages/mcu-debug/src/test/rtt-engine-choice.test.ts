// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Which built-in RTT engine a session uses, and which channels it drains.
//
// Worth pinning because both are now load-bearing. The engine choice defaults to the Agent's, so a
// mistake here changes what every session with built-in RTT does; and "you can't have both" is a
// correctness requirement rather than a preference -- two engines would each keep their own idea of
// the ring buffer's read pointer and corrupt the channel between them.

import test from "node:test";
import assert from "node:assert/strict";

import { chooseRttEngine, upChannels, rttAddressLooksUsable } from "../adapter/rtt-proxy-bridge";
import { RTTConfiguration } from "../adapter/servers/common";

function config(over: Partial<RTTConfiguration> = {}): RTTConfiguration {
    return { enabled: true, decoders: [], ...over } as RTTConfiguration;
}

/** Stands in for a live ProxyClient; nothing here calls it. */
const aProxy = {} as any;

test("the Agent's engine is the default", () => {
    const { engine, why } = chooseRttEngine(config(), aProxy, undefined);
    assert.equal(engine, "rust");
    assert.equal(why, undefined, "the default needs no explanation");
});

test("asking for the debug adapter's engine gets it, with no complaint", () => {
    const cfg = config({ useBuiltinRTT: { enabled: true, implementation: "typescript" } });
    const { engine, why } = chooseRttEngine(cfg, aProxy, undefined);
    assert.equal(engine, "typescript");
    assert.equal(why, undefined, "an explicit choice is not a fallback");
});

test("no proxy means the debug adapter's engine, and says so", () => {
    // An external gdb-server, or one matched by regex: there is no Agent to run anything in.
    const { engine, why } = chooseRttEngine(config(), null, undefined);
    assert.equal(engine, "typescript");
    assert.match(why!, /no Probe Agent/);
});

test("rspMux false falls back rather than losing RTT, and is reported", () => {
    // rspMux is normally set false to isolate a problem. Silently changing the RTT engine at the
    // same time would make that experiment meaningless, so the fallback has to be stated.
    const { engine, why } = chooseRttEngine(config(), aProxy, false);
    assert.equal(engine, "typescript");
    assert.match(why!, /rspMux/);
});

test("rspMux left unset is the multiplexer's default, which is on", () => {
    assert.equal(chooseRttEngine(config(), aProxy, undefined).engine, "rust");
    assert.equal(chooseRttEngine(config(), aProxy, true).engine, "rust");
});

test("an explicit typescript choice wins even where rust would have worked", () => {
    const cfg = config({ useBuiltinRTT: { enabled: true, implementation: "typescript" } });
    assert.equal(chooseRttEngine(cfg, aProxy, true).engine, "typescript");
});

test("channels come from the decoders, deduplicated and ordered", () => {
    // Not from the control block: a target may allocate sixteen channels while the user displays
    // one, and draining the rest spends round trips -- the thing RTT throughput is bound by -- on
    // data nobody reads.
    const cfg = config({
        decoders: [
            { type: "console", port: 2 },
            { type: "console", port: 0 },
            { type: "graph", port: 2 },
            { type: "advanced", ports: [1, 5] },
        ] as any,
    });
    assert.deepEqual(upChannels(cfg), [0, 1, 2, 5]);
});

test("no decoder means no channels, which the caller must treat as an error", () => {
    assert.deepEqual(upChannels(config()), []);
});

test("an unresolved control block address is refused", () => {
    // `auto` is resolved during symbol loading. Reaching the Agent with it unresolved would make the
    // engine poll address 0 for ever, which looks exactly like firmware that never starts RTT.
    assert.equal(rttAddressLooksUsable(undefined), false);
    assert.equal(rttAddressLooksUsable("auto"), false);
    assert.equal(rttAddressLooksUsable("0x0"), false);
    assert.equal(rttAddressLooksUsable("0"), false);
    assert.equal(rttAddressLooksUsable("0x20000000"), true);
});
