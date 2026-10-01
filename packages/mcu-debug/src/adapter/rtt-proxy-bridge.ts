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

//! Agent-side RTT, wired to the debug adapter's existing RTT plumbing.
//!
//! This is deliberately the *whole* of the client side, and it is small, because `RttTransport`
//! already separates "where the bytes come from" from "what is done with them". `RttTcpServer`
//! keeps its job unchanged -- local ports, the pre-decoder, fan-out to every connected client,
//! and the `rtt-configure` events the frontend's decoders act on -- and only the source of the
//! bytes moves. So the terminals, graphs, the `pipe` decoder and its throughput stats behave
//! identically whichever engine is reading the target, which is what makes a parity comparison
//! a comparison of engines rather than of two different pipelines.
//!
//! What it replaces is `RttBufferManager`: instead of polling target memory over GDB/MI from this
//! process, it asks the Agent to poll over the multiplexed RSP connection and hands us the result
//! on ordinary funnel streams.

import { RTTConfiguration } from "./servers/common";
import { GDBDebugSession } from "./gdb-session";
import { Stderr, Stdout } from "./gdb-mi/mi-types";
import { ProxyClient } from "./proxy-client";
import { RttTransport } from "./rtt-builtin";
import { parseAddress } from "../common/utils";
import { RttStartConfig } from "@mcu-debug/shared/proxy-protocol/RttStartConfig";
import { TargetInfo } from "./target-info";

/**
 * How often the Agent should report its counters, or `undefined` for never.
 *
 * Deliberately **not a flag of its own**. The engine's counters are one half of a throughput
 * measurement and the consumer's `[RTT Logs stats]` line is the other -- `trips/sec` says what the
 * bytes cost, and only the pair distinguishes "the Agent drained less" from "the host delivered
 * less". Reporting one without the other would be noise, and asking users for a second switch to
 * turn on the other half of one number would be worse.
 *
 * So it rides the existing per-decoder `stats` opt-in, and takes that decoder's `statsInterval` so
 * both lines describe the same window. No decoder asking for statistics means the Agent sends none.
 */
export function statsIntervalMs(config: RTTConfiguration): number | undefined {
    const asked = (config.decoders || []).filter((d) => (d as { stats?: boolean }).stats);
    if (asked.length === 0) {
        return undefined;
    }
    // The shortest, where several disagree: a window that divides the others is readable against all
    // of them, and the engine's counters are per session rather than per channel anyway.
    const intervals = asked.map((d) => (d as { statsInterval?: number }).statsInterval).filter((n): n is number => typeof n === "number" && n > 0);
    return (intervals.length > 0 ? Math.min(...intervals) : 5) * 1000;
}

/** The Agent's RTT counters, as `rttStats` carries them. Cumulative since the block was found. */
export interface RttEngineStats {
    bytes_up: number;
    bytes_down: number;
    drains: number;
    idle: number;
    gated: number;
    errors: number;
    err_invalid: number;
    err_rejected: number;
    err_timeout: number;
    err_other: number;
    reads: number;
    writes: number;
    elapsed_ms: number;
}

/**
 * One line of engine statistics, describing the window between `prev` and `now`.
 *
 * The complement to `ThroughputMonitor`'s line, and the two are meant to be read together: that one
 * measures bytes arriving at the last consumer, this one measures what they cost. Its `msgs/sec`
 * cannot stand in for `drains/sec` -- a `msg` there is one TCP buffer, and on a fast probe several
 * drains arrive coalesced -- which is what made an earlier comparison of servers meaningless.
 *
 * **`trips/sec` is the figure that sets RTT throughput**, and `trips/drain` is the diagnostic: a
 * drain costs three round trips (read the descriptor, read the data, write `RdOff`), so materially
 * more than 3.0 means wrapped drains splitting into two reads, or reads being rejected and retried.
 */
export function formatRttEngineStats(now: RttEngineStats, prev: RttEngineStats | null): string {
    const base: RttEngineStats = prev ?? {
        bytes_up: 0,
        bytes_down: 0,
        drains: 0,
        idle: 0,
        gated: 0,
        errors: 0,
        err_invalid: 0,
        err_rejected: 0,
        err_timeout: 0,
        err_other: 0,
        reads: 0,
        writes: 0,
        elapsed_ms: 0,
    };
    // Guarded rather than assumed: an Agent restart would reset the counters, and a negative window
    // printed as a rate is worse than a slightly wrong one.
    const secs = Math.max((now.elapsed_ms - base.elapsed_ms) / 1000, 0.001);
    const delta = (a: number, b: number) => Math.max(a - b, 0);
    const bytes = delta(now.bytes_up, base.bytes_up);
    const drains = delta(now.drains, base.drains);
    const trips = delta(now.reads + now.writes, base.reads + base.writes);
    const per = (n: number, d: number) => (d > 0 ? n / d : 0);
    const totalKB = now.bytes_up / 1024;
    const total = totalKB >= 1024 ? `${(totalKB / 1024).toFixed(2)} MB` : `${totalKB.toFixed(1)} KB`;
    return (
        `[RTT engine] ${(bytes / 1024 / secs).toFixed(1)} KB/sec | ` +
        `${(drains / secs).toFixed(0)} drains/sec, ${per(bytes, drains).toFixed(0)} B/drain | ` +
        `${(trips / secs).toFixed(0)} trips/sec, ${per(trips, drains).toFixed(1)} trips/drain | ` +
        `idle ${delta(now.idle, base.idle)}, gated ${delta(now.gated, base.gated)}, ` +
        `unusable ${delta(now.err_invalid, base.err_invalid)}, errors ${delta(now.errors, base.errors)}${errorKinds(now, base)} | ` +
        `total ${total} over ${(now.elapsed_ms / 1000).toFixed(1)}s`
    );
}

/**
 * The error count's breakdown, shown only when there is one.
 *
 * One total cannot be acted on. A rejected reply means the gdb-server mangled one, usually over its
 * size; a timeout means it never answered. Unrelated problems with unrelated fixes -- and until this
 * existed the only place the distinction survived was an `eprintln!` in a daemonised Agent, whose
 * stderr goes to `/dev/null`.
 *
 * `unusable` is reported *outside* `errors` and counted separately, because a control block that does
 * not make sense is not a failure: the firmware may not have initialised it yet. Halting at `main`
 * and going for a coffee has to be survivable, so the engine backs off to the search interval and
 * keeps waiting rather than counting toward `max_consecutive_errors`. An error is a **read failure**
 * -- the target unreachable, or the server mangling a reply. What the bytes say once we have them is
 * the target's business.
 */
function errorKinds(now: RttEngineStats, base: RttEngineStats): string {
    const parts: string[] = [];
    const add = (label: string, a: number, b: number) => {
        const n = Math.max(a - b, 0);
        if (n > 0) {
            parts.push(`${label} ${n}`);
        }
    };
    add("rejected", now.err_rejected, base.err_rejected);
    add("timeout", now.err_timeout, base.err_timeout);
    add("other", now.err_other, base.err_other);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export class RttProxyBridge {
    /** RTT channel → the funnel stream its data arrives on. */
    private channelToStream: Map<number, number> = new Map();
    private transport: RttTransport | null = null;
    private started = false;
    /** The previous `rttStats` sample, since the event is cumulative and the line is a window. */
    private lastStats: RttEngineStats | null = null;
    private onStats: ((s: RttEngineStats) => void) | null = null;

    constructor(
        private mainSession: GDBDebugSession,
        private proxy: ProxyClient,
    ) {}

    /**
     * Start the Agent's engine and connect it to `transport`.
     *
     * The order matters: the local ports are bound and announced **first**, so a decoder that
     * connects the moment it hears about its port finds a listener. RTT data that arrives before
     * then is handled by `RttTcpServer` as it always was -- the pre-decoder consumes it, and with no
     * client attached the broadcast goes nowhere. Starting the engine first would widen that window
     * for no gain.
     */
    public async start(transport: RttTransport, config: RTTConfiguration): Promise<void> {
        const channels = upChannels(config);
        if (channels.length === 0) {
            throw new Error("RTT is enabled but no decoder names a channel");
        }
        this.transport = transport;
        await transport.setPort(channels);

        const address = config.address;
        if (!address || address === "auto") {
            // `auto` is resolved during symbol loading, long before this runs. Reaching here with it
            // unresolved means that failed, and polling address 0 for ever would look exactly like
            // firmware that never initialises RTT -- so say so instead.
            throw new Error(`RTT control block address is '${address ?? "unset"}'; symbol resolution must have failed`);
        }

        const request: RttStartConfig = {
            cb_address: address,
            search_id: config.searchId || "SEGGER RTT",
            big_endian: (TargetInfo.Instance?.endianness ?? "little") === "big",
            up_channels: channels,
            // Every up channel may also take input. A channel the firmware did not allocate is
            // skipped by the engine rather than failing, so asking for all of them costs nothing.
            down_channels: channels,
            poll_interval_ms: config.polling_interval ?? null,
            // Unset means "use the Agent's measured default for this gdb-server", which is where the
            // per-server knowledge belongs -- the limit is a property of the server's reply buffer and
            // is not derivable from its advertised `PacketSize`. `debugFlags.rttDrainBytes` overrides
            // it for a sweep; it is a measurement knob, not something a user should have to set.
            max_bytes_per_drain: this.mainSession.args.debugFlags?.rttDrainBytes ?? null,
            stats_interval_ms: statsIntervalMs(config) ?? null,
        };

        // Registered **before** the request, not after it resolves. The engine starts the moment the
        // Agent handles `startRtt`, and a control block that is already initialised is found in
        // microseconds -- so `rttReady` can be on the wire immediately behind the response. Node's
        // microtask ordering happens to make the other order safe too, which is exactly the kind of
        // reasoning worth not depending on.
        // The response to `startRtt` means only that a search has begun. How long it takes is the
        // firmware's business: `defmt-rtt` initialises RTT on its first write, so a session stopped
        // at `main` -- or at a breakpoint the user set before the first log call -- has no control
        // block yet, and this can be sub-millisecond or minutes.
        this.proxy.once("rttReady", (info: { cb_address: string; up_channels: number; down_channels: number; search_ms: number }) => {
            const took = info.search_ms < 1000 ? `${info.search_ms}ms` : `${(info.search_ms / 1000).toFixed(1)}s`;
            this.mainSession.handleMsg(Stdout, `RTT ready: control block at ${info.cb_address}, ${info.up_channels} up and ${info.down_channels} down channels (found in ${took})\n`);
            // A decoder naming a channel the firmware never allocated would simply never produce
            // anything, which is indistinguishable from a quiet channel. Worth saying once.
            const missing = channels.filter((c) => c >= info.up_channels);
            if (missing.length > 0) {
                this.mainSession.handleMsg(
                    Stderr,
                    `WARNING: RTT channel${missing.length > 1 ? "s" : ""} ${missing.join(", ")} requested, but the firmware allocated only ${info.up_channels} up channel${info.up_channels === 1 ? "" : "s"} (0..${info.up_channels - 1})\n`,
                );
            }
        });
        // `on`, not `once`: one line per interval for as long as RTT runs. Printed without needing a
        // debug flag -- the Agent's own stderr copy is dropped unless one happens to be set, and
        // measuring throughput is a feature rather than debug noise. The Agent sends nothing at all
        // unless a decoder asked for statistics, so this listener is normally never called.
        this.onStats = (info: RttEngineStats) => {
            this.mainSession.handleMsg(Stdout, `${formatRttEngineStats(info, this.lastStats)}\n`);
            this.lastStats = info;
        };
        this.proxy.on("rttStats", this.onStats);
        this.proxy.once("rttStopped", (info: { reason: string }) => {
            // Said out loud whether we asked for it or the engine gave up, so RTT going quiet is
            // never something the user has to guess about.
            this.mainSession.handleMsg(Stderr, `RTT stopped: ${info.reason}\n`);
        });

        const streams = await this.proxy.startRtt(request);
        for (const { channel, stream_id } of streams) {
            this.channelToStream.set(channel, stream_id);
            // Target → host. `onRttDataRead` is what applies the pre-decoder and broadcasts, exactly
            // as it does for the TypeScript engine.
            this.proxy.registerRawStream(stream_id, (data: Buffer) => {
                this.transport?.onRttDataRead(channel, data);
            });
        }

        // Host → target. One listener for every channel, because the transport reports which.
        transport.on("dataToWrite", (channel: number, data: Buffer) => {
            const stream_id = this.channelToStream.get(channel);
            if (stream_id === undefined) {
                this.mainSession.handleMsg(Stderr, `RTT: input for channel ${channel}, which the Agent is not serving\n`);
                return;
            }
            this.proxy.sendRawStream(stream_id, data);
        });

        this.started = true;
        const list = streams.map((s) => `${s.channel}→stream ${s.stream_id}`).join(", ");
        this.mainSession.handleMsg(Stdout, `RTT search started in the Probe Agent on the multiplexed gdb connection (${list})\n`);
    }

    public async dispose(): Promise<void> {
        // Stop the engine *before* unregistering, so it produces less that nobody is listening for.
        // It does not close the window entirely -- whatever the Agent had already written to the
        // funnel arrives after the response -- which is why `unregisterRawStream` remembers the id.
        if (this.started) {
            this.started = false;
            await this.proxy.stopRtt();
        }
        if (this.onStats) {
            this.proxy.off("rttStats", this.onStats);
            this.onStats = null;
        }
        for (const stream_id of this.channelToStream.values()) {
            this.proxy.unregisterRawStream(stream_id);
        }
        this.channelToStream.clear();
        this.transport = null;
    }
}

/**
 * The channels the configuration actually asks for, deduplicated and ordered.
 *
 * Taken from the decoders rather than from the control block: a target may allocate sixteen
 * channels while the user displays one, and draining the other fifteen would spend round trips --
 * the thing RTT throughput is bound by -- on data nobody reads.
 */
export function upChannels(config: RTTConfiguration): number[] {
    const found = new Set<number>();
    for (const dec of config.decoders || []) {
        if (typeof dec.port === "number") {
            found.add(dec.port);
        }
        for (const p of dec.ports || []) {
            found.add(p);
        }
    }
    return [...found].sort((a, b) => a - b);
}

/**
 * Which built-in RTT engine this session should use, and why.
 *
 * Kept as one function returning a reason so that the fallback is reported once, in words, rather
 * than being inferred from RTT quietly behaving like the old implementation.
 */
export function chooseRttEngine(config: RTTConfiguration, proxy: ProxyClient | null, rspMux: boolean | undefined): { engine: "rust" | "typescript"; why?: string } {
    const asked = config.useBuiltinRTT?.implementation ?? "rust";
    if (asked === "typescript") {
        return { engine: "typescript" };
    }
    if (!proxy) {
        return {
            engine: "typescript",
            why: "this session has no Probe Agent (an external gdb-server, or one matched by regex)",
        };
    }
    if (rspMux === false) {
        // The engine reads target memory through the multiplexer, so without it there is nothing to
        // run on. Falling back beats losing RTT, but it must be said out loud -- `rspMux: false` is
        // normally set to isolate a problem, and silently changing a second thing at the same time
        // would make the result meaningless.
        return { engine: "typescript", why: "debugFlags.rspMux is false, and Agent-side RTT needs the multiplexer" };
    }
    return { engine: "rust" };
}

/** Guard against a control-block address that would make the engine poll address 0 for ever. */
export function rttAddressLooksUsable(address: string | undefined): boolean {
    if (!address || address === "auto") {
        return false;
    }
    try {
        return parseAddress(address) !== 0n;
    } catch {
        return false;
    }
}
