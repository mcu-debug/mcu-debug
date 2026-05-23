import * as readline from "node:readline";
import { ConfigurationArguments } from "../adapter/servers/common";
import { IHostAdapter } from "../common/host-adapter";
import { logger } from "../common/logger";
import { GDBDebugSession } from "../adapter/gdb-session";
import { DebugProtocol } from "@vscode/debugprotocol";
import winston from "winston";

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
    private history: string[] = [];

    constructor(private cliArgs: any, private adapter: IHostAdapter, private config: ConfigurationArguments) {
        // Initialize session driver
        config.debugFlags = undefined as any; // TODO: Remove this line after testing normal flow
        config.liveWatch = undefined as any; // not used in CLI, but some code expects it to exist
        this.gdbLogger = logger.child({ source: 'GDB', color: 'cyan', isConsole: true });
        this.stdoutLogger = logger.child({ source: 'DA', isConsole: true });
        this.stderrLogger = logger.child({ source: 'DA', color: 'red', isConsole: true });
        this.mcuStderrLogger = logger.child({ source: 'DA', color: 'red', isConsole: true });
        this.mcuStdoutLogger = logger.child({ source: 'DA', color: 'orange', isConsole: true });
        this.gdbMiLogger = logger.child({ source: 'GDB-MI', isConsole: true });
    }

    async startSession(cliArgs: any) {
        // Start the debug session with the provided CLI arguments
        logger.info("Starting debug session with arguments:", cliArgs);

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
            return this.sendRequest<DebugProtocol.LaunchResponse>({
                seq: 0,          // overwritten by sendRequest
                type: 'request', // overwritten by sendRequest
                command: (this.config as any)?.type === 'attach' ? 'attach' : 'launch',
                arguments: {
                    noDebug: cliArgs.noDebug,
                    ...this.config,
                } satisfies DebugProtocol.LaunchRequestArguments,
            });
        }).then((launchResponse: DebugProtocol.LaunchResponse) => {
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
            logger.debug(input, { source: 'user-input', skipConsole: true }); // log user input, but not to console to avoid confusion with DA output
            // Handle user input and send it to the debug session
            const continueCommands = ['continue', 'c', 'cont', 'run'];
            if (continueCommands.includes(input.trim().toLowerCase())) {
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
            } else if (input.trim().toLowerCase() === 'pause') {
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
            } else if (input.trim().toLowerCase() === 'exit') {
                this.sendRequest<DebugProtocol.TerminateResponse>({
                    seq: 0,          // overwritten by sendRequest
                    type: 'request', // overwritten by sendRequest
                    command: 'terminate',
                }).then((response) => {
                    if (!response.success) {
                        logger.warn(`Terminate request failed: ${response.message}`);
                    }
                    this.rlPaused?.close();
                    this.rlPaused = null;
                });
            } else {
                const save = this.rlPaused
                // Anything else, we treat as a raw GDB command and send as REPL "evaluateRequest"
                this.sendRequest<DebugProtocol.EvaluateResponse>({
                    seq: 0,          // overwritten by sendRequest
                    type: 'request', // overwritten by sendRequest
                    command: 'evaluate',
                    arguments: {
                        expression: input,
                        context: 'repl',
                    },
                }).then((response) => {
                    if (!response.success) {
                        logger.warn(`Evaluate request failed: ${response.message}`);
                    }
                }).finally(() => {
                    setTimeout(() => {
                        if (this.rlPaused === save) {
                            this.rlPaused?.prompt();
                        }
                    }, 250);
                });
            }
        });

        this.rlPaused.on('history', (history) => {
            this.history = history;
        });

        this.rlPaused.on('SIGINT', () => {
            logger.info('SIGINT ignored while paused. Type "continue" to resume or "exit" to terminate the session.');
        });

        this.rlPaused.on('close', () => {
            // logger.info('Exiting debug session.');
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
        this.rlRunning.on('line', () => { }); // discard any accidental input while running
        this.rlRunning.on('SIGINT', () => {
            logger.info('SIGINT received, sending interrupt to debug session...');
            this.sendRequest<DebugProtocol.PauseResponse>({
                seq: 0,
                type: 'request',
                command: 'pause',
            });
        });
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
                logger.info(`Stopped: ${event.body?.reason}` +
                    (event.body?.description ? ` — ${event.body.description}` : ''));
                this.rlRunning?.close();
                this.rlRunning = null;
                this.startReadlinePaused();
                break;
            case 'continued':
                logger.info('Running');
                this.rlPaused?.close();
                this.rlPaused = null;
                this.startReadlineRunning();
                break;
            case 'terminated':
                logger.info('Session terminated');
                this.rlPaused?.close();
                this.rlPaused = null;
                this.rlRunning?.close();
                this.rlRunning = null;
                process.exit(0);
                break;
            case 'thread':
                // threadId, reason ('started'|'exited') — mostly noise, log at debug
                logger.debug('thread', { threadId: event.body?.threadId, reason: event.body?.reason });
                break;
            case 'output': {
                const body = event.body as DebugProtocol.OutputEvent['body'];
                const output = body?.output ?? '';
                const category = body?.category ?? 'console';
                this.routeOutput(category, output);
                break;
            }
            case 'initialized': break;
            case 'uart-configure': break
            default:
                // Custom events (custom-event-ports-done, SWOConfigure, etc.)
                logger.debug(`event:${event.event}`, { body: event.body });
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
}

