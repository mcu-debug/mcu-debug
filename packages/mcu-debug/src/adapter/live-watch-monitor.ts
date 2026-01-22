// @ts-strict-ignore
import * as process from "process";
import * as crypto from "crypto";
import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { VariableContainer, VariableManager, VariableObject } from "./variables";
import { GdbEventNames, Stderr, MIError, MINode, VarUpdateRecord, Stdout } from "./gdb-mi/mi-types";
import { expandValue } from "./gdb-mi/gdb_expansion";
import { VariableScope } from "./var-scopes";
import {
    LiveConnectedEvent,
    LiveUpdateEvent,
    RegisterClientRequest,
    RegisterClientResponse,
    DeleteLiveGdbVariables,
    SetVariableArgumentsLive,
    SetExpressionArgumentsLive,
    SetVariableLiveResponse,
    SetExpressionLiveResponse,
} from "./custom-requests";
import { DebugFlags, formatHexValue } from "./servers/common";
import { MemoryRequests } from "./memory";

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
    constructor(
        public clientId: string,
        public sessionId: string,
        public container: VariableContainer,
    ) {}
}
export class LiveWatchMonitor {
    private sessionsByClientId = new Map<string, LiveClientSession>();
    private sessionsByPrefix = new Map<string, LiveClientSession>();
    public gdbInstance: GdbInstance | undefined;
    protected debugFlags: DebugFlags = {};
    protected varManager: VariableManager;
    protected memoryRequests: MemoryRequests;
    protected liveWatchEnabled: boolean = false;
    protected handlingRequest: boolean = false;
    constructor(private mainSession: GDBDebugSession) {
        this.gdbInstance = new GdbInstance();
        this.varManager = new VariableManager(this.gdbInstance, this.mainSession);
        this.memoryRequests = new MemoryRequests(mainSession, this.gdbInstance);
    }

    public start(gdbCommands: string[]): void {
        this.debugFlags = this.mainSession.args.debugFlags;
        this.gdbInstance.debugFlags = this.debugFlags;
        const exe = this.mainSession.gdbInstance.gdbPath;
        const args = this.mainSession.gdbInstance.gdbArgs;
        gdbCommands.push('interpreter-exec console "set stack-cache off"');
        gdbCommands.push('interpreter-exec console "set remote interrupt-on-connect off"');
        gdbCommands.push(...this.mainSession.getServerConnectCommands());
        this.gdbInstance
            .start(exe, args, process.cwd(), [], 10 * 1000, false)
            .then(() => {
                this.handleMsg(Stderr, `Started GDB process ${exe} ${args.join(" ")}\n`);
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
            });
    }

    public stop(): void {
        this.stopTimer();
        this.quit().catch(() => {});
    }

    public enabled(): boolean {
        return this.liveWatchEnabled;
    }

    protected handleMsg(type: GdbEventNames, msg: string) {
        this.mainSession.handleMsg(type, "LiveGDB: " + msg);
    }
    protected handleErrResponse(response: DebugProtocol.Response, msg: string) {
        this.mainSession.handleErrResponse(response, "LiveGDB: " + msg);
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
            this.liveWatchEnabled = true;
            this.handleMsg(Stderr, `Live GDB connected to target.\n`);
            this.mainSession.sendEvent(this.newLiveConnectedEvent());
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
        // this.miDebugger = undefined;
        this.liveWatchEnabled = false;
    }

    public async evaluateRequestLive(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        try {
            if (this.liveWatchEnabled === false) {
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
                this.handleMsg(Stderr, `Evaluated ${args.expression}\n`);
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
            if (this.liveWatchEnabled === false) {
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
                this.handleMsg(Stderr, `Retrieved ${vars.length} variables for reference ${args.variablesReference}\n`);
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
            if (this.liveWatchEnabled === false) {
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

    public async registerClientRequest(response: RegisterClientResponse, args: RegisterClientRequest): Promise<void> {
        try {
            if (this.liveWatchEnabled === false) {
                throw new Error("Live watch is not enabled (GDB not connected to target)");
            }
            this.handlingRequest = true;
            await this.updatePromise;
            const size = this.sessionsByClientId.size.toString();
            const sessionId = `mcu-debug-live-${size}-` + shortUuid(8);
            const prefix = `W${size}-`;
            const container = new VariableContainer(this.gdbInstance, VariableScope.Watch, prefix);
            const session = new LiveClientSession(args.clientId, sessionId, container);
            this.sessionsByClientId.set(sessionId, session);
            this.sessionsByPrefix.set(prefix, session);
            response.body = {
                clientId: args.clientId,
                sessionId: sessionId,
            };
            this.sendResponse(response);
            if (this.debugFlags.anyFlags) {
                this.handleMsg(Stderr, `Registered client '${args.clientId}' with session ID '${response.body.sessionId}'\n`);
            }
        } catch (e: any) {
            this.handleErrResponse(response, `Error registering client: ${e.toString()}, Not connected to target\n`);
        } finally {
            this.handlingRequest = false;
        }
    }

    // Calling this will also enable caching for the future of the session
    private isUpdatingVariables: boolean = false;
    public updatePromise = Promise.resolve();
    private pvrWriteUpdates: VarUpdateRecord[] = [];
    public async updateVariables(): Promise<void> {
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
                for (const [clientId, session] of this.sessionsByClientId) {
                    const sz = session.updates.size;
                    if (sz > 0) {
                        const ev: LiveUpdateEvent = this.newLiveUpdateEvent(session);
                        this.mainSession.sendEvent(ev);
                        session.updates.clear();
                        if (this.debugFlags.gdbTraces) {
                            this.handleMsg(Stdout, `Updated ${sz} variables for client '${clientId}, session '${session.sessionId}'\n`);
                        }
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
            const records = miOutput.resultRecord.result["changelist"];
            return records;
        } catch (e) {
            if (this.debugFlags.anyFlags) {
                this.handleMsg(GdbEventNames.Console, `mcu-debug: Error updating all variables: ${e}\n`);
            }
            return [];
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
    private newLiveConnectedEvent(): LiveConnectedEvent {
        return {
            seq: 0,
            type: "event",
            event: "custom-live-watch-connected",
            body: {},
        };
    }

    public updateTimer: NodeJS.Timeout | undefined;
    public startTimer(): void {
        if (this.liveWatchEnabled && !this.updateTimer) {
            const setting = Math.max(0.1, this.mainSession.args.liveWatch.samplesPerSecond ?? 4);
            const intervalMs = Math.max(100, 1000 / setting);
            this.updateTimer = setInterval(() => {
                for (const [_clientId, session] of this.sessionsByClientId) {
                    if (session.container.numberOfGdbVariables() > 0) {
                        if (!this.isUpdatingVariables && !this.handlingRequest) {
                            this.updateVariables().catch(() => {});
                        }
                        break;
                    }
                }
            }, intervalMs);
        }
    }

    private async tryWriteViaMonitorCommand(response: SetVariableLiveResponse, varObj: VariableObject, argValue: string): Promise<boolean> {
        const serverType = this.mainSession.args.servertype;
        if (!varObj.addressOf) {
            // Children may not have addressOf info yet, try to get it
            await varObj.queryGdbVarInfo(this.gdbInstance).catch(() => {});
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
                this.pvrWriteUpdates = miOutput.resultRecord.result["changelist"];
                const ourUpdate = this.pvrWriteUpdates[0];
                if (BigInt(argValue) !== BigInt(ourUpdate.value)) {
                    throw new Error(`GDB could not confirm an update to '${varObj.evaluateName}' via OpenOCD monitor command`);
                }
                varObj.value = ourUpdate.value;
                response.body = {
                    value: ourUpdate.value,
                    gdbVarName: varObj.gdbVarName,
                    variableObject: varObj.toProtocolVariable(),
                };
                this.sendResponse(response);
                return true;
            } catch (e) {
                this.handleMsg(Stderr, `Error writing memory via OpenOCD monitor command: ${e}\n`);
            }
        }
        return false;
    }

    private async setByGdbVarName(response: SetVariableLiveResponse, varObj: VariableObject, argValue: string): Promise<void> {
        const gdbVarName = varObj.gdbVarName!;
        const cmd = `-var-assign ${gdbVarName} ${argValue}`;
        try {
            const miOutput = await this.gdbInstance!.sendCommand(cmd);
            this.handleMsg(Stderr, `Set variable '${varObj.evaluateName}' (GDB name '${gdbVarName}') to value '${argValue}'\n`);
            const result = miOutput.resultRecord?.result;
            if (result && result["value"]) {
                const newValue = result["value"];
                if (newValue !== argValue) {
                    throw new Error(`GDB could not update value to '${argValue}'`);
                }
                varObj.value = newValue;
                response.body = {
                    value: newValue,
                    gdbVarName: gdbVarName,
                    variableObject: varObj.toProtocolVariable(),
                };
                this.sendResponse(response);
                return;
            } else {
                throw new Error(`No value returned from GDB`);
            }
        } catch (e) {
            if (!(await this.tryWriteViaMonitorCommand(response, varObj, argValue))) {
                this.handleMsg(Stderr, `Error setting variable with GDB name '${gdbVarName}': ${e}\n`);
                throw new Error(`Could not set variable with GDB name '${gdbVarName}': ${e}`);
            }
        }
    }

    public async setVariableRequest(response: SetVariableLiveResponse, args: SetVariableArgumentsLive): Promise<void> {
        let updateDone = false;
        if (this.liveWatchEnabled === false) {
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
                    await this.setByGdbVarName(response, varObj, args.value);
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
        if (this.liveWatchEnabled === false) {
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
                    await this.setByGdbVarName(response, varObj, args.value);
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
        if (this.liveWatchEnabled === false) {
            this.handleErrResponse(response, "Live watch is not enabled (GDB not connected to target)");
            return;
        }
        await this.memoryRequests.readMemoryRequest(response, args);
    }

    public async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
        if (this.liveWatchEnabled === false) {
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
    public async quit() {
        try {
            if (!this.quitting && this.gdbInstance.IsGdbRunning()) {
                this.quitting = true;
                try {
                    // Give GDB a chance to detach nicely, but don't wait forever
                    await this.gdbInstance.sendCommand("-target-disconnect", 100);
                } catch (e) {
                    // Ignore errors
                } finally {
                    await this.gdbInstance.sendCommand("-gdb-exit", 100);
                }
            }
        } catch (e: any) {
            console.error("LiveWatchMonitor.quit", e);
        }
    }
}
