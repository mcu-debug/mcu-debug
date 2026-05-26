import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { ConfigurationArguments, getNonce, RTTCommonDecoderOpts, RTTConsoleDecoderOpts } from "../adapter/servers/common";
import { IDebugConfiguration, IDebugSession, IHostAdapter } from "../common/host-adapter";
import { CustomTransport, logger } from "../common/logger";
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
    private optionalInfo: winston.Logger;
    private history: string[] = [];
    private isPaused = false;
    private isInternalClose = false; // to distinguish user-initiated vs DA-initiated session close
    private serialManager = new SerialPortManager();
    public debugSession: CDebugSession;
    public status: "not-started" | "starting" | "running" | "paused" | "terminated" = "not-started";

    // Socker server member variables
    private socketPromise: Promise<void> = Promise.resolve(); // used to wait for socket connections
    private serverClients = new Set<net.Socket>();
    private server: net.Server | null = null;
    private socketPath: string | null = null;
    private rtts: CLIRTTTerminal[] = [];

    constructor(private cliArgs: any, private customTransport: CustomTransport, private adapter: IHostAdapter, private config: ConfigurationArguments) {
        // Initialize session driver
        config.debugFlags = undefined as any; // TODO: Remove this line after testing normal flow
        if (config.liveWatch?.enabled) {
            logger.warn("Live watch is not supported in CLI mode. Disabling live watch.", { source: 'DA', isConsole: true });
            delete (config as any).liveWatch;
        }
        if (config.swoConfig?.enabled) {
            logger.warn("SWO is not supported in CLI mode. Disabling SWO.", { source: 'DA', isConsole: true });
            delete (config as any).swoConfig;
        }
        if (config.chainedConfigurations?.enabled) {
            logger.warn("Chained configurations are not supported in CLI mode. Ignoring chained configurations.", { source: 'DA', isConsole: true });
            delete (config as any).chainedConfigurations;
        }
        this.gdbLogger = logger.child({ source: 'GDB', color: 'cyan', isConsole: true });
        this.stdoutLogger = logger.child({ source: 'DA', isConsole: true });
        this.stderrLogger = logger.child({ source: 'DA', color: 'red', isConsole: true });
        this.mcuStderrLogger = logger.child({ source: 'DA', color: 'red', isConsole: true });
        this.mcuStdoutLogger = logger.child({ source: 'DA', color: 'orange', isConsole: true });
        this.gdbMiLogger = logger.child({ source: 'GDB-MI', isConsole: true });
        this.optionalInfo = logger.child({ source: 'DA', skipConsole: cliArgs.debug ? false : true });

        const dbgSession: IDebugSession = {
            id: getNonce(),
            type: "mcu-debug",
            name: this.config.name,
            configuration: this.config,
            customRequest: async (command: string, args?: any) => { }
        };
        this.debugSession = CDebugSession.GetSession(dbgSession, this.config);
    }

    async startSession(cliArgs: any) {
        try {
            await this.startSocketReader();
        } catch (error) {
            logger.error("Failed to start socket reader: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        // Start the debug session with the provided CLI arguments
        logger.info("Starting debug session with arguments:", cliArgs);
        this.status = "starting";

        // Create and start the debug session
        logger.info("Creating debug session...");
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

    private startReadlinePaused() {
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
            this.sendRequest<DebugProtocol.EvaluateResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: 'evaluate',
                arguments: {
                    expression: trimmedInput,
                    context: 'repl',
                },
            }).then((response) => {
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
                this.status = "paused";
                this.optionalInfo.info(`Stopped: ${event.body?.reason}` +
                    (event.body?.description ? ` — ${event.body.description}` : ''));
                this.isInternalClose = true;
                this.rlRunning?.close();
                this.rlRunning = null;
                this.isPaused = true;
                this.startReadlinePaused();
                this.isInternalClose = false;
                break;
            case 'continued':
                this.status = "running";
                this.optionalInfo.info('Running');
                this.isInternalClose = true;
                this.rlPaused?.close();
                this.rlPaused = null;
                this.isPaused = false;
                this.startReadlineRunning();
                this.isInternalClose = false;
                break;
            case 'terminated':
                this.status = "terminated";
                logger.info('Session terminated');
                this.rlPaused?.close();
                this.rlPaused = null;
                this.rlRunning?.close();
                this.rlRunning = null;
                process.exit(0);
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
            case 'initialized': break;
            case "swo-configure":
                // this.receivedSWOConfigureEvent(event);
                break;
            case "rtt-configure":
                handleRTTConfigureEvent(event.body, this.debugSession, (decoder: RTTConsoleDecoderOpts, src: SocketRTTSource) => {
                    this.rtts.push(new CLIRTTTerminal(decoder, src));
                });
                break;
            case 'uart-configure':
                this.serialManager.createSerialPorts(this.config).catch((error) => {
                    logger.error("Failed to create serial ports: " + (error instanceof Error ? error.message : String(error)));
                });
                break;
            default:
                // Custom events (custom-event-ports-done, SWOConfigure, etc.)
                this.optionalInfo.debug(`event:${event.event}`, { body: event.body });
                break;

        }
        // TODO: route stopped/output/terminated events to the TUI / headless stream
    }

    private routeOutput(category: string, output: string): void {
        const text = output.trimEnd();
        if (!text || text === '^done') {
            // this.terminalWrite('\n'); // preserve blank lines, no need to log them
            return;
        }

        if (category === 'stdout' && /^\d+[-~&@^]/.test(output)) {
            // GDB MI command sent by DA (gdbTraces mode) — log structured, never raw to terminal
            this.gdbMiLogger.debug('mi:tx', { mi: text });
            this.terminalWrite(`\x1b[2m[MI>] ${text}\x1b[0m\n`); // dim
            return;
        }

        if (category === 'console' && output.startsWith('-> ')) {
            // GDB MI response received — strip the '-> ' the DA added
            const mi = text.slice(3);
            this.gdbMiLogger.debug('mi:rx', { mi });
            this.terminalWrite(`\x1b[2m[MI<] ${mi}\x1b[0m\n`); // dim
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
            throw new Error(`initialize failed: ${response.message}`);
        }
        logger.info("Debug session initialized. DA capabilities:", response.body);
        return response;
    }

    private createSocketJsonPath() {
        return `${process.cwd()}/.mcu-debug.sock.json`;
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
                        logger.error(`Socket file ${socketJsonPath} already exists and process ${existing.pid} is still running. Is another instance running?`, { source: 'DA', isConsole: true, ...existing });
                    } catch (err) {
                        logger.warn(`Socket file ${socketJsonPath} already exists but process ${existing.pid} is not running. It will be overwritten.`, { source: 'DA', isConsole: true, ...existing });
                    }
                } else {
                    logger.warn(`Socket file ${socketJsonPath} already exists but has unexpected content. It will be overwritten.`, { source: 'DA', isConsole: true, content: existing });
                }
            } catch (err) {
                logger.error(`Socket file ${socketJsonPath} already exists and could not be read. Is another instance running?`, { source: 'DA', isConsole: true });
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
                this.customTransport.addStream(conn);
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
        // Write the socket path to .mcu-debug.sock.json for the Rust side to pick up
        const sockInfo = {
            pid: process.pid,
            socket: socketPath,
            cwd: process.cwd(),
            config: this.config.name,
            startedAt: new Date().toISOString(),
            logFile: this.cliArgs.logFile
        };
        const socketPathJson = `${process.cwd()}/.mcu-debug.sock.json`;
        try {
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

