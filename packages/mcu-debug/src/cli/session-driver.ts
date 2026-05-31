import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { ConfigurationArguments, getNonce, RTTCommonDecoderOpts, RTTConsoleDecoderOpts } from "../adapter/servers/common";
import { CLISessionType, IDebugConfiguration, IDebugSession, IHostAdapter } from "../common/host-adapter";
import { CustomTransport, logger } from "../common/cli-logger";
import { GDBDebugSession } from "../adapter/gdb-session";
import { DebugProtocol } from "@vscode/debugprotocol";
import winston from "winston";
import { SerialPortManager } from "../common/serial-manager";
import { CLIRTTTerminal } from "./cli-rtt";
import { CDebugSession } from "../common/mcu-debug-session";
import { handleRTTConfigureEvent } from "../common/rtt-source";
import { SocketRTTSource } from "../common/swo/sources/socket";
import { CliAdapter } from "./cli-adapter";

/**
 * We are the driver for the gdb-session. It is like we are VSCode asking the DebugAdapter to do something
 * using the DebugAdapter Protocol. We are responsible for starting the session, let the gdb-server and gdb talk
 * and once the session is initialized, we transfer raw gdb inputs and outputs between the terminal and the session.
 *
 * We do have to handle paused/resumed events from the session and also pass along the same from the terminal as
 * requests to the session.
 *
 * In-process wiring
 * -----------------
 * We are NOT using stdio or a TCP socket. The DA runs in-process. Two halves:
 *
 *   Inbound (us → DA):  session.handleMessage({ type: 'request', ... })
 *     ProtocolServer.handleMessage checks msg.type === 'request' and calls dispatchRequest,
 *     which feeds into SeqDebugSession's serialised request queue.
 *
 *   Outbound (DA → us): session.onDidSendMessage(cb)
 *     Every sendResponse / sendEvent call internally calls _send, which fires _sendMessage.
 *     onDidSendMessage is the public face of that emitter.
 *     Registering a listener also sets _isRunningInline() = true, which prevents the
 *     base DebugSession.shutdown() from calling process.exit(0).
 *
 * We track in-flight request promises in pendingRequests keyed by seq so we can await each step.
 */

export class CliSessionDriver {
    private session: GDBDebugSession | null = null;
    private rlPaused: readline.Interface | null = null;
    private rlRunning: readline.Interface | null = null;
    private nextSeq = 1;
    // Keyed by the seq we assign to each request; resolved when the matching response arrives.
    private pendingRequests = new Map<number, (response: DebugProtocol.Response) => void>();
    private gdbLogger: winston.Logger;
    private stdoutLogger: winston.Logger;
    private stderrLogger: winston.Logger;
    private mcuStderrLogger: winston.Logger;
    private mcuStdoutLogger: winston.Logger;
    private gdbMiLogger: winston.Logger;
    private gdbServerLogger: winston.Logger;
    private optionalInfo: winston.Logger;
    private history: string[] = [];
    private isPaused = false;
    private isInternalClose = false; // to distinguish user-initiated vs DA-initiated session close
    private serialManager = new SerialPortManager();
    public debugSession: CDebugSession | null = null;
    public status: CLISessionType = "not-started";
    public bkptSaveFile: string | null = null; // used for restart command to save/restore breakpoints across a full teardown
    private restarting = false; // track whether we're in the middle of a restart to suppress TerminatedEvent during teardown

    // Socker server member variables
    private socketPromise: Promise<void> = Promise.resolve(); // used to wait for socket connections
    private serverClients = new Set<net.Socket>();
    private server: net.Server | null = null;
    private socketPath: string | null = null;
    private rtts: CLIRTTTerminal[] = [];

    constructor(private cliArgs: any, private customTransport: CustomTransport, private adapter: IHostAdapter, private config: ConfigurationArguments) {
        // Initialize session driver
        this.gdbLogger = logger.child({ source: 'GDB', isConsole: true });
        this.stdoutLogger = logger.child({ source: 'DA', isConsole: true });
        this.stderrLogger = logger.child({ source: 'DA', color: 'red', isConsole: true });
        this.mcuStderrLogger = logger.child({ source: 'DA', color: 'red', isConsole: true });
        this.mcuStdoutLogger = logger.child({ source: 'DA', color: 'yellow', isConsole: true });
        this.gdbMiLogger = logger.child({ source: 'GDB-MI', isConsole: true, color: 'blue.dim' });
        this.gdbServerLogger = logger.child({ source: 'GDB-SERVER', isConsole: true, color: 'cyan.dim' });
        this.optionalInfo = logger.child({ source: 'DA', skipConsole: cliArgs.debug ? false : true });
        config.pvtIsCli = true; // inform the DA that we are running in CLI mode

        this.setState("not-started");
    }

    private createCDebugSession() {
        const dbgSession: IDebugSession = {
            id: getNonce(),
            type: "mcu-debug",
            name: this.config.name,
            configuration: this.config,
            customRequest: async (command: string, args?: any) => { }
        };
        this.debugSession = CDebugSession.GetSession(dbgSession, this.config);
    }

    private removeCDebugSession() {
        if (this.debugSession) {
            CDebugSession.RemoveSession(this.debugSession.session);
            this.debugSession = null as any; // we won't use this again, so just null it out to be safe
        }
    }

    private setState(state: CLISessionType, reason?: string) {
        if (this.status === state && state !== "not-started") {
            return;
        }
        this.status = state;
        const infoMsg = `status: ${state}` + (reason ? `: Reason — ${reason}` : '');
        process.stderr.write(infoMsg + os.EOL);
        logger.info(infoMsg, { source: 'DA', skipConsole: true });
    }

    async startSession(cliArgs: any) {
        try {
            if (!this.restarting) {
                await this.startSocketReader();
            }
        } catch (error) {
            this.stderrLogger.error("Failed to start socket reader: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        if (this.config.servertype !== 'external') {
            try {
                await this.startGDBServerConsole("Starting GDB Server console...");
            } catch (error) { }
        }

        this.setupBreakpointsFile(this.getBreakpointsFileName());

        // Start the debug session with the provided CLI arguments
        logger.info("Starting debug session with arguments:", cliArgs);
        this.setState("starting");

        // Create and start the debug session
        logger.info("Creating debug session...");
        this.createCDebugSession();
        this.session = new GDBDebugSession();

        // Wire up the outbound message handler BEFORE any requests are sent.
        // This subscription also sets _isRunningInline() = true, preventing shutdown()
        // from calling process.exit(0) when the session ends.
        this.session.onDidSendMessage((msg) => {
            this.handleOutgoingMessage(msg as DebugProtocol.ProtocolMessage);
        });

        /**
         * DAP sequence for a fresh launch:
         *   1. initialize       → configures capabilities, DA returns its capabilities
         *   2. launch / attach  → starts the debug target
         *   3. configurationDone → signals end of initial configuration (breakpoints etc.)
         *   4. (session runs)
         *   5. disconnect / terminate → ends the session
         *
         * setBreakpoints / setFunctionBreakpoints / setExceptionBreakpoints are no-ops
         * for the CLI and can be skipped.
         */
        this.doInitializeRequest().then(() => {
            logger.info("Initialization complete. Sending launch request...");
            this.config.request = this.config.request === 'attach' ? 'attach' : 'launch'; // guard against invalid request types
            return this.sendRequest<DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: this.config.request,
                arguments: {
                    noDebug: cliArgs.noDebug,
                    ...this.config,
                } satisfies DebugProtocol.LaunchRequestArguments,
            });
        }).then((launchResponse: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse) => {
            if (!launchResponse.success) {
                throw new Error(`Launch failed: ${launchResponse.message}`);
            }
            logger.info("Launch successful. Sending configurationDone...");
            return this.sendRequest<DebugProtocol.ConfigurationDoneResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: 'configurationDone',
            });
        }).then((configDoneResponse: DebugProtocol.ConfigurationDoneResponse) => {
            if (!configDoneResponse.success) {
                throw new Error(`configurationDone failed: ${configDoneResponse.message}`);
            }
            logger.info("Debug session started successfully.");
        }).catch((error: Error | unknown) => {
            logger.error("Failed to start debug session: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        });
    }

    private startGDBServerConsole(message: string): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            const port = await this.adapter.getGdbServerConsolePort();
            const server = net.createServer((socket) => {
                socket.on('data', (data) => {
                    const str = data.toString().trimEnd();
                    if (str) {
                        const prefix = this.config?.servertype ?? 'gdb-server';
                        this.gdbServerLogger.info(`[${prefix}] ${data.toString()}`);
                    }
                });
            });
            server.listen(port, () => {
                resolve();
            });
            server.on('error', (err) => {
                this.mcuStderrLogger.error(`GDB Server console error: ${err.message}`);
                reject(err);
            });
        });
    }

    private startReadlinePaused() {
        if (this.rlPaused) {
            return;
        }
        this.rlPaused = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
            prompt: 'gdb> ',
            historySize: 1000,
            history: this.history || [],
        });

        this.rlPaused.prompt();

        this.rlPaused.on('line', (input: string) => {
            if (!input.trim()) {
                this.rlPaused?.prompt();
                return;
            }
            this.handleInputLinePaused(input, true);
        });

        this.rlPaused.on('history', (history) => {
            this.history = history;
        });

        this.rlPaused.on('SIGINT', () => {
            logger.info('SIGINT ignored while paused. Type "continue" to resume or "exit" to terminate the session.');
        });

        this.rlPaused.on('close', () => {
            // logger.info('Exiting debug session.');
            if (!this.isInternalClose) {
                this.doExit(true);
            }
            this.isInternalClose = false;
        });
    }

    private handleInputLinePaused(input: string, isTerminal: boolean) {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            return;
        }
        logger.debug(input, { source: 'user-input', skipConsole: true }); // log user input, but not to console to avoid confusion with DA output
        // Handle user input and send it to the debug session
        const continueCommands = ['continue', 'c', 'cont', 'run'];
        if (continueCommands.includes(trimmedInput.toLowerCase())) {
            this.sendRequest<DebugProtocol.ContinueResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: 'continue',
                arguments: { threadId: 1 }, // Assuming single-threaded target; adjust as needed
            }).then((response) => {
                if (!response.success) {
                    logger.warn(`Continue request failed: ${response.message}`);
                }
            });
        } else if (this.handleSpecialCommands(trimmedInput, isTerminal)) {
            // Special commands handled
        } else {
            const save = this.rlPaused;
            // Anything else, we treat as a raw GDB command and send as REPL "evaluateRequest"
            this.doReplCommand(trimmedInput).then((response) => {
                if (!response.success) {
                    logger.warn(`Evaluate request failed: ${response.message}`);
                }
            }).finally(() => {
                if (isTerminal) {
                    setTimeout(() => {
                        if (this.rlPaused === save) {
                            this.rlPaused?.prompt();
                        }
                    }, 250);
                }
            });
        }
    }

    /**
     * These commands are special commands that are okay to use in both paused and running states,
     * and don't get sent to the DA as raw GDB commands. They are for controlling the session itself,
     * not the target. Some are not even gdb commands (e.g. reset)
     * @param trimmedInput 
     * @param isTerminal use true for stdin
     * @returns true if handled
     */
    private handleSpecialCommands(trimmedInput: string, isTerminal: boolean): boolean {
        if (trimmedInput === 'pause' || trimmedInput.toLowerCase() === '!!sigint') {
            this.doInterrupt();
            return true;
        } if (trimmedInput === 'reset' || trimmedInput.toLowerCase() === '!!reset') {
            this.sendRequest<DebugProtocol.RestartResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: 'reset-device',
            }).then((response) => {
                if (!response.success) {
                    logger.warn(`Reset request failed: ${response.message}`);
                }
            });
            return true;
        } else if (trimmedInput.toLowerCase() === 'status' || trimmedInput.toLowerCase() === '!!status') {
            this.doStatus();
            return true;
        } else if (trimmedInput.toLowerCase() === 'restart' || trimmedInput.toLowerCase() === '!!restart') {
            this.doRestart(isTerminal);
            return true;
        } else if (trimmedInput.toLowerCase() === 'exit') {
            this.doExit(isTerminal);
            return true;
        } else if (trimmedInput.toLowerCase().startsWith('!!')) {
            // Future meta-commands (!!RESET, !!NOTE:, etc.)
            this.handleMetaCommand(trimmedInput);
            return true;
        }
        return false;
    }

    private async doReplCommand(command: string) {
        return this.sendRequest<DebugProtocol.EvaluateResponse>({
            seq: 0,          // overwritten by sendRequest
            type: 'request',
            command: 'evaluate',
            arguments: {
                expression: command,
                context: 'repl',
            }
        });
    }

    // We will try to save the breakpoints across the restart by saving them to a temp file and asking the DA
    // to restore them after restart. But there are questions about how to do this.
    // Note: we have a limited (small) number of breakpoints the HW allows. So be careful
    // 1. if the user has runToEntryPoint, how is that handled
    // A. These new breakpoints are come after the stop for that happens. This is so we don't burn a breakpoint for the
    //    that. If we set the saved breakpoints after that bkpt is hit, then we save one bkpt for the user. Danger is
    //    if the user bkpts affect pre runToEntryPoint code. But then they should use breakAfterReset.
    // 2. If the does not have runToEntryPoint, then we should set these bkpts at the beginning of the session. Reset time
    //    is the most likely time for bkpts to be lost, so we set them at the beginning and hope they survive the reset.
    private savedPostStartCommands: string[] | undefined;
    private savedPreStartCommands: string[] | undefined;
    private setupBreakpointsFile(file: string) {
        if ((!fs.existsSync(file) || fs.statSync(file).size === 0)) {
            return;
        }
        if (this.config.runToEntryPoint) {
            // Handle runToEntryPoint scenario
            this.savedPostStartCommands = this.config.postStartSessionCommands;
            const existingCommands = this.config.postStartSessionCommands || [];
            this.config.postStartSessionCommands = [...existingCommands, `source ${file}`];
        } else {
            // No runToEntryPoint, set breakpoints at the beginning of the session
            this.savedPreStartCommands = this.config.request === 'attach' ? this.config.preAttachCommands : this.config.preLaunchCommands;
            const existingCommands = this.savedPreStartCommands || [];
            if (this.config.request === 'attach') {
                this.config.preAttachCommands = [...existingCommands, `source ${file}`];
            } else {
                this.config.preLaunchCommands = [...existingCommands, `source ${file}`];
            }
        }
    }

    private undoSetupBreakpointsFile() {
        if (this.savedPostStartCommands) {
            this.config.postStartSessionCommands = this.savedPostStartCommands;
            this.savedPostStartCommands = undefined;
        }
        if (this.savedPreStartCommands) {
            if (this.config.request === 'attach') {
                this.config.preAttachCommands = this.savedPreStartCommands;
            } else {
                this.config.preLaunchCommands = this.savedPreStartCommands;
            }
            this.savedPreStartCommands = undefined;
        }
    }

    private getBreakpointsFileName() {
        if (this.cliArgs.breakpointsFile) {
            return this.cliArgs.breakpointsFile;
        }
        const configNameSafe = this.config.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        return `${process.cwd()}/.mcu-debug/${configNameSafe}.bkpts`;
    }

    // Our DA does not support the 'restart' request , so we do a best-effort emulation by sending
    // 'terminate' followed by a full teardown and re-launch of the session. This is not perfect —
    // we may lose some state that the DA would have preserved across a restart — but it's the best
    // we can do without native support.
    private async doRestart(isTerminal: boolean) {
        const bkptFile = this.getBreakpointsFileName();
        await this.doReplCommand(`save breakpoints ${bkptFile}`);
        for (const rtt of this.rtts) {
            try { rtt.dispose(); } catch (e) { }
        }
        // We don't close the uarts, logfile or socket server because they are shared across sessions are not
        // part of the DA. Actually not doing so provides continuity across the restart and also avoids potential
        // issues with the clients attached to them.
        this.rtts = [];
        this.restarting = true;
        // this.closeLineReaders();
        // While a restart is not officially supported we have some rudimentary support to finish
        // the previous session but not send a 'terminated' event which will exit our program. We kinda
        // approximate what a VSCode like client would do for a restart.
        try {
            await this.sendRequest<DebugProtocol.TerminateResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: 'restart'
            });
        } catch (error) {
            logger.error("Failed to restart session. Terminate failed: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        this.removeCDebugSession();
        this.startSession(this.cliArgs).then(() => {
            this.undoSetupBreakpointsFile();
            this.restarting = false;
        }).catch((error) => {
            throw error;
        });
    }

    private doStatus() {
        // We summarize our current status
        const serialPorts = (this.adapter as CliAdapter).getSerialPortViews().map((port) => {
            const params: any = {
                status: port.getStatus(),
                prefix: port.getPrefix(),
                ...port.serialConfig
            };
            return params;
        });
        const obj: any = {
            'status': this.status,
            'cwd': process.cwd(),
            'pid': process.pid,
            'targetCwd': this.config.cwd,
            'configName': this.config.name,
            'serverType': this.config.servertype,
            'configType': this.config.request,
            'rtts': this.rtts.map(rtt => ({
                status: rtt.getStatus(), prefix: rtt.getPrefix(),
                tcpPort: rtt.options.tcpPort, channel: rtt.options.port, type: rtt.options.type,
            })),
            'serialPorts': serialPorts,
            'socketPath': this.socketPath,
            'logFile': this.cliArgs.logFile,
        };
        logger.info(`Session summary: ${JSON.stringify(obj, null, 2)}`);
    }

    private doExit(isTerminal: boolean) {
        this.sendRequest<DebugProtocol.TerminateResponse>({
            seq: 0,          // overwritten by sendRequest
            type: 'request', // overwritten by sendRequest
            command: 'terminate',
        }).then((response) => {
            if (!response.success) {
                logger.warn(`Terminate request failed: ${response.message}`);
            }
            if (isTerminal) {
                this.rlPaused?.close();
                this.rlPaused = null;
            }
        });
    }

    private doInterrupt() {
        this.sendRequest<DebugProtocol.PauseResponse>({
            seq: 0,          // overwritten by sendRequest
            type: 'request', // overwritten by sendRequest
            command: 'pause',
            arguments: { threadId: 1 }, // Assuming single-threaded target; adjust as needed
        }).then((response) => {
            if (!response.success) {
                logger.warn(`Pause request failed: ${response.message}`);
            }
        });
    }

    private startReadlineRunning() {
        if (this.rlRunning) {
            return;
        }
        this.rlRunning = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });
        // Don't call pause() — a paused readline won't read stdin and won't detect Ctrl-C.
        // When terminal:true puts stdin in raw mode, ISIG is cleared so the OS no longer
        // generates SIGINT for Ctrl-C; readline must read the \x03 byte itself to emit 'SIGINT'.
        this.rlRunning.on('line', (input) => {
            this.handleInputLineRunning(input, true);
        }); // discard any accidental input while running
        this.rlRunning.on('SIGINT', () => {
            logger.info('SIGINT received, sending interrupt to debug session...');
            this.sendRequest<DebugProtocol.PauseResponse>({
                seq: 0,
                type: 'request',
                command: 'pause',
            });
        });
        this.rlRunning.on('close', () => {
            // logger.info('Exiting debug session.');
            if (!this.isInternalClose) {
                this.doExit(true);
            }
            this.isInternalClose = false;
        });
    }

    private handleInputLineRunning(input: string, isTerminal: boolean) {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            return;
        }
        if (this.handleSpecialCommands(trimmedInput, isTerminal)) {
            return;
        }
    }

    /**
     * Dispatch one request into the DA and return a Promise that resolves with the response.
     * We use handleMessage() (public on ProtocolServer) so the call goes through the normal
     * dispatch path including SeqDebugSession's serialised queue.
     *
     * The Promise always resolves — it never rejects — because the DA always calls sendResponse
     * (even on errors, via sendErrorResponse which sets success=false). Callers must inspect
     * response.success themselves. Two patterns:
     *
     *   Unrecoverable (e.g. initialize):
     *     const r = await this.sendRequest(...);
     *     if (!r.success) throw new Error(`initialize failed: ${r.message}`);
     *
     *   Recoverable (e.g. setBreakpoints):
     *     const r = await this.sendRequest(...);
     *     if (!r.success) { logger.warn(...); return; }
     */
    private sendRequest<T extends DebugProtocol.Response>(req: DebugProtocol.Request): Promise<T> {
        const seq = this.nextSeq++;
        req.seq = seq;
        req.type = 'request';
        // TODO(Ctrl-C): No timeout is applied here. Some operations (e.g. flash write) take 30+ seconds
        // on real hardware, so a fixed timeout would produce false positives. Hung gdb-servers are
        // handled via a future SIGINT handler that calls gdbMiCommands.sendInterrupt(), and escalates
        // to killing the gdb-server process via serverSession if MI stays silent. The pendingRequests
        // map tells the handler what DAP request is currently in-flight.
        return new Promise<T>((resolve) => {
            this.pendingRequests.set(seq, resolve as (r: DebugProtocol.Response) => void);
            this.session!.handleMessage(req);
        });
    }

    /** Routes every outgoing message (responses + events) from the DA to the right handler. */
    private handleOutgoingMessage(msg: DebugProtocol.ProtocolMessage): void {
        if (msg.type === 'response') {
            const response = msg as DebugProtocol.Response;
            const resolve = this.pendingRequests.get(response.request_seq);
            if (resolve) {
                this.pendingRequests.delete(response.request_seq);
                resolve(response);
            }
        } else if (msg.type === 'event') {
            this.handleEvent(msg as DebugProtocol.Event);
        }
    }

    /** Handle events emitted by the DA (stopped, output, terminated, etc.). */
    private handleEvent(event: DebugProtocol.Event): void {
        if (event.event.startsWith('custom')) {
            // Custom events are for DA → CLI communication, not user-facing. Log at debug.
            // TODO: Handle these later. We are only interested in a few
            return;
        }
        switch (event.event) {
            case 'stopped':
                const reason = `${event.body?.reason}` + (event.body?.description ? ` — ${event.body.description}` : '');
                this.setState("paused", reason);
                this.isInternalClose = true;
                this.rlRunning?.close();
                this.rlRunning = null;
                this.isPaused = true;
                this.startReadlinePaused();
                this.isInternalClose = false;
                break;
            case 'continued':
                this.setState("running");
                this.isInternalClose = true;
                this.rlPaused?.close();
                this.rlPaused = null;
                this.isPaused = false;
                this.startReadlineRunning();
                this.isInternalClose = false;
                break;
            case 'terminated':
                if (!this.restarting) {
                    this.setState("terminated");
                    this.closeLineReaders();
                    process.exit(0);
                }
                break;
            case 'thread':
                // threadId, reason ('started'|'exited') — mostly noise, log at debug
                this.optionalInfo.debug('thread', { threadId: event.body?.threadId, reason: event.body?.reason });
                break;
            case 'output': {
                const body = event.body as DebugProtocol.OutputEvent['body'];
                const output = body?.output ?? '';
                const category = body?.category ?? 'console';
                this.routeOutput(category, output);
                break;
            }
            case 'initialized':
                this.setState("initialized");
                setTimeout(() => {
                    if (this.status === "initialized" && this.session) {
                        if (this.session.isRunning()) {
                            this.setState("running");
                            this.startReadlineRunning();
                        } else {
                            this.setState("paused");
                            this.startReadlinePaused();
                        }
                    }
                }, 2000);
                break;
            case "swo-configure":
                // this.receivedSWOConfigureEvent(event);
                break;
            case "rtt-configure":
                handleRTTConfigureEvent(event.body, this.debugSession!, (decoder: RTTConsoleDecoderOpts, src: SocketRTTSource) => {
                    this.rtts.push(new CLIRTTTerminal(decoder, src));
                });
                break;
            case 'uart-configure':
                this.serialManager.createSerialPorts(this.config).catch((error) => {
                    this.stderrLogger.error("Failed to create serial ports: " + (error instanceof Error ? error.message : String(error)));
                });
                break;
            default:
                // Custom events (custom-event-ports-done, SWOConfigure, etc.)
                this.optionalInfo.debug(`event:${event.event} `, { body: event.body });
                break;

        }
        // TODO: route stopped/output/terminated events to the TUI / headless stream
    }

    private closeLineReaders() {
        this.rlPaused?.close();
        this.rlPaused = null;
        this.rlRunning?.close();
        this.rlRunning = null;
    }

    private routeOutput(category: string, output: string): void {
        const text = output.trimEnd();
        if (!text || text === '^done') {
            // this.terminalWrite('\n'); // preserve blank lines, no need to log them
            return;
        }

        if (category === 'stdout' && /^\d+[-~&@^]/.test(output)) {
            // GDB MI command sent by DA (gdbTraces mode) — log structured, never raw to terminal
            this.gdbMiLogger.debug(`mi: tx[MI >] ${text} `);
            return;
        }

        if (category === 'console' && output.startsWith('-> ')) {
            // GDB MI response received — strip the '-> ' the DA added
            const mi = text.slice(3);
            this.gdbMiLogger.debug(`mi: rx[MI <] ${mi} `);
            return;
        }

        if (category === 'stderr') {
            // DA internal messages — strip the well-known prefixes
            const prefix1 = 'mcu-debug stderr: ';
            const prefix2 = 'mcu-debug: ';
            if (output.startsWith(prefix1)) {
                const logLine = output.slice(prefix1.length).trimEnd();
                this.mcuStderrLogger.info(logLine);
            } else if (output.startsWith(prefix2)) {
                const logLine = output.slice(prefix2.length).trimEnd();
                this.mcuStdoutLogger.info(logLine);
            } else {
                this.stderrLogger.info(text);
            }
            return;
        }

        if (text.startsWith('\r') && !text.startsWith('\r[100')) {
            this.terminalWrite(text); // overwrite current line (e.g. progress updates) — no need to log
            return;
        }
        // category === 'console' without '-> ': real GDB console output the user should see
        // category === 'stdout' without MI token: target stdout (rare on embedded but handle it)
        if (category === 'console') {
            this.gdbLogger.info(text);
        } else {
            this.stdoutLogger.info(text);
        }
    }

    private terminalWrite(data: string): void {
        process.stdout.write(data);
    }

    async doInitializeRequest(): Promise<DebugProtocol.InitializeResponse> {
        logger.info("Sending initialize request...");
        const response = await this.sendRequest<DebugProtocol.InitializeResponse>({
            seq: 0,          // overwritten by sendRequest
            type: 'request', // overwritten by sendRequest
            command: 'initialize',
            arguments: {
                clientID: 'mcu-debug-cli',
                adapterID: 'mcu-debug',
                pathFormat: 'path',
                linesStartAt1: true,
                columnsStartAt1: true,
                supportsVariableType: true,
                supportsVariablePaging: true,
                supportsRunInTerminalRequest: false,
            } satisfies DebugProtocol.InitializeRequestArguments,
        });
        // initialize is unrecoverable — throw so the caller's session setup aborts cleanly.
        if (!response.success) {
            throw new Error(`initialize failed: ${response.message} `);
        }
        logger.debug("Debug session initialized. DA capabilities:", response.body);
        return response;
    }

    private createSocketJsonPath() {
        return `${process.cwd()} /.mcu-debug/socket.json`;
    }

    private checkSocketFree() {
        const socketJsonPath = this.createSocketJsonPath();
        if (fs.existsSync(socketJsonPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(socketJsonPath, 'utf-8'));
                if (existing && existing.pid) {
                    // Check if the process is still running
                    try {
                        process.kill(existing.pid, 0); // signal 0 doesn't actually kill, just checks if it exists
                        logger.error(`Socket file ${socketJsonPath} already exists and process ${existing.pid} is still running.Is another instance running ? `, { source: 'DA', isConsole: true, ...existing });
                    } catch (err) {
                        logger.warn(`Socket file ${socketJsonPath} already exists but process ${existing.pid} is not running.It will be overwritten.`, { source: 'DA', isConsole: true, ...existing });
                    }
                } else {
                    logger.warn(`Socket file ${socketJsonPath} already exists but has unexpected content.It will be overwritten.`, { source: 'DA', isConsole: true, content: existing });
                }
            } catch (err) {
                logger.error(`Socket file ${socketJsonPath} already exists and could not be read.Is another instance running ? `, { source: 'DA', isConsole: true });
            }
        }
    }

    // In session-driver.ts — to be implemented when Node socket is wired up
    private startSocketReader(): Promise<void> {
        this.checkSocketFree();
        const socketPath = `${os.tmpdir()}/.mcu-debug-${process.pid}.sock`;
        let timeout: NodeJS.Timeout | null = null;
        this.socketPromise = new Promise((resolve, reject) => {
            this.server = net.createServer((conn) => {
                const rl = readline.createInterface({ input: conn });
                rl.on('line', (line) => {
                    if (this.isPaused) {
                        this.handleInputLinePaused(line, false);
                    } else {
                        this.handleInputLineRunning(line, false);
                    }
                });
                if (this.cliArgs.waitForClient && this.serverClients.size == 0) {
                    // First client connected, resolve the promise to let session setup continue
                    resolve();
                    if (timeout) clearTimeout(timeout!);
                }
                // Also pipe mux output back to this connection
                this.serverClients.add(conn);
                this.customTransport.addStream(conn, socketPath);
                conn.on('close', () => this.serverClients.delete(conn));
            });
            this.server.listen(socketPath, () => {
                this.socketPath = socketPath;
                this.writeSockFile(socketPath);  // triggers Rust's wait_for_sock_file()
                logger.info(`Socket server listening on ${socketPath}`, { source: 'DA', isConsole: true });
                if (!this.cliArgs.waitForClient) {
                    resolve();
                } else {
                    timeout = setTimeout(() => {
                        if (timeout && this.serverClients.size === 0) {
                            logger.error('waitForClient is true but no client connected within timeout. Is the client side running and configured correctly?', { source: 'DA', isConsole: true });
                        }
                        timeout = null;
                    }, 5000); // arbitrary timeout to catch listen() failures in waitForClient mode
                }
                process.on('exit', () => {
                    if (this.server) {
                        this.server.close();
                    }
                });
            });
            this.server.on('error', (err) => {
                logger.error(`Socket server error: ${err instanceof Error ? err.message : String(err)}`, { source: 'DA', isConsole: true });
                reject(err);
            });
        });
        return this.socketPromise;
    }
    private handleMetaCommand(cmd: string) {
        // Handle future meta-commands from the Rust side (e.g. !!RESET, !!NOTE:, etc.)
        logger.info(`Unhandled meta-command from clients: ${cmd}`, { source: 'DA', isConsole: true });
    }

    private writeSockFile(socketPath: string) {
        // Write the socket path to .mcu-debug/socket.json for the Rust side to pick up
        const sockInfo = {
            pid: process.pid,
            socket: socketPath,
            cwd: process.cwd(),
            config: this.config.name,
            startedAt: new Date().toISOString(),
            logFile: this.cliArgs.logFile
        };
        const socketPathJson = `${process.cwd()}/.mcu-debug/socket.json`;
        try {
            fs.mkdirSync(`${process.cwd()}/.mcu-debug`, { recursive: true });
            fs.writeFileSync(socketPathJson, JSON.stringify(sockInfo, null, 2));
        } catch (err) {
            logger.error(`Failed to write socket file ${socketPathJson}: ${err instanceof Error ? err.message : String(err)}`, { source: 'DA', isConsole: true });
            if (this.cliArgs.waitForClient) {
                process.exit(1); // Rust side will detect absence of socket file and wait, so we can exit cleanly here and let Rust restart us when ready
            }
            return;
        }
        logger.info(`Socket path written to ${socketPathJson}`, { source: 'DA', isConsole: true });
        process.on('exit', () => {
            try {
                this.server?.close();
                fs.unlinkSync(socketPathJson);
                try { fs.unlinkSync(socketPath); } catch (err) { } // also clean up the socket file itself
                logger.info(`Cleaned up socket file ${socketPathJson}`, { source: 'DA', isConsole: true });
            } catch (err) {
                logger.warn(`Failed to clean up socket file ${socketPathJson}: ${err instanceof Error ? err.message : String(err)}`, { source: 'DA', isConsole: true });
            }
        });
    }
}

