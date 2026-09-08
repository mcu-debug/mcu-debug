import * as process from "process";
import * as crypto from "crypto";
import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { VariableContainer, VariableManager, VariableObject } from "./variables";
import { GdbEventNames, Stderr, MIError, MINode, VarUpdateRecord, Stdout, Console } from "./gdb-mi/mi-types";
import { VariableScope } from "./var-scopes";
import {
    LiveConnectedEvent,
    LiveUpdateEvent,
    RegisterClientRequest,
    RegisterClientResponse,
    UnregisterClientRequest,
    UnregisterClientResponse,
    LiveWatchClientReadyRequest,
    LiveWatchClientReadyResponse,
    DeleteLiveGdbVariables,
    SetVariableArgumentsLive,
    SetExpressionArgumentsLive,
    SetVariableLiveResponse,
    SetExpressionLiveResponse,
} from "./custom-requests";
import { DebugFlags, formatHexValue } from "./servers/common";
import { MemoryRequests } from "./memory";
import EventEmitter from "events";

function shortUuid(length = 16) {
    // Generate a random byte buffer and convert it to a URL-friendly base64 string
    const randomBytes = crypto.randomBytes(Math.ceil(length * 0.75));
    let id = randomBytes
        .toString("base64")
        .replace(/\+/g, "-") // Replace '+' with '-'
        .replace(/\//g, "_") // Replace '/' with '_'
        .replace(/=/g, "") // Remove '='
        .substring(0, length);
    return id.toLocaleUpperCase();
}

export class LiveClientSession {
    public updates = new Map<string, VarUpdateRecord>();
    // Only meaningful for notifyMode "onReady": false right after a push, until the client acks
    // via liveWatchClientReady. "always" clients never have this flipped false.
    public ready: boolean = true;
    constructor(
        public clientId: string,
        public sessionId: string,
        public container: VariableContainer,
        public notifyMode: "always" | "onReady" = "always",
    ) { }
}

// Events emitted by LiveWatchMonitor: "started", "connected", "quit"
// Dap events emitted: "custom-live-watch-updates", "custom-live-watch-connected", "rttServerStarted"
export class LiveWatchMonitor extends EventEmitter {
    private sessionsByClientId = new Map<string, LiveClientSession>();
    private sessionsByPrefix = new Map<string, LiveClientSession>();
    public gdbInstance: GdbInstance;
    protected debugFlags: DebugFlags = {};
    protected varManager: VariableManager;
    protected memoryRequests: MemoryRequests;
    protected liveMonitorEnabled: boolean = false;
    protected handlingRequest: boolean = false;
    protected disableConsoleMessages: boolean = true;      // We start out with Console as they are init. chatter with gdb
    constructor(public mainSession: GDBDebugSession) {
        super();
        this.gdbInstance = new GdbInstance();
        this.varManager = new VariableManager(this.gdbInstance, this.mainSession);
        this.memoryRequests = new MemoryRequests(mainSession, this.gdbInstance);
    }

    public start(gdbCommands: string[]): void {
        this.debugFlags = { ...this.mainSession.args.debugFlags };
        this.debugFlags.gdbTraces = this.debugFlags.liveGdbTraces;
        this.debugFlags.gdbTracesParsed = this.debugFlags.liveGdbTracesParsed;
        this.gdbInstance.debugFlags = this.debugFlags ?? this.gdbInstance.debugFlags ?? {};
        const exe = this.mainSession.gdbInstance.gdbPath;
        const args = this.mainSession.gdbInstance.gdbArgs;
        gdbCommands.push('interpreter-exec console "set stack-cache off"');
        gdbCommands.push('interpreter-exec console "set remote interrupt-on-connect off"');
        gdbCommands.push(...this.mainSession.getServerConnectCommands());
        this.gdbInstance
            .start(exe, args, process.cwd(), [], false)
            .then(() => {
                this.emit("started");
                this.handleMsg(Stdout, `Started GDB process ${exe} ${args.join(" ")}\n`);
                // We disable queue processing to send commands immediately. Because we are well behaved with only a couple of clients
                // making requests at a time, this improves latency. More importatly for RTT reads,
                this.gdbInstance.disableQueueProcessing();
                this.setupEvents();
                for (const cmd of gdbCommands) {
                    this.gdbInstance!.sendCommand(cmd).catch((err) => {
                        this.handleMsg(Stderr, `Error with command '${cmd}': ${err.toString()}\n`);
                    });
                }
            })
            .catch((err) => {
                this.handleMsg(Stderr, `Could not start/initialize Live GDB process: ${err.toString()}\n`);
                this.handleMsg(Stderr, `Live watch expressions will not work.\n`);
                this.connectionState = "failed";
                this.connectionError = err;
                this.mainSession.sendEvent(this.newLiveConnectedEvent(false, err?.toString?.() ?? String(err)));
                this.resolveConnectionWaiters(err);
            });
    }

    public async stop(): Promise<void> {
        this.stopTimer();
        await this.quit().catch(() => { });
    }

    public enabled(): boolean {
        return this.liveMonitorEnabled;
    }

    protected handleMsg(type: GdbEventNames, msg: string) {
        if (this.disableConsoleMessages && !this.debugFlags.anyFlags && type === Console) {
            return;
        }
        const doPrint = (type !== Stdout || this.debugFlags.gdbTraces);
        if (doPrint) {
            this.mainSession.handleMsg(type, "LiveGDB: " + msg);
        }
    }
    protected handleErrResponse(response: DebugProtocol.Response, msg: string, showUser = true) {
        this.mainSession.handleErrResponse(response, "LiveGDB: " + msg, undefined, false, showUser);
    }
    protected sendResponse(response: DebugProtocol.Response) {
        this.mainSession.sendResponse(response);
    }

    protected setupEvents() {
        this.gdbInstance.on("quit", this.quitEvent.bind(this));
        this.gdbInstance.on("exited-normally", this.quitEvent.bind(this));
        this.gdbInstance.on("msg", (type: GdbEventNames, msg: string) => {
            this.handleMsg(type, msg);
        });
        // To be more reliable, we track the target state from the main session's GDB instance
        // This is because we never get z "running" events from the live GDB instance in non-stop mode
        this.mainSession.gdbInstance.on(GdbEventNames.Stopped, this.onStopped.bind(this));
        this.mainSession.gdbInstance.on(GdbEventNames.Running, this.onRunning.bind(this));
        this.gdbInstance.on("connected", () => {
            this.disableConsoleMessages = false;
            this.liveMonitorEnabled = true;
            this.connectionState = "connected";
            this.handleMsg(Stdout, `Live GDB connected to target.\n`);
            this.mainSession.sendEvent(this.newLiveConnectedEvent(true));
            this.emit("connected");
            this.resolveConnectionWaiters();
        });
    }

    protected onStopped() {
        this.stopTimer();
        if (this.isUpdatingVariables) {
            this.updatePromise?.finally(() => {
                this.updateVariables();
            });
        } else {
            this.updateVariables();
        }
    }

    protected onRunning() {
        this.startTimer();
    }

    protected quitEvent() {
        this.emit("quit");
        // this.miDebugger = undefined;
        this.liveMonitorEnabled = false;
    }

    public async evaluateRequestLive(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        try {
            if (this.liveMonitorEnabled === false) {
                throw new Error("Live watch is not enabled (GDB not connected to target)");
            }
            this.handlingRequest = true;
            await this.updatePromise;
            const clientSession = this.sessionsByClientId.get((args as any).sessionId || "");
            if (!clientSession) {
                throw new Error(`Invalid session ID '${(args as any).sessionId}'`);
            }
            args.frameId = undefined; // We don't have threads or frames here. We always evaluate in global context
            await this.varManager.evaluateExpression(response, args, clientSession.container);
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stdout, `Evaluated ${args.expression}\n`);
            }
            this.sendResponse(response);
        } catch (e: any) {
            this.handleErrResponse(response, `Error evaluating expression: ${e.toString()}\n`);
        } finally {
            this.handlingRequest = false;
        }
        return Promise.resolve();
    }

    public async variablesRequestLive(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        try {
            if (this.liveMonitorEnabled === false) {
                throw new Error("Live watch is not enabled (GDB not connected to target)");
            }
            this.handlingRequest = true;
            await this.updatePromise;
            const clientSession = this.sessionsByClientId.get((args as any).sessionId || "");
            if (!clientSession) {
                throw new Error(`Invalid session ID '${(args as any).sessionId}'`);
            }
            const vars = await this.varManager.getVariables(args, clientSession.container);
            response.body = { variables: vars };
            this.sendResponse(response);
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stdout, `Retrieved ${vars.length} variables for reference ${args.variablesReference}\n`);
            }
        } catch (e: any) {
            this.handleErrResponse(response, `Error retrieving variables: ${e.toString()}\n`);
        } finally {
            this.handlingRequest = false;
        }
        return Promise.resolve();
    }

    // Calling this will also enable caching for the future of the session
    public async deleteLiveGdbVariables(response: DebugProtocol.Response, args: DeleteLiveGdbVariables): Promise<void> {
        try {
            if (this.liveMonitorEnabled === false) {
                throw new Error("Live watch is not enabled (GDB not connected to target)");
            }
            this.handlingRequest = true;
            await this.updatePromise;
            const clientSession = this.sessionsByClientId.get((args as any).sessionId || "");
            if (!clientSession) {
                throw new Error(`Invalid session ID '${(args as any).sessionId}'`);
            }
            response.body = { updates: [] };
            const container = clientSession.container;
            if (args.deleteGdbVars && args.deleteGdbVars.length > 0) {
                for (const gdbVarName of args.deleteGdbVars) {
                    await container.deleteObjectByGdbName(gdbVarName, (name) => {
                        if (this.debugFlags.anyFlags) {
                            this.handleMsg(Stderr, `Warning: Could not delete live watch GDB variable '${name}'\n`);
                        }
                    });
                }
            }
            this.sendResponse(response);
        } catch (e: any) {
            this.handleErrResponse(response, `Error refreshing live cache: ${e.toString()}\n`);
        } finally {
            this.handlingRequest = false;
        }
        return Promise.resolve();
    }

    // Single entry point for starting the live GDB connection, whether triggered eagerly by
    // launch.json settings (liveWatch.enabled / built-in RTT) or lazily by the first client that
    // registers even though the user never enabled those. Safe to call repeatedly/concurrently -
    // only the first caller actually starts anything; everyone else just waits on (or immediately
    // gets) the same outcome. Rejects definitively (no retry) once a start attempt has failed.
    private connectionState: "pending" | "connected" | "failed" = "pending";
    private connectionError: any;
    private connectionWaiters: Array<{ resolve: () => void; reject: (e: any) => void }> = [];
    private startInvoked = false;
    private resolveConnectionWaiters(err?: any) {
        const waiters = this.connectionWaiters;
        this.connectionWaiters = [];
        for (const w of waiters) {
            if (err) {
                w.reject(err);
            } else {
                w.resolve();
            }
        }
    }
    public requestLiveCapability(): Promise<void> {
        if (this.connectionState === "connected") {
            return Promise.resolve();
        }
        if (this.connectionState === "failed") {
            return Promise.reject(this.connectionError ?? new Error("Live GDB connection is not available"));
        }
        if (!this.startInvoked) {
            this.startInvoked = true;
            this.start(this.mainSession.getLiveWatchStartCommands());
        }
        return new Promise<void>((resolve, reject) => {
            this.connectionWaiters.push({ resolve, reject });
        });
    }

    public async registerClientRequest(response: RegisterClientResponse, args: RegisterClientRequest): Promise<void> {
        try {
            this.handlingRequest = true;
            await this.requestLiveCapability();
            await this.updatePromise;
            const size = this.sessionsByClientId.size.toString();
            const sessionId = `mcu-debug-live-${size}-` + shortUuid(8);
            const prefix = `W${size}-`;
            const container = new VariableContainer(this.gdbInstance, this.mainSession, VariableScope.Watch, prefix);
            const session = new LiveClientSession(args.clientId, sessionId, container, args.notifyMode === "onReady" ? "onReady" : "always");
            this.sessionsByClientId.set(sessionId, session);
            this.sessionsByPrefix.set(prefix, session);
            if (this.mainSession.gdbInstance.IsRunning()) {
                // Idempotent; ensures a client that registers lazily (i.e. liveWatch.enabled was never
                // set) starts getting periodic updates without waiting for the next run/stop transition.
                this.startTimer();
            }
            response.body = {
                clientId: args.clientId,
                sessionId: sessionId,
            };
            this.sendResponse(response);
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stderr, `Registered client '${args.clientId}' with session ID '${response.body.sessionId}'\n`);
            }
        } catch (e: any) {
            // Registration can routinely fail (gdb-server doesn't support live probes, or the connection
            // hasn't come up/failed yet) - not something the user needs a popup for.
            this.handleErrResponse(response, `Error registering client: ${e.toString()}, Not connected to target\n`, false);
        } finally {
            this.handlingRequest = false;
        }
    }

    // Releases a client's tracked GDB variables and its session. Nothing calls this today (clients
    // simply live until the debug session ends), but a client that no longer wants updates can use it
    // to free its live watch resources early rather than leaving them tracked for the rest of the session.
    public async unregisterClientRequest(response: UnregisterClientResponse, args: UnregisterClientRequest): Promise<void> {
        try {
            this.handlingRequest = true;
            await this.updatePromise;
            const sessionId = (args as any).sessionId || "";
            const clientSession = this.sessionsByClientId.get(sessionId);
            if (!clientSession) {
                throw new Error(`Invalid session ID '${sessionId}'`);
            }
            await clientSession.container.clear((name) => {
                if (this.debugFlags.anyFlags) {
                    this.handleMsg(Stderr, `Warning: Could not delete GDB variable '${name}' while unregistering client\n`);
                }
            });
            this.sessionsByClientId.delete(sessionId);
            for (const [prefix, session] of this.sessionsByPrefix) {
                if (session === clientSession) {
                    this.sessionsByPrefix.delete(prefix);
                    break;
                }
            }
            response.body = {};
            this.sendResponse(response);
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stdout, `Unregistered client with session ID '${sessionId}'\n`);
            }
        } catch (e: any) {
            this.handleErrResponse(response, `Error unregistering client: ${e.toString()}\n`);
        } finally {
            this.handlingRequest = false;
        }
    }

    // Calling this will also enable caching for the future of the session
    private isUpdatingVariables: boolean = false;
    public updatePromise = Promise.resolve();
    private pvrWriteUpdates: VarUpdateRecord[] = []; public async updateVariables(): Promise<void> {
        this.updatePromise = new Promise<void>(async (resolve) => {
            try {
                this.isUpdatingVariables = true;
                const updates = await this.updateAllGdbVariables();
                if (this.pvrWriteUpdates.length > 0) {
                    updates.unshift(...this.pvrWriteUpdates);
                }
                for (const update of updates) {
                    const prefix = update.name.substring(0, update.name.indexOf("-") + 1);
                    const session = this.sessionsByPrefix.get(prefix);
                    if (session) {
                        session.updates.set(update.name, update);
                    }
                }
                this.pvrWriteUpdates = [];
                for (const [_clientId, session] of this.sessionsByClientId) {
                    if (session.updates.size > 0 && session.ready) {
                        this.dispatchLiveUpdate(session);
                    }
                }
            } catch (e: any) {
                if (this.debugFlags.anyFlags) {
                    this.handleMsg(Stderr, `Error refreshing live cache: ${e.toString()}\n`);
                }
            } finally {
                this.isUpdatingVariables = false;
                resolve();
            }
        });
        return this.updatePromise;
    }

    public async updateAllGdbVariables(): Promise<VarUpdateRecord[]> {
        try {
            const cmd = `-var-update --all-values *`;
            const miOutput = await this.gdbInstance.sendCommand(cmd);
            const records = (miOutput.resultRecord?.result as any)["changelist"];
            return records;
        } catch (e: any) {
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stderr, `mcu-debug: Error updating all variables: ${e}\n`);
            }
            return [];
        }
    }

    // Sends the pending batch to a client and clears it. For notifyMode "onReady" clients, this
    // also marks them not-ready until they explicitly ack via liveWatchClientReady.
    private dispatchLiveUpdate(session: LiveClientSession): void {
        const sz = session.updates.size;
        const ev: LiveUpdateEvent = this.newLiveUpdateEvent(session);
        this.mainSession.sendEvent(ev);
        session.updates.clear();
        if (session.notifyMode === "onReady") {
            session.ready = false;
        }
        if (this.debugFlags.gdbTraces) {
            this.handleMsg(Stdout, `Updated ${sz} variables for client '${session.clientId}', session '${session.sessionId}'\n`);
        }
    }

    public async liveWatchClientReadyRequest(response: LiveWatchClientReadyResponse, args: LiveWatchClientReadyRequest): Promise<void> {
        try {
            this.handlingRequest = true;
            await this.updatePromise;
            const sessionId = (args as any).sessionId || "";
            const clientSession = this.sessionsByClientId.get(sessionId);
            if (!clientSession) {
                throw new Error(`Invalid session ID '${sessionId}'`);
            }
            clientSession.ready = true;
            if (clientSession.updates.size > 0) {
                this.dispatchLiveUpdate(clientSession);
            }
            response.body = {};
            this.sendResponse(response);
        } catch (e: any) {
            this.handleErrResponse(response, `Error processing live watch client ready: ${e.toString()}\n`);
        } finally {
            this.handlingRequest = false;
        }
    }

    private newLiveUpdateEvent(session: LiveClientSession): LiveUpdateEvent {
        return {
            seq: 0,
            type: "event",
            event: "custom-live-watch-updates",
            body: {
                sessionId: session.sessionId,
                clientId: session.clientId,
                updates: Array.from(session.updates.values()),
            },
        };
    }
    private newLiveConnectedEvent(connected: boolean, reason?: string): LiveConnectedEvent {
        return {
            seq: 0,
            type: "event",
            event: "custom-live-watch-connected",
            body: { connected, reason },
        };
    }

    public updateTimer: NodeJS.Timeout | undefined;
    public startTimer(): void {
        const hasLiveClients = this.sessionsByClientId.size > 0;
        if (this.liveMonitorEnabled && !this.updateTimer && (this.mainSession.args.liveWatch?.enabled || hasLiveClients)) {
            const setting = Math.max(0.1, this.mainSession.args.liveWatch?.samplesPerSecond ?? 1);
            const intervalMs = Math.max(100, 1000 / setting);
            this.updateTimer = setInterval(() => {
                for (const [_clientId, session] of this.sessionsByClientId) {
                    if (session.container.numberOfGdbVariables() > 0) {
                        if (!this.isUpdatingVariables && !this.handlingRequest) {
                            this.updateVariables().catch(() => { });
                        }
                        break;
                    }
                }
            }, intervalMs);
        }
    }

    private async tryWriteViaMonitorCommand(container: VariableContainer, response: SetVariableLiveResponse, varObj: VariableObject, argValue: string): Promise<boolean> {
        const serverType = this.mainSession.args.servertype;
        if (!varObj.addressOf) {
            // Children may not have addressOf info yet, try to get it
            await varObj.queryGdbVarInfo(this.gdbInstance).catch(() => { });
        }
        const size = varObj.sizeof || 0;
        const isOk = varObj.addressOf && size > 0 && size <= 8 && varObj.editable;
        if (serverType === "openocd" && isOk) {
            const val = formatHexValue(BigInt(argValue), size * 8);
            const ww = size === 1 ? "b" : size === 2 ? "h" : size === 4 ? "w" : "d";
            const cmd = `-interpreter-exec console "monitor mw${ww}  ${varObj.addressOf} ${val}"`;
            try {
                await this.gdbInstance!.sendCommand(cmd);
                this.handleMsg(Stdout, `Wrote memory at '${varObj.addressOf}' to value '${val}' via OpenOCD monitor command\n`);
                // Now read back the value to confirm
                const readCmd = `-var-update --all-values ${varObj.gdbVarName}`;
                const miOutput = await this.gdbInstance!.sendCommand(readCmd);
                // At this point, the regular updates are halted, so we need to capture the changelist ourselves
                // And we can save them so that a future updateVariables() call will send them out
                this.pvrWriteUpdates = (miOutput.resultRecord?.result as any)["changelist"];
                const ourUpdate = this.pvrWriteUpdates[0];
                if (BigInt(argValue) !== BigInt(ourUpdate.value)) {
                    throw new Error(`GDB could not confirm an update to '${varObj.evaluateName}' via OpenOCD monitor command`);
                }
                varObj.value = ourUpdate.value;
                response.body = {
                    value: ourUpdate.value,
                    gdbVarName: varObj.gdbVarName,
                    variableObject: await container.toProtocolVariable(varObj),
                };
                this.sendResponse(response);
                return true;
            } catch (e) {
                this.handleMsg(Stderr, `Error writing memory via OpenOCD monitor command: ${e}\n`);
            }
        }
        return false;
    }

    private async setByGdbVarName(container: VariableContainer, response: SetVariableLiveResponse, varObj: VariableObject, argValue: string): Promise<void> {
        const gdbVarName = varObj.gdbVarName!;
        const cmd = `-var-assign ${gdbVarName} ${argValue}`;
        try {
            const miOutput = await this.gdbInstance!.sendCommand(cmd);
            this.handleMsg(Stderr, `Set variable '${varObj.evaluateName}' (GDB name '${gdbVarName}') to value '${argValue}'\n`);
            const result = miOutput.resultRecord?.result as any;
            if (result && result["value"]) {
                const newValue = result["value"];
                if (newValue !== argValue) {
                    throw new Error(`GDB could not update value to '${argValue}'`);
                }
                varObj.value = newValue;
                response.body = {
                    value: newValue,
                    gdbVarName: gdbVarName,
                    variableObject: await container.toProtocolVariable(varObj),
                };
                this.sendResponse(response);
                return;
            } else {
                throw new Error(`No value returned from GDB`);
            }
        } catch (e) {
            if (!(await this.tryWriteViaMonitorCommand(container, response, varObj, argValue))) {
                this.handleMsg(Stderr, `Error setting variable with GDB name '${gdbVarName}': ${e}\n`);
                throw new Error(`Could not set variable with GDB name '${gdbVarName}': ${e}`);
            }
        }
    }

    public async setVariableRequest(response: SetVariableLiveResponse, args: SetVariableArgumentsLive): Promise<void> {
        let updateDone = false;
        if (this.liveMonitorEnabled === false) {
            this.handleErrResponse(response, "Live watch is not enabled (GDB not connected to target)");
            return;
        }
        try {
            this.handlingRequest = true;
            await this.updatePromise;
            const clientSession = this.sessionsByClientId.get((args as any).sessionId || "");
            if (!clientSession) {
                throw new Error(`Invalid session ID '${(args as any).sessionId}'`);
            }
            const gdbVarName = args.gdbVarName;
            const varObj = gdbVarName ? clientSession.container.getVariableByGdbName(gdbVarName) : undefined;
            if (varObj) {
                try {
                    await this.setByGdbVarName(clientSession.container, response, varObj, args.value);
                    updateDone = true;
                    return;
                } catch (e) {
                    throw e;
                }
            }

            response.body = await this.varManager.setVariable(args, clientSession.container);
            updateDone = true;
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetVariable request failed: ${e}`);
        } finally {
            this.handlingRequest = false;
            if (updateDone && this.gdbInstance.IsStopped()) {
                await this.updateVariables();
            }
        }
    }

    public async setExpressionRequest(response: SetExpressionLiveResponse, args: SetExpressionArgumentsLive): Promise<void> {
        let updateDone = false;
        if (this.liveMonitorEnabled === false) {
            this.handleErrResponse(response, "Live watch is not enabled (GDB not connected to target)");
            return;
        }
        try {
            this.handlingRequest = true;
            await this.updatePromise;
            const clientSession = this.sessionsByClientId.get((args as any).sessionId || "");
            if (!clientSession) {
                throw new Error(`Invalid session ID '${(args as any).sessionId}'`);
            }
            const gdbVarName = args.gdbVarName;
            const varObj = gdbVarName ? clientSession.container.getVariableByGdbName(gdbVarName) : undefined;
            if (varObj) {
                try {
                    await this.setByGdbVarName(clientSession.container, response, varObj, args.value);
                    updateDone = true;
                    return;
                } catch (e) {
                    throw e;
                }
            }

            response.body = await this.varManager.setExpression(args, clientSession.container);
            this.sendResponse(response);
        } catch (e) {
            this.handleErrResponse(response, `SetExpression request failed: ${e}`);
        } finally {
            this.handlingRequest = false;
            if (updateDone && this.gdbInstance.IsStopped()) {
                await this.updateVariables();
            }
        }
    }

    public async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
        if (this.liveMonitorEnabled === false) {
            this.handleErrResponse(response, "Live watch is not enabled (GDB not connected to target)");
            return;
        }
        await this.memoryRequests.readMemoryRequest(response, args);
    }

    public async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
        if (this.liveMonitorEnabled === false) {
            this.handleErrResponse(response, "Live watch is not enabled (GDB not connected to target)");
            return;
        }
        await this.memoryRequests.writeMemoryRequest(response, args);
    }

    public stopTimer(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
        }
    }

    private quitting = false;
    private async quit() {
        try {
            if (!this.quitting && this.gdbInstance.IsGdbRunning()) {
                this.quitting = true;
                try {
                    // Give GDB a chance to disconnect nicely, but don't wait forever. Note that we do not `detach`
                    // which causes a continue in the target. Not doing anything will cause an implicit detach by gdb
                    await this.gdbInstance.sendCommand("-target-disconnect", 100);
                } catch (e) {
                    if (this.debugFlags.anyFlags) {
                        this.handleMsg(Stderr, `Error during live watch GDB exit command: ${e}\n`);
                    }
                    // Ignore errors
                } finally {
                    await this.gdbInstance.sendCommand("-gdb-exit", 100);
                }
            }
        } catch (e: any) {
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stderr, `LiveWatchMonitor.quit: ${e}\n`);
            }
            // Ignore errors
        }
    }
}
