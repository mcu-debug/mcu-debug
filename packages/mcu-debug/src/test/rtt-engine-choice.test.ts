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

import { upChannels, rttAddressLooksUsable, formatRttEngineStats, RttEngineStats, statsIntervalMs } from "../adapter/rtt-proxy-bridge";
import { RTTConfiguration, createPortName, rttBuiltinServes, rttServerServes, resolveRttEngine } from "../adapter/servers/common";

function config(over: Partial<RTTConfiguration> = {}): RTTConfiguration {
    return { enabled: true, decoders: [], ...over } as RTTConfiguration;
}

const EXTERNAL = "external";
const OPENOCD = "openocd";

test("the Agent's engine is the default", () => {
    const r = resolveRttEngine(config(), OPENOCD, undefined)!;
    assert.equal(r.engine, "builtin-rust");
    assert.equal(r.why, undefined, "the default needs no explanation");
});

test("asking for the debug adapter's engine gets it, with no complaint", () => {
    const r = resolveRttEngine(config({ engine: "builtin-typescript" }), OPENOCD, undefined)!;
    assert.equal(r.engine, "builtin-typescript");
    assert.equal(r.why, undefined, "an explicit choice is not a fallback");
});

test("auto on an external server means the debug adapter's engine, and says so", () => {
    // `servertype: "external"` is the one case with no Probe Agent, which is what makes this
    // decidable from the configuration alone rather than needing a live ProxyClient.
    const r = resolveRttEngine(config(), EXTERNAL, undefined)!;
    assert.equal(r.engine, "builtin-typescript");
    assert.match(r.why!, /Probe Agent/);
    assert.ok(!r.error, "auto is the default, so nobody is refused for having no opinion");
});

test("auto with rspMux false falls back rather than losing RTT, and is reported", () => {
    // rspMux is normally set false to isolate a problem. Silently changing the RTT engine at the
    // same time would make that experiment meaningless, so the fallback has to be stated.
    const r = resolveRttEngine(config(), OPENOCD, false)!;
    assert.equal(r.engine, "builtin-typescript");
    assert.match(r.why!, /rspMux/);
    assert.ok(!r.error);
});

test("rspMux left unset is the multiplexer's default, which is on", () => {
    assert.equal(resolveRttEngine(config(), OPENOCD, undefined)!.engine, "builtin-rust");
    assert.equal(resolveRttEngine(config(), OPENOCD, true)!.engine, "builtin-rust");
});

// Only `auto` substitutes. Naming an engine is how a user asks *not* to be handed a different one,
// which is the entire reason the setting exists -- so an explicit ask that cannot be met is an
// error, not a downgrade. These are the whole difference between `auto` and `builtin-rust`, which
// otherwise resolve identically.
test("an explicit builtin-rust is refused rather than downgraded where there is no Agent", () => {
    const r = resolveRttEngine(config({ engine: "builtin-rust" }), EXTERNAL, undefined)!;
    assert.ok(r.error, "explicit asks are refused, not substituted");
    assert.match(r.why!, /Probe Agent/);
});

test("an explicit builtin-rust is refused when the multiplexer is off", () => {
    const r = resolveRttEngine(config({ engine: "builtin-rust" }), OPENOCD, false)!;
    assert.ok(r.error);
    assert.match(r.why!, /rspMux/);
});

test("gdb-server is refused for servertypes that cannot serve RTT", () => {
    for (const st of ["stlink", "pyocd", "probe-rs", "external", "bmp"]) {
        const r = resolveRttEngine(config({ engine: "gdb-server" }), st, undefined)!;
        assert.ok(r.error, `${st} has no RTT of its own`);
    }
    for (const st of ["openocd", "jlink"]) {
        const r = resolveRttEngine(config({ engine: "gdb-server" }), st, undefined)!;
        assert.ok(!r.error, st);
        assert.equal(r.engine, "gdb-server");
    }
});

test("every refusal carries its own remedy", () => {
    // A refusal is delivered as a notification and nothing else: the resolver returns `undefined`,
    // VS Code never starts the debug adapter, and there is no Debug Console to elaborate in. So a
    // message that names only the cause leaves the user with no way forward.
    const refusals = [
        resolveRttEngine(config({ engine: "builtin-rust" }), EXTERNAL, undefined)!,
        resolveRttEngine(config({ engine: "builtin-rust" }), OPENOCD, false)!,
        resolveRttEngine(config({ engine: "gdb-server" }), "stlink", undefined)!,
    ];
    for (const r of refusals) {
        assert.ok(r.error, "these are all refusals");
        assert.ok(r.why, `${r.engine}: a cause`);
        assert.ok(r.remedy, `${r.why}: and something to do about it`);
    }
});

test("a fallback explains itself but does not prescribe", () => {
    // The opposite case: `auto` already did the thing, so telling the user to do it would be noise.
    // This is why cause and remedy are separate fields rather than one string.
    for (const r of [resolveRttEngine(config(), EXTERNAL, undefined)!, resolveRttEngine(config(), OPENOCD, false)!]) {
        assert.ok(!r.error);
        assert.ok(r.why, "it still says why");
        assert.equal(r.remedy, undefined, "but asks nothing of the user");
    }
});

test("resolution is idempotent, because the CLI resolves a configuration twice", () => {
    // cli-config-loader runs both resolvers, and its own override runs them again. A written-back
    // value is seen as an *explicit* ask on the second pass, where `auto` would have substituted --
    // so a fallback must not turn into an error just because it already happened once.
    for (const [servertype, rspMux] of [
        [OPENOCD, undefined],
        [OPENOCD, false],
        [EXTERNAL, undefined],
        [EXTERNAL, false],
    ] as const) {
        const cfg = config();
        const first = resolveRttEngine(cfg, servertype, rspMux)!;
        assert.ok(!first.error, `${servertype}/${rspMux}: auto never errors`);
        cfg.engine = first.engine;
        const second = resolveRttEngine(cfg, servertype, rspMux)!;
        assert.ok(!second.error, `${servertype}/${rspMux}: re-resolving must not error`);
        assert.equal(second.engine, first.engine, `${servertype}/${rspMux}: and must not move`);
    }
});

test("a disabled RTT config resolves to nothing at all", () => {
    assert.equal(resolveRttEngine(config({ enabled: false }), OPENOCD, undefined), null);
    assert.equal(resolveRttEngine(undefined, OPENOCD, undefined), null);
});

test("rttBuiltinServes and rttServerServes are exact complements while RTT is enabled", () => {
    // The load-bearing property: every caller picks a side from one of these, and a configuration
    // that answered yes to both would allocate two sources per channel on one socket.
    for (const engine of [undefined, "auto", "builtin-rust", "builtin-typescript", "gdb-server"] as const) {
        const cfg = config(engine === undefined ? {} : { engine });
        assert.notEqual(rttBuiltinServes(cfg), rttServerServes(cfg), `engine ${engine}`);
    }
});

test("neither side serves when RTT is disabled", () => {
    const cfg = config({ enabled: false, engine: "gdb-server" });
    assert.equal(rttBuiltinServes(cfg), false);
    assert.equal(rttServerServes(cfg), false);
});

test("auto never selects the gdb-server's own RTT", () => {
    // Arriving from cortex-debug with no `engine` at all should land on our engine: it is the one we
    // measure, and the one that needs no server-side setup.
    assert.equal(rttBuiltinServes(config()), true);
    assert.equal(rttBuiltinServes(config({ engine: "auto" })), true);
    assert.equal(resolveRttEngine(config(), OPENOCD, undefined)!.engine, "builtin-rust");
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
    return {
        bytes_up: 0,
        bytes_down: 0,
        drains: 0,
        idle: 0,
        gated: 0,
        errors: 0,
        err_invalid: 0,
        err_rejected: 0,
        err_timeout: 0,
        err_target: 0,
        err_other: 0,
        reads: 0,
        writes: 0,
        elapsed_ms: 0,
        ...over,
    };
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
    assert.match(line, /idle 5, gated 6, unusable 0, errors 3/);
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

test("the error count carries its breakdown, and only when there is one", () => {
    // One total cannot be acted on: a failed descriptor validation, a mangled reply and a timeout
    // are three unrelated problems. 76 errors in the first five seconds of a J-Link run were
    // indistinguishable until this existed, because the reason went to a daemon's /dev/null stderr.
    const clean = formatRttEngineStats(sample({ errors: 0, elapsed_ms: 5000 }), null);
    assert.doesNotMatch(clean, /\(/, "no breakdown when nothing failed");

    // `invalid` is deliberately NOT inside `errors`: an unusable control block is the firmware not
    // having initialised yet, which must survive a coffee break rather than count toward giving up.
    const unusable = formatRttEngineStats(sample({ err_invalid: 76, elapsed_ms: 5000 }), null);
    assert.match(unusable, /unusable 76, errors 0/);
    assert.doesNotMatch(unusable, /\(/, "an unusable block is not an error kind");

    const mixed = formatRttEngineStats(sample({ errors: 5, err_rejected: 3, err_timeout: 2, elapsed_ms: 5000 }), null);
    assert.match(mixed, /errors 5 \(rejected 3, timeout 2\)/);
});

test("the breakdown is a window delta like everything else on the line", () => {
    const prev = sample({ errors: 76, err_invalid: 76, elapsed_ms: 5000 });
    const now = sample({ errors: 80, err_invalid: 76, err_rejected: 4, elapsed_ms: 10_000 });
    const line = formatRttEngineStats(now, prev);
    assert.match(line, /errors 4 \(rejected 4\)/, "the 76 invalid belong to the previous window");
});

// ── Which gdb stream RTT runs on ──────────────────────────────────────────────

test("the controller stream follows targetProcessor, not core 0", () => {
    // A 2-core PSoC6 with `targetProcessor: 1`: GDB connects to `gdbPort1`, so that is the stream the
    // Agent's mux owns. `gdbPort` is allocated and never connected, so it has no multiplexer at all.
    // Naming it produced "stream 3 has no RSP multiplexer; Agent-side RTT needs debugFlags.rspMux" --
    // a flag that could not have helped, since the mux was present on a different stream.
    assert.equal(createPortName(0), "gdbPort");
    assert.equal(createPortName(1), "gdbPort1");
    assert.equal(createPortName(2), "gdbPort2");
});
