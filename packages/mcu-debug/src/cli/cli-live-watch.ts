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

// Live watch for the CLI: `!!live-watch add|list|delete|depth|help`.
//
// Model. Each `add` creates a root with a stable integer id. A root is an expression plus a depth;
// expanding it to that depth turns every node into a gdb varobj in the live GDB, and from then on
// the DA pushes `-var-update` records for whichever of them changed. Only roots have ids -- the
// tree under a root is rebuilt from (expr, depth) whenever needed, so nothing else has to be named.
//
// What is sent where. Every change is one log line through `out`, which reaches stdout, the log
// file and socket clients; the metadata fields (watchId, path, value, prev) arrive in the socket's
// JSON as top-level fields, so a script never parses the text.
//
// Limits, all deliberate:
// - Global context only. The DA evaluates with no frame (the target is running), so locals fail.
// - Sampled, not exact. Values are read `samplesPerSecond` times a second; a change that reverts
//   between two samples is never seen. This is observation, not a watchpoint.
// - Bounded. Every tracked node is a memory read per sample while the target runs, so each root
//   tracks at most MAX_NODES_PER_ROOT nodes. A node whose children would exceed that is left
//   unexpanded, decided from its child count *before* listing: listing creates a varobj per child,
//   and the DA only ever '-var-delete's roots, so children cannot be released individually.

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
import { CLISessionType } from "../common/host-adapter";
import { formatLiveValue } from "../common/live-watch-format";
import { logger } from "../common/logger";
import { CliSessionDriver } from "./cli-driver";

const DEFAULT_DEPTH = 1; // depth 0 on a struct tracks only `{...}`, which never changes
const MAX_DEPTH = 8; // linked lists (`node->next`) are infinite; a bound is not optional
const MAX_NODES_PER_ROOT = 64;

/** The panel's `expr,x` suffix, accepted for familiarity. */
const HEX_SUFFIX = /\s*,\s*x$/i;

/** Per root. Only hex vs natural: floats stay floats either way, and that covers what people ask for. */
type CliWatchFormat = "natural" | "hex";

/** One tracked varobj under a root. */
interface WatchNode {
    gdbVarName: string;
    /** What the user would type to watch this node on its own; used in every report line. */
    path: string;
    value: string;
    type: string;
    /** > 0 means composite (struct, array, pointer): it has children to expand. */
    variablesReference: number;
    numchild: number;
    /** Sizes negatives and padding when formatting as hex. */
    sizeof?: number;
    children: WatchNode[];
    /** Composite left unexpanded because its children would exceed the budget. */
    notExpanded?: boolean;
}

interface WatchRoot {
    id: number;
    expr: string;
    depth: number;
    /** Tracked but not reported on change; still shown by `list`. */
    quiet: boolean;
    /** Applies to the whole tree. Display only: changing it never re-tracks anything. */
    format: CliWatchFormat;
    /** Undefined until tracked in the live GDB (not connected yet, or re-tracking after a reconnect). */
    node?: WatchNode;
    /** Why the last attempt to track this root failed, e.g. a local or a typo. */
    error?: string;
    /** Set when MAX_NODES_PER_ROOT cut the expansion short. */
    truncated?: { tracked: number; skipped: number };
}

export class CliLiveWatchProvider {
    private readonly clientId = "mcu-debug-live-watch-cli-provider";
    private readonly out = logger.child({ source: "LIVE-WATCH", isConsole: true });
    private sessionStatus: CLISessionType = "not-started";
    private liveSessionId: string | undefined;
    private registering: Promise<boolean> | undefined;

    private nextId = 1; // never reused within a session, so `delete 3` cannot hit a newer watch
    private readonly roots = new Map<number, WatchRoot>();
    private readonly byGdbVarName = new Map<string, { root: WatchRoot; node: WatchNode }>();

    constructor(private sessionDriver: CliSessionDriver) {
        this.sessionDriver.on("stateChanged", (state: CLISessionType) => {
            this.sessionStatus = state;
            if (state === "terminated") {
                this.forgetLiveState();
            }
        });
    }

    // ---- commands ---------------------------------------------------------------------------

    /** `args` is everything after `!!live-watch`, with its original case (expressions are C). */
    public async handleCommand(args: string): Promise<boolean> {
        const [sub = "help", ...rest] = args.split(/\s+/).filter(Boolean);
        try {
            switch (sub.toLowerCase()) {
                case "add":
                    return await this.addCommand(rest);
                case "list":
                    return this.listCommand(rest);
                case "delete":
                    return await this.deleteCommand(rest);
                case "depth":
                    return await this.depthCommand(rest);
                case "format":
                    return this.formatCommand(rest);
                case "help":
                    this.printHelp();
                    return true;
                default:
                    this.out.warn(`Unknown live-watch command '${sub}'. Try: !!live-watch help`);
                    return false;
            }
        } catch (e: any) {
            this.out.error(`live-watch ${sub}: ${e?.message ?? e}`);
            return false;
        }
    }

    private async addCommand(tokens: string[]): Promise<boolean> {
        let depth = DEFAULT_DEPTH;
        let quiet = false;
        let format: CliWatchFormat = "natural";
        while (tokens[0]?.startsWith("--")) {
            const opt = tokens.shift()!;
            if (opt === "--quiet") {
                quiet = true;
            } else if (opt === "--hex") {
                format = "hex";
            } else if (opt === "--depth") {
                depth = this.parseDepth(tokens.shift());
            } else {
                throw new Error(`unknown option '${opt}'`);
            }
        }
        // The expression is the rest of the line: `a.b[i] + 1` contains spaces.
        let expr = tokens.join(" ");
        if (HEX_SUFFIX.test(expr)) {
            // Stripped rather than passed on: the DA would turn it into gdb's `-var-set-format`,
            // which formats the root but none of its children (see common/live-watch-format).
            expr = expr.replace(HEX_SUFFIX, "");
            format = "hex";
        }
        if (!expr) {
            throw new Error("usage: !!live-watch add [--depth N] [--hex] [--quiet] <expression>");
        }
        const root: WatchRoot = { id: this.nextId++, expr, depth, quiet, format };
        this.roots.set(root.id, root);
        await this.trackRoot(root);
        if (root.error) {
            // Keep it: a typo is fixed by `delete`, but a root that failed only because the live
            // connection was not up yet is retried when it comes up.
            this.out.warn(`#${root.id} ${expr}: ${root.error}`);
            return false;
        }
        this.out.info(`#${root.id} added: ${expr}`, { watchId: root.id, expr });
        this.printTree(root);
        return true;
    }

    private listCommand(tokens: string[]): boolean {
        const tree = tokens.includes("--tree");
        if (this.roots.size === 0) {
            this.out.info("No live watches. Add one with: !!live-watch add <expression>");
            return true;
        }
        for (const root of this.roots.values()) {
            if (tree) {
                this.printTree(root);
            } else {
                this.out.info(`#${root.id}  ${root.expr} = ${this.describeRoot(root)}`);
            }
        }
        return true;
    }

    private async deleteCommand(tokens: string[]): Promise<boolean> {
        const arg = tokens[0];
        if (!arg) {
            throw new Error("usage: !!live-watch delete <id|all>");
        }
        const victims = arg === "all" ? [...this.roots.values()] : [this.rootById(arg)];
        for (const root of victims) {
            await this.untrackRoot(root);
            this.roots.delete(root.id);
            this.out.info(`#${root.id} deleted: ${root.expr}`, { watchId: root.id });
        }
        return true;
    }

    private async depthCommand(tokens: string[]): Promise<boolean> {
        const root = this.rootById(tokens[0]);
        root.depth = this.parseDepth(tokens[1]);
        // Simplest correct way to change depth in either direction: rebuild the tree.
        await this.untrackRoot(root);
        await this.trackRoot(root);
        this.printTree(root);
        return !root.error;
    }

    private formatCommand(tokens: string[]): boolean {
        const root = this.rootById(tokens[0]);
        const format = tokens[1]?.toLowerCase();
        if (format !== "hex" && format !== "natural") {
            throw new Error("usage: !!live-watch format <id> hex|natural");
        }
        root.format = format;
        this.printTree(root);
        return true;
    }

    private printHelp() {
        this.out.info(
            [
                "!!live-watch add [--depth N] [--hex] [--quiet] <expr>   watch a global; prints its id (`<expr>,x` = --hex)",
                "!!live-watch list [--tree]                      current values (no target access)",
                "!!live-watch delete <id|all>",
                "!!live-watch depth <id> <N>                     change how deep a watch is expanded",
                "!!live-watch format <id> hex|natural            integers in hex; floats, enums and pointers unchanged",
                `Depth defaults to ${DEFAULT_DEPTH}, max ${MAX_DEPTH}; each watch tracks at most ${MAX_NODES_PER_ROOT} nodes.`,
                "Large arrays: watch a slice, e.g. `buf[16]@8`. Globals only: there is no frame while running.",
                "Values are sampled (liveWatch.samplesPerSecond), so a change that reverts between samples is not seen.",
            ].join("\n"),
        );
    }

    // ---- tracking ---------------------------------------------------------------------------

    private async trackRoot(root: WatchRoot): Promise<void> {
        root.error = undefined;
        root.truncated = undefined;
        if (!(await this.ensureRegistered())) {
            root.error = "live watch is not available yet; will retry when it connects";
            return;
        }
        const arg: EvaluateRequestLiveArguments = {
            command: "evaluateLive",
            sessionId: this.liveSessionId!,
            expression: root.expr,
            context: "watch",
        };
        const rsp = await this.request<EvaluateLiveResponse>(arg);
        const obj = rsp.success ? rsp.body?.variableObject : undefined;
        if (!obj) {
            root.error = rsp.message || "could not evaluate (globals only: locals have no frame while running)";
            return;
        }
        const node = this.newNode(root, obj, root.expr, rsp.body.gdbName);
        root.node = node;
        const budget = { left: MAX_NODES_PER_ROOT - 1, skipped: 0 };
        await this.expand(root, node, root.depth, budget);
        if (budget.skipped > 0) {
            root.truncated = { tracked: MAX_NODES_PER_ROOT - budget.left, skipped: budget.skipped };
        }
    }

    /** Lists children (which makes them varobjs, i.e. tracked) down to `levels` more levels. */
    private async expand(root: WatchRoot, node: WatchNode, levels: number, budget: { left: number; skipped: number }): Promise<void> {
        if (levels <= 0 || node.variablesReference <= 0 || this.isString(node)) {
            return;
        }
        const arg: VariablesRequestLiveArguments = {
            command: "variablesLive",
            sessionId: this.liveSessionId!,
            variablesReference: node.variablesReference,
            gdbVarName: node.gdbVarName,
        };
        if (node.numchild > budget.left) {
            // All or nothing: listing would create every child's varobj (see the header).
            node.notExpanded = true;
            budget.skipped += node.numchild;
            return;
        }
        const rsp = await this.request<VariablesLiveResponse>(arg);
        const vars = rsp.success ? (rsp.body?.variables ?? []) : [];
        // Counted as listed, not as predicted: the DA may unwrap C++ layers, changing the count.
        budget.left -= vars.length;
        node.children = vars.map((v) => this.newNode(root, v as GdbProtocolVariable, this.childPath(node, v)));
        for (const child of node.children) {
            await this.expand(root, child, levels - 1, budget);
        }
    }

    // Sends every name in the tree, as the panel does. Only the root becomes a '-var-delete' (gdb
    // takes its children with it); for the children the DA just drops its own map entries, so
    // naming them causes no gdb errors and keeps the DA's cache from leaking.
    private async untrackRoot(root: WatchRoot): Promise<void> {
        const names: string[] = [];
        const walk = (n: WatchNode) => {
            names.push(n.gdbVarName);
            this.byGdbVarName.delete(n.gdbVarName);
            n.children.forEach(walk);
        };
        if (root.node) {
            walk(root.node);
        }
        root.node = undefined;
        await this.deleteGdbVars(names.filter(Boolean));
    }

    private newNode(root: WatchRoot, v: GdbProtocolVariable, path: string, gdbName?: string): WatchNode {
        const node: WatchNode = {
            gdbVarName: gdbName || v.gdbVarName || "",
            path,
            value: v.value ?? "",
            type: v.type ?? "",
            variablesReference: v.variablesReference ?? 0,
            numchild: v.numchild ?? 0,
            sizeof: v.sizeof,
            children: [],
        };
        if (node.gdbVarName) {
            this.byGdbVarName.set(node.gdbVarName, { root, node });
        }
        return node;
    }

    /** `evaluateName` is what the user could type to watch the child on its own, so prefer it. */
    private childPath(parent: WatchNode, v: DebugProtocol.Variable): string {
        if (v.evaluateName) {
            return v.evaluateName;
        }
        return v.name.startsWith("[") ? `${parent.path}${v.name}` : `${parent.path}.${v.name}`;
    }

    /** A `char *` already shows the string in its value; its one child is just the first char. */
    private isString(node: WatchNode): boolean {
        return /\bchar\s*\*\s*$/.test(node.type);
    }

    // ---- DA events --------------------------------------------------------------------------

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
        const value = update.in_scope === "true" ? update.value : update.in_scope === "false" ? "<out of scope>" : "<invalid>";
        if (update.type_changed === "true" && update.new_type) {
            node.type = update.new_type;
        }
        if (value === node.value) {
            return;
        }
        const prev = this.show(root, node.value, node);
        node.value = value;
        if (!root.quiet) {
            const shown = this.show(root, value, node);
            this.out.info(`#${root.id} ${node.path} = ${shown}  (was ${prev})`, { watchId: root.id, path: node.path, value: shown, prev });
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
        if (this.roots.size === 0) {
            return; // registered lazily on the first `add`
        }
        for (const root of this.roots.values()) {
            await this.trackRoot(root);
            if (root.error) {
                this.out.warn(`#${root.id} ${root.expr}: ${root.error}`);
            }
        }
    }

    // ---- DA plumbing ------------------------------------------------------------------------

    /**
     * Register with the DA once per live session. Registering also asks the DA to start the live
     * GDB if it has not already, so `add` works even when `liveWatch.enabled` was not configured.
     */
    private ensureRegistered(): Promise<boolean> {
        if (this.sessionStatus === "not-started" || this.sessionStatus === "terminated") {
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
                    this.registering = undefined; // allow a retry after the next 'connected'
                    this.out.warn(`Live watch unavailable: ${rsp.message ?? "registration failed"}`);
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
        this.byGdbVarName.clear();
        for (const root of this.roots.values()) {
            root.node = undefined;
        }
    }

    private async deleteGdbVars(names: string[]): Promise<void> {
        if (names.length === 0 || !this.liveSessionId) {
            return;
        }
        const arg: DeleteLiveGdbVariables = { command: "deleteLiveGdbVariables", sessionId: this.liveSessionId, deleteGdbVars: names };
        await this.request<DebugProtocol.Response>(arg);
    }

    /** `sendRequest` resolves failed responses too; callers check `success`. */
    private request<T extends DebugProtocol.Response>(args: { command: string }): Promise<T> {
        return this.sessionDriver.sendRequest<T>({ seq: 0, type: "request", command: args.command, arguments: args });
    }

    // ---- presentation -----------------------------------------------------------------------

    private printTree(root: WatchRoot) {
        const rootNote = root.node?.notExpanded ? `   (${root.node.numchild} children, not tracked; watch a slice, e.g. ${root.expr}[0]@8)` : "";
        const lines = [`#${root.id}  ${root.expr} = ${this.describeRoot(root)}${rootNote}`];
        const walk = (n: WatchNode, indent: string) => {
            for (const c of n.children) {
                const note = c.notExpanded ? `   (${c.numchild} children, not tracked; watch a slice or a member)` : "";
                lines.push(`${indent}${c.path} = ${this.show(root, c.value, c)}${note}`);
                walk(c, indent + "  ");
            }
        };
        if (root.node) {
            walk(root.node, "    ");
        }
        if (root.truncated) {
            lines.push(`    (tracking ${root.truncated.tracked} nodes; ${root.truncated.skipped} more over the ${MAX_NODES_PER_ROOT}-node limit)`);
        }
        this.out.info(lines.join("\n"));
    }

    private describeRoot(root: WatchRoot): string {
        if (root.error) {
            return `<${root.error}>`;
        }
        if (!root.node) {
            return "<not tracked yet>";
        }
        const n = root.node;
        return n.variablesReference > 0 ? `${n.value}  [${this.countNodes(n) - 1} tracked]` : this.show(root, n.value, n);
    }

    private show(root: WatchRoot, value: string, node: WatchNode): string {
        return formatLiveValue(value, root.format, node.sizeof);
    }

    private countNodes(n: WatchNode): number {
        return 1 + n.children.reduce((sum, c) => sum + this.countNodes(c), 0);
    }

    private rootById(arg: string | undefined): WatchRoot {
        const id = Number(arg?.replace(/^#/, ""));
        const root = Number.isInteger(id) ? this.roots.get(id) : undefined;
        if (!root) {
            throw new Error(`no live watch '${arg ?? ""}'. See: !!live-watch list`);
        }
        return root;
    }

    private parseDepth(arg: string | undefined): number {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 0 || n > MAX_DEPTH) {
            throw new Error(`depth must be an integer 0..${MAX_DEPTH}`);
        }
        return n;
    }
}
