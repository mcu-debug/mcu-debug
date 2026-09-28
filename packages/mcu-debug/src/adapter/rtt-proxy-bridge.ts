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

export class RttProxyBridge {
    /** RTT channel → the funnel stream its data arrives on. */
    private channelToStream: Map<number, number> = new Map();
    private transport: RttTransport | null = null;
    private started = false;

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
            max_bytes_per_drain: null,
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
