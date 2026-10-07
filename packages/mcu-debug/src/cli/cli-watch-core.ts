// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// What `!!watch` and `!!live-watch` share: roots with stable ids, expansion to a depth under a node
// budget, the commands, persistence, and output. A subclass supplies only how to evaluate a root, list
// a node's children and release varobjs -- through the main GDB at a stop, or the live GDB while
// running -- plus whatever events drive it.
//
// Output is one structured record per value: the log file and socket clients get one JSON object per
// line, so a multi-line message would arrive as one record with no per-value fields. The `#id` and the
// tree indentation go in `consolePrefix`, which only the console shows.
//
// Every value carries a state, because sometimes there is no current value and sometimes none at all:
//   current       read at this stop (watch) or in the latest sample (live watch)
//   stale         watch, while running: the value from the last stop
//   unavailable   never read, or reading it failed (with the reason)
//   out-of-scope  watch: names a local that the stopped frame does not have

import { GdbProtocolVariable } from "../adapter/custom-requests";
import { CliWatchOptions } from "../adapter/servers/common";
import { formatLiveValue } from "../common/live-watch-format";
import { logger } from "../common/logger";
import { WatchKind, WatchRootSpec, WatchStore } from "./cli-watch-store";

const MAX_DEPTH = 8; // linked lists (`node->next`) are infinite; a bound is not optional
const MAX_NODES_PER_ROOT = 64;
/** The panel's `expr,x` suffix, accepted for familiarity. */
const HEX_SUFFIX = /\s*,\s*x$/i;

export type ValueState = "current" | "stale" | "unavailable" | "out-of-scope";

/** `cliOptions.watch` / `cliOptions.liveWatch` with every field filled in. */
export type ResolvedWatchOptions = Required<CliWatchOptions>;

// The defaults, in one place. manifest-src/definitions.js repeats them as schema `default`s, which
// are documentation only (VS Code does not put them into a launch config); a unit test checks the
// two agree, so they cannot drift apart.
export const WATCH_DEFAULTS: ResolvedWatchOptions = {
    // Only what changed since the previous stop: a batch stepping 100 times would otherwise print
    // 100 full trees.
    onStop: "changes",
    defaultDepth: 1, // depth 0 on a struct tracks only `{...}`, which never changes
    defaultFormat: "natural",
    onFrameChange: "none", // like gdb's `display`: re-evaluated silently, `list` shows it
};

export const LIVE_WATCH_DEFAULTS: ResolvedWatchOptions = {
    // One line per root: the changes were already reported as they were sampled.
    onStop: "roots",
    defaultDepth: 1,
    defaultFormat: "natural",
    onFrameChange: "none", // not used: live watch has no frame (and no schema entry)
};

/** `defaults` overridden by whatever launch.json actually sets; a null or missing field keeps its default. */
export function resolveWatchOptions(options: CliWatchOptions | undefined, defaults: ResolvedWatchOptions): ResolvedWatchOptions {
    const set = Object.entries(options ?? {}).filter(([, v]) => v !== undefined && v !== null);
    return { ...defaults, ...Object.fromEntries(set) };
}
type WatchFormat = WatchRootSpec["format"];

/** One tracked varobj under a root. */
export interface WatchNode {
    gdbVarName: string;
    /** What the user would type to watch this node on its own; used in every report line. */
    path: string;
    value: string;
    state: ValueState;
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

export interface WatchRoot extends WatchRootSpec {
    /** Undefined while the root has no value: not evaluated yet, or the evaluation failed. */
    node?: WatchNode;
    /** Why there is no node. */
    status?: { state: "unavailable" | "out-of-scope"; reason: string };
    /** Set when MAX_NODES_PER_ROOT cut the expansion short. */
    truncated?: { tracked: number; skipped: number };
}

/** A root's evaluation: a variable, or why there is none. */
export interface EvalResult {
    variable?: GdbProtocolVariable;
    gdbName?: string;
    failure?: { state: "unavailable" | "out-of-scope"; reason: string };
}

export abstract class WatchProviderBase {
    protected readonly roots = new Map<number, WatchRoot>();
    protected readonly out: ReturnType<typeof logger.child>;
    protected readonly options: ResolvedWatchOptions;
    private nextId = 1; // never reused (ids persist), so `delete 3` cannot hit a newer watch
    /** Values at the previous stop, by root id then path, for `onStop: "changes"`. */
    private lastStop = new Map<number, Map<string, string>>();

    /**
     * @param command    the meta-command, for messages: `!!watch` or `!!live-watch`
     * @param storeKind  this provider's section of the watch file
     * @param options    launch.json's `cliOptions.<kind>`, resolved against `defaults` once, here
     */
    constructor(
        protected readonly command: string,
        private readonly storeKind: WatchKind,
        private readonly store: WatchStore,
        options: CliWatchOptions | undefined,
        defaults: ResolvedWatchOptions,
        source: string,
    ) {
        this.options = resolveWatchOptions(options, defaults);
        this.out = logger.child({ source, isConsole: true });
        for (const spec of this.store.load(storeKind)) {
            this.roots.set(spec.id, { ...spec, depth: Math.min(spec.depth, MAX_DEPTH) });
            this.nextId = Math.max(this.nextId, spec.id + 1);
        }
    }

    // ---- what a subclass supplies -----------------------------------------------------------

    /** Undefined when roots can be evaluated now; otherwise why not, e.g. "evaluated at the next stop". */
    protected abstract notReadyReason(): Promise<string | undefined>;
    protected abstract evaluate(expr: string): Promise<EvalResult>;
    protected abstract children(node: WatchNode): Promise<GdbProtocolVariable[]>;
    /** Release varobjs (every name in a tree; the DA only `-var-delete`s roots). */
    protected abstract release(names: string[]): Promise<void>;
    /** Lines added to `help`, saying how this kind gets its values. */
    protected abstract helpNotes(): string[];

    // ---- commands ---------------------------------------------------------------------------

    /** `args` is everything after the command, with its original case (expressions are C). */
    public async handleCommand(args: string): Promise<boolean> {
        const [sub = "help", ...rest] = args.split(/\s+/).filter(Boolean);
        try {
            switch (sub.toLowerCase()) {
                case "add":
                    return await this.addCommand(rest);
                case "list":
                    this.listCommand(rest);
                    return true;
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
                    this.out.warn(`Unknown ${this.command} command '${sub}'. Try: ${this.command} help`);
                    return false;
            }
        } catch (e: any) {
            this.out.error(`${this.command} ${sub}: ${e?.message ?? e}`);
            return false;
        }
    }

    private async addCommand(tokens: string[]): Promise<boolean> {
        // Parsed, not trusted: launch.json is hand-written, and a bad value should say so here.
        let depth = this.parseDepth(String(this.options.defaultDepth));
        let quiet = false;
        let format: WatchFormat = this.options.defaultFormat === "hex" ? "hex" : "natural";
        while (tokens[0]?.startsWith("--")) {
            const opt = tokens.shift()!;
            if (opt === "--quiet") {
                quiet = true;
            } else if (opt === "--hex") {
                format = "hex";
            } else if (opt === "--natural") {
                format = "natural";
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
            throw new Error(`usage: ${this.command} add [--depth N] [--hex] [--quiet] <expression>`);
        }
        // The id is taken only once the root is kept, so a rejected typo does not leave a gap.
        const root: WatchRoot = { id: this.nextId, expr, depth, quiet, format };
        const notReady = await this.notReadyReason();
        if (notReady) {
            root.status = { state: "unavailable", reason: notReady };
        } else {
            await this.trackRoot(root);
            if (root.status?.state === "unavailable") {
                // Evaluated and failed: a typo, or (live) a local. Not worth keeping or persisting.
                this.out.warn(`${expr}: ${root.status.reason}`, { consolePrefix: `#${root.id} ` });
                return false;
            }
        }
        this.nextId++;
        this.roots.set(root.id, root);
        this.persist();
        this.out.info(`added ${expr}`, { consolePrefix: `#${root.id} `, kind: this.storeKind, watchId: root.id, expr });
        this.printTree(root);
        return true;
    }

    private listCommand(tokens: string[]): void {
        if (this.roots.size === 0) {
            this.out.info(`No watches. Add one with: ${this.command} add <expression>`);
            return;
        }
        const tree = tokens.includes("--tree");
        this.emitHeader();
        for (const root of this.roots.values()) {
            tree ? this.printTree(root) : this.emitRoot(root);
        }
    }

    private async deleteCommand(tokens: string[]): Promise<boolean> {
        const arg = tokens[0];
        if (!arg) {
            throw new Error(`usage: ${this.command} delete <id|all>`);
        }
        const victims = arg === "all" ? [...this.roots.values()] : [this.rootById(arg)];
        for (const root of victims) {
            await this.untrackRoot(root);
            this.roots.delete(root.id);
            this.lastStop.delete(root.id);
            this.out.info(`deleted ${root.expr}`, { consolePrefix: `#${root.id} `, kind: this.storeKind, watchId: root.id });
        }
        this.persist();
        return true;
    }

    private async depthCommand(tokens: string[]): Promise<boolean> {
        const root = this.rootById(tokens[0]);
        root.depth = this.parseDepth(tokens[1]);
        this.persist();
        const notReady = await this.notReadyReason();
        if (notReady) {
            this.out.info(`depth ${root.depth}, applied later: ${notReady}`, { consolePrefix: `#${root.id} ` });
            return true;
        }
        // Simplest correct way to change depth in either direction: rebuild the tree.
        await this.untrackRoot(root);
        await this.trackRoot(root);
        this.printTree(root);
        return true;
    }

    private formatCommand(tokens: string[]): boolean {
        const root = this.rootById(tokens[0]);
        const format = tokens[1]?.toLowerCase();
        if (format !== "hex" && format !== "natural") {
            throw new Error(`usage: ${this.command} format <id> hex|natural`);
        }
        root.format = format; // display only: nothing is re-read
        this.persist();
        this.printTree(root);
        return true;
    }

    private printHelp() {
        const c = this.command;
        this.out.info(
            [
                `${c} add [--depth N] [--hex] [--quiet] <expr>   prints its id; '<expr>,x' is the same as --hex`,
                `${c} list [--tree]                      the values we have, each marked current/stale/unavailable`,
                `${c} delete <id|all>`,
                `${c} depth <id> <N>                     how deep a struct/array/pointer is expanded (max ${MAX_DEPTH})`,
                `${c} format <id> hex|natural            hex applies to integers; floats, enums and pointers are unchanged`,
                ...this.helpNotes(),
                `Each watch tracks at most ${MAX_NODES_PER_ROOT} values; for a large array watch a slice, e.g. buf[16]@8.`,
                `Watches are saved in ${this.store.file} (keyed by the launch config's name).`,
            ].join("\n"),
        );
    }

    // ---- tracking ---------------------------------------------------------------------------

    /** Evaluate and expand one root. The caller has checked `notReadyReason()`. */
    protected async trackRoot(root: WatchRoot): Promise<void> {
        root.status = undefined;
        root.truncated = undefined;
        const result = await this.evaluate(root.expr);
        if (!result.variable) {
            root.node = undefined;
            root.status = result.failure ?? { state: "unavailable", reason: "could not evaluate" };
            return;
        }
        root.node = this.newNode(root, result.variable, root.expr, result.gdbName);
        const budget = { left: MAX_NODES_PER_ROOT - 1, skipped: 0 };
        await this.expand(root, root.node, root.depth, budget);
        if (budget.skipped > 0) {
            root.truncated = { tracked: MAX_NODES_PER_ROOT - budget.left, skipped: budget.skipped };
        }
    }

    /** Lists children (which makes them varobjs, i.e. tracked) down to `levels` more levels. */
    private async expand(root: WatchRoot, node: WatchNode, levels: number, budget: { left: number; skipped: number }): Promise<void> {
        if (levels <= 0 || node.variablesReference <= 0 || isString(node)) {
            return;
        }
        if (node.numchild > budget.left) {
            // All or nothing: listing creates a varobj per child, and the DA only ever
            // `-var-delete`s roots, so children over the budget could not be released again.
            node.notExpanded = true;
            budget.skipped += node.numchild;
            return;
        }
        const vars = await this.children(node);
        // Counted as listed, not as predicted: the DA may unwrap C++ layers, changing the count.
        budget.left -= vars.length;
        node.children = vars.map((v) => this.newNode(root, v, childPath(node, v)));
        for (const child of node.children) {
            await this.expand(root, child, levels - 1, budget);
        }
    }

    // Sends every name in the tree, as the panel does. Only the root becomes a '-var-delete' (gdb
    // takes its children with it); for the children the DA just drops its own map entries, so
    // naming them causes no gdb errors and keeps the DA's cache from leaking.
    protected async untrackRoot(root: WatchRoot): Promise<void> {
        const names: string[] = [];
        if (root.node) {
            walk(root.node, (n) => names.push(n.gdbVarName));
        }
        this.forgetNodes(root);
        root.node = undefined;
        await this.release(names.filter(Boolean));
    }

    /** Hook for a subclass that indexes nodes, before a root's nodes are dropped. */
    protected forgetNodes(_root: WatchRoot): void {}

    /** Hook for a subclass that indexes nodes, as each is created. */
    protected nodeCreated(_root: WatchRoot, _node: WatchNode): void {}

    private newNode(root: WatchRoot, v: GdbProtocolVariable, path: string, gdbName?: string): WatchNode {
        const node: WatchNode = {
            gdbVarName: gdbName || v.gdbVarName || "",
            path,
            value: v.value ?? "",
            state: "current",
            type: v.type ?? "",
            variablesReference: v.variablesReference ?? 0,
            numchild: v.numchild ?? 0,
            sizeof: v.sizeof,
            children: [],
        };
        this.nodeCreated(root, node);
        return node;
    }

    /**
     * The DA session is going away (a restart). Saves the list -- already saved on every change, so
     * this only guards against a change that failed to save -- and drops nothing else: a provider is
     * never reused after this; the next session makes its own from the file.
     */
    public dispose(): void {
        this.persist();
    }

    protected persist() {
        const specs = [...this.roots.values()].map(({ id, expr, depth, format, quiet }) => ({ id, expr, depth, format, quiet }));
        try {
            this.store.save(this.storeKind, specs);
            if (this.store.unparsable) {
                this.out.warn(`${this.store.file} was not valid JSON; kept it as ${this.store.file}.bad`);
            }
        } catch (e: any) {
            this.out.warn(`Could not save watches to ${this.store.file}: ${e?.message ?? e}`);
        }
    }

    // ---- output -----------------------------------------------------------------------------

    /**
     * A line saying which context the values belong to, when it is not the obvious one (watch: a
     * frame other than the stopped one). Printed above `list` and frame-change output.
     */
    protected header(): string | undefined {
        return undefined;
    }

    private emitHeader() {
        const text = this.header();
        if (text) {
            this.out.info(text, { kind: this.storeKind });
        }
    }

    /** Every non-quiet root, as a tree or one line each. Takes no snapshot: not a stop. */
    protected printAll(mode: "tree" | "roots") {
        this.emitHeader();
        for (const root of this.roots.values()) {
            if (!root.quiet) {
                mode === "tree" ? this.printTree(root) : this.emitRoot(root);
            }
        }
    }

    /** Print the watches for a stop, as launch.json's `cliOptions.<kind>.onStop` asks. */
    protected printAtStop() {
        const mode = this.options.onStop;
        const roots = [...this.roots.values()].filter((r) => !r.quiet);
        if (mode === "tree" || mode === "roots") {
            this.printAll(mode);
        } else if (mode === "changes") {
            for (const root of roots) {
                const before = this.lastStop.get(root.id);
                if (!root.node) {
                    if (before?.get(root.expr) !== this.display(root)) {
                        this.emitRoot(root);
                    }
                    continue;
                }
                walk(root.node, (n) => {
                    const prev = before?.get(n.path);
                    if (n.children.length === 0 && prev !== this.show(root, n)) {
                        this.emitChange(root, n, prev);
                    }
                });
            }
        }
        this.snapshot();
    }

    /** Remember this stop's values, so the next stop can report only what changed. */
    private snapshot() {
        this.lastStop.clear();
        for (const root of this.roots.values()) {
            const values = new Map<string, string>();
            if (root.node) {
                walk(root.node, (n) => values.set(n.path, this.show(root, n)));
            } else {
                values.set(root.expr, this.display(root));
            }
            this.lastStop.set(root.id, values);
        }
    }

    protected printTree(root: WatchRoot) {
        this.emitRoot(root);
        if (root.node) {
            for (const child of root.node.children) {
                walk(child, (n, level) => this.emitValue(root, n, level + 1));
            }
        }
        if (root.truncated) {
            this.out.info(`(tracking ${root.truncated.tracked} values; ${root.truncated.skipped} more over the ${MAX_NODES_PER_ROOT}-value limit)`, {
                consolePrefix: " ".repeat(`#${root.id} `.length),
            });
        }
    }

    /** One line for a root, whether or not it has a value. */
    protected emitRoot(root: WatchRoot) {
        if (root.node) {
            this.emitValue(root, root.node, 0);
            return;
        }
        const status = root.status ?? { state: "unavailable" as const, reason: "not evaluated yet" };
        this.out.info(`${root.expr} = ${this.display(root)}`, {
            consolePrefix: `#${root.id} `,
            kind: this.storeKind,
            watchId: root.id,
            path: root.expr,
            state: status.state,
            reason: status.reason,
        });
    }

    /** One record per value. `level` 0 is the root; children are indented on the console only. */
    protected emitValue(root: WatchRoot, node: WatchNode, level: number) {
        const shown = this.show(root, node);
        let text = `${node.path} = ${shown}`;
        const tracked = countNodes(node) - 1;
        if (level === 0 && tracked > 0) {
            text += `  [${tracked} tracked]`; // not for depth 0, or a pointer left unexpanded
        }
        if (node.notExpanded) {
            text += `   (${node.numchild} values, not tracked; watch a slice, e.g. ${node.path}[0]@8, or a member)`;
        }
        const idPrefix = `#${root.id} `;
        this.out.info(text, {
            consolePrefix: level === 0 ? idPrefix : " ".repeat(idPrefix.length) + "  ".repeat(level - 1),
            kind: this.storeKind,
            watchId: root.id,
            path: node.path,
            value: formatLiveValue(node.value, root.format, node.sizeof),
            state: node.state,
        });
    }

    /**
     * One changed value, as a flat line: `#3 motor.speed = 120  (was 100)`. `prev` is as displayed;
     * undefined when there was no earlier value (a new watch, or the first stop).
     */
    protected emitChange(root: WatchRoot, node: WatchNode, prev: string | undefined) {
        const shown = this.show(root, node);
        this.out.info(`${node.path} = ${shown}${prev !== undefined ? `  (was ${prev})` : ""}`, {
            consolePrefix: `#${root.id} `,
            kind: this.storeKind,
            watchId: root.id,
            path: node.path,
            value: formatLiveValue(node.value, root.format, node.sizeof),
            state: node.state,
            ...(prev !== undefined ? { prev } : {}),
        });
    }

    /** A node's value as displayed: formatted, and marked when it is not current. */
    protected show(root: WatchRoot, node: WatchNode): string {
        const value = formatLiveValue(node.value, root.format, node.sizeof);
        switch (node.state) {
            case "stale":
                return `${value}   (at last stop)`;
            case "out-of-scope":
                return "<not in scope>";
            case "unavailable":
                return "<unavailable>"; // e.g. gdb reports the varobj invalid
            default:
                return value;
        }
    }

    /** A root without a node: why it has no value. */
    private display(root: WatchRoot): string {
        if (root.status?.state === "out-of-scope") {
            return "<not in scope>";
        }
        return `<unavailable: ${root.status?.reason ?? "not evaluated yet"}>`;
    }

    // ---- helpers ----------------------------------------------------------------------------

    protected rootById(arg: string | undefined): WatchRoot {
        const id = Number(arg?.replace(/^#/, ""));
        const root = Number.isInteger(id) ? this.roots.get(id) : undefined;
        if (!root) {
            throw new Error(`no watch '${arg ?? ""}'. See: ${this.command} list`);
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

/** Pre-order walk; `level` is 0 for the node passed in. */
export function walk(node: WatchNode, visit: (n: WatchNode, level: number) => void, level = 0) {
    visit(node, level);
    for (const c of node.children) {
        walk(c, visit, level + 1);
    }
}

function countNodes(n: WatchNode): number {
    return 1 + n.children.reduce((sum, c) => sum + countNodes(c), 0);
}

/** `evaluateName` is what the user could type to watch the child on its own, so prefer it. */
function childPath(parent: WatchNode, v: GdbProtocolVariable): string {
    if (v.evaluateName) {
        return v.evaluateName;
    }
    return v.name.startsWith("[") ? `${parent.path}${v.name}` : `${parent.path}.${v.name}`;
}

/** A `char *` already shows the string in its value; its one child is just the first char. */
function isString(node: WatchNode): boolean {
    return /\bchar\s*\*\s*$/.test(node.type);
}
