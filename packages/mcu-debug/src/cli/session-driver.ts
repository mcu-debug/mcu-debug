import { ConfigurationArguments } from "../adapter/servers/common";
import { IHostAdapter } from "../common/host-adapter";
import { CliConfigProvider } from "./config-loader";
import { logger } from "../common/logger";
import { GDBDebugSession } from "../adapter/gdb-session";
import { DebugProtocol } from "@vscode/debugprotocol";

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
    private nextSeq = 1;
    // Keyed by the seq we assign to each request; resolved when the matching response arrives.
    private pendingRequests = new Map<number, (response: DebugProtocol.Response) => void>();

    constructor(private cliArgs: any, private adapter: IHostAdapter, private config: ConfigurationArguments) {
        // Initialize session driver
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
        switch (event.event) {
            case 'stopped':
                logger.info(`Debug target stopped: reason=${event.body?.reason}`);
                break;
            case 'output':
                if ((event.body?.category === 'console') || (event.body?.category === 'stdout')) {
                    process.stdout.write(event.body.output);
                } else if (event.body?.category === 'stderr') {
                    process.stderr.write(event.body.output);
                } else {
                    logger.info(`Output event (category=${event.body?.category}): ${event.body?.output}`);
                }
                break;
            case 'terminated':
                logger.info("Debug session terminated.");
                break;
            default:
                logger.warn(`Unhandled DA event: ${event.event}`);
        }
        // TODO: route stopped/output/terminated events to the TUI / headless stream
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

