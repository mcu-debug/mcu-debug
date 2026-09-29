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

import { chooseRttEngine, upChannels, rttAddressLooksUsable, formatRttEngineStats, RttEngineStats, statsIntervalMs } from "../adapter/rtt-proxy-bridge";
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

// ── The engine's statistics line ──────────────────────────────────────────────
//
// Worth pinning because this line is the instrument a server comparison is made with, and the last
// one was wrong in a way nobody noticed for a while: `msgs/sec` from the consumer's monitor was taken
// for the drain rate, when a `msg` there is one TCP buffer and several drains often share one.

function sample(over: Partial<RttEngineStats> = {}): RttEngineStats {
    return { bytes_up: 0, bytes_down: 0, drains: 0, idle: 0, gated: 0, errors: 0, reads: 0, writes: 0, elapsed_ms: 0, ...over };
}

test("the window is the difference between two cumulative samples", () => {
    // The event is cumulative so that a dropped one costs accuracy in a single window rather than
    // bytes from the running total. That makes subtracting the client's job.
    const prev = sample({ bytes_up: 100_000, drains: 200, reads: 400, writes: 200, elapsed_ms: 5000 });
    const now = sample({ bytes_up: 200_000, drains: 400, reads: 800, writes: 400, elapsed_ms: 10_000 });
    const line = formatRttEngineStats(now, prev);
    // 100,000 bytes in 5s is 19.5 KB/sec; 200 drains in 5s is 40/sec at 500 B each.
    assert.match(line, /19\.5 KB\/sec/);
    assert.match(line, /40 drains\/sec, 500 B\/drain/);
    // 600 round trips over 200 drains is the three a drain costs: descriptor, data, RdOff.
    assert.match(line, /120 trips\/sec, 3\.0 trips\/drain/);
});

test("the first sample is a window from zero rather than nothing", () => {
    const line = formatRttEngineStats(sample({ bytes_up: 51_200, drains: 100, reads: 200, writes: 100, elapsed_ms: 5000 }), null);
    assert.match(line, /10\.0 KB\/sec/);
    assert.match(line, /20 drains\/sec, 512 B\/drain/);
});

test("counters that go backwards do not print a negative rate", () => {
    // An Agent restart would reset them. A negative rate is worse than a slightly wrong one.
    const prev = sample({ bytes_up: 1_000_000, drains: 2000, reads: 4000, writes: 2000, elapsed_ms: 60_000 });
    const line = formatRttEngineStats(sample({ bytes_up: 1000, drains: 2, elapsed_ms: 1000 }), prev);
    assert.doesNotMatch(line, /-/);
    assert.match(line, /0\.0 KB\/sec/);
});

test("an idle engine reports zero rates rather than dividing by zero", () => {
    const prev = sample({ bytes_up: 5000, drains: 10, reads: 20, writes: 10, elapsed_ms: 5000 });
    const line = formatRttEngineStats(sample({ ...prev, elapsed_ms: 10_000 }), prev);
    assert.match(line, /0\.0 KB\/sec/);
    assert.match(line, /0 drains\/sec, 0 B\/drain/);
    assert.match(line, /0 trips\/sec, 0\.0 trips\/drain/);
});

test("the three diagnostic counters are reported as window deltas", () => {
    // Which one is climbing is the whole point: idle means the firmware had nothing, gated means GDB
    // had the connection, errors means reads are being retried at half size.
    const prev = sample({ idle: 10, gated: 20, errors: 1, elapsed_ms: 5000 });
    const line = formatRttEngineStats(sample({ idle: 15, gated: 26, errors: 4, elapsed_ms: 10_000 }), prev);
    assert.match(line, /idle 5, gated 6, errors 3/);
});

test("the running total switches to MB where KB stops being readable", () => {
    assert.match(formatRttEngineStats(sample({ bytes_up: 512_000, elapsed_ms: 1000 }), null), /total 500\.0 KB over 1\.0s/);
    assert.match(formatRttEngineStats(sample({ bytes_up: 4_587_520, elapsed_ms: 60_100 }), null), /total 4\.38 MB over 60\.1s/);
});

// ── Who asked for statistics ──────────────────────────────────────────────────
//
// The engine's line is half of a throughput measurement and the consumer's line is the other half, so
// they share one switch: the per-decoder `stats` option that already existed. A session that did not
// ask for statistics must get none -- an RTT stream is a user-facing terminal, not a diagnostic.

test("no decoder asking for stats means the Agent reports none", () => {
    assert.equal(statsIntervalMs(config({ decoders: [{ type: "console", port: 0 }] as any })), undefined);
    assert.equal(statsIntervalMs(config()), undefined);
});

test("a decoder with stats turns the engine's counters on, at the consumer's default window", () => {
    // 5 seconds is ThroughputMonitor's default, and matching it is the point: two lines describing
    // different windows cannot be read against each other.
    const cfg = config({ decoders: [{ type: "pipe", port: 0, stats: true }] as any });
    assert.equal(statsIntervalMs(cfg), 5000);
});

test("an explicit statsInterval is carried through, in seconds", () => {
    const cfg = config({ decoders: [{ type: "pipe", port: 0, stats: true, statsInterval: 2 }] as any });
    assert.equal(statsIntervalMs(cfg), 2000);
});

test("where several decoders disagree the shortest window wins", () => {
    // The engine's counters are per session, not per channel, so there is one line however many
    // decoders asked. The shortest interval divides the others and so reads against all of them.
    const cfg = config({
        decoders: [
            { type: "console", port: 0, stats: true, statsInterval: 10 },
            { type: "pipe", port: 1, stats: true, statsInterval: 3 },
        ] as any,
    });
    assert.equal(statsIntervalMs(cfg), 3000);
});

test("a decoder that asks for stats without an interval falls back to the default", () => {
    const cfg = config({
        decoders: [
            { type: "console", port: 0 },
            { type: "pipe", port: 1, stats: true },
        ] as any,
    });
    assert.equal(statsIntervalMs(cfg), 5000);
});

test("a nonsensical interval is ignored rather than becoming a busy loop", () => {
    const cfg = config({ decoders: [{ type: "pipe", port: 0, stats: true, statsInterval: 0 }] as any });
    assert.equal(statsIntervalMs(cfg), 5000);
});
