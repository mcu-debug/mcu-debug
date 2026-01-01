import { DebugProtocol } from "@vscode/debugprotocol";
import { SeqDebugSession } from "./seq-debug-session";
import { Config } from "winston/lib/winston/config";
import { Logger, logger, OutputEvent, Variable } from "@vscode/debugadapter";
import { ConfigurationArguments, RTTCommonDecoderOpts, CustomStoppedEvent } from "./servers/common";
import path from "path";
import os from "os";
import fs from "fs";
import hasbin from "hasbin";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GdbEventNames, GdbMiRecord } from "./gdb-mi/mi-types";
import { SWODecoderConfig } from "../frontend/swo/common";
import { ValueHandleRegistryPrimitive } from "@mcu-debug/shared";
import { VariableManager } from "./variables";
import { GDBServerSession } from "./server-session";
import { GdbMiThreadInfoList, MiCommands } from "./gdb-mi/mi-commands";

export class SymbolManager {
    constructor() {}
}

export class GDBDebugSession extends SeqDebugSession {
    public args = {} as ConfigurationArguments;
    public gdbInstance: GdbInstance | null = null;
    public liveGdbInstance: GdbInstance | null = null;
    public serverSession: GDBServerSession;
    public gdbMiCommands: MiCommands | null = null;
    public latestThreadInfo: GdbMiThreadInfoList | null = null;
    public continuing: boolean = false;
    public isRunning(): boolean {
        return this.gdbInstance?.status === "running";
    }
    public isBusy(): boolean {
        return this.continuing || this.isRunning();
    }

    protected frameHanedles = new ValueHandleRegistryPrimitive<number>();
    protected variableManager = new VariableManager();

    constructor() {
        super();
        this.serverSession = new GDBServerSession(this);
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        // Support all breakpoint types
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        this.sendResponse(response);
    }
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.serverSession) {
            await this.serverSession.stopServer();
        }
        this.sendResponse(response);
    }
    protected launchRequest(response: DebugProtocol.LaunchResponse, args: ConfigurationArguments, request?: DebugProtocol.Request): void {
        this.launchAttachInit(args);
        this.launchAttachRequest(response, false, args.noDebug || false);
    }
    protected attachRequest(response: DebugProtocol.AttachResponse, args: ConfigurationArguments, request?: DebugProtocol.Request): void {
        this.launchAttachInit(args);
        this.launchAttachRequest(response, true, false);
    }
    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
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
        this.sendResponse(response);
    }
    protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
        response.body = { threads: [] };
        if (this.isBusy()) {
            this.handleMsg(GdbEventNames.Stderr, "Threads request received while target is running. Returning empty thread list.\n");
        } else if (this.latestThreadInfo) {
            for (const t of this.latestThreadInfo.threads) {
                response.body.threads.push({ id: t.id, name: t.name });
            }
        } else {
            response.body.threads.push({ id: 1, name: "Unnamed Thread" });
        }
        this.sendResponse(response);
    }

    protected terminateThreadsRequest(response: DebugProtocol.TerminateThreadsResponse, args: DebugProtocol.TerminateThreadsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void {
        response.body = { stackFrames: [], totalFrames: 0 };
        this.sendResponse(response);
    }
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {
        response.body = { scopes: [] };
        this.sendResponse(response);
    }
    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
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
        this.sendResponse(response);
    }
    protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
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
        if (this.args.debugFlags.anyFlags && this.args.debugFlags.timestamps) {
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

    private getInitCommands(): string[] {
        return [
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
        args.debugFlags.gdbTraces = args.debugFlags.gdbTraces || args.debugFlags.gdbTracesParsed || args.debugFlags.timestamps;
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
        this.serverSession = new GDBServerSession(this);
    }

    private async launchAttachRequest(response: DebugProtocol.LaunchResponse, isAttach: boolean, noDebug: boolean): Promise<void> {
        return new Promise<void>(async (resolve, _reject) => {
            const finish = () => {
                this.sendResponse(response);
                resolve();
            };
            const finishWithError = (message: string) => {
                this.handleMsg(GdbEventNames.Stderr, message);
                this.sendErrorResponse(response, {
                    id: 3000,
                    format: message,
                    showUser: true,
                    sendTelemetry: false,
                });
                resolve();
            };

            await this.startGdb().catch((e) => {
                return finishWithError(`Failed to start GDB: ${e instanceof Error ? e.message : String(e)}`);
            });
            await this.startServer().catch((e) => {
                return finishWithError(`Failed to start debug server: ${e instanceof Error ? e.message : String(e)}`);
            });
            finish();
        });
    }

    private async startGdb(): Promise<void> {
        try {
            const gdbPath = this.getGdbPath();
            const gdbArgs = ["-q", "--interpreter=mi3", ...(this.args.debuggerArgs || [])];
            this.gdbInstance = new GdbInstance(gdbPath, gdbArgs);
            this.gdbInstance.debugFlags = this.args.debugFlags;
            this.handleMsg(GdbEventNames.Console, `Starting GDB: ${gdbPath} ${gdbArgs.join(" ")}\n`);
            this.subscribeToGdbEvents();
            this.gdbMiCommands = new MiCommands(this.gdbInstance);
            await this.gdbInstance.start(this.args.cwd, this.getInitCommands());
        } catch (e) {
            throw e;
        }
    }

    private async startServer(): Promise<void> {
        await this.serverSession.startServer();
        const commands = this.serverSession.serverController.initCommands();
        if (commands.length > 0 && this.gdbInstance) {
            for (const cmd of commands) {
                await this.gdbInstance.sendCommand(cmd);
            }
        }
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
        throw new Error("Not yet implemented");
    }

    // Unlike in cortex-debug, we get the thread info here before sending the stop event
    // Sometimes we get interrupted by other requests, so we store the latest thread info
    // and use that when needed. This works for All-Stop mode only for now.
    stopEvent(record: GdbMiRecord, reason?: string) {
        let getStack = true;
        let doNotify = !this.args.noDebug;
        switch (reason) {
            case "entry":
                // doNotify = false;
                // getStack = false;
                break;
            case "exited":
            case "exited-normally":
                // TODO: Handle exit properly, send TerminatedEvent
                getStack = false;
                break;
            default:
        }
        this.latestThreadInfo = null;
        if (getStack) {
            this.gdbMiCommands
                .sendThreadInfoAll()
                .then((threadsInfo) => {
                    this.latestThreadInfo = threadsInfo;
                })
                .catch((err) => {
                    this.handleMsg(GdbEventNames.Stderr, `Failed to get thread info: ${err instanceof Error ? err.message : String(err)}\n`);
                })
                .finally(() => {
                    if (doNotify) {
                        this.notifyStopped(reason, true);
                    }
                });
        }
    }

    private notifyStopped(reason, doCustom = true) {
        const threadId = this.latestThreadInfo?.currentThreadId || 1;
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
        this.sendEvent(ev);
        if (doCustom) {
            this.sendEvent(new CustomStoppedEvent(reason, threadId));
        }
    }

    handleBreakpointDeleted() {
        throw new Error("Not yet implemented");
    }
    handleBreakpoint() {
        throw new Error("Not yet implemented");
    }
    handleWatchpoint() {
        throw new Error("Not yet implemented");
    }
    handleBreak() {
        throw new Error("Not yet implemented");
    }
    handlePause() {
        throw new Error("Not yet implemented");
    }
    handleRunning() {
        throw new Error("Not yet implemented");
    }
    handleContinueFailed() {
        throw new Error("Not yet implemented");
    }
    handleThreadCreated() {
        throw new Error("Not yet implemented");
    }
    handleThreadExited() {
        throw new Error("Not yet implemented");
    }
    handleThreadSelected() {
        throw new Error("Not yet implemented");
    }
    handleThreadGroupExited() {
        throw new Error("Not yet implemented");
    }
}
