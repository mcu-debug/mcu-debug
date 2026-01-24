import { DebugProtocol } from "@vscode/debugprotocol";
import { SeqDebugSession } from "./seq-debug-session";
import { Config } from "winston/lib/winston/config";
import { InitializedEvent, Logger, logger, OutputEvent, Variable, TerminatedEvent } from "@vscode/debugadapter";
import { ConfigurationArguments, RTTCommonDecoderOpts, CustomStoppedEvent, GenericCustomEvent, SymbolFile, defSymbolFile, canonicalizePath, SWOConfigureEvent } from "./servers/common";
import os from "os";
import fs from "fs";
import path from "path";
import hasbin from "hasbin";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GdbEventNames, GdbMiOutput, GdbMiRecord, GdbMiThreadIF, Stderr, Stdout } from "./gdb-mi/mi-types";
import { SWODecoderConfig } from "../frontend/swo/common";
import { VariableManager } from "./variables";
import { SymbolTable } from "./symbols";
import { GDBServerSession } from "./server-session";
import { GdbMiThreadInfoList, MiCommands } from "./gdb-mi/mi-commands";
import { SessionMode } from "./servers/common";
import { formatAddress, parseAddress } from "../frontend/utils";
import { BreakpointManager } from "./breakpoints";
import { LiveWatchMonitor } from "./live-watch-monitor";
import { MemoryRequests } from "./memory";
import { ServerConsoleLog } from "./server-console-log";
import { gitCommitHash, pkgJsonVersion } from "../commit-hash";
import { VariableScope, getScopeFromReference, getVariableClass } from "./var-scopes";
import { RegisterClientResponse, SetExpressionLiveResponse, SetVariableLiveResponse } from "./custom-requests";
import { TargetInfo } from "./target-info";

let SessionCounter = 0;

function COMMAND_MAP(c: string): string {
    if (!c) {
        return c;
    }
    c = c.trim();
    if (["continue", "c", "cont"].find((s) => s === c)) {
        // For some reason doing a continue in one of the commands from launch.json does not work with gdb when in MI mode
        // Maybe it is version dependent
        return "exec-continue --all";
    }
    return c.startsWith("-") ? c : `-interpreter-exec console "${c.replace(/"/g, '\\"')}"`;
}

export class GDBDebugSession extends SeqDebugSession {
    public args = {} as ConfigurationArguments;
    public gdbInstance: GdbInstance;
    public serverSession: GDBServerSession;
    public gdbMiCommands: MiCommands;
    public lastThreadsInfo: GdbMiThreadInfoList;
    public liveWatchMonitor: LiveWatchMonitor;
    public memoryRequests: MemoryRequests;
    public suppressStoppedEvents: boolean = true;
    public continuing: boolean = false;
    configurationDone: boolean = false;
    public fileMap: Map<string, number> = new Map();
    private swoLaunchPromise = Promise.resolve();
    private swoLaunched = false;

    protected varManager: VariableManager;
    protected bkptManager: BreakpointManager;
    public symbolTable: SymbolTable;

    constructor() {
        super();
        SessionCounter++;
        this.gdbInstance = new GdbInstance();
        this.gdbInstance.currentCommandTimeout = 0; // Disable timeouts by default until after launch/attach
        this.serverSession = new GDBServerSession(this);
        this.gdbMiCommands = new MiCommands(this.gdbInstance);
        this.varManager = new VariableManager(this.gdbInstance, this);
        this.bkptManager = new BreakpointManager(this.gdbInstance!, this);
        this.symbolTable = new SymbolTable(this);
        this.liveWatchMonitor = new LiveWatchMonitor(this);
        this.memoryRequests = new MemoryRequests(this, this.gdbInstance);
        this.lastThreadsInfo = this.createEmptyThreadInfo();
        this.getFileId(VariableManager.GlobalFileName); // Make sure global file ID is always 1
    }

    private createEmptyThreadInfo(): GdbMiThreadInfoList {
        return new GdbMiThreadInfoList({
            hasTerminator: true,
            outOfBandRecords: [],
        });
    }

    public isRunning(): boolean {
        if (!this.gdbInstance) {
            return false;
        }
        return this.gdbInstance.IsRunning();
    }
    public isBusy(): boolean {
        return this.continuing || this.isRunning();
    }

    public handleErrResponse(response: DebugProtocol.Response, msg: string, message?: DebugProtocol.Message): void {
        if (!msg.startsWith("mcu-debug")) {
            msg = "mcu-debug: " + msg;
        }
        this.handleMsg(GdbEventNames.Stderr, msg + "\n");
        this.sendErrorResponse(response, message ?? 1, msg);
    }
    public handleResponseMsg(response: DebugProtocol.Response, msg: string, message?: DebugProtocol.Message): void {
        if (!msg.startsWith("mcu-debug")) {
            msg = "mcu-debug: " + msg;
        }
        this.handleMsg(GdbEventNames.Stderr, msg + "\n");
        this.sendResponse(response);
    }
    public busyError(response: DebugProtocol.Response, args: any) {
        response.message = "notStopped";
        this.handleErrResponse(response, "Target is running. Cannot process request now.", { id: 2, format: "Busy" });
    }
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;

        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsSetVariable = true;
        response.body.supportsSetExpression = true;

        // We no longer support a 'Restart' request. However, VSCode will implement a replacement by terminating the
        // current session and starting a new one from scratch. But, we still have to support the launch.json
        // properties related to Restart but for Reset. This way, we don't break functionality.
        response.body.supportsRestartRequest = false;
        response.body.supportsTerminateRequest = true;

        response.body.supportsGotoTargetsRequest = true;
        response.body.supportSuspendDebuggee = true;
        response.body.supportsValueFormattingOptions = true;
        // response.body.supportTerminateDebuggee = true;
        response.body.supportsDataBreakpoints = true;
        // response.body.supportsDisassembleRequest = true;
        // response.body.supportsSteppingGranularity = true;
        // response.body.supportsInstructionBreakpoints = true;
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsWriteMemoryRequest = true;

        this.sendResponse(response);
    }

    private async waitForCompletion(nTimes: number, completionCheck: () => boolean, delayMs: number = 10): Promise<void> {
        for (let i = 0; i < nTimes; i++) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (completionCheck()) {
                return;
            }
        }
    }

    private endSession: boolean = false;
    protected async finishSession(response: DebugProtocol.DisconnectResponse | DebugProtocol.TerminateResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        const done = () => {
            // Delay just a bit to allow any pending events/messages to be sent
            setTimeout(() => {
                this.sendResponse(response);
                this.sendEvent(new TerminatedEvent());
            }, 20);
        };
        if (this.endSession) {
            done();
            return;
        }
        try {
            this.endSession = true;
            this.liveWatchMonitor.stop();
            const doTerminate = !!args.terminateDebuggee;
            this.handleMsg(Stdout, `Ending debug session...${JSON.stringify(args)}\n`);
            if (this.gdbInstance) {
                this.suppressStoppedEvents = true;
                if (this.isRunning()) {
                    try {
                        await this.gdbInstance.sendCommand("-exec-interrupt", 100);
                        await this.waitForCompletion(5, () => !this.isRunning(), 5);
                        if (this.isRunning()) {
                            this.handleMsg(Stderr, "Target is still running during disconnect. Trying to halt it again...\n");
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                }

                try {
                    await this.bkptManager.deleteAllBreakpoints(); // Delete all breakpoints silently
                } catch (e) {
                    // Ignore failure to delete breakpoints
                }
                if (this.args.overridePreEndSessionCommands) {
                    for (const cmd of this.args.overridePreEndSessionCommands) {
                        try {
                            await this.gdbInstance.sendCommand(COMMAND_MAP(cmd));
                        } catch (e) {
                            this.handleMsg(Stderr, "GDB commands overridePreEndSessionCommands failed " + (e ? e.toString() : "Unknown error") + "\n");
                        }
                    }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }

                if (!doTerminate && !this.isRunning()) {
                    try {
                        // Try to exit GDB nicely
                        await this.gdbInstance.sendCommand("-exec-continue", 200);
                        await this.waitForCompletion(5, () => this.isRunning(), 5);
                        if (!this.isRunning()) {
                            this.handleMsg(Stderr, "Target is not running depite issuing a continue command again...\n");
                        }
                    } catch (e) {
                        this.handleMsg(Stderr, "Error continuing target before exit: " + (e ? e.toString() : "Unknown error") + "\n");
                    }
                }

                try {
                    // Give GDB a chance to detach nicely, but don't wait forever
                    await this.gdbInstance.sendCommand("-target-disconnect", 250);
                } catch (e) {
                    // Ignore errors
                }

                // This stops the GDB process aggressively if needed
                await this.gdbInstance.stop();
                // @ts-ignore
                this.gdbInstance = null;
            }

            if (this.serverSession) {
                await this.serverSession.stopServer();
                // @ts-ignore
                this.serverSession = null;
            }
        } catch (e) {
            this.handleMsg(Stderr, "Error ending session: " + (e ? e.toString() : "Unknown error") + "\n");
        }
        done();
    }
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        // We have a problem here. It is not clear in the case of managed life-cycles what the children are supposed to do.
        // If we try to wait for children to exit cleanly and then exit ourselves, we are having issues (when not in server mode
        // which is always the case for production).
        //
        // If we wait for a timeout or event and the child exits in the meantime, VSCode is killing the parent while we are still
        // not yet done terminating ourselves. So, let the children terminate and in the meantime, at the same time we terminate ourselves
        // What really happens is that when/if we terminate first, the server (if any) is killed and the children will automatically die
        // but not gracefully.
        //
        // We have a catchall exit handler defined in server.ts but hopefully, we can get rid of that
        //
        // Maybe longer term, what might be better is that we enter server mode ourselves. For another day
        if (this.args.chainedConfigurations?.enabled) {
            // this.serverConsoleLog("Begin disconnectRequest children");
            this.sendEvent(new GenericCustomEvent("session-terminating", args));
        }
        await this.finishSession(response, args);
    }
    protected launchRequest(response: DebugProtocol.LaunchResponse, args: ConfigurationArguments, request?: DebugProtocol.Request): void {
        args.pvtSessionMode = SessionMode.Launch;
        this.launchAttachInit(args);
        this.launchAttachRequest(response, args.noDebug ?? false);
    }
    protected attachRequest(response: DebugProtocol.AttachResponse, args: ConfigurationArguments, request?: DebugProtocol.Request): void {
        args.pvtSessionMode = SessionMode.Attach;
        this.launchAttachInit(args);
        this.launchAttachRequest(response, false);
    }
    protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): Promise<void> {
        const newArgs: DebugProtocol.DisconnectArguments = {
            terminateDebuggee: true,
        };
        await this.finishSession(response, newArgs);
    }
    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
        try {
            response.body = { breakpoints: [] };
            this.suppressStoppedEvents = this.isRunning();
            await this.bkptManager.setBreakPointsRequest(response, args, request);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetBreakPoints request failed: ${e}`);
        } finally {
            this.suppressStoppedEvents = false;
            Promise.resolve();
        }
    }
    protected async setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments,
        request?: DebugProtocol.Request,
    ): Promise<void> {
        try {
            response.body = { breakpoints: [] };
            this.suppressStoppedEvents = this.isRunning();
            await this.bkptManager.setFunctionBreakPointsRequest(response, args, request);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetFunctionBreakPoints request failed: ${e}`);
        } finally {
            this.suppressStoppedEvents = false;
            Promise.resolve();
        }
    }
    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {
        this.configurationDone = true;
        this.emit("configurationDone");
        this.sendResponse(response);
    }
    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.isBusy()) {
            this.handleErrResponse(response, "Continue request received while target is running.");
            return;
        }
        await this.clearForContinue();
        this.continuing = true;
        this.gdbMiCommands!.sendContinue(undefined)
            .then(() => {
                response.body = { allThreadsContinued: true };
                this.sendResponse(response);
            })
            .catch((e) => {
                this.continuing = false;
                this.handleErrResponse(response, `Continue request failed: ${e}`);
            });
    }
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {
        this.continuing = true;
        this.gdbMiCommands!.sendNext()
            .then(() => {
                this.sendResponse(response);
            })
            .catch((e) => {
                this.continuing = false;
                this.handleErrResponse(response, `Next request failed: ${e}`);
            });
    }
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
        this.continuing = true;
        this.gdbMiCommands!.sendStepIn()
            .then(() => {
                this.sendResponse(response);
            })
            .catch((e) => {
                this.continuing = false;
                this.handleErrResponse(response, `StepIn request failed: ${e}`);
            });
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
        this.continuing = true;
        this.gdbMiCommands!.sendStepOut()
            .then(() => {
                this.sendResponse(response);
            })
            .catch((e) => {
                this.continuing = false;
                this.handleErrResponse(response, `StepOut request failed: ${e}`);
            });
    }
    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request): void {}
    protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
        this.gdbMiCommands!.sendHalt(undefined)
            .then(() => {
                this.sendResponse(response);
            })
            .catch((e) => {
                // If the halt failed, we are probably still running, or maybe GDB is just confused.
                // It is safer to assume we are still running. But we should report the error.
                this.handleErrResponse(response, `Pause request failed: ${e}`);
            });
    }
    protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected async threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): Promise<void> {
        response.body = { threads: [] };
        try {
            if (this.isBusy()) {
                this.handleResponseMsg(response, "mcu-debug: Threads request received while target is running. Returning empty thread list.\n");
                return;
            }
            // We get the thread info when we are stopped already. No need to do it again here.
            const threads = this.lastThreadsInfo?.getSortedThreadList() || [];
            for (const t of threads) {
                response.body.threads.push({ id: t.id, name: t.name || t.target_id || `Thread ${t.id}` });
            }
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `Failed to get threads: ${e}`);
        }
    }

    protected terminateThreadsRequest(response: DebugProtocol.TerminateThreadsResponse, args: DebugProtocol.TerminateThreadsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): Promise<void> {
        response.body = { stackFrames: [], totalFrames: 0 };
        if (this.isBusy()) {
            this.handleMsg(GdbEventNames.Stderr, "mcu-debug: StackTrace request received while target is running. Returning empty stack trace.\n");
            this.sendResponse(response);
            return;
        }
        try {
            const threadId = args.threadId;
            const startFrame = args.startFrame || 0;
            const levels = args.levels || 40;
            const thread = this.lastThreadsInfo?.threadMap.get(threadId);
            if (!thread) {
                this.handleResponseMsg(response, `Thread with id ${threadId} not found.`);
                return;
            }
            await this.gdbMiCommands.sendStackListFrames(thread, startFrame, startFrame + levels);
            for (const frame of thread.frames || []) {
                const handle = this.varManager.addFrameInfo(threadId, frame.level, VariableScope.Local);
                const stackFrame: DebugProtocol.StackFrame = {
                    id: handle,
                    name: frame.func || "<unknown>",
                    line: frame.line || 0,
                    column: 0,
                    instructionPointerReference: frame.addr || undefined,
                    source: {
                        name: frame.file || "<unknown>",
                        path: frame.fullname || undefined,
                    },
                };
                response.body.stackFrames.push(stackFrame);
            }
            response.body.totalFrames = thread.frames ? thread.frames.length : 0;
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `Failed to get stack frames: ${e}`);
            return;
        }
    }

    protected fileMapReverse: Map<number, string> = new Map();
    protected getFileId(filePath: string): number {
        const path = canonicalizePath(filePath);
        const existing = this.fileMap.get(path);
        if (existing === undefined) {
            const ix = this.fileMap.size;
            this.fileMap.set(path, ix);
            this.fileMapReverse.set(ix, path);
            return ix;
        }
        return existing;
    }
    public getFileById(fileId: number): string {
        return this.fileMapReverse.get(fileId) ?? "";
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {
        const scopes: DebugProtocol.Scope[] = [];
        try {
            const add = (t: number, f: number, s: VariableScope): number => {
                return this.varManager.addFrameInfo(t, f, s);
            };
            const [threadId, frameId, scope] = this.varManager.getFrameInfo(args.frameId);
            const thread = this.lastThreadsInfo?.threadMap.get(threadId);
            if (!thread) {
                this.handleResponseMsg(response, `Thread with id ${threadId} not found.`);
                return;
            }
            const frame = thread?.frames.length > frameId ? thread.frames[frameId] : undefined;
            if (!frame) {
                this.handleErrResponse(response, `Frame with id ${frameId} not found in thread ${threadId}.`);
                return;
            }
            let fileId = 0,
                fullFileId = 0;
            if (frame.file) {
                fileId = this.getFileId(frame.file);
            }
            if (frame.fullname) {
                fullFileId = this.getFileId(frame.fullname);
            }
            const useFname = frame.file || frame.fullname ? `-> ${frame.file || frame.fullname}` : "";
            const statics = `Static${useFname}`;
            scopes.push({ name: "Local", variablesReference: add(threadId, frameId, VariableScope.Local), expensive: false });
            scopes.push({ name: statics, variablesReference: add(fileId, fullFileId, VariableScope.Static), expensive: false });
            scopes.push({ name: "Global", variablesReference: add(0, 0, VariableScope.Global), expensive: true });
            scopes.push({ name: "Registers", variablesReference: add(threadId, frameId, VariableScope.Registers), expensive: false });
        } catch (e) {
            this.handleErrResponse(response, `Failed to get scopes: ${e}`);
            return;
        }

        response.body = { scopes: scopes };
        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
        response.body = { variables: [] };
        if (this.isBusy()) {
            this.handleErrResponse(response, "Variables request received while target is running.");
            return;
        }
        try {
            response.body.variables = await this.varManager.getVariables(args);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `Failed to get variables: ${e}`);
            return;
        }
    }
    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.isBusy()) {
            this.handleErrResponse(response, "SetVariable request received while target is running.");
            return;
        }
        try {
            response.body = await this.varManager.setVariable(args);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetVariable request failed: ${e}`);
        }
    }
    protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.isBusy()) {
            this.handleErrResponse(response, "SetExpression request received while target is running.");
            return;
        }
        try {
            response.body = await this.varManager.setExpression(args);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetExpression request failed: ${e}`);
        }
    }
    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.isBusy() && args.context !== "repl") {
            this.handleErrResponse(response, "Evaluate request received while target is running.");
            return;
        }
        response.body = {
            result: "",
            variablesReference: 0,
        };
        try {
            if (args.context === "repl") {
                return await this.evalRepl(args.expression, response);
            } else {
                await this.varManager.evaluateExpression(response, args);
                this.sendResponse(response);
            }
        } catch (e) {
            this.handleErrResponse(response, `Evaluate request failed for '${args.expression}': ${e}`);
        }
    }
    private async evalRepl(expr: string, response: DebugProtocol.EvaluateResponse): Promise<void> {
        expr = expr.trim().replace(/"/g, '\\"');
        // These commands have special handling in the REPL. For some reason, they don't work well or at all
        const mappings: { [key: string]: string } = {
            continue: "-exec-continue",
            c: "-exec-continue",
            cont: "-exec-continue",
            step: "-exec-step",
            s: "-exec-step",
            next: "-exec-next",
            n: "-exec-next",
            finish: "-exec-finish",
            f: "-exec-finish",
            break: "-break-insert",
            b: "-break-insert",
            run: "-exec-run",
            r: "-exec-run",
        };
        const isLiveCmd = expr.startsWith("+");
        if (isLiveCmd) {
            expr = expr.slice(1).trim();
        }
        const splits = expr.split(/\s+/);
        const cmd = mappings[splits[0]];
        if (cmd) {
            expr = cmd + " " + splits.slice(1).join(" ");
        }
        const isMi = expr.startsWith("-");
        if (!expr.startsWith("-")) {
            expr = `-interpreter-exec console "${expr}"`;
        }
        this.handleMsg(Stdout, `${expr}\n`);
        const gdbInstance = isLiveCmd ? this.liveWatchMonitor.gdbInstance : this.gdbInstance;
        await gdbInstance!
            .sendCommand(expr)
            .then((out) => {
                if (isMi) {
                    this.handleMsg(Stdout, `^done\n`);
                }
                this.sendResponse(response);
            })
            .catch((e) => {
                this.handleErrResponse(response, `Evaluate request '${expr}' failed: ${e}`);
            });
    }

    protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request): void {
        response.body = { targets: [] };
        if (args.source?.path && fs.existsSync(args.source.path)) {
            this.continuing = true;
            this.gdbMiCommands
                .sendGotoFileLine(args.source.path, args.line)
                .then(() => {
                    this.sendResponse(response);
                })
                .catch((e) => {
                    this.handleErrResponse(response, `GotoTargets request failed: ${e}`);
                });
        } else {
            this.handleErrResponse(response, `GotoTargets request failed: invalid source path. ${args.source?.path}`);
        }
    }
    protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments, request?: DebugProtocol.Request): void {
        try {
            response.body = {
                dataId: null,
                description: "Invalid data breakpoint location",
                accessTypes: undefined,
                canPersist: false,
            };

            const ref = args.variablesReference;
            if (ref === undefined || ref <= 0) {
                response.body.description = "No reference for data breakpoint.";
                this.sendResponse(response);
                return;
            }
            const scope = getScopeFromReference(ref);
            if (scope === VariableScope.Registers) {
                response.body.description = "Data breakpoints are not supported on registers.";
                this.sendResponse(response);
                return;
            }
            if (scope === VariableScope.Local) {
                response.body.canPersist = false;
            } else {
                // What about watch variables? Could the persist? Depends on what it is. Let GDB/user decide.
                response.body.canPersist = true;
            }

            const varName = this.varManager.getVariableFullName(ref, args.name);
            if (!varName) {
                this.sendResponse(response);
                return;
            }

            response.body.dataId = varName; // Used to identify the data breakpoint in setDataBreakpointsRequest
            response.body.description = varName; // What is displayed in the Breakpoints window
            response.body.accessTypes = ["read", "write", "readWrite"];
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `DataBreakpointInfo request failed: ${e}`);
        }
    }
    protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
        try {
            this.suppressStoppedEvents = this.isRunning();
            await this.bkptManager.setDataBreakPointsRequest(response, args);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetDataBreakpoints request failed: ${e}`);
        } finally {
            this.suppressStoppedEvents = false;
            Promise.resolve();
        }
    }

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.isBusy()) {
            this.busyError(response, args);
            return;
        }
        await this.memoryRequests.readMemoryRequest(response, args);
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.isBusy()) {
            this.busyError(response, args);
            return;
        }
        await this.memoryRequests.writeMemoryRequest(response, args);
    }

    protected async customRequest(command: string, response: DebugProtocol.Response, args: any) {
        const retFunc = () => {
            this.handleErrResponse(response, `Debugger is busy. Cannot process custom request '${command}' now.`);
        };

        if (this.serverSession.serverController.customRequest(command, response, args)) {
            return retFunc();
        }

        const isBusy = this.isBusy();
        switch (command) {
            case "readMemoryLive": {
                const rsp: DebugProtocol.ReadMemoryResponse = {
                    ...response,
                    body: {
                        address: args.address,
                        unreadableBytes: 0,
                        data: "",
                    },
                };
                return await this.liveWatchMonitor.readMemoryRequest(rsp, args);
            }
            case "writeMemoryLive": {
                const wrsp: DebugProtocol.WriteMemoryResponse = {
                    ...response,
                    body: {
                        bytesWritten: 0,
                    },
                };
                return await this.liveWatchMonitor.writeMemoryRequest(wrsp, args);
            }
            case "registerClient": {
                const rsp: RegisterClientResponse = {
                    ...response,
                    body: {
                        clientId: "",
                        sessionId: "",
                    },
                };
                this.liveWatchMonitor.registerClientRequest(rsp, args);
                break;
            }
            case "evaluateLive":
                if (this.liveWatchMonitor.enabled()) {
                    const rsp: DebugProtocol.EvaluateResponse = {
                        ...response,
                        body: {
                            result: "",
                            variablesReference: 0,
                        },
                    };
                    return await this.liveWatchMonitor.evaluateRequestLive(rsp, args); // always returns
                } else {
                    this.sendResponse(response);
                }
                break;
            case "deleteLiveGdbVariables":
                return await this.liveWatchMonitor.deleteLiveGdbVariables(response, args);
            case "variablesLive":
                if (this.liveWatchMonitor.enabled()) {
                    const rsp: DebugProtocol.VariablesResponse = {
                        ...response,
                        body: {
                            variables: [],
                        },
                    };
                    return await this.liveWatchMonitor.variablesRequestLive(rsp, args);
                } else {
                    this.sendResponse(response);
                }
                break;
            case "setVariableLive":
                if (this.liveWatchMonitor.enabled()) {
                    const rsp: SetVariableLiveResponse = {
                        ...response,
                        body: {
                            value: "",
                            variablesReference: 0,
                        },
                    };
                    return await this.liveWatchMonitor.setVariableRequest(rsp, args);
                } else {
                    this.sendResponse(response);
                }
                break;
            case "setExpressionLive":
                if (this.liveWatchMonitor.enabled()) {
                    const rsp: SetExpressionLiveResponse = {
                        ...response,
                        body: {
                            value: "",
                            variablesReference: 0,
                        },
                    };
                    return await this.liveWatchMonitor.setExpressionRequest(rsp, args);
                } else {
                    this.sendResponse(response);
                }
                break;
            case "load-function-symbols":
                const ret = this.symbolTable.getFunctionSymbols();
                const tmpFile = path.join(os.tmpdir(), `mcu-debug-syms-${Date.now()}.json`);
                const jsonContent = JSON.stringify({ functionSymbols: ret }, (key, value) => {
                    return typeof value === "bigint" ? value.toString() : value;
                });
                fs.writeFileSync(tmpFile, jsonContent);
                response.body = { file: tmpFile };
                this.sendResponse(response);
                break;
            case "get-arguments":
                response.body = this.args;
                this.sendResponse(response);
                break;
            case "set-var-format":
                this.args.variableUseNaturalFormat = args && args.hex ? false : true;
                // this.setGdbOutputRadix();
                this.sendResponse(response);
                break;
            case "disassemble":
                // this.disassember.customDisassembleRequest(response, args);
                break;
            case "execute-command": {
                const cmd = COMMAND_MAP(args?.command as string);
                if (cmd) {
                    this.gdbInstance.sendCommand(cmd).then(
                        (output) => {
                            response.body = { miOutput: output };
                            this.sendResponse(response);
                        },
                        (error) => {
                            response.body = error;
                            this.handleErrResponse(response, `Execute command failed: ${error}`);
                        },
                    );
                }
                break;
            }
            case "reset-device":
                this.doResetDevice(response, args);
                break;
            case "custom-stop-debugging":
                //this.serverConsoleLog(`Got request ${command}`);
                await this.finishSession(response, args);
                break;
            case "notified-children-to-terminate": // We never get this request
                //this.serverConsoleLog(`Got request ${command}`);
                this.emit("children-terminating");
                this.sendResponse(response);
                break;
            case "rtt-poll": {
                if (this.serverSession.serverController.rttPoll) {
                    this.serverSession.serverController.rttPoll();
                }
                this.sendResponse(response);
                break;
            }
            case "swo-connected": {
                this.swoLaunched = true;
                this.sendResponse(response);
                break;
            }
            default:
                response.body = { error: "Invalid command." };
                this.sendResponse(response);
                break;
        }
    }

    protected async doResetDevice(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): Promise<void> {
        try {
            this.suppressStoppedEvents = true;
            const mode = SessionMode.Reset;
            this.args.pvtSessionMode = mode;
            const commands = [];
            commands.push(...(this.args.preResetCommands?.map(COMMAND_MAP) || []));
            commands.push(...(this.args.overrideResetCommands ? this.args.overrideResetCommands.map(COMMAND_MAP) : this.serverSession.serverController.resetCommands() || []));
            commands.push(...(this.args.postResetCommands?.map(COMMAND_MAP) || []));

            await this.sendCommandsWithWait(commands);
            if (this.args.chainedConfigurations && this.args.chainedConfigurations.enabled) {
                setTimeout(() => {
                    // Maybe this delay should be handled in the front-end
                    // this.serverConsoleLog(`Begin ${mode} children`);
                    this.sendEvent(new GenericCustomEvent(`session-${mode}`, args));
                }, 250);
            }
            await this.runSessionModeCommands();
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `Reset device failed: ${e}`);
        }
        return Promise.resolve();
    }

    protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected setInstructionBreakpointsRequest(
        response: DebugProtocol.SetInstructionBreakpointsResponse,
        args: DebugProtocol.SetInstructionBreakpointsArguments,
        request?: DebugProtocol.Request,
    ): void {
        this.sendResponse(response);
    }

    protected timeStart = Date.now();
    protected timeLast = this.timeStart;
    protected wrapTimeStamp(str: string): string {
        if (this.args.debugFlags.timestamps) {
            return this.wrapTimeStampRaw(str);
        } else {
            return str;
        }
    }
    private wrapTimeStampRaw(str: string) {
        const now = Date.now();
        const elapsed = now - this.timeStart;
        const delta = now - this.timeLast;
        this.timeLast = now;
        const elapsedStr = elapsed.toString().padStart(10, "0") + "+" + delta.toString().padStart(5, "0");
        return elapsedStr + ": " + str;
    }
    protected suppressRadixMsgs: boolean = false;
    public handleMsg(type: GdbEventNames, msg: string) {
        if (this.suppressRadixMsgs && type === GdbEventNames.Console && /radix/.test(msg)) {
            // Filter out unnecessary radix change messages
            return;
        }
        msg = this.wrapTimeStamp(msg);
        if (msg.endsWith("\n") === false) {
            msg += "\n";
        }
        if (this.args.debugFlags.vscodeRequests) {
            logger.setup(Logger.LogLevel.Stop, false, false);
            this.sendEvent(new OutputEvent(msg, type));
            logger.setup(Logger.LogLevel.Verbose, false, false);
        } else {
            this.sendEvent(new OutputEvent(msg, type));
        }
    }

    setupLogging() {
        if (this.args.debugFlags.vscodeRequests) {
            logger.setup(Logger.LogLevel.Verbose, false, false);
            logger.init((ev: OutputEvent) => {
                // This callback is called with every msg. We don't want to create a recursive
                // callback to output a single message. Turn off logging, print and then turn it
                // back on.
                logger.setup(Logger.LogLevel.Stop, false, false);
                const msg = this.wrapTimeStamp(ev.body.output);
                this.sendEvent(new OutputEvent(msg, ev.body.category));
                logger.setup(Logger.LogLevel.Verbose, false, false);
            });
        }
    }

    private getGdbPath(): string {
        let gdbExePath = os.platform() !== "win32" ? `${this.args.toolchainPrefix}-gdb` : `${this.args.toolchainPrefix}-gdb.exe`;
        if (this.args.toolchainPath) {
            gdbExePath = path.normalize(path.join(this.args.toolchainPath, gdbExePath));
        }
        const gdbMissingMsg = `GDB executable "${gdbExePath}" was not found.\n` + 'Please configure "mcu-debug.armToolchainPath" or "mcu-debug.gdbPath" correctly.';

        if (this.args.gdbPath) {
            gdbExePath = this.args.gdbPath;
        } else if (path.isAbsolute(gdbExePath)) {
            if (fs.existsSync(gdbExePath) === false) {
                throw new Error(gdbMissingMsg);
            }
        } else if (!hasbin.sync(gdbExePath.replace(/\.exe$/i, ""))) {
            throw new Error(gdbMissingMsg);
        }
        this.args.gdbPath = gdbExePath; // This now becomes the official gdb-path
        return gdbExePath;
    }

    private formatRadixGdbCommand(forced: string | null = null): string[] {
        // radix setting affects future interpretations of values, so format it unambiguously with hex values
        const radix = forced || (this.args.variableUseNaturalFormat ? "0xa" : "0x10");
        // If we set just the output radix, it will affect setting values. Always leave input radix in decimal
        // Also, don't understand why setting the output-radix modifies the input radix as well
        const cmds = [`interpreter-exec console "set output-radix ${radix}"`, 'interpreter-exec console "set input-radix 0xa"'];
        return cmds;
    }

    private getGdbStartCommands(): string[] {
        return [
            "-gdb-set mi-async on",
            'interpreter-exec console "set print demangle on"',
            'interpreter-exec console "set print asm-demangle on"',
            "enable-pretty-printing",
            `interpreter-exec console "source ${this.args.extensionPath}/support/gdbsupport.init"`,
            `interpreter-exec console "source ${this.args.extensionPath}/support/gdb-swo.init"`,
            ...this.formatRadixGdbCommand(),
        ];
    }

    private normalizeArguments(args: ConfigurationArguments): ConfigurationArguments {
        args.graphConfig = args.graphConfig || [];

        args.debugFlags = args.debugFlags || {};
        args.debugFlags.gdbTraces = args.debugFlags.gdbTraces || args.debugFlags.gdbTracesParsed;
        args.debugFlags.anyFlags = Object.values(args.debugFlags).some((v) => v === true);

        if (args.executable && !path.isAbsolute(args.executable)) {
            args.executable = path.normalize(path.join(args.cwd, args.executable));
            if (os.platform() === "win32") {
                args.executable = args.executable.replace(/\\/gi, "/");
            }
        }

        if (args.svdFile && !path.isAbsolute(args.svdFile)) {
            args.svdFile = path.normalize(path.join(args.cwd, args.svdFile));
        }

        if (args.swoConfig && args.swoConfig.decoders) {
            args.swoConfig.decoders = args.swoConfig.decoders.map((dec): SWODecoderConfig => {
                const decAny = dec as any;
                if (dec.type === "advanced" && decAny.decoder && !path.isAbsolute(decAny.decoder)) {
                    decAny.decoder = path.normalize(path.join(args.cwd, decAny.decoder));
                }
                return dec;
            });
        }

        if (args.rttConfig && args.rttConfig.decoders) {
            args.rttConfig.decoders = args.rttConfig.decoders.map((dec: any) => {
                if (dec.type === "advanced" && dec.decoder && !path.isAbsolute(dec.decoder)) {
                    dec.decoder = path.normalize(path.join(args.cwd, dec.decoder));
                }
                return dec as RTTCommonDecoderOpts;
            });
        }

        if (args.chainedConfigurations && args.chainedConfigurations.enabled && args.chainedConfigurations.launches) {
            for (const config of args.chainedConfigurations.launches) {
                let folder = config.folder || args.cwd || process.cwd();
                if (!path.isAbsolute(folder)) {
                    folder = path.join(args.cwd || process.cwd(), folder);
                }
                folder = path.normalize(folder).replace(/\\/g, "/");
                while (folder.length > 1 && folder.endsWith("/") && !folder.endsWith(":/")) {
                    folder = folder.substring(0, folder.length - 1);
                }
                config.folder = folder;
            }
        }

        return args;
    }

    private launchAttachInit(args: ConfigurationArguments) {
        this.args = this.normalizeArguments(args);
        this.setupLogging();
        // We need go create the server session here now that args are normalized. In the ctor,
        // args are not available just had to keep the ts-compiler happy
        this.serverSession = new GDBServerSession(this);
        this.serverSession.serverController.on("event", this.serverControllerEvent.bind(this));
    }

    private async launchAttachRequest(response: DebugProtocol.LaunchResponse, noDebug: boolean): Promise<void> {
        let sentResponse = false;
        const finishWithError = (message: string) => {
            if (!sentResponse) {
                sentResponse = true;
                this.handleErrResponse(response, message);
            }
        };
        try {
            this.on("configurationDone", async () => {
                if (this.args.liveWatch?.enabled) {
                    this.liveWatchMonitor.start([...this.getGdbStartCommands(), ...this.gdbPreConnectInitCommands]);
                }
            });
            this.handleMsg(Stdout, `MCU-Debug: Embedded MCU debug adapter version ${pkgJsonVersion} (${gitCommitHash}). ` + "Usage info: https://github.com/mcu-debug/mcu-debug#usage");
            if (this.args.debugFlags.anyFlags) {
                this.handleMsg(Stderr, "Debug Flags Enabled. launch.json after processing by VSCode and MCU-Debug:\n");
                const jsonStr = JSON.stringify(this.args, null, 2);
                this.handleMsg(Stderr, jsonStr + "\n");
            }

            const showTimes = this.args.debugFlags.timestamps || this.args.debugFlags.gdbTraces;
            const reportTime = (stage: string) => {
                if (showTimes) {
                    this.handleMsg(Stderr, `Debug Time: ${stage} - ${Date.now() - this.timeStart} ms\n`);
                }
            };
            this.getSymbolAndLoadCommands();
            // Go ahead and start loading symbols in parallel to gdb and gdb server startup
            const loadSymbolsPromise = this.loadSymbols();
            const startServerPromise = this.startServer();

            // Question? Should we supress all running/stopped events until we are fully started? VSCode can
            // easily get confused if we send stopped/running events too early
            // this.handleRunning(); // Assume we are running at the beginning, so VSCode doesn't send any requests too early
            try {
                await this.startGdb();
            } catch (e) {
                const msg = "\nMake sure that the GDB executable is installed correctly and can be run from command line.\n";
                return finishWithError(`Failed to start GDB: ${e instanceof Error ? e.message : String(e)}${msg}`);
            }
            reportTime("GDB Ready");
            const gdbPreConnectPromise = this.sendCommandsWithWait(this.gdbPreConnectInitCommands);
            try {
                await startServerPromise;
            } catch (e) {
                const msg = "\nMake sure that the GDB server is configured correctly. See TERMINAL->gdb-server tab for details.\n";
                return finishWithError(`Failed to start debug server: ${e instanceof Error ? e.message : String(e)}${msg}`);
            }
            reportTime("GDB Server Ready");
            await gdbPreConnectPromise;

            // if SWO launch was requested by the server controller, we wait for it to connect before starting actual debug
            await this.swoLaunchPromise;

            // This is the last of the place where ports are allocated
            this.sendEvent(new GenericCustomEvent("post-start-server", this.args)); // if SWO launch was requested by the server controller, we wait for it to connect before starting actual debug

            // Let gdb connect to the server
            await this.sendCommandsWithWait(this.getConnectCommands()); // Can throw

            // Post connect, target info should be available
            const tInfo = new TargetInfo(this.gdbInstance, this);
            const tInfoPromise = tInfo.initialize();

            reportTime("GDB Init Commands Sent");
            // Let client know we are done with the launch/attach request and ready.
            if (!sentResponse) {
                sentResponse = true;
            } else {
                this.handleMsg(Stderr, "mcu-debug: Internal Error? launch/attach response already sent.\n");
            }
            this.sendResponse(response);

            // At this point, the program image should have been loaded, gdb and the server are connected
            // and we are ready to go. However, the program may be running depending on the session mode and settings
            // So, we now inform VSCode that the debugger has started. It will in turn set breakpoints, etc.
            this.sendEvent(new InitializedEvent()); // This is when we tell that the debugger has really started

            // After the above, VSCode will set various kinds of breakpoints, watchpoints, etc. When all those things
            // happen, it will finally send a configDone request and now everything should be stable
            this.sendEvent(new GenericCustomEvent("post-start-gdb", this.args));

            // This part of the process happens after we have sent the initialized event
            // and responded to the launch/attach request. Or else, configrationDoneRequest
            // will never happen
            await this.postStartServer();

            // Following can be deferred to configurationDone
            await loadSymbolsPromise;
            await tInfoPromise;
            this.gdbInstance.currentCommandTimeout = GdbInstance.DefaultCommandTimeout;
            reportTime("Ready for full debugging");
        } catch (e) {
            return finishWithError(`Launch/Attach request failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async loadSymbols(): Promise<void> {
        try {
            const execs: SymbolFile[] = this.args.symbolFiles || [defSymbolFile(this.args.executable)];
            this.symbolTable.initialize(execs);
            await this.symbolTable.loadSymbols();
            if (this.args.rttConfig.enabled) {
                const symName = this.symbolTable.rttSymbolName;
                if (!this.args.rttConfig.address) {
                    this.handleMsg(Stderr, 'INFO: "rttConfig.address" not specified. Defaulting to "auto"\n');
                    this.args.rttConfig.address = "auto";
                }
                if (this.args.rttConfig.address === "auto") {
                    const rttSym = this.symbolTable.getGlobalOrStaticVarByName(symName);
                    if (!rttSym) {
                        this.args.rttConfig.enabled = false;
                        this.handleMsg(Stderr, `Could not find symbol '${symName}' in executable. ` + "Make sure you compile/link with debug ON or you can specify your own RTT address\n");
                    } else {
                        const searchStr = this.args.rttConfig.searchId || "SEGGER RTT";
                        this.args.rttConfig.address = formatAddress(rttSym.address);
                        this.args.rttConfig.searchSize = Math.max(this.args.rttConfig.searchSize || 0, searchStr.length);
                        this.args.rttConfig.searchId = searchStr;
                        this.args.rttConfig.clearSearch = this.args.rttConfig.clearSearch === undefined ? true : this.args.rttConfig.clearSearch;
                    }
                }
            }
        } catch (e) {
            this.handleMsg(Stderr, `WARNING: Loading symbols failed. Please report this issue. Debugging may still work ${e}\n`);
        }
    }

    private async startGdb(): Promise<void> {
        const gdbPath = this.getGdbPath();
        const gdbArgs = ["-q", "--interpreter=mi3", ...(this.args.debuggerArgs || [])];
        this.gdbInstance.debugFlags = this.args.debugFlags;
        this.handleMsg(GdbEventNames.Console, `mcu-debug: Starting GDB: ${gdbPath} ${gdbArgs.join(" ")}\n`);
        this.subscribeToGdbEvents();
        await this.gdbInstance.start(gdbPath, gdbArgs, this.args.cwd, this.getGdbStartCommands());
    }

    private async startServer(): Promise<void> {
        try {
            const mode = this.args.pvtSessionMode;
            await this.serverSession.startServer(); // Can throw
            this.serverSession.on("server-exited", (code, signal) => {
                const msg = `GDB Server exited unexpectedly with code ${code} signal ${signal}`;
                this.handleMsg(Stderr, msg + "\n");
                this.sendEvent(new TerminatedEvent());
            });
        } catch (e) {
            throw e;
        }
    }

    private async postStartServer(): Promise<void> {
        if (this.isRunning()) {
            // We should not be running here, unless the user did something in the post-launch/attach commands
            this.suppressStoppedEvents = false;
            this.handleMsg(Stderr, "mcu-debug: Target is running after initial connection commands. Skipping session mode commands.\n");
            return;
        }
        await this.runSessionModeCommands();
    }

    private symPostConnectInitCommands: string[] = [];
    private gdbPreConnectInitCommands: string[] = [];
    private getSymbolAndLoadCommands(): void {
        const loadFiles = this.args.loadFiles;
        let isLoaded = false;
        if (this.args.symbolFiles) {
            // If you just used 'add-symbol-file' debugging works but RTOS detection fails
            // for most debuggers.
            for (const symF of this.args.symbolFiles) {
                const offset = symF.offset ? `-o ${formatAddress(symF.offset)}"` : "";
                let otherArgs = typeof symF.textaddress === "bigint" ? ` ${formatAddress(symF.textaddress)}"` : "";
                for (const section of symF.sections) {
                    otherArgs += ` -s ${section.name} ${section.address}`;
                }
                const cmd = `add-symbol-file \\"${symF.file}\\" ${offset} ${otherArgs}`.trimEnd();
                this.symPostConnectInitCommands.push(`interpreter-exec console "${cmd}"`);
            }
            if (this.symPostConnectInitCommands.length === 0) {
                this.handleMsg(Stderr, 'mcu-debug: GDB may not start since there were no files with symbols in "symbolFiles?\n');
            }
            this.gdbPreConnectInitCommands.push(...this.symPostConnectInitCommands);
            this.symPostConnectInitCommands = [];
        } else if (!loadFiles && this.args.executable) {
            this.gdbPreConnectInitCommands.push(`file-exec-and-symbols "${this.args.executable}"`);
            isLoaded = true;
        }
        if (!isLoaded && !loadFiles && this.args.executable) {
            this.args.loadFiles = [this.args.executable];
        }
    }

    public getServerConnectCommands() {
        // server init commands simply makes a tcp connection. It should not halt
        // the program. After the connection is established, we should load all the
        // symbols -- especially before a halt
        const cmds: string[] = [
            // 'interpreter-exec console "set debug remote 1"',
            ...(this.serverSession.serverController.connectCommands() || []),
            ...this.symPostConnectInitCommands,
        ];
        return cmds;
    }
    protected getConnectCommands(): string[] {
        const commands = this.getServerConnectCommands();

        if (this.args.pvtSessionMode === SessionMode.Attach) {
            commands.push(...(this.args.preAttachCommands?.map(COMMAND_MAP) ?? []));
            const attachCommands = this.args.overrideAttachCommands != null ? this.args.overrideAttachCommands.map(COMMAND_MAP) : this.serverSession.serverController.attachCommands();
            commands.push(...attachCommands);
            commands.push(...(this.args.postAttachCommands?.map(COMMAND_MAP) ?? []));
        } else {
            commands.push(...(this.args.preLaunchCommands?.map(COMMAND_MAP) ?? []));
            const launchCommands = this.args.overrideLaunchCommands != null ? this.args.overrideLaunchCommands.map(COMMAND_MAP) : this.serverSession.serverController.launchCommands();
            commands.push(...launchCommands);
            commands.push(...(this.args.postLaunchCommands?.map(COMMAND_MAP) ?? []));
        }
        return commands;
    }

    protected async sendContinueWhenPossible(): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            const tryContinue = async () => {
                try {
                    this.continuing = true;
                    await this.gdbMiCommands.sendContinue(undefined);
                } catch (e) {
                    this.handleMsg(Stderr, `mcu-debug: Failed to send continue command: ${e instanceof Error ? e.message : String(e)}\n`);
                }
            };
            if (this.configurationDone === false) {
                this.once("configurationDone", async () => {
                    resolve();
                    if (!this.isRunning()) {
                        await tryContinue();
                    }
                });
            } else if (this.isRunning()) {
                resolve();
            } else {
                resolve();
                await tryContinue();
            }
        });
    }

    protected async runSessionModeCommands(): Promise<void> {
        let commands: string[] = [];
        let needsContinue = false;
        const isReset = this.args.pvtSessionMode === SessionMode.Reset;
        const isLaunch = this.args.pvtSessionMode === SessionMode.Launch;
        let needsDelay = false;

        try {
            const swoRttCommands = this.serverSession.serverController.swoAndRTTCommands();
            await this.sendCommandsWithWait(swoRttCommands);
        } catch (e) {
            const msg = `SWO/RTT Initialization failed: ${e}`;
            this.handleMsg(Stderr, msg);
            this.sendEvent(new GenericCustomEvent("popup", { type: "error", message: msg }));
        }

        // Unified Logic
        if (isLaunch || isReset) {
            if (this.args.noDebug) {
                // No Debug -> Always Continue
                needsContinue = true;
            } else if (!this.args.breakAfterReset && this.args.runToEntryPoint) {
                // Run to Entry Point -> Set Breakpoint, Run. Only if breakAfterReset is false
                commands = [`-break-insert -t ${this.args.runToEntryPoint}`];
                needsContinue = true;
            } else {
                // Standard Debug
                // If breakAfterReset is true -> Stay Stopped (needsContinue = false)
                // If breakAfterReset is false -> Continue
                const cmds = isReset ? (this.args.postResetSessionCommands?.map(COMMAND_MAP) ?? []) : (this.args.postStartSessionCommands?.map(COMMAND_MAP) ?? []);
                commands.push(...cmds);
                needsContinue = !this.args.breakAfterReset;
                needsDelay = cmds.length > 0;
            }
        } else if (this.args.pvtSessionMode === SessionMode.Attach) {
            // ATTACH LOGIC
            if (this.args.noDebug) {
                needsContinue = true;
            } else {
                // Standard Attach -> We usually expect to be halted to allow setting breakpoints etc.
                // TODO: If we implement "Non-Intrusive Attach", this would be true (continue)
                // AND we would verify we didn't send a halt command.
                needsContinue = false;
            }
        }

        try {
            await this.sendCommandsWithWait(commands);
        } catch (e) {
            this.handleMsg(Stderr, `mcu-debug: Warning: Failed to run post start session commands (e.g. runToEntryPoint): ${e instanceof Error ? e.message : String(e)}\n`);
        }
        this.suppressStoppedEvents = false;

        if (needsContinue) {
            this.sendContinueWhenPossible().catch((e) => {
                this.handleMsg(Stderr, `mcu-debug: Failed to continue after session mode commands: ${e instanceof Error ? e.message : String(e)}\n`);
            });
            return;
        }
        if (needsDelay) {
            await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay to allow GDB to process commands
        }
        try {
            await this.gdbMiCommands.sendFlushRegs();
        } catch (e) {
            this.handleMsg(Stderr, `mcu-debug: Warning: Failed to flush registers before sending stopped event: ${e instanceof Error ? e.message : String(e)}\n`);
        }
        if (!this.isRunning()) {
            // VSCode still thinks we are running although, we should be stopped at entry point
            // The GdbMiInstance has the true status and if it is not running, we send a stopped event
            // Also, users custom commands may have messed with the session state, so we ensure we
            // notify VSCode of the stopped state here.
            this.stopEvent(undefined, "Reset");
        } else {
            // Send the following to ensure VSCode knows we are running. Now everyone shuld be in sync
            // The gdbInstance has the true status.
            this.handleRunningInternal();
        }
    }

    protected sendCommandsWithWait(cmds: string[]): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            for (const cmd of cmds) {
                try {
                    await this.gdbInstance!.sendCommand(cmd);
                } catch (e) {
                    reject(new Error(`Failed to send start command to GDB: ${cmd}\nError: ${e instanceof Error ? e.message : String(e)}`));
                    return;
                }
            }
            resolve();
        });
    }

    protected subscribeToGdbEvents() {
        this.gdbInstance.on("quit", this.quitEvent.bind(this));
        this.gdbInstance.on("exited-normally", this.quitEvent.bind(this));
        this.gdbInstance.on("stopped", this.stopEvent.bind(this));
        this.gdbInstance.on("breakpoint-deleted", this.handleBreakpointDeleted.bind(this));
        this.gdbInstance.on("msg", this.handleMsg.bind(this));
        this.gdbInstance.on("breakpoint", this.handleBreakpoint.bind(this));
        this.gdbInstance.on("watchpoint", this.handleWatchpoint.bind(this, "hit"));
        this.gdbInstance.on("watchpoint-scope", this.handleWatchpoint.bind(this, "scope"));
        this.gdbInstance.on("step-end", this.handleBreak.bind(this));
        this.gdbInstance.on("step-out-end", this.handleBreak.bind(this));
        this.gdbInstance.on("signal-stop", this.handlePause.bind(this));
        this.gdbInstance.on("running", this.handleRunning.bind(this));
        this.gdbInstance.on("continue-failed", this.handleContinueFailed.bind(this));
        this.gdbInstance.on("thread-created", this.handleThreadCreated.bind(this));
        this.gdbInstance.on("thread-exited", this.handleThreadExited.bind(this));
        this.gdbInstance.on("thread-selected", this.handleThreadSelected.bind(this));
        this.gdbInstance.on("thread-group-exited", this.handleThreadGroupExited.bind(this));
    }

    quitEvent() {
        this.sendEvent(new TerminatedEvent());
    }

    // Unlike in cortex-debug, we get the thread info here before sending the stop event
    // Sometimes we get interrupted by other requests, so we store the latest thread info
    // and use that when needed. This works for All-Stop mode only for now.
    private lastStoppedThreadId: number = 1;
    async stopEvent(record: GdbMiRecord | undefined, reason?: string) {
        this.lastStoppedThreadId = record ? parseInt((record.result as any)["thread-id"] ?? "1") : 1;
        if (this.suppressStoppedEvents) {
            return;
        }

        try {
            const cleaupPromise = this.varManager.prepareForStopped();
            // We have several issues to deal with here:
            // 1. GDB sometimes reports a different current thread id than the one in the stop record
            //    We will trust the stop record more, since that is what caused the stop
            // 2. GDB sometimes reports a current thread id that is not in the thread list
            //    This seems to happen with some RTOSes where threads are created/destroyed rapidly
            //    In this case, we will just pick the first thread in the list
            // 3. VSCode will ask for a stackTrace even before it queries for threads. In this case,
            //    we need to have the current thread info available for stackTrace requests.
            // 4. Just after a reset, things are messed up (stale RAM, junk RTOS threads, etc.) and made worse after
            //    a program operation like "load". So we need to be resilient to all kinds of weird states. Threads
            //    were reported by GDB may not exist after a reset+load. So, query GDB once again for its world view of threads.
            let found = false;
            this.lastThreadsInfo = await this.gdbMiCommands.sendThreadInfoAll();
            if (this.lastThreadsInfo.currentThreadId !== undefined && this.lastStoppedThreadId != this.lastThreadsInfo.currentThreadId) {
                this.handleMsg(Stderr, `mcu-debug: Warning: Stopped thread id ${this.lastStoppedThreadId} does not match current thread id ${this.lastThreadsInfo.currentThreadId}\n`);
                this.lastStoppedThreadId = this.lastThreadsInfo.currentThreadId;
            } else if (this.lastThreadsInfo.currentThreadId === undefined) {
                this.lastThreadsInfo.currentThreadId = this.lastStoppedThreadId;
            }
            let firstThread: GdbMiThreadIF | null = null;
            for (const [thNum, thInfo] of this.lastThreadsInfo.threadMap) {
                firstThread = firstThread || thInfo;
                if (thInfo.id === this.lastThreadsInfo.currentThreadId) {
                    found = true;
                }
            }
            if (!found) {
                this.handleMsg(Stderr, `mcu-debug: Warning: Current thread id ${this.lastThreadsInfo.currentThreadId} not found in thread list\n`);
                this.lastStoppedThreadId = firstThread ? firstThread.id : 1;
                try {
                    // If we don't have a proper thread selected, things like next/step/continue fail
                    await this.gdbInstance.sendCommand(`-thread-select ${this.lastStoppedThreadId}`); // Try to select a valid thread
                } catch (e) {
                    this.handleMsg(Stderr, `mcu-debug: Warning: Failed to select thread id ${this.lastStoppedThreadId}: ${e instanceof Error ? e.message : String(e)}\n`);
                }
            }
            await cleaupPromise;
        } catch (e) {
            this.handleMsg(Stderr, `mcu-debug: Failed to get thread info on stop event: ${e instanceof Error ? e.message : String(e)}\n`);
            this.lastThreadsInfo = this.createEmptyThreadInfo();
        }

        let doNotify = !this.args.noDebug;
        switch (reason) {
            case "entry":
                doNotify = false;
                break;
            case "exited":
            case "exited-normally":
                this.quitEvent();
                return;
            default:
        }
        this.notifyStopped(reason ?? "breakpoint", doNotify, true);
    }

    private notifyStopped(reason: string, doVSCode: boolean, doCustom: boolean) {
        const threadId = this.lastStoppedThreadId;
        if (doVSCode) {
            const ev: DebugProtocol.StoppedEvent = {
                type: "event",
                seq: 0,
                event: "stopped",
                body: {
                    reason: reason || "breakpoint",
                    threadId: threadId,
                    allThreadsStopped: true,
                },
            };
            if (this.args.debugFlags.gdbTraces) {
                this.handleMsg(Stderr, "gdb-mi.status = stopped sent to VSCode\n");
            }
            this.sendEvent(ev);
        }
        if (doCustom) {
            this.sendEvent(new CustomStoppedEvent(reason ?? "breakpoint", threadId));
        }
    }

    handleBreakpointDeleted() {
        // throw new Error("Not yet implemented");
    }
    handleBreakpoint() {
        // throw new Error("Not yet implemented");
    }
    handleWatchpoint(type: string) {
        // throw new Error("Not yet implemented");
    }
    handleBreak() {
        // throw new Error("Not yet implemented");
    }
    handlePause() {
        // Nothing special to do here. Handled by general stop event
    }

    handleRunning() {
        // This is called from outside when we send a continue command
        this.continuing = false;
        this.handleRunningInternal();
    }

    handleRunningInternal() {
        const threadId = this.lastThreadsInfo?.currentThreadId || 1;
        const ev: DebugProtocol.ContinuedEvent = {
            type: "event",
            seq: 0,
            event: "continued",
            body: {
                threadId: threadId,
                allThreadsContinued: true,
            },
        };
        if (this.args.debugFlags.gdbTraces) {
            this.handleMsg(Stderr, "gdb-mi.status = running sent to VSCode\n");
        }
        this.sendEvent(ev);
        ev.event = "custom-continued";
        this.sendEvent(ev);
    }

    private async clearForContinue() {
        await this.varManager.clearForContinue();
        // this.lastThreadsInfo = null;
    }

    handleContinueFailed() {
        throw new Error("Not yet implemented");
    }

    createThreadEvent(id: string, reason: "started" | "exited" | "selected"): DebugProtocol.ThreadEvent {
        const ev: DebugProtocol.ThreadEvent = {
            type: "event",
            seq: 0,
            event: "thread",
            body: {
                reason: reason,
                threadId: parseInt(id, 10),
            },
        };
        return ev;
    }
    handleThreadCreated(record: GdbMiRecord) {
        if (record && record.result && (record.result as any).id !== undefined) {
            const id = (record.result as any).id;
            if (id) {
                this.sendEvent(this.createThreadEvent(id, "started"));
            }
        }
    }
    handleThreadExited(record: GdbMiRecord) {
        if (record && record.result && (record.result as any).id !== undefined) {
            const id = (record.result as any).id;
            if (id) {
                this.sendEvent(this.createThreadEvent(id, "exited"));
            }
        }
    }
    handleThreadSelected(record: GdbMiRecord) {
        if (record && record.result && (record.result as any).id !== undefined) {
            const id = (record.result as any).id;
            if (id) {
                this.sendEvent(this.createThreadEvent(id, "selected"));
            }
        }
    }
    handleThreadGroupExited() {
        // throw new Error("Not yet implemented");
    }

    private serverControllerEvent(event: DebugProtocol.Event) {
        if (event instanceof SWOConfigureEvent) {
            const { type, port } = (event as any).body;
            if (type === "socket") {
                this.swoLaunchPromise = new Promise<void>((resolve, reject) => {
                    const tm = 1000;
                    const timeout = setTimeout(() => {
                        if (!this.swoLaunched) {
                            const msg = `Timeout waiting for SWV TCP port ${port}: ${tm} ms. It may connect later, continue debugging...\n`;
                            this.handleMsg(Stderr, msg);
                        }
                        resolve();
                    }, tm);
                });
            }
        }

        this.sendEvent(event);
    }
}
