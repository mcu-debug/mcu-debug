// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// `!!watch`: watches evaluated through the main GDB, at every stop, in the stopped frame -- so unlike
// `!!live-watch` it can watch locals, and it works with gdb-servers that refuse a second connection.
// The commands, expansion, output and persistence are shared with live watch (cli-watch-core).
//
// Every stop rebuilds every tree. There is no choice: the DA deletes all non-global varobjs, watch
// ones included, when the target continues (`clearForContinue`). For the same reason nothing is ever
// released here. While running, `list` shows the last stop's values marked stale.

import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbProtocolVariable } from "../adapter/custom-requests";
import { CliWatchOptions, CustomFrameSelectedEvent } from "../adapter/servers/common";
import { CliSessionDriver } from "./cli-driver";
import { EvalResult, walk, WATCH_DEFAULTS, WatchNode, WatchProviderBase } from "./cli-watch-core";
import { WatchStore } from "./cli-watch-store";

export class CliWatchProvider extends WatchProviderBase {
    /**
     * The frame watches are evaluated in: the stopped thread's top frame, or the one the user selected
     * since (`up`, `frame N`). Undefined while running -- the DA's frame ids die on continue.
     */
    private frameId: number | undefined;
    /** Set while a frame other than the stopped one is selected, for the header line. */
    private selected: { level: number; where: string } | undefined;

    constructor(
        private sessionDriver: CliSessionDriver,
        store: WatchStore,
        options: CliWatchOptions | undefined,
    ) {
        super("!!watch", "watch", store, options, WATCH_DEFAULTS, "WATCH");
    }

    // ---- the core's transport -----------------------------------------------------------------

    protected async notReadyReason(): Promise<string | undefined> {
        return this.frameId === undefined ? "the target is running; evaluated at the next stop" : undefined;
    }

    protected async evaluate(expr: string): Promise<EvalResult> {
        const rsp = await this.request<DebugProtocol.EvaluateResponse>("evaluate", {
            expression: expr,
            context: "watch",
            frameId: this.frameId,
        } as DebugProtocol.EvaluateArguments);
        const variable = rsp.success ? ((rsp.body as any)?.variableObject as GdbProtocolVariable | undefined) : undefined;
        if (variable) {
            return { variable, gdbName: variable.gdbVarName };
        }
        // For the main session the DA reports a failed watch as a *successful* response whose result
        // is the error text, so the reason may be in either place. It wraps gdb's message in JSON;
        // keep just the message.
        const raw = (rsp.success ? rsp.body?.result : rsp.message) || "could not evaluate";
        const reason = /"message":"([^"]+)"/.exec(raw)?.[1] ?? raw;
        // Whether this is a typo or a local the frame does not have, MI's `-var-create` says the
        // same thing. `add` rejects it (you add while stopped where you mean it); `onStop` turns it
        // into out-of-scope for a watch that was valid when added.
        return { failure: { state: "unavailable", reason } };
    }

    protected async children(node: WatchNode): Promise<GdbProtocolVariable[]> {
        const rsp = await this.request<DebugProtocol.VariablesResponse>("variables", { variablesReference: node.variablesReference });
        return rsp.success ? ((rsp.body?.variables ?? []) as GdbProtocolVariable[]) : [];
    }

    protected async release(_names: string[]): Promise<void> {
        // Nothing to do: the DA deletes these varobjs itself when the target continues.
    }

    protected helpNotes(): string[] {
        return [
            "Evaluated at every stop, in the stopped frame: locals work. While running, values are the last stop's.",
            "Add a local while stopped in its function; at stops in other functions it shows <not in scope>.",
        ];
    }

    // ---- driver hooks -------------------------------------------------------------------------

    /**
     * The target stopped. Called by the driver before it runs the next queued command, so the stop's
     * output comes before that command's.
     */
    public async onStop(threadId: number): Promise<void> {
        this.frameId = await this.topFrame(threadId);
        this.selected = undefined; // a stop always means the stopped thread's top frame again
        if (this.roots.size === 0) {
            return;
        }
        await this.evaluateAll();
        this.printAtStop();
    }

    /**
     * The user selected another frame or thread while stopped. Evaluated there from now until the next
     * stop; printed only if `onFrameChange` asks (default: silently, `list` shows them). The stop's
     * snapshot is left alone, so `changes` at the next stop still compares stop with stop.
     *
     * Advisory: thread events have been seen with ids that are only valid after a stop, so the thread
     * is checked against the current thread list, and anything unexpected is ignored rather than acted on.
     */
    public async onFrameChange(body: CustomFrameSelectedEvent["body"]): Promise<void> {
        if (this.frameId === undefined || !Number.isInteger(body?.frameId)) {
            return; // not stopped, or nothing usable
        }
        const threads = await this.request<DebugProtocol.ThreadsResponse>("threads", {});
        if (!threads.success || !threads.body?.threads?.some((t) => t.id === body.threadId)) {
            return;
        }
        this.frameId = body.frameId;
        const where = [body.func ?? "??", body.file ? `at ${body.file}${body.line ? `:${body.line}` : ""}` : ""].filter(Boolean).join(" ");
        this.selected = body.level === 0 ? undefined : { level: body.level, where };
        if (this.roots.size === 0) {
            return;
        }
        await this.evaluateAll();
        const mode = this.options.onFrameChange;
        if (mode !== "none") {
            this.printAll(mode);
        }
    }

    protected header(): string | undefined {
        return this.selected ? `frame ${this.selected.level}: ${this.selected.where}` : undefined;
    }

    /** Rebuild every tree in the current frame. */
    private async evaluateAll(): Promise<void> {
        for (const root of this.roots.values()) {
            if (this.frameId === undefined) {
                root.node = undefined;
                root.status = { state: "unavailable", reason: "no stack frame at this stop" };
                continue;
            }
            await this.trackRoot(root);
            if (root.status?.state === "unavailable") {
                // It evaluated when it was added, so a failure now is a frame that lacks it.
                root.status = { state: "out-of-scope", reason: root.status.reason };
            }
        }
    }

    /** The target is running: frame ids are gone, and what we have becomes the last stop's values. */
    public onRunning(): void {
        this.frameId = undefined;
        this.selected = undefined;
        for (const root of this.roots.values()) {
            if (root.node) {
                walk(root.node, (n) => {
                    if (n.state === "current") {
                        n.state = "stale";
                    }
                });
            }
        }
    }

    private async topFrame(threadId: number): Promise<number | undefined> {
        // `threads` first, as VS Code does. Without it the DA answers `stackTrace` from the stop record,
        // which has no frame level, and fakes one as 1 (`parseStoppedThreadInfo`) -- so the top frame's
        // id would mean level 1, and a watch would read the caller's frame (seen on the NUCLEO).
        await this.request<DebugProtocol.ThreadsResponse>("threads", {});
        const rsp = await this.request<DebugProtocol.StackTraceResponse>("stackTrace", { threadId, startFrame: 0, levels: 1 });
        return rsp.success ? rsp.body?.stackFrames?.[0]?.id : undefined;
    }

    /** `sendRequest` resolves failed responses too; callers check `success`. */
    private request<T extends DebugProtocol.Response>(command: string, args: object): Promise<T> {
        return this.sessionDriver.sendRequest<T>({ seq: 0, type: "request", command, arguments: args });
    }
}
