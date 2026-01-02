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
import { GdbEventNames, GdbMiOutput, GdbMiRecord, Stderr } from "./gdb-mi/mi-types";
import { SWODecoderConfig } from "../frontend/swo/common";
import { ValueHandleRegistryPrimitive } from "@mcu-debug/shared";
import { decodeReference, encodeReference, VariableContainer, VariableManager, VariableScope } from "./variables";
import { GDBServerSession } from "./server-session";
import { GdbMiThreadInfoList, MiCommands } from "./gdb-mi/mi-commands";
import { SessionMode } from "./servers/common";
import { hexFormat } from "../frontend/utils";
export class SymbolManager {
    constructor() {}
}

export class GDBDebugSession extends SeqDebugSession {
    public args = {} as ConfigurationArguments;
    public gdbInstance: GdbInstance | null = null;
    public liveGdbInstance: GdbInstance | null = null;
    public serverSession: GDBServerSession;
    public gdbMiCommands: MiCommands | null = null;
    public lastThreadsInfo: GdbMiThreadInfoList | null = null;
    public continuing: boolean = false;
    public isRunning(): boolean {
        return this.gdbInstance?.status === "running";
    }
    public isBusy(): boolean {
        return this.continuing || this.isRunning();
    }

    protected frameHanedles = new ValueHandleRegistryPrimitive<number>();
    protected varManager = new VariableManager();

    constructor() {
        super();
        this.serverSession = new GDBServerSession(this);
    }

    handleErrResponse(response: DebugProtocol.Response, msg: string): void {
        if (!msg.startsWith("mcu-debug")) {
            msg = "mcu-debug: " + msg;
        }
        this.handleMsg(GdbEventNames.Stderr, msg + "\n");
        this.sendErrorResponse(response, 1, msg);
    }
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;

        // response.body.supportsHitConditionalBreakpoints = true;
        // response.body.supportsConditionalBreakpoints = true;
        // response.body.supportsLogPoints = true;
        // response.body.supportsFunctionBreakpoints = true;
        // response.body.supportsEvaluateForHovers = true;
        // response.body.supportsSetVariable = true;
        // response.body.supportsSetExpression = true;

        // We no longer support a 'Restart' request. However, VSCode will implement a replacement by terminating the
        // current session and starting a new one from scratch. But, we still have to support the launch.json
        // properties related to Restart but for Reset. This way, we don't break functionality.
        response.body.supportsRestartRequest = false;

        response.body.supportsGotoTargetsRequest = true;
        response.body.supportSuspendDebuggee = true;
        // response.body.supportTerminateDebuggee = true;
        // response.body.supportsDataBreakpoints = true;
        // response.body.supportsDisassembleRequest = true;
        // response.body.supportsSteppingGranularity = true;
        // response.body.supportsInstructionBreakpoints = true;
        // response.body.supportsReadMemoryRequest = true;
        // response.body.supportsWriteMemoryRequest = true;

        this.sendResponse(response);
    }
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): Promise<void> {
        if (this.serverSession) {
            await this.serverSession.stopServer();
        }
        this.sendResponse(response);
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
        if (this.isBusy()) {
            this.handleErrResponse(response, "Continue request received while target is running.");
            return;
        }
        this.continuing = true;
        this.gdbMiCommands!.sendContinue(undefined)
            .then(() => {
                response.body = { allThreadsContinued: true };
                this.sendResponse(response);
            })
            .catch((e) => {
                this.handleErrResponse(response, `Continue request failed: ${e}`);
            })
            .finally(() => {
                this.clearForContinue();
            });
    }
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {
        this.continuing = true;
        this.gdbMiCommands!.sendNext()
            .then(() => {
                this.sendResponse(response);
            })
            .catch((e) => {
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
                this.handleErrResponse(response, `Next request failed: ${e}`);
            });
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
        this.continuing = true;
        this.gdbMiCommands!.sendStepOut()
            .then(() => {
                this.sendResponse(response);
            })
            .catch((e) => {
                this.handleErrResponse(response, `Next request failed: ${e}`);
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
                this.handleErrResponse(response, `Pause request failed: ${e}`);
            });
    }
    protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
        response.body = { threads: [] };
        if (this.isBusy()) {
            this.handleMsg(GdbEventNames.Stderr, "mcu-debug: Threads request received while target is running. Returning empty thread list.\n");
        } else if (this.lastThreadsInfo) {
            for (const t of this.lastThreadsInfo.threads) {
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
            const frames = await this.gdbMiCommands.sendStackListFrames(threadId, startFrame, startFrame + levels);
            for (const frame of frames) {
                const ref = encodeReference(threadId, frame.level, VariableScope.Scope);
                const handle = this.frameHanedles.add(ref);
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
            response.body.totalFrames = frames.length;
        } catch (e) {
            this.handleErrResponse(response, `Failed to get stack frames: ${e}`);
            return;
        }
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {
        const scopes: DebugProtocol.Scope[] = [];
        const frameRef = this.frameHanedles.get(args.frameId);
        if (frameRef === undefined) {
            this.handleErrResponse(response, `Invalid frame ID: ${args.frameId}`);
            return;
        }
        const [threadId, frameId, scope] = decodeReference(frameRef);
        if (scope !== VariableScope.Scope) {
            this.handleErrResponse(response, `Invalid scope for scopes request: ${VariableScope[scope]}`);
            return;
        }
        scopes.push({ name: "Local", variablesReference: encodeReference(threadId, frameId, VariableScope.Local), expensive: false });
        scopes.push({ name: "Global", variablesReference: encodeReference(0, 0, VariableScope.Global), expensive: true });
        scopes.push({ name: "Static", variablesReference: encodeReference(0, 0, VariableScope.Static), expensive: false });
        scopes.push({ name: "Registers", variablesReference: encodeReference(threadId, frameId, VariableScope.Registers), expensive: false });
        for (const s of scopes) {
            // We need to get a handle for the variablesReference
            s.variablesReference = this.frameHanedles.add(s.variablesReference);
        }

        response.body = { scopes: scopes };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void {
        response.body = { variables: [] };
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

    private async launchAttachRequest(response: DebugProtocol.LaunchResponse, noDebug: boolean): Promise<void> {
        return new Promise<void>(async (resolve, _reject) => {
            const finish = () => {
                this.sendResponse(response);
                resolve();
            };
            const finishWithError = (message: string) => {
                this.handleErrResponse(response, message);
                resolve();
            };
            try {
                this.getSymbolAndLoadCommands();

                this.handleRunning(); // Assume we are running at the beginning, so VSCode doesn't send any requests too early
                await this.startGdb().catch((e) => {
                    return finishWithError(`Failed to start GDB: ${e instanceof Error ? e.message : String(e)}`);
                });
                await this.sendCommandsWithWait(this.gdbInitCommands);
                await this.startServer().catch((e) => {
                    return finishWithError(`Failed to start debug server: ${e instanceof Error ? e.message : String(e)}`);
                });
                finish();
            } catch (e) {
                return finishWithError(`Launch/Attach request failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        });
    }

    private async startGdb(): Promise<void> {
        try {
            const gdbPath = this.getGdbPath();
            const gdbArgs = ["-q", "--interpreter=mi3", ...(this.args.debuggerArgs || [])];
            this.gdbInstance = new GdbInstance(gdbPath, gdbArgs);
            this.gdbInstance.debugFlags = this.args.debugFlags;
            this.handleMsg(GdbEventNames.Console, `mcu-debug: Starting GDB: ${gdbPath} ${gdbArgs.join(" ")}\n`);
            this.subscribeToGdbEvents();
            this.gdbMiCommands = new MiCommands(this.gdbInstance);
            await this.gdbInstance.start(this.args.cwd, this.getInitCommands());
        } catch (e) {
            throw e;
        }
    }

    private async startServer(): Promise<void> {
        const mode = this.args.pvtSessionMode;
        await this.serverSession.startServer(); // Can throw
        await this.sendCommandsWithWait(this.getConnectCommands()); // Can throw
        if (this.isRunning()) {
            return;
        }
        await this.runSessionModeCommands();
    }

    private symInitCommands: string[] = [];
    private gdbInitCommands: string[] = [];
    private getSymbolAndLoadCommands(): void {
        const loadFiles = this.args.loadFiles;
        let isLoaded = false;
        if (this.args.symbolFiles) {
            // If you just used 'add-symbol-file' debugging works but RTOS detection fails
            // for most debuggers.
            for (const symF of this.args.symbolFiles) {
                const offset = symF.offset ? `-o ${hexFormat(symF.offset)}"` : "";
                let otherArgs = typeof symF.textaddress === "number" ? ` ${hexFormat(symF.textaddress)}"` : "";
                for (const section of symF.sections) {
                    otherArgs += ` -s ${section.name} ${section.address}`;
                }
                const cmd = `add-symbol-file \\"${symF.file}\\" ${offset} ${otherArgs}`.trimEnd();
                this.symInitCommands.push(`interpreter-exec console "${cmd}"`);
            }
            if (this.symInitCommands.length === 0) {
                this.handleMsg(Stderr, 'mcu-debug: GDB may not start since there were no files with symbols in "symbolFiles?\n');
            }
            this.gdbInitCommands.push(...this.symInitCommands);
            this.symInitCommands = [];
        } else if (!loadFiles && this.args.executable) {
            this.gdbInitCommands.push(`file-exec-and-symbols "${this.args.executable}"`);
            isLoaded = true;
        }
        if (!isLoaded && !loadFiles && this.args.executable) {
            this.args.loadFiles = [this.args.executable];
        }
    }

    private getServerConnectCommands() {
        // server init commands simply makes a tcp connection. It should not halt
        // the program. After the connection is established, we should load all the
        // symbols -- especially before a halt
        const cmds: string[] = [
            // 'interpreter-exec console "set debug remote 1"',
            ...(this.serverSession.serverController.initCommands() || []),
            ...this.symInitCommands,
        ];
        return cmds;
    }
    protected getConnectCommands(): string[] {
        const commands = this.getServerConnectCommands();

        if (this.args.pvtSessionMode === SessionMode.Attach) {
            commands.push(...this.args.preAttachCommands);
            const attachCommands = this.args.overrideAttachCommands != null ? this.args.overrideAttachCommands : this.serverSession.serverController.attachCommands();
            commands.push(...attachCommands);
            commands.push(...this.args.postAttachCommands);
        } else {
            commands.push(...this.args.preLaunchCommands);
            const launchCommands = this.args.overrideLaunchCommands != null ? this.args.overrideLaunchCommands : this.serverSession.serverController.launchCommands();
            commands.push(...launchCommands);
            commands.push(...this.args.postLaunchCommands);
        }
        return commands;
    }

    protected async runSessionModeCommands(): Promise<void> {
        let commands = [];
        if (this.args.pvtSessionMode === SessionMode.Launch || this.args.pvtSessionMode === SessionMode.Reset) {
            if (!this.args.breakAfterReset && this.args.runToEntryPoint && !this.args.noDebug) {
                commands = [`-break-insert -t ${this.args.runToEntryPoint}`, "-exec-continue"];
            } else if (this.args.noDebug || this.args.breakAfterReset === false) {
                commands = ["-exec-continue"];
            }
        } else if (this.args.pvtSessionMode === SessionMode.Attach) {
            commands = !this.args.noDebug ? [] : ["-exec-continue"];
        } else if (this.args.pvtSessionMode === SessionMode.Launch || this.args.pvtSessionMode === SessionMode.Reset) {
            commands = this.args.breakAfterReset ? [] : ["-exec-continue"];
        }
        this.continuing = commands.length > 0;
        await this.sendCommandsWithWait(commands);

        if (!this.isRunning()) {
            // VSCode still things we are running althrough, we should be stopped at entry point
            // The GdbMiInstance has the true status and if it is not running, we send a stopped event
            // Also, users custom commands may have messed with the session state, so we ensure we
            // notify VSCode of the stopped state here.
            this.notifyStopped("entry", !this.args.noDebug, false);
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
                doNotify = false;
                // getStack = false;
                break;
            case "exited":
            case "exited-normally":
                // TODO: Handle exit properly, send TerminatedEvent
                getStack = false;
                break;
            default:
        }
        this.lastThreadsInfo = null;
        if (getStack) {
            this.gdbMiCommands
                .sendThreadInfoAll()
                .then((threadsInfo) => {
                    this.lastThreadsInfo = threadsInfo;
                })
                .catch((err) => {
                    this.handleMsg(GdbEventNames.Stderr, `mcu-debug: Failed to get thread info: ${err instanceof Error ? err.message : String(err)}\n`);
                })
                .finally(() => {
                    this.notifyStopped(reason, doNotify, true);
                });
        }
    }

    private notifyStopped(reason, doVSCode, doCustom) {
        const threadId = this.lastThreadsInfo?.currentThreadId || 1;
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
            this.sendEvent(ev);
        }
        if (doCustom) {
            this.sendEvent(new CustomStoppedEvent(reason, threadId));
        }
    }

    handleBreakpointDeleted() {
        // throw new Error("Not yet implemented");
    }
    handleBreakpoint() {
        // throw new Error("Not yet implemented");
    }
    handleWatchpoint() {
        // throw new Error("Not yet implemented");
    }
    handleBreak() {
        // throw new Error("Not yet implemented");
    }
    handlePause() {
        // Nothing special to do here. Handled by general stop event
    }
    handleRunning() {
        this.clearForContinue();
        this.continuing = false;

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
        this.sendEvent(ev);
    }
    private clearForContinue() {
        this.varManager.clearForContinue();
        this.frameHanedles.clear();
        this.lastThreadsInfo = null;
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
        const id = record.result["id"];
        if (id) {
            this.sendEvent(this.createThreadEvent(id, "started"));
        }
    }
    handleThreadExited(record: GdbMiRecord) {
        const id = record.result["id"];
        if (id) {
            this.sendEvent(this.createThreadEvent(id, "exited"));
        }
    }
    handleThreadSelected(record: GdbMiRecord) {
        const id = record.result["id"];
        if (id) {
            this.sendEvent(this.createThreadEvent(id, "selected"));
        }
    }
    handleThreadGroupExited() {
        throw new Error("Not yet implemented");
    }
}
