import * as process from "process";
import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { VariableManager } from "./variables";
import { GdbEventNames, Stderr, MIError, MINode } from "./gdb-mi/mi-types";
import { expandValue } from "./gdb-mi/gdb_expansion";
export class LiveWatchMonitor {
    public miDebugger: GdbInstance | undefined;
    protected varManager: VariableManager;
    protected liveWatchEnabled: boolean = false;
    constructor(private mainSession: GDBDebugSession) {
        this.miDebugger = new GdbInstance();
        this.varManager = new VariableManager(this.miDebugger, this.mainSession);
    }

    public start(gdbCommands: string[]): void {
        this.miDebugger.debugFlags = this.mainSession.args.debugFlags;
        const exe = this.mainSession.gdbInstance.gdbPath;
        const args = this.mainSession.gdbInstance.gdbArgs;
        gdbCommands.push('interpreter-exec console "set stack-cache off"');
        gdbCommands.push('interpreter-exec console "set remote interrupt-on-connect off"');
        gdbCommands.push(...this.mainSession.getServerConnectCommands());
        this.miDebugger
            .start(exe, args, process.cwd(), [], 10 * 1000, false)
            .then(() => {
                this.handleMsg(Stderr, `Started GDB process ${exe} ${args.join(" ")}\n`);
                this.setupEvents();
                for (const cmd of gdbCommands) {
                    this.miDebugger!.sendCommand(cmd).catch((err) => {
                        this.handleMsg(Stderr, `Error with command '${cmd}': ${err.toString()}\n`);
                    });
                }
                this.liveWatchEnabled = true;
            })
            .catch((err) => {
                this.handleMsg(Stderr, `Could not start/initialize Live GDB process: ${err.toString()}\n`);
                this.handleMsg(Stderr, `Live watch expressions will not work.\n`);
            });
    }

    protected handleMsg(type: GdbEventNames, msg: string) {
        this.mainSession.handleMsg(type, "LiveGDB: " + msg);
    }

    protected setupEvents() {
        this.miDebugger.on("quit", this.quitEvent.bind(this));
        this.miDebugger.on("exited-normally", this.quitEvent.bind(this));
        this.miDebugger.on("msg", (type: GdbEventNames, msg: string) => {
            this.handleMsg(type, msg);
        });

        /*
        Yes, we get all of these events and they seem to be harlmess
        const otherEvents = [
            'stopped',
            'watchpoint',
            'watchpoint-scope',
            'step-end',
            'step-out-end',
            'signal-stop',
            'running',
            'continue-failed',
            'thread-created',
            'thread-exited',
            'thread-selected',
            'thread-group-exited'
        ];
        for (const ev of otherEvents) {
            this.miDebugger.on(ev, (arg) => {
                this.mainSession.handleMsg(
                    'stderr', `Internal Error: Live watch GDB session received an unexpected event '${ev}' with arg ${arg?.toString() ?? '<empty>'}\n`);
            });
        }
        */
    }

    protected quitEvent() {
        // this.miDebugger = undefined;
        this.liveWatchEnabled = false;
    }

    public async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        try {
            args.frameId = undefined; // We don't have threads or frames here. We always evaluate in global context
            await this.varManager.evaluateExpression(response, args);
            if (this.mainSession.args.debugFlags.anyFlags) {
                this.mainSession.handleMsg(Stderr, `LiveGDB: Evaluated ${args.expression}\n`);
            }
        } catch (e: any) {
            this.mainSession.handleErrResponse(response, `LiveGDB: Error evaluating expression: ${e.toString()}\n`);
        }
        return Promise.resolve();
    }

    public async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        try {
            const vars = await this.varManager.getVariables(args);
            response.body = { variables: vars };
            this.mainSession.sendResponse(response);
            if (this.mainSession.args.debugFlags.anyFlags) {
                this.mainSession.handleMsg(Stderr, `LiveGDB: Retrieved ${vars.length} variables for reference ${args.variablesReference}\n`);
            }
        } catch (e: any) {
            this.mainSession.handleErrResponse(response, `LiveGDB: Error retrieving variables: ${e.toString()}\n`);
        }
        return Promise.resolve();
    }

    // Calling this will also enable caching for the future of the session
    public async refreshLiveCache(response: DebugProtocol.Response, args: RefreshAllArguments): Promise<void> {
        try {
            if (args.deleteAll) {
                // await this.varManager.clearCachedVars(this.miDebugger!);
                return Promise.resolve();
            }
            const updates = await this.varManager.updateAllVariables();
            response.body = { updates: updates };
            this.mainSession.sendResponse(response);
        } catch (e: any) {
            this.mainSession.handleErrResponse(response, `LiveGDB: Error refreshing live cache: ${e.toString()}\n`);
        }
        return Promise.resolve();
    }

    private quitting = false;
    public quit() {
        try {
            if (!this.quitting) {
                this.quitting = true;
                this.miDebugger!.detach();
            }
        } catch (e: any) {
            console.error("LiveWatchMonitor.quit", e);
        }
    }
}

interface RefreshAllArguments {
    // Delete all gdb variables and the cache. This should be done when a live expression is deleted,
    // but otherwise, it is not needed
    deleteAll: boolean;
}
