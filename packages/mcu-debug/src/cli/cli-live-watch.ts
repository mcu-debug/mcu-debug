// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
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

// `!!live-watch`: watches read through the second ("live") GDB while the target runs. The commands,
// expansion, output and persistence are shared with `!!watch` (cli-watch-core); this file is what is
// live-specific: registering with the DA, the pushed update events, and reconnects.
//
// Limits, all deliberate:
// - Global context only. The DA evaluates with no frame (the target is running), so locals fail;
//   `!!watch` can watch those, at stops.
// - Sampled, not exact. Values are read `samplesPerSecond` times a second; a change that reverts
//   between two samples is never seen. This is observation, not a watchpoint.

import { DebugProtocol } from "@vscode/debugprotocol";
import {
    DeleteLiveGdbVariables,
    EvaluateLiveResponse,
    EvaluateRequestLiveArguments,
    GdbProtocolVariable,
    LatestLiveSessionVersion,
    LiveConnectedEvent,
    LiveUpdateEvent,
    LiveWatchClientReadyRequest,
    RegisterClientRequest,
    RegisterClientResponse,
    VariablesLiveResponse,
    VariablesRequestLiveArguments,
} from "../adapter/custom-requests";
import { VarUpdateRecord } from "../adapter/gdb-mi/mi-types";
import { CliWatchOptions } from "../adapter/servers/common";
import { CLISessionType } from "../common/host-adapter";
import { CliSessionDriver } from "./cli-driver";
import { EvalResult, LIVE_WATCH_DEFAULTS, walk, WatchNode, WatchProviderBase, WatchRoot } from "./cli-watch-core";
import { WatchStore } from "./cli-watch-store";

export class CliLiveWatchProvider extends WatchProviderBase {
    private readonly clientId = "mcu-debug-live-watch-cli-provider";
    private sessionStatus: CLISessionType = "not-started";
    private liveSessionId: string | undefined;
    private registering: Promise<boolean> | undefined;
    /** Set when registration failed; no retry until the next 'connected' event, to avoid a warning per stop. */
    private unavailable: string | undefined;
    private readonly byGdbVarName = new Map<string, { root: WatchRoot; node: WatchNode }>();

    constructor(
        private sessionDriver: CliSessionDriver,
        store: WatchStore,
        options: CliWatchOptions | undefined,
    ) {
        super("!!live-watch", "liveWatch", store, options, LIVE_WATCH_DEFAULTS, "LIVE-WATCH");
        this.sessionDriver.on("stateChanged", this.onStateChanged);
    }

    private readonly onStateChanged = (state: CLISessionType) => {
        this.sessionStatus = state;
        if (state === "terminated") {
            this.forgetLiveState();
        }
    };

    /** The driver outlives us across a restart, so the listener must go with us. */
    public dispose(): void {
        this.sessionDriver.off("stateChanged", this.onStateChanged);
        super.dispose();
    }

    // ---- the core's transport -----------------------------------------------------------------

    protected async notReadyReason(): Promise<string | undefined> {
        if (this.sessionStatus === "not-started" || this.sessionStatus === "terminated") {
            return "the session is not running; read once live watch connects";
        }
        if (!(await this.ensureRegistered())) {
            return this.unavailable ?? "live watch is not connected yet";
        }
        return undefined;
    }

    protected async evaluate(expr: string): Promise<EvalResult> {
        const arg: EvaluateRequestLiveArguments = {
            command: "evaluateLive",
            sessionId: this.liveSessionId!,
            expression: expr,
            context: "watch",
        };
        const rsp = await this.request<EvaluateLiveResponse>(arg);
        const variable = rsp.success ? rsp.body?.variableObject : undefined;
        if (!variable) {
            return { failure: { state: "unavailable", reason: rsp.message || "could not evaluate (globals only: locals have no frame while running)" } };
        }
        return { variable, gdbName: rsp.body.gdbName };
    }

    protected async children(node: WatchNode): Promise<GdbProtocolVariable[]> {
        const arg: VariablesRequestLiveArguments = {
            command: "variablesLive",
            sessionId: this.liveSessionId!,
            variablesReference: node.variablesReference,
            gdbVarName: node.gdbVarName,
        };
        const rsp = await this.request<VariablesLiveResponse>(arg);
        return rsp.success ? (rsp.body?.variables ?? []) : [];
    }

    protected async release(names: string[]): Promise<void> {
        if (names.length === 0 || !this.liveSessionId) {
            return;
        }
        const arg: DeleteLiveGdbVariables = { command: "deleteLiveGdbVariables", sessionId: this.liveSessionId, deleteGdbVars: names };
        await this.request<DebugProtocol.Response>(arg);
    }

    protected helpNotes(): string[] {
        return [
            "Globals only: the target is running, so there is no frame (use !!watch for locals, at stops).",
            "Values are sampled (liveWatch.samplesPerSecond); a change that reverts between samples is not seen.",
        ];
    }

    protected nodeCreated(root: WatchRoot, node: WatchNode): void {
        if (node.gdbVarName) {
            this.byGdbVarName.set(node.gdbVarName, { root, node });
        }
    }

    protected forgetNodes(root: WatchRoot): void {
        if (root.node) {
            walk(root.node, (n) => this.byGdbVarName.delete(n.gdbVarName));
        }
    }

    // ---- driver hooks -------------------------------------------------------------------------

    /**
     * The target stopped. Called by the driver before it runs the next queued command, so the stop's
     * output comes before that command's.
     */
    public async onStop(): Promise<void> {
        if (this.roots.size === 0) {
            return;
        }
        if (!this.liveSessionId) {
            // Roots restored from the watch file, and live watch not enabled in launch.json, so
            // nothing has registered yet. Registering starts the live GDB on demand.
            await this.trackAll();
        } else {
            // The DA runs one last update when the target stops. Every live request waits for it,
            // and this one also flushes a batch held for our ack *before* its response -- so once it
            // returns, the values are the ones at the stop. (Assumes the DA started that update
            // before this request arrived: both follow the same gdb stop, and the DAP 'stopped' event
            // is sent after the DA's own stop processing.)
            await this.request<DebugProtocol.Response>({ command: "liveWatchClientReady", sessionId: this.liveSessionId } as LiveWatchClientReadyRequest);
        }
        this.printAtStop();
    }

    // ---- DA events ----------------------------------------------------------------------------

    public async receivedVariableUpdates(e_: DebugProtocol.Event): Promise<void> {
        const e = e_ as LiveUpdateEvent;
        if (e.body?.sessionId !== this.liveSessionId) {
            return; // a batch for an earlier registration, from before a reconnect
        }
        const reshape = new Set<WatchRoot>();
        for (const update of e.body.updates ?? []) {
            const hit = this.byGdbVarName.get(update.name);
            if (!hit) {
                continue;
            }
            this.applyUpdate(hit.root, hit.node, update);
            // A changed child count or type (a pretty-printed container, a union read differently)
            // invalidates the tree below. Rebuild the whole root from (expr, depth): rare, and far
            // simpler than patching one subtree.
            if (update.type_changed === "true" || update.new_num_children !== undefined) {
                reshape.add(hit.root);
            }
        }
        for (const root of reshape) {
            await this.untrackRoot(root);
            await this.trackRoot(root);
        }
        // Registered "onReady": the DA holds the next batch until this ack, coalescing changes while
        // a slow consumer (a socket client) catches up instead of queueing a flood.
        await this.request<DebugProtocol.Response>({ command: "liveWatchClientReady", sessionId: this.liveSessionId } as LiveWatchClientReadyRequest);
    }

    private applyUpdate(root: WatchRoot, node: WatchNode, update: VarUpdateRecord) {
        if (update.type_changed === "true" && update.new_type) {
            node.type = update.new_type;
        }
        const state = update.in_scope === "true" ? "current" : update.in_scope === "false" ? "out-of-scope" : "unavailable";
        const value = state === "current" ? update.value : node.value;
        if (value === node.value && state === node.state) {
            return;
        }
        const prev = this.show(root, node);
        node.value = value;
        node.state = state;
        if (!root.quiet) {
            this.emitChange(root, node, prev);
        }
    }

    // The live GDB finished starting. It connects once per DA session, so a second 'connected'
    // means a new session: every varobj name we hold is meaningless now. Keep the roots (ids
    // survive), drop the rest, and track everything again.
    public async liveWatchConnected(e_: DebugProtocol.Event): Promise<void> {
        const e = e_ as any as LiveConnectedEvent;
        if (!e.body?.connected) {
            if (e.body?.reason) {
                this.out.warn("Live Watch connection failed: " + e.body.reason);
            }
            return;
        }
        this.forgetLiveState();
        await this.trackAll(); // with no roots yet, registration waits for the first `add`
    }

    private async trackAll() {
        if (this.roots.size === 0) {
            return;
        }
        const notReady = await this.notReadyReason();
        for (const root of this.roots.values()) {
            if (notReady) {
                root.status = { state: "unavailable", reason: notReady };
                continue;
            }
            await this.trackRoot(root);
            if (root.status) {
                this.out.warn(`${root.expr}: ${root.status.reason}`, { consolePrefix: `#${root.id} ` });
            }
        }
    }

    // ---- DA plumbing --------------------------------------------------------------------------

    /**
     * Register with the DA once per live session. Registering also asks the DA to start the live
     * GDB if it has not already, so `add` works even when `liveWatch.enabled` was not configured.
     */
    private ensureRegistered(): Promise<boolean> {
        if (this.unavailable) {
            return Promise.resolve(false);
        }
        if (!this.registering) {
            const req: RegisterClientRequest = {
                command: "registerClient",
                clientId: this.clientId,
                version: LatestLiveSessionVersion,
                notifyMode: "onReady",
                sessionId: "",
            };
            this.registering = this.request<RegisterClientResponse>(req).then((rsp) => {
                if (!rsp.success || !rsp.body?.sessionId) {
                    this.registering = undefined;
                    this.unavailable = `live watch unavailable: ${rsp.message ?? "registration failed"}`;
                    this.out.warn(this.unavailable);
                    return false;
                }
                this.liveSessionId = rsp.body.sessionId;
                return true;
            });
        }
        return this.registering;
    }

    private forgetLiveState() {
        this.registering = undefined;
        this.liveSessionId = undefined;
        this.unavailable = undefined;
        this.byGdbVarName.clear();
        for (const root of this.roots.values()) {
            root.node = undefined;
        }
    }

    /** `sendRequest` resolves failed responses too; callers check `success`. */
    private request<T extends DebugProtocol.Response>(args: { command: string }): Promise<T> {
        return this.sessionDriver.sendRequest<T>({ seq: 0, type: "request", command: args.command, arguments: args });
    }
}
