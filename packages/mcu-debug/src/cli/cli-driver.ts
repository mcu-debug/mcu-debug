import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import find from "find-process";
import { ConfigurationArguments, RTTConsoleDecoderOpts } from "../adapter/servers/common";
import { CLISessionType, IDebugConfiguration, IDebugSession, IHostAdapter } from "../common/host-adapter";
import { CustomTransport, logger } from "../common/logger";
import { GDBDebugSession } from "../adapter/gdb-session";
import { DebugProtocol } from "@vscode/debugprotocol";
import winston from "winston";
import { SerialPortManager } from "../common/serial-manager";
import { CLIRTTTerminal } from "./cli-rtt";
import { CDebugSession } from "../common/cli-session";
import { handleRTTConfigureEvent } from "../common/rtt-source";
import { SocketRTTSource } from "../common/swo/sources/socket";
import { CliAdapter } from "./cli-adapter";
import { generateNonce, LineSplitter } from "@mcu-debug/shared";
import { NotesManager } from "./notes";
import { CliTelemetry } from "../analytics/telemetry-cli";

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

/** Where a line of input came from. Interactive-ness is separate: that is `isTTY`, and only for stdin. */
type InputSource = "stdin" | "socket" | "script";
interface QueuedLine {
    line: string;
    source: InputSource;
}

export class CliSessionDriver {
    private session: GDBDebugSession | null = null;
    private rl: readline.Interface | null = null;
    private inRedraw = false;
    private stdoutWriteOrig: typeof process.stdout.write | null = null;
    private stderrWriteOrig: typeof process.stderr.write | null = null;
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
    // Input queue: see submitLine()
    private inputQueue: QueuedLine[] = [];
    private draining = false;
    private inputOpen = false; // closed until the session has settled (see openInputWhenSettled), and again during a restart
    private configDoneSeen = false;
    private postInitializedSeen = false;
    private stopCount = 0; // number of `stopped` events so far, so a batch can wait for the next one
    private stopWaiters: Array<() => void> = [];
    private stdinEnded = false;
    private scriptQueued = false;
    private batchAborted = false;
    private batchFinished = false;
    private exitCode = 0;
    private serialManager = new SerialPortManager();
    public debugSession: CDebugSession | null = null;
    public status: CLISessionType = "not-started";
    public bkptSaveFile: string | null = null; // used for restart command to save/restore breakpoints across a full teardown
    private restarting = false; // track whether we're in the middle of a restart to suppress TerminatedEvent during teardown
    private serverConsole: net.Server | null = null;
    private notesManager: NotesManager;
    private telemetryId = generateNonce(); // anonymous per-invocation id for the offline queue

    // Socker server member variables
    private socketPromise: Promise<void> = Promise.resolve(); // used to wait for socket connections
    private serverClients = new Set<net.Socket>();
    private server: net.Server | null = null;
    private socketPath: string | null = null;
    private rtts: CLIRTTTerminal[] = [];

    constructor(
        private cliArgs: any,
        private customTransport: CustomTransport,
        private adapter: IHostAdapter,
        private config: ConfigurationArguments,
    ) {
        // Initialize session driver
        this.gdbLogger = logger.child({ source: "GDB", isConsole: true });
        this.stdoutLogger = logger.child({ source: "DA", isConsole: true });
        this.stderrLogger = logger.child({ source: "DA", color: "red", isConsole: true });
        this.mcuStderrLogger = logger.child({ source: "DA", color: "red", isConsole: true });
        this.mcuStdoutLogger = logger.child({ source: "DA", color: "yellow", isConsole: true });
        this.gdbMiLogger = logger.child({ source: "GDB-MI", isConsole: true, color: "blue.dim" });
        this.gdbServerLogger = logger.child({ source: "GDB-SERVER", isConsole: true, color: "cyan" });
        this.optionalInfo = logger.child({ source: "DA", skipConsole: cliArgs.debug ? false : true });
        config.pvtIsCli = true; // inform the DA that we are running in CLI mode
        config.pvtCliOptions = { ...cliArgs }; // pass along CLI options to the DA via the config
        this.notesManager = new NotesManager(this.customTransport.timeCreated);

        // This is already routed to the CLI, no need to also route it terminal again
        this.config.routeGdbServerOutputToDebugConsole = false;

        process.on("exit", () => {
            this.dispose();
        });

        // Parked in ~/.mcu-debug/telemetry.json; the VS Code extension flushes it later (honoring
        // opt-out at flush time). Records the shape of this config only — see telemetry-core.ts.
        CliTelemetry.beginSession(this.telemetryId, this.config);

        this.setState("not-started");
    }

    private createCDebugSession() {
        const dbgSession: IDebugSession = {
            id: generateNonce(),
            type: "mcu-debug",
            name: this.config.name,
            configuration: this.config,
            customRequest: async (command: string, args?: any) => {},
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
        const infoMsg = `status: ${state}` + (reason ? `: Reason — ${reason}` : "");
        if (!this.isTTY) {
            process.stderr.write(infoMsg + os.EOL);
        }
        // `status`/`reason` ride along as structured meta so consumers (AI agents reading the
        // JSON stream) never have to regex `infoMsg`. Only isConsole/color/skipConsole are
        // stripped before format.json(), so these survive as top-level fields on the log line.
        // `infoMsg` stays as-is for humans reading stderr/TUI — do not make it the contract.
        logger.info(infoMsg, { source: "DA", status: state, reason: reason ?? "", skipConsole: true });
    }

    async startSession(cliArgs: any) {
        // Nobody would be flying: stdin cannot be the pilot and no client is expected either.
        // Refuse now, before the gdb-server is launched and has to be torn down again.
        if (!this.restarting && !this.stdinIsPilot && !this.cliArgs.waitForClient && !(this.cliArgs.batch && this.cliArgs.script)) {
            const msg =
                "stdin is closed and no client can connect, so nothing would be able to control this session.\n" +
                "Use --wait-for-client (and --nostdin if you are backgrounding this process) to drive it over the socket.";
            process.stderr.write(msg + os.EOL);
            logger.error(msg.replace(/\n/g, " "), { source: "DA" });
            process.exit(1);
        }

        // Open serial ports first — before the gdb-server or GDB start, and before the target has run —
        // so nothing the firmware prints is lost. This used to wait for the adapter's `uart-configure`
        // event, which only arrived once GDB had connected and so raced the firmware. Not awaited: a slow
        // port must not hold up the session, and one that fails to open must not end it. A JSON copy,
        // because `createSerialPorts` edits its argument synchronously and `this.config` is about to be
        // sent as the launch request.
        this.serialManager.createSerialPorts(JSON.parse(JSON.stringify(this.config))).catch((error) => {
            this.stderrLogger.error("Failed to create serial ports: " + (error instanceof Error ? error.message : String(error)));
        });

        if (!this.restarting && this.cliArgs.batch && !(this.stdinIsPilot && process.stdin.isTTY)) {
            // Readline only sees Ctrl-C when it is reading a terminal, and the default would kill
            // us without releasing the probe. Do what gdb does instead: the first one interrupts a
            // running target (unblocking a waiting `continue`), one while halted ends the session.
            process.on("SIGINT", () => {
                if (this.isPaused) {
                    this.batchAborted = true;
                    this.exitCode = 1;
                    this.doExit(true);
                } else {
                    logger.info("SIGINT received, sending interrupt to debug session...");
                    this.doInterrupt();
                }
            });
        }

        try {
            if (!this.restarting) {
                await this.startSocketReader();
            }
        } catch (error) {
            this.stderrLogger.error("Failed to start socket reader: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        if (this.config.servertype !== "external") {
            try {
                await this.startGDBServerConsole("Starting GDB Server console...");
            } catch (error) {}
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
        this.doInitializeRequest()
            .then(() => {
                logger.debug("Initialization complete. Sending launch request...");
                this.config.request = this.config.request === "attach" ? "attach" : "launch"; // guard against invalid request types
                return this.sendRequest<DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse>({
                    seq: 0, // overwritten by sendRequest
                    type: "request", // overwritten by sendRequest
                    command: this.config.request,
                    arguments: {
                        noDebug: cliArgs.noDebug,
                        ...this.config,
                    } satisfies DebugProtocol.LaunchRequestArguments,
                });
            })
            .then((launchResponse: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse) => {
                if (!launchResponse.success) {
                    throw new Error(`Launch failed: ${launchResponse.message}`);
                }
                logger.debug("Launch successful. Sending configurationDone...");
                return this.sendRequest<DebugProtocol.ConfigurationDoneResponse>({
                    seq: 0, // overwritten by sendRequest
                    type: "request", // overwritten by sendRequest
                    command: "configurationDone",
                });
            })
            .then((configDoneResponse: DebugProtocol.ConfigurationDoneResponse) => {
                if (!configDoneResponse.success) {
                    throw new Error(`configurationDone failed: ${configDoneResponse.message}`);
                }
                logger.debug("Debug session started successfully.");
                if (!(this.cliArgs.batch && this.scriptQueued)) {
                    // Not twice in a batch: a `restart` in the script would queue it again, forever.
                    this.runScript(cliArgs.script);
                }
                this.scriptQueued = true;
                this.configDoneSeen = true;
                this.openInputWhenSettled();
            })
            .catch((error: Error | unknown) => {
                logger.error("Failed to start debug session: " + (error instanceof Error ? error.message : String(error)));
                process.exit(1);
            });
    }

    private runScript(script?: string) {
        if (!script) {
            return;
        }
        // Implement the logic to run the GDB script here
        let scriptContent = "";
        try {
            scriptContent = fs.readFileSync(script, "utf-8");
            // Execute the GDB script content here
        } catch (error) {
            logger.error("Failed to run script: " + (error instanceof Error ? error.message : String(error)));
            if (this.cliArgs.batch) {
                this.exitCode = 1; // the batch has nothing to run; say so in the exit status
            }
            return;
        }
        // Split on either line ending. Unlike the readline-based stdin and socket readers, this
        // path would otherwise leave a \r on every line of a CRLF file, and commands that take
        // their arguments verbatim (!!send) would pass it through to the target.
        const lines = scriptContent.split(/\r?\n/).filter((line) => line.trim());
        // Ahead of anything stdin or a socket queued while the session was starting: the script
        // runs "after startup", before anyone else gets a turn.
        this.inputQueue.unshift(...lines.map((line): QueuedLine => ({ line, source: "script" })));
    }

    private startGDBServerConsole(message: string): Promise<void> {
        if (this.serverConsole) {
            return Promise.resolve();
        }
        return new Promise<void>(async (resolve, reject) => {
            const port = await this.adapter.getGdbServerConsolePort();
            const server = net.createServer((socket) => {
                const prefix = this.config?.servertype ?? "gdb-server";
                const splitter = new LineSplitter(
                    (line: string, prefix: string, partial: boolean) => {
                        this.gdbServerLogger.info(`[${prefix}] ${line}`);
                    },
                    prefix,
                    500,
                );
                socket.on("data", (data) => {
                    splitter.write(data.toString());
                });
                socket.on("end", () => {
                    splitter.end();
                });
            });
            // Loopback, explicitly -- matching `server-console.ts`, which is the frontend's
            // equivalent of this console. `listen(port)` with no host binds 0.0.0.0 and would
            // expose the gdb-server's stdio stream to the network.
            server.listen(port, "127.0.0.1", () => {
                this.serverConsole = server;
                resolve();
            });
            server.on("error", (err) => {
                this.mcuStderrLogger.error(`GDB Server console error: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Create the single readline interface the first time it is needed.
     * Subsequent calls are no-ops — the same interface is reused for the
     * entire session lifetime so partial input and history survive
     * paused ↔ running state transitions.
     */
    private ensureReadline() {
        if (this.rl) {
            return;
        }
        if (!this.stdinIsPilot) {
            // Either the caller passed --nostdin, or stdin was already at EOF when we started.
            // Do not open a reader: with --nostdin, reading the controlling terminal from a
            // backgrounded process raises SIGTTIN and suspends us, and no probe can detect that
            // intent. The socket is flying this session.
            return;
        }
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: !!process.stdin.isTTY,
            prompt: "gdb> ",
            historySize: 1000,
            history: this.history || [],
        });

        // Single line handler — dispatches based on current session state.
        this.rl.on("line", (input: string) => {
            this.submitLine(input, "stdin");
        });

        this.rl.on("history", (history) => {
            this.history = history;
        });

        // Single SIGINT handler — behaviour depends on current session state.
        this.rl.on("SIGINT", () => {
            if (this.isPaused) {
                logger.info('SIGINT ignored while paused. Type "continue" to resume or "exit" to terminate the session.');
            } else {
                logger.info("SIGINT received, sending interrupt to debug session...");
                this.doInterrupt();
            }
        });

        this.rl.on("close", () => {
            // We only ever open a reader when stdin is the pilot, so its EOF ends the session --
            // even if an AI is attached over the socket. The AI is the copilot; it does not
            // inherit the controls when the human walks away. A deliberate handoff is expressed
            // at launch with --wait-for-client --nostdin, not by closing a terminal.
            //
            // Except in batch mode, where end of input only means there is nothing more to queue:
            // the session ends once the queue has run dry, as `gdb -batch` does.
            if (!this.isInternalClose) {
                if (this.cliArgs.batch) {
                    this.stdinEnded = true;
                    this.maybeFinishBatch();
                } else {
                    this.doExit(true);
                }
            }
            this.isInternalClose = false;
        });

        this.installStdoutProxy();
        this.installStderrProxy();
    }

    /**
     * Re-render the prompt and partial input after async output has overwritten it.
     *
     * Prefers the private `_refreshLine()` method (stable since Node v0.4, used by
     * inquirer/ora/listr2) because it handles edge cases like multi-line wrapping and
     * ANSI prompt widths correctly.  Falls back to a public-API reconstruction using
     * the documented `rl.line` and `rl.cursor` getters (stable since Node v0.1.98)
     * so the feature degrades gracefully if Node ever removes the private method.
     */
    private refreshLine(): void {
        if (!this.rl) {
            return;
        }
        if (typeof (this.rl as any)._refreshLine === "function") {
            (this.rl as any)._refreshLine();
        } else {
            // Public-API fallback: replicate what _refreshLine does.
            // This does not handle multi-line prompts or inputs or escape sequences, but it's better than
            // leaving the prompt blank with no input after every async log.
            const prompt: string = this.rl.getPrompt();
            const line: string = this.rl.line ?? "";
            const cursor: number = this.rl.cursor ?? 0;
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(prompt + line);
            if (cursor < line.length) {
                readline.cursorTo(process.stdout, prompt.length + cursor);
            }
        }
    }

    /** True only when stdin is an interactive terminal. */
    private get isTTY(): boolean {
        return !!process.stdin.isTTY;
    }

    /**
     * True when stdin was already at EOF as this process started — `< /dev/null` on POSIX,
     * `< NUL` on Windows, or no fd 0 at all.
     *
     * The `isCharacterDevice()` gate is what makes the probe safe. A blocking `readSync` on fd 0
     * would consume a byte from a pipe that has data, and would *block indefinitely* on a pipe
     * that does not have data yet — which is exactly how the TUI runs us (spawn.rs gives node a
     * piped stdin). Pipes and files are FIFO/FILE and never reach the read; only a non-TTY
     * character device does, and there the read returns 0 immediately.
     */
    private startedWithNoStdin(): boolean {
        if (process.stdin.isTTY) {
            return false; // A terminal is real stdin.
        }
        let st: fs.Stats;
        try {
            st = fs.fstatSync(0);
        } catch (e) {
            return true; // No fd 0 at all.
        }
        if (!st.isCharacterDevice()) {
            return false; // FIFO or regular file: real stdin, never probe it.
        }
        if (process.platform !== "win32") {
            // Compare device ids rather than reading. /dev/zero and /dev/urandom are also non-TTY
            // character devices, and a read would consume a byte from them; /dev/null has a
            // distinct rdev, so this answers the question without touching the stream at all.
            try {
                return st.rdev === fs.statSync("/dev/null").rdev;
            } catch (e) {
                // Fall through to the read below.
            }
        }
        // Windows NUL, and the fallback if /dev/null could not be stat'd. NUL is always at EOF,
        // so this reads zero bytes and consumes nothing.
        try {
            return fs.readSync(0, Buffer.alloc(1), 0, 1, null) === 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Who owns this session's lifetime, decided once at startup and never changed.
     *
     * Two people can be in the cockpit — a human on stdin and an AI on the socket — but only one
     * is flying. Deciding that up front is what keeps the session from being orphaned: if
     * ownership could move at runtime (say, to whoever is still connected), a human closing their
     * terminal would silently promote the AI without telling it, and when the AI also left,
     * nothing would be left to shut the session down or release the probe.
     *
     * stdin is the pilot whenever it is a usable control channel. Otherwise the socket is, and
     * stdin is never read at all.
     */
    private stdinIsPilotCached: boolean | undefined;
    private get stdinIsPilot(): boolean {
        if (this.stdinIsPilotCached === undefined) {
            // startedWithNoStdin() stats fd 0, so evaluate it once and remember the answer.
            // `--batch --script` takes its commands from the script alone, as `gdb -batch -x` does.
            const scriptIsTheBatch = !!this.cliArgs.batch && !!this.cliArgs.script;
            this.stdinIsPilotCached = !this.cliArgs.nostdin && !scriptIsTheBatch && !this.startedWithNoStdin();
        }
        return this.stdinIsPilotCached;
    }

    /**
     * Set once the first socket client connects. Distinguishes "waiting for the first client",
     * where zero clients is normal, from "the last client left", where in socket-pilot mode
     * nobody is flying any more.
     */
    private hasEverHadClient = false;
    private clientSeq = 0; // distinguishes socket clients in the log transport's stream map

    /**
     * Update the prompt string and redraw the input line in place.
     * Called whenever the session transitions between paused and running.
     * Because we keep one rl instance, the user's partial input is preserved.
     */
    private setReadlineState(paused: boolean) {
        this.ensureReadline();
        if (!this.isTTY || !this.rl) {
            return; // TUI / VS Code panel — no prompt, no redraw needed; or stdin is not being read
        }
        this.rl!.setPrompt(paused ? "gdb> " : "");
        if (paused) {
            // Redraws prompt + any partial input already in the buffer.
            this.rl!.prompt(true);
        } else {
            // Clear the prompt glyph but leave any partial input visible.
            if (this.isTTY) {
                this.refreshLine();
            }
        }
    }

    /**
     * Wrap process.stdout.write so that any async output (RTT, UART, DA events)
     * printed while a gdb> prompt is showing:
     *   1. Erases the current prompt+partial-input line.
     *   2. Prints the output.
     *   3. Redraws prompt+partial-input via readline's internal _refreshLine.
     *
     * This keeps the user's partial command intact and visible after every
     * async write, regardless of source (logger, RTT, UART socket, etc.).
     */
    private installStdoutProxy() {
        if (!this.isTTY) {
            return; // TUI / VS Code panel — stdout is a pipe, no prompt to protect
        }
        const orig = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
        this.stdoutWriteOrig = orig;
        (process.stdout.write as any) = (chunk: any, encoding?: any, callback?: any): boolean => {
            return this.proxyWrite(orig, chunk, encoding, callback);
        };
    }

    private installStderrProxy() {
        if (!this.isTTY) {
            return; // TUI / VS Code panel — stderr is a pipe, no prompt to protect
        }
        const orig = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
        this.stderrWriteOrig = orig;
        (process.stderr.write as any) = (chunk: any, encoding?: any, callback?: any): boolean => {
            return this.proxyWrite(orig, chunk, encoding, callback);
        };
    }

    private proxyWrite(orig: typeof process.stdout.write | typeof process.stderr.write, chunk: any, encoding?: any, callback?: any): boolean {
        // Guard against re-entrant calls from clearLine / cursorTo / refreshLine.
        if (this.inRedraw || !this.isPaused) {
            return orig(chunk, encoding, callback);
        }
        this.inRedraw = true;
        try {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            orig(chunk, encoding, callback);
            this.refreshLine();
        } finally {
            this.inRedraw = false;
        }
        return true;
    }

    /** Batch sources run gdb-style: an execution command is not finished until the target stops. */
    private isBatchSource(source: InputSource): boolean {
        return source === "script" || (source === "stdin" && !!this.cliArgs.batch);
    }

    /**
     * Commands that act on the session rather than on the target, and must not wait behind
     * whatever the queue is doing -- above all `pause`, which is how a human or an AI gets back
     * control from a queue blocked on a long command. From a batch source they are queued like
     * anything else: there, their position in the script is the point.
     */
    private isOutOfBand(trimmedInput: string): boolean {
        const lower = trimmedInput.toLowerCase();
        if (["pause", "!!sigint", "status", "!!status", "exit"].includes(lower)) {
            return true;
        }
        return /^!!(ai|ai-request|ai-request-clear|note)(\s|:|$)/.test(lower);
    }

    /**
     * Every line of input, from any source, enters here. Lines are executed one at a time, in
     * arrival order: the next one is not taken until the previous one has finished. Before this
     * queue each line was dispatched the moment it arrived, against whatever state the session
     * was in at that instant -- fine for a human, but a piped script arrives all at once and
     * every command raced the one before it.
     */
    private submitLine(input: string, source: InputSource) {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            if (source === "stdin" && this.isTTY && this.isPaused) {
                this.rl?.prompt();
            }
            return;
        }
        if (this.batchAborted && this.isBatchSource(source)) {
            return; // the batch already failed; we are on our way out
        }
        if (!this.isBatchSource(source) && this.isOutOfBand(trimmedInput)) {
            void this.executeLine(input, source);
            return;
        }
        this.inputQueue.push({ line: input, source });
        void this.drainQueue();
    }

    private async drainQueue() {
        if (this.draining) {
            return;
        }
        this.draining = true;
        try {
            while (this.inputOpen && this.inputQueue.length > 0) {
                const item = this.inputQueue.shift()!;
                const ok = await this.executeLine(item.line, item.source);
                if (!ok && this.isBatchSource(item.source)) {
                    this.abandonBatch(item);
                }
            }
        } finally {
            this.draining = false;
        }
        this.maybeFinishBatch();
    }

    /** A failed command stops the batch, as it stops a gdb `source` file. */
    private abandonBatch(item: QueuedLine) {
        const what = item.source === "script" ? `script ${this.cliArgs.script}` : "batch input";
        logger.error(`Stopping ${what}: '${item.line.trim()}' failed`, { source: "DA", isConsole: true, command: item.line.trim(), error: "batch-aborted" });
        this.inputQueue = this.inputQueue.filter((q) => !this.isBatchSource(q.source));
        if (this.cliArgs.batch) {
            this.batchAborted = true;
            this.exitCode = 1;
            this.doExit(true);
        }
    }

    /** In batch mode the session ends once all of its input has been consumed and executed. */
    private maybeFinishBatch() {
        if (!this.cliArgs.batch || this.batchAborted || this.batchFinished) {
            return;
        }
        // A batch driven over the socket alone has no end of input; it ends with `exit`.
        const inputExhausted = this.stdinIsPilot ? this.stdinEnded : !!this.cliArgs.script && this.scriptQueued;
        if (inputExhausted && this.inputOpen && !this.draining && this.inputQueue.length === 0) {
            this.batchFinished = true;
            this.doExit(true);
        }
    }

    /**
     * An execution command, recognised so that a batch can wait for the target to stop again.
     * A trailing `&` (as in gdb's `continue &`) means "don't wait": it is stripped here, and the
     * command finishes as soon as the target is running.
     */
    private parseExecCommand(trimmedInput: string): { command: string; isContinue: boolean; async: boolean } | undefined {
        const async = trimmedInput.endsWith("&");
        const command = async ? trimmedInput.slice(0, -1).trimEnd() : trimmedInput;
        const verb = command.split(/\s+/)[0].toLowerCase();
        if (["continue", "c", "cont", "run"].includes(command.toLowerCase())) {
            return { command, isContinue: true, async };
        }
        const stepping = ["step", "s", "next", "n", "stepi", "si", "nexti", "ni", "finish", "fin", "until", "u", "advance", "jump"];
        if (stepping.includes(verb)) {
            return { command, isContinue: false, async };
        }
        return undefined;
    }

    /**
     * Execute one line and resolve when it has finished, with whether it succeeded. For an
     * execution command from a batch source, finished means the target has stopped again.
     */
    private async executeLine(input: string, source: InputSource): Promise<boolean> {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
            return true;
        }
        // One record per command: the structured stream (log file, socket clients) always gets it,
        // whatever its source. The console echoes it too -- as it runs, not as it arrives, so each
        // command sits directly above its own output in a batch -- except where it is already on
        // screen: typed at a terminal, or an !!AI-REQUEST, which the TUI and panel turn into a banner.
        const alreadyShown = (source === "stdin" && this.isTTY) || /^!!ai-request/i.test(trimmedInput);
        const echo = alreadyShown ? { skipConsole: true } : { isConsole: true, consolePrefix: source === "socket" ? "socket> " : "gdb> ", color: source === "socket" ? "magenta" : "green" };
        logger.info(input, { source: `${source === "stdin" ? "user" : source}-input`, ...echo });

        const exec = this.parseExecCommand(trimmedInput);
        const stopsBefore = this.stopCount;
        let ok: boolean;
        if (exec?.isContinue && this.isPaused) {
            ok = await this.doContinue();
        } else {
            const special = this.handleSpecialCommands(trimmedInput, source, input);
            if (special) {
                return special;
            }
            // Anything else, we treat as a raw GDB command and send as REPL "evaluateRequest".
            // Everything goes to GDB whether we are paused or running. We used to drop commands
            // while running, which was a self-inflicted limitation: because we drive GDB through
            // the MI interface (not a terminal REPL), GDB accepts plenty of commands while the
            // target is running -- `info breakpoints`, `info threads`, breakpoint management,
            // symbol/type and source queries. Only commands that actually read or write target
            // state need a halted core, and GDB rejects those itself with a clear error. GDB is
            // the authority on what is legal in the current state; our job is to deliver the
            // command and report the answer.
            const response = await this.doReplCommand(exec ? exec.command : trimmedInput);
            if (!response.success) {
                logger.warn(`Evaluate request failed: ${response.message}`);
            }
            ok = response.success;
            if (source === "stdin" && this.isTTY) {
                // Give GDB's output a moment to be printed before the prompt goes back up.
                setTimeout(() => {
                    // Only re-prompt if still paused — a continued/stopped event
                    // may have changed state while the command was in-flight.
                    if (this.isPaused) {
                        this.rl?.prompt();
                    }
                }, 250);
            }
        }
        if (ok && exec && !exec.async && this.isBatchSource(source)) {
            // Counted rather than tested with isPaused: a short step can stop again before its
            // response reaches us, and a response can arrive before the `continued` event does.
            ok = await this.waitForStop(stopsBefore);
        }
        return ok;
    }

    private async doContinue(): Promise<boolean> {
        const response = await this.sendRequest<DebugProtocol.ContinueResponse>({
            seq: 0, // overwritten by sendRequest
            type: "request", // overwritten by sendRequest
            command: "continue",
            arguments: { threadId: 1 }, // Assuming single-threaded target; adjust as needed
        });
        if (!response.success) {
            logger.warn(`Continue request failed: ${response.message}`);
        }
        return response.success;
    }

    /**
     * Resolve once the target has stopped more than `stopsBefore` times in total, or with false
     * after `timeoutMs`. Without a timeout this waits as long as the target runs, as gdb does;
     * Ctrl-C or `pause` from another client is the way out.
     */
    private waitForStop(stopsBefore: number, timeoutMs?: number): Promise<boolean> {
        if (this.stopCount > stopsBefore) {
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            let timer: NodeJS.Timeout | undefined;
            const waiter = () => {
                if (timer) {
                    clearTimeout(timer);
                }
                resolve(true);
            };
            this.stopWaiters.push(waiter);
            if (timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    this.stopWaiters = this.stopWaiters.filter((w) => w !== waiter);
                    resolve(false);
                }, timeoutMs);
            }
        });
    }

    /**
     * These commands are special commands that are okay to use in both paused and running states,
     * and don't get sent to the DA as raw GDB commands. They are for controlling the session itself,
     * not the target. Some are not even gdb commands (e.g. reset)
     * @param trimmedInput use for dispatch and for commands whose arguments are tokens
     * @param source where the line came from
     * @param rawInput the line as typed. Use this where whitespace is payload rather than
     *                 separator -- `!!send` carries text meant for the target verbatim.
     * @returns undefined if not a special command, otherwise a promise that resolves with
     *          whether it succeeded, once it has finished
     */
    private handleSpecialCommands(trimmedInput: string, source: InputSource, rawInput: string): Promise<boolean> | undefined {
        // Match on the lower-cased copy; slice payloads out of `trimmedInput` so their own case
        // survives. Meta-commands are recognised case-insensitively so that capitalisation alone
        // cannot turn a command into an error; a genuine misspelling falls through to
        // unknowMetaCommand() below and is reported rather than acted on.
        const lower = trimmedInput.toLowerCase();
        const done = (ok: boolean = true) => Promise.resolve(ok);
        if (lower === "pause" || lower === "!!sigint") {
            if (!this.isBatchSource(source)) {
                return this.doInterrupt();
            }
            // In a batch the next line usually needs the halted core (`bt`), and the pause
            // response can arrive before the `stopped` event does.
            const stopsBefore = this.stopCount;
            return this.doInterrupt().then((ok) => ok && this.waitForStop(stopsBefore));
        }
        if (lower === "reset" || lower === "!!reset") {
            return this.sendRequest<DebugProtocol.RestartResponse>({
                seq: 0, // overwritten by sendRequest
                type: "request", // overwritten by sendRequest
                command: "reset-device",
            }).then((response) => {
                if (!response.success) {
                    logger.warn(`Reset request failed: ${response.message}`);
                }
                return response.success;
            });
        } else if (lower === "status" || lower === "!!status") {
            this.doStatus();
            return done();
        } else if (lower === "restart" || lower === "!!restart") {
            return this.doRestart(source === "stdin").then(() => true);
        } else if (lower === "exit") {
            return this.doExit(source === "stdin");
        } else if (/^!!sleep(\s|$)/.test(lower)) {
            // For batches: `c&` / `!!sleep 2000` / `pause` / `bt` samples a running target.
            const ms = Number(lower.substring("!!sleep".length).trim());
            if (!Number.isFinite(ms) || ms < 0) {
                this.stdoutLogger.warn("Usage: !!sleep <milliseconds>");
                return done(false);
            }
            return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms));
        } else if (/^!!wait-stop(\s|$)/.test(lower)) {
            // Wait until the target is halted -- e.g. at the top of a script, for runToEntryPoint.
            // Returns at once if it already is. A timeout counts as a failure.
            const arg = lower.substring("!!wait-stop".length).trim();
            const ms = arg ? Number(arg) : undefined;
            if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) {
                this.stdoutLogger.warn("Usage: !!wait-stop [timeout-milliseconds]");
                return done(false);
            }
            if (this.isPaused) {
                return done();
            }
            return this.waitForStop(this.stopCount, ms).then((ok) => {
                if (!ok) {
                    logger.warn(`!!wait-stop: target still running after ${ms} ms`);
                }
                return ok;
            });
        } else if (lower.startsWith("!!ai-request-clear")) {
            // All we do is echo it back so the console display can pick it up and use it to trigger the AI Request UI.
            // The actual processing of the command is done in the console UI. It is an instruction to the user or a request
            // to the UI to clear/display something
            logger.info("!!AI-REQUEST-CLEAR", { isConsole: true, source: "AI" });
            return done();
        } else if (lower.startsWith("!!ai-request:")) {
            // All we do is echo it back so the console display can pick it up and use it to trigger the AI Request UI.
            // The actual processing of the command is done in the console UI. It is an instruction to the user or a request
            // to the UI to clear/display something
            // Re-emit the canonical spelling rather than what was typed: the TUI matches this
            // prefix exactly (cockpit/tui.rs), so a lower-case variant would pass through here
            // and then fail to be intercepted downstream.
            logger.info(`!!AI-REQUEST:${trimmedInput.substring("!!AI-REQUEST:".length)}`, { isConsole: true, source: "AI" });
            return done();
        } else if (lower.startsWith("!!note:")) {
            // This is a command from the DA to the CLI to update the notes. The payload is in the format of !!NOTE:{"doc":[{...json-patch...}]}
            const jsonStr = trimmedInput.substring("!!NOTE:".length);
            this.handleNotes(jsonStr);
            return done();
        } else if (/^!!send(\s|$)/i.test(trimmedInput)) {
            // Match on a whitespace boundary, not a literal space: `!!send\t[]` used to miss this
            // branch and fall through to the catch-all below, which forwards anything starting
            // with `!!` to the AI -- so a tab silently turned a target write into a chat message.
            // Take the arguments from the raw line: trimStart() drops indentation before the
            // command, but anything after it -- trailing spaces included -- is the target's data.
            return done(this.doSendToStream(rawInput.trimStart().substring("!!send".length).replace(/^\s/, "")));
        } else if (source === "stdin" && /^!!ai(\s|$)/i.test(trimmedInput)) {
            // A free-text message to whatever client is attached. This used to be the catch-all for
            // any unrecognised `!!` typed on stdin, which meant a mistyped command was relayed as
            // chat instead of being reported, and no line beginning with `!!` could ever reach gdb.
            // Naming the verb costs three characters and makes both of those go away.
            //
            // Two events on purpose: the USER-REQUEST line carries the payload alone, so a reader
            // never has to strip our wording out of it, and the DA line is the human's
            // confirmation. Socket clients are registered as transport streams, so the first one
            // reaches them as JSON without anything further being written by hand.
            const request = trimmedInput.substring("!!ai".length).trim();
            if (!request) {
                this.stdoutLogger.warn("Usage: !!ai <text> — sends the text to any connected AI");
                return done(false);
            }
            logger.info(request, { skipConsole: true, source: "USER-REQUEST" });
            this.stdoutLogger.info(`Sent to any connected AI: ${request}`);
            return done();
        } else if (lower.startsWith("!!")) {
            // An unrecognised meta-command from a socket client. This is the agent's only signal
            // that it got the spelling wrong, so it is reported rather than dropped.
            this.unknowMetaCommand(trimmedInput);
            return done(false);
        }
        return undefined;
    }

    private handleNotes(message: string) {
        const configName = this.config.name;
        try {
            const payload = JSON.parse(message);
            if (!Array.isArray(payload)) {
                logger.error(`Invalid note payload, doc is not an array: ${message}`);
                return;
            }
            this.notesManager.applyPatches(configName, payload);
        } catch (err) {
            logger.error(`Failed to apply notes patches for config ${configName}: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        // Notes are informational messages from AI to keep session notes in json-patch format (JSONPatch RFC 6902)
    }

    private async doReplCommand(command: string) {
        return this.sendRequest<DebugProtocol.EvaluateResponse>({
            seq: 0, // overwritten by sendRequest
            type: "request",
            command: "evaluate",
            arguments: {
                expression: command,
                context: "repl",
            },
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
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
            return;
        }
        if (this.config.runToEntryPoint) {
            // Handle runToEntryPoint scenario
            this.savedPostStartCommands = this.config.postStartSessionCommands;
            const existingCommands = this.config.postStartSessionCommands || [];
            this.config.postStartSessionCommands = [...existingCommands, `source ${file}`];
        } else {
            // No runToEntryPoint, set breakpoints at the beginning of the session
            this.savedPreStartCommands = this.config.request === "attach" ? this.config.preAttachCommands : this.config.preLaunchCommands;
            const existingCommands = this.savedPreStartCommands || [];
            if (this.config.request === "attach") {
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
            if (this.config.request === "attach") {
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
        const configNameSafe = this.config.name.replace(/[^a-zA-Z0-9-_]/g, "_");
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
            try {
                rtt.dispose();
            } catch (e) {}
        }
        // We don't close the uarts, logfile or socket server because they are shared across sessions are not
        // part of the DA. Actually not doing so provides continuity across the restart and also avoids potential
        // issues with the clients attached to them.
        this.rtts = [];
        this.restarting = true;
        this.inputOpen = false; // reopened once the new session is up
        this.configDoneSeen = false;
        this.postInitializedSeen = false;
        // this.closeLineReaders();
        // While a restart is not officially supported we have some rudimentary support to finish
        // the previous session but not send a 'terminated' event which will exit our program. We kinda
        // approximate what a VSCode like client would do for a restart.
        try {
            await this.sendRequest<DebugProtocol.TerminateResponse>({
                seq: 0, // overwritten by sendRequest
                type: "request", // overwritten by sendRequest
                command: "restart",
            });
        } catch (error) {
            logger.error("Failed to restart session. Terminate failed: " + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        this.removeCDebugSession();
        this.startSession(this.cliArgs)
            .then(() => {
                this.undoSetupBreakpointsFile();
                this.restarting = false;
            })
            .catch((error) => {
                throw error;
            });
    }

    /**
     * `!!send [<prefix>] [text]` — write a line to one of the target's own I/O streams.
     *
     * stdin belongs to GDB, so without this there is no way to answer firmware that prompts for
     * input ("Press 'Enter' to continue").
     *
     * Brackets are what separate an address from payload, so a command means the same thing no
     * matter how many streams happen to exist:
     *
     *   !!send [RTT#0] hello    -> that stream
     *   !!send hello            -> the only stream; an error when there is more than one
     *   !!send                  -> a bare newline to the only stream
     *   !!send [] hello         -> the only stream, said out loud, for text starting with '['
     *
     * Resolving an unbracketed first word against the stream list instead would make the parse
     * depend on session state: text would be swallowed as an address whenever it collided with
     * a name, and the same command would change meaning as streams came and went.
     *
     * The prefix is the tag that labels that stream's own output and is listed by `status`, so
     * the address is discoverable from the stream itself. A line terminator is always appended.
     * Everything after the address is payload, whitespace included -- which is why the caller
     * hands us the raw line rather than a trimmed one.
     */
    private doSendToStream(args: string): boolean {
        type Sink = { prefix: string; write: (text: string) => boolean };
        const sinks: Sink[] = [
            ...this.rtts.map((r) => ({
                prefix: r.getPrefix(),
                write: (text: string) => r.sendToTarget(`${text}\r\n`),
            })),
            ...(this.adapter as CliAdapter).getSerialPortViews().map((p) => ({
                prefix: p.getPrefix(),
                // onUserInput() appends the terminator itself; the RTT path above adds its own.
                write: (text: string) => {
                    if (p.getStatus() !== "connected") {
                        return false;
                    }
                    p.onUserInput(text);
                    return true;
                },
            })),
        ];
        const names = () => sinks.map((s) => s.prefix);
        const fail = (msg: string, error: string, extra: object = {}) => {
            logger.error(`!!send: ${msg}`, { source: "DA", isConsole: true, command: "send", error, ...extra });
        };

        // Look for the address past any extra spacing: `!!send   [port]` means the port, not the
        // literal text "[port]" to the only stream. Payload keeps its leading spaces because it
        // is only reached when there is no bracket to find.
        const addressPart = args.trimStart();
        let addressed: string | undefined;
        let text: string;
        if (addressPart.startsWith("[")) {
            const end = addressPart.indexOf("]");
            if (end < 0) {
                fail(`unterminated stream name in '${addressPart}'`, "bad-prefix");
                return false;
            }
            const prefix = addressPart.substring(0, end + 1);
            addressed = prefix === "[]" ? undefined : prefix; // '[]' is "the only one", stated explicitly
            text = addressPart.substring(end + 1).replace(/^\s/, ""); // drop the separator, keep the rest
        } else {
            text = args; // unbracketed: all of it is payload
        }

        let target: Sink | undefined;
        if (addressed) {
            target = sinks.find((s) => s.prefix === addressed);
            if (!target) {
                fail(`no stream named ${addressed}. Known streams: ${names().join(", ") || "(none)"}`, "unknown-stream", { target: addressed, available: names() });
                return false;
            }
        } else if (sinks.length > 1) {
            fail(`more than one stream, name the one you mean: ${names().join(", ")}`, "ambiguous", { available: names() });
            return false;
        } else {
            target = sinks[0]; // undefined when the session has no streams at all
        }
        if (!target) {
            fail("this session has no serial or RTT streams to send to", "no-streams", { available: [] });
            return false;
        }

        if (!target.write(text)) {
            fail(`${target.prefix} is not connected`, "not-connected", { target: target.prefix });
            return false;
        }
        logger.info(`${target.prefix} <= ${text}`, { source: "DA", skipConsole: true, command: "send", target: target.prefix, text });
        return true;
    }

    private doStatus() {
        // We summarize our current status
        const serialPorts = (this.adapter as CliAdapter).getSerialPortViews().map((port) => {
            const params: any = {
                status: port.getStatus(),
                prefix: port.getPrefix(),
                ...port.serialConfig,
            };
            return params;
        });
        const obj: any = {
            status: this.status,
            cwd: process.cwd(),
            pid: process.pid,
            targetCwd: this.config.cwd,
            configName: this.config.name,
            serverType: this.config.servertype,
            configType: this.config.request,
            rtts: this.rtts.map((rtt) => ({
                status: rtt.getStatus(),
                prefix: rtt.getPrefix(),
                tcpPort: rtt.options.pvtTcpPort,
                channel: rtt.options.port,
                type: rtt.options.type,
            })),
            serialPorts: serialPorts,
            socketPath: this.socketPath,
            logFile: this.cliArgs.logFile,
        };
        logger.info(`Session summary: ${JSON.stringify(obj, null, 2)}`);
    }

    private doExit(isTerminal: boolean): Promise<boolean> {
        return this.sendRequest<DebugProtocol.TerminateResponse>({
            seq: 0, // overwritten by sendRequest
            type: "request", // overwritten by sendRequest
            command: "terminate",
        }).then((response) => {
            if (!response.success) {
                logger.warn(`Terminate request failed: ${response.message}`);
            }
            if (isTerminal) {
                // The rl may already be closed (user pressed Ctrl-D) or will be closed
                // when the terminated event arrives via closeLineReaders().
                this.closeLineReaders();
            }
            return response.success;
        });
    }

    private doInterrupt(): Promise<boolean> {
        return this.sendRequest<DebugProtocol.PauseResponse>({
            seq: 0, // overwritten by sendRequest
            type: "request", // overwritten by sendRequest
            command: "pause",
            arguments: { threadId: 1 }, // Assuming single-threaded target; adjust as needed
        }).then((response) => {
            if (!response.success) {
                logger.warn(`Pause request failed: ${response.message}`);
            }
            return response.success;
        });
    }

    // startReadlineRunning() has been merged into ensureReadline() / setReadlineState().
    // The single this.rl interface handles both paused and running states, dispatching
    // input via this.isPaused at the point each line arrives.

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
        req.type = "request";
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
        if (msg.type === "response") {
            const response = msg as DebugProtocol.Response;
            const resolve = this.pendingRequests.get(response.request_seq);
            if (resolve) {
                this.pendingRequests.delete(response.request_seq);
                resolve(response);
            }
        } else if (msg.type === "event") {
            this.handleEvent(msg as DebugProtocol.Event);
        }
    }

    /** Handle events emitted by the DA (stopped, output, terminated, etc.). */
    private handleEvent(event: DebugProtocol.Event): void {
        switch (event.event) {
            case "stopped": {
                const reason = `${event.body?.reason}` + (event.body?.description ? ` — ${event.body.description}` : "");
                this.isPaused = true;
                this.stopCount++;
                this.setState("paused", reason);
                this.setReadlineState(true);
                this.releaseStopWaiters();
                break;
            }
            case "continued":
                this.isPaused = false;
                this.setState("running");
                this.setReadlineState(false);
                break;
            case "terminated":
                if (!this.restarting) {
                    this.setState("terminated");
                    this.closeLineReaders();
                    process.exit(this.exitCode);
                }
                break;
            case "thread":
                // threadId, reason ('started'|'exited') — mostly noise, log at debug
                this.optionalInfo.debug("thread", { threadId: event.body?.threadId, reason: event.body?.reason });
                break;
            case "output": {
                const body = event.body as DebugProtocol.OutputEvent["body"];
                const output = body?.output ?? "";
                const category = body?.category ?? "console";
                this.routeOutput(category, output);
                break;
            }
            case "initialized":
                if (this.status === "starting") {
                    this.setState("initialized");
                    if (this.session) {
                        if (this.session.isRunning()) {
                            this.isPaused = false;
                            this.setState("running");
                            this.setReadlineState(false);
                        } else {
                            this.isPaused = true;
                            this.setState("paused");
                            this.setReadlineState(true);
                        }
                    }
                }
                break;
            case "post-initialized":
                this.postInitializedSeen = true;
                this.openInputWhenSettled();
                break;
            case "swo-configure":
                // this.receivedSWOConfigureEvent(event);
                break;
            case "rtt-configure":
                handleRTTConfigureEvent(event.body, this.debugSession!, (decoder: RTTConsoleDecoderOpts, src: SocketRTTSource) => {
                    this.rtts.push(new CLIRTTTerminal(decoder, src));
                });
                break;
            default:
                // Custom events (custom-event-ports-done, SWOConfigure, etc.)
                if (event.event.startsWith("custom-event-")) {
                    this.optionalInfo.debug(`custom event:${event.event} `, { body: event.body });
                } else {
                    this.optionalInfo.debug(`event:${event.event} `, { body: event.body });
                }
                break;
        }
        // TODO: route stopped/output/terminated events to the TUI / headless stream
    }

    /**
     * Open the input queue once start-up has settled: the DA has sent `post-initialized` (its
     * session-mode commands -- runToEntryPoint, breakAfterReset -- are done) and has answered
     * configurationDone. Either can come first.
     *
     * Until then our paused/running state cannot be trusted. The DA decides to continue the target
     * (runToEntryPoint, or no breakAfterReset) while it is still halted from the reset, and the
     * `continued` event only follows once gdb reports running. A batch that started in that gap
     * saw a halted target -- `!!wait-stop` returned at once, and the `continue` after it was
     * rejected as the target was by then running. The DA's own isBusy() is set synchronously when
     * it issues the continue, so at this point it is the truth; take our state from it.
     */
    private openInputWhenSettled() {
        if (this.inputOpen || !this.configDoneSeen || !this.postInitializedSeen) {
            return;
        }
        if (this.isPaused && this.session?.isBusy()) {
            this.isPaused = false;
            this.setState("running");
            this.setReadlineState(false);
        }
        this.inputOpen = true;
        void this.drainQueue();
    }

    private releaseStopWaiters() {
        const waiters = this.stopWaiters;
        this.stopWaiters = [];
        for (const waiter of waiters) {
            waiter();
        }
    }

    private closeLineReaders() {
        this.isInternalClose = true;
        this.rl?.close();
        this.rl = null;
        this.isInternalClose = false;
        // Restore the original process.stdout.write now that readline is torn down.
        if (this.stdoutWriteOrig) {
            process.stdout.write = this.stdoutWriteOrig;
            this.stdoutWriteOrig = null;
        }
    }

    private previousParialLine = "";
    private previousParitalCategory = "";
    private previousPartialTimer: NodeJS.Timeout | null = null;
    private routeOutput(category: string, output: string): void {
        const doOutput = (category: string, output: string) => {
            const text = output.trimEnd();
            if (!text) {
                return;
            }

            if (category === "stdout" && /^\d+[-~&@^]/.test(output)) {
                // GDB MI command sent by DA (gdbTraces mode) — log structured, never raw to terminal
                this.gdbMiLogger.debug(`mi: tx[MI >] ${text} `);
                return;
            }

            if (category === "console" && output.startsWith("-> ")) {
                // GDB MI response received — strip the '-> ' the DA added
                const mi = text.slice(3);
                this.gdbMiLogger.debug(`mi: rx[MI <] ${mi} `);
                return;
            }

            if (category === "stderr" || category === "stdout") {
                // DA internal messages — strip the well-known prefixes
                const prefix1 = "mcu-debug stderr: ";
                const prefix2 = "mcu-debug: ";
                if (output.startsWith(prefix1)) {
                    const logLine = output.slice(prefix1.length).trimEnd();
                    this.mcuStderrLogger.info(logLine);
                } else if (output.startsWith(prefix2)) {
                    const logLine = output.slice(prefix2.length).trimEnd();
                    this.mcuStdoutLogger.info(logLine);
                } else if (category === "stderr") {
                    this.stderrLogger.info(text);
                } else {
                    // A leading '\r' is the gdb-server overwriting its own line -- erase/program
                    // progress. Overwriting in place only means something on a terminal. When
                    // stdout is a pipe (TUI, socket, an AI driving the session) the escape is
                    // noise, and returning early would drop the progress from the log file too.
                    // During a 30-second flash it is the only evidence the session is alive, so
                    // off a terminal it becomes an ordinary log event.
                    if (text.startsWith("\r") && !text.startsWith("\r[100")) {
                        if (this.isTTY) {
                            this.terminalWrite(text); // overwrite current line -- no need to log
                            return;
                        }
                        // Several updates may have coalesced into one flush, each separated by
                        // its own '\r'. Only the last one is the current state -- that is what
                        // overwriting in place would have left on screen.
                        this.stdoutLogger.info(text.split("\r").pop() ?? text);
                        return;
                    }
                    this.stdoutLogger.info(text);
                }
            } else {
                // category === 'console' without '-> ': real GDB console output the user should see
                this.gdbLogger.info(text);
            }
        };

        const flushPartial = () => {
            if (this.previousParialLine) {
                doOutput(this.previousParitalCategory, this.previousParialLine);
                this.previousParialLine = "";
                this.previousParitalCategory = "";
                if (this.previousPartialTimer) {
                    clearTimeout(this.previousPartialTimer);
                    this.previousPartialTimer = null;
                }
            }
        };

        const isPartial = !output.endsWith("\n");
        if (isPartial && output) {
            if (this.previousParialLine) {
                if (category !== this.previousParitalCategory) {
                    flushPartial();
                }
                output = this.previousParialLine + output;
                if (this.previousPartialTimer) {
                    clearTimeout(this.previousPartialTimer);
                    this.previousPartialTimer = null;
                }
            }
            this.previousParialLine = output;
            this.previousParitalCategory = category;
            output = output.slice(0, -1);
            this.previousPartialTimer = setTimeout(() => {
                flushPartial();
            }, 100);
        } else if (this.previousParialLine) {
            // A complete line must not overtake a partial that is still pending. When it
            // continues that same partial it is the rest of the line, so join them; when it
            // comes from a different source, flush the partial first to preserve ordering.
            // Without this a line split across chunks ("Erasing wo" + "rld\n") emitted "rld"
            // immediately and "Erasing wo" after the timer -- split and out of order.
            if (category === this.previousParitalCategory) {
                output = this.previousParialLine + output;
                this.previousParialLine = "";
                this.previousParitalCategory = "";
                if (this.previousPartialTimer) {
                    clearTimeout(this.previousPartialTimer);
                    this.previousPartialTimer = null;
                }
            } else {
                flushPartial();
            }
            doOutput(category, output);
        } else {
            doOutput(category, output);
        }
    }

    private terminalWrite(data: string): void {
        process.stdout.write(data);
    }

    async doInitializeRequest(): Promise<DebugProtocol.InitializeResponse> {
        logger.info("Sending initialize request...");
        const response = await this.sendRequest<DebugProtocol.InitializeResponse>({
            seq: 0, // overwritten by sendRequest
            type: "request", // overwritten by sendRequest
            command: "initialize",
            arguments: {
                clientID: "mcu-debug-cli",
                adapterID: "mcu-debug",
                pathFormat: "path",
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
        return `${process.cwd()}/.mcu-debug/socket.json`;
    }

    private createSocketPath(): string {
        let count = 0;
        const getName = (): string => {
            return `${os.tmpdir()}/mcu-debug-${process.pid}-${count++}.sock`;
        };
        let sockPath: string;
        switch (process.platform) {
            case "win32":
                // Windows named pipe path format \\.\pipe\pipename
                return `\\\\.\\pipe\\mcu-debug-${process.pid}`;
            default:
                sockPath = getName(); // filesystem socket (visible in /tmp, should be cleaned up on exit)
                break;
        }
        while (fs.existsSync(sockPath)) {
            sockPath = getName();
        }
        if (sockPath.length > 100) {
            // Unix socket path length limit is usually around 108 chars, but can be as low as 88 on some distros with long temp dir paths. Check to avoid hard-to-diagnose errors from net.createServer.
            logger.error(
                `Generated socket path is too long (${sockPath.length} chars): ${sockPath}. This may cause the socket server to fail. Consider setting TMPDIR to a shorter path and/or using a RAM disk for /tmp.`,
                { source: "DA", isConsole: true },
            );
        }
        return sockPath;
    }

    private async checkSocketFree() {
        const socketJsonPath = this.createSocketJsonPath();
        if (fs.existsSync(socketJsonPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(socketJsonPath, "utf-8"));
                if (existing && existing.pid) {
                    // Check if the process is still running
                    try {
                        const list = await find("pid", existing.pid);
                        if (list.length > 0) {
                            logger.error(`Socket file ${socketJsonPath} already exists and process ${existing.pid} is still running. Is another instance running ? `, {
                                source: "DA",
                                isConsole: true,
                                ...existing,
                            });
                        }
                    } catch (err) {
                        logger.warn(`Socket file ${socketJsonPath} already exists but process ${existing.pid} is not running.It will be overwritten.`, { source: "DA", isConsole: true, ...existing });
                    }
                } else {
                    logger.warn(`Socket file ${socketJsonPath} already exists but has unexpected content.It will be overwritten.`, { source: "DA", isConsole: true, content: existing });
                }
            } catch (err) {
                logger.error(`Socket file ${socketJsonPath} already exists and could not be read.Is another instance running ? `, { source: "DA", isConsole: true });
            }
        }
    }

    private async startSocketReader(): Promise<void> {
        await this.checkSocketFree();
        const socketPath = this.createSocketPath(); // Will have backslashes and .sock suffix on Windows, normal .sock file on Unix
        let timeout: NodeJS.Timeout | null = null;
        this.socketPromise = new Promise((resolve, reject) => {
            this.server = net.createServer((conn) => {
                const rl = readline.createInterface({ input: conn });
                rl.on("line", (line) => {
                    this.submitLine(line, "socket");
                });
                // readline re-emits its input's errors on the interface, so this is where a client
                // that goes away mid-write (EPIPE, ECONNRESET) surfaces. Unhandled, it became an
                // uncaught exception and ended the debug session. It is only a disconnect: 'close'
                // follows and does the bookkeeping.
                rl.on("error", (err) => {
                    logger.debug(`Socket client error: ${err.message}`, { source: "DA" });
                });
                if (!this.customTransport.getRingBuffer().isEmpty()) {
                    // Replay recent history to the new client, trimmed to a whole-line boundary.
                    // The ring buffer wraps mid-line, so a raw snapshot() would lead with a JSON
                    // fragment that any consumer parsing NDJSON would choke on.
                    const backlog = this.customTransport.getRingBuffer().snapshotFromRecordStart();
                    if (backlog.length > 0) {
                        conn.write(backlog);
                    }
                }
                if (this.cliArgs.waitForClient && this.serverClients.size === 0) {
                    // First client connected, resolve the promise to let session setup continue
                    resolve();
                    if (timeout) clearTimeout(timeout!);
                }
                // Also pipe mux output back to this connection
                this.serverClients.add(conn);
                this.hasEverHadClient = true;
                // One key per connection: they all share the socket path, and under that one key
                // each new client replaced the last, and the first to close cut off the rest.
                this.customTransport.addStream(conn, `${socketPath}#${++this.clientSeq}`);
                conn.on("close", () => {
                    this.serverClients.delete(conn);
                    // In socket-pilot mode the last client leaving means nobody is flying. Exit
                    // cleanly rather than lingering: a debug session holds the probe exclusively,
                    // so an abandoned one blocks the *next* session from starting. We cannot rely
                    // on a well-behaved `exit` -- an AI client can vanish in plenty of ways that
                    // never reach us. Waiting around for a possible re-attach would trade a
                    // recoverable inconvenience for a resource nobody else can use.
                    if (!this.stdinIsPilot && this.hasEverHadClient && this.serverClients.size === 0) {
                        logger.info("Last client disconnected and there is no stdin to fall back on; ending the session and releasing the probe.", { source: "DA" });
                        this.doExit(false);
                    }
                });
            });
            this.server.listen(socketPath, () => {
                this.socketPath = socketPath;
                this.writeSockFile(socketPath); // triggers Rust's wait_for_sock_file()
                logger.info(`Socket server listening on ${socketPath}`, { source: "DA", isConsole: true });
                if (!this.cliArgs.waitForClient) {
                    resolve();
                } else {
                    // Announce the wait on stderr before blocking. This is a deliberate,
                    // unbounded wait and stdout carries the mux stream, so without a word here an
                    // operator just sees a process that appears hung.
                    process.stderr.write(
                        `Waiting for a client to connect before starting the debug session.` +
                            os.EOL +
                            `  socket: ${socketPath}` +
                            os.EOL +
                            `  connect with: mcu-debug attach` +
                            os.EOL +
                            `This waits indefinitely; press Ctrl-C to abort.` +
                            os.EOL,
                    );
                    timeout = setTimeout(() => {
                        if (timeout && this.serverClients.size === 0) {
                            logger.error("waitForClient is true but no client connected within timeout. Is the client side running and configured correctly?", { source: "DA", isConsole: true });
                        }
                        timeout = null;
                    }, 5000); // arbitrary timeout to catch listen() failures in waitForClient mode
                }
                process.on("exit", () => {
                    if (this.server) {
                        this.server.close();
                    }
                    try {
                        fs.unlinkSync(socketPath);
                    } catch (err) {}
                });
            });
            this.server.on("error", (err) => {
                logger.error(`Socket server error: ${err instanceof Error ? err.message : String(err)}`, { source: "DA", isConsole: true });
                reject(err);
            });
        });
        return this.socketPromise;
    }

    private unknowMetaCommand(cmd: string) {
        // warn, not info: this is the only indication a client gets that its command was not
        // understood, and an agent filtering on level would read an info line as normal traffic.
        logger.warn(`Unhandled meta-command from clients: ${cmd}`, { source: "DA", isConsole: true, command: cmd, error: "unknown-meta-command" });
    }

    private writeSockFile(socketPath: string) {
        // Write the socket/pipe path to .mcu-debug/socket.json for the Rust side to pick up.
        // The Rust SockInfo struct treats these as mutually exclusive: a Windows named pipe
        // path goes under `pipe`, everything else (Unix domain socket) goes under `socket`.
        const sockInfo = {
            pid: process.pid,
            socket: process.platform === "win32" ? undefined : socketPath,
            pipe: process.platform === "win32" ? socketPath : undefined,
            cwd: process.cwd(),
            config: this.config.name,
            started: new Date().toISOString(),
            logFile: this.cliArgs.logFile,
        };
        const socketPathJson = this.createSocketJsonPath();
        try {
            const dir = path.dirname(socketPathJson);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(socketPathJson, JSON.stringify(sockInfo, null, 2) + "\n");
        } catch (err) {
            logger.error(`Failed to write socket file ${socketPathJson}: ${err instanceof Error ? err.message : String(err)}`, { source: "DA", isConsole: true });
            if (this.cliArgs.waitForClient) {
                process.exit(1); // Rust side will detect absence of socket file and wait, so we can exit cleanly here and let Rust restart us when ready
            }
            return;
        }
        logger.debug(`Socket path written to ${socketPathJson}`, { source: "DA", isConsole: true });
        process.on("exit", () => {
            try {
                this.server?.close();
                fs.unlinkSync(socketPathJson);
                try {
                    fs.unlinkSync(socketPath);
                } catch (err) {} // also clean up the socket file itself
                logger.debug(`Cleaned up socket file ${socketPathJson}`, { source: "DA", isConsole: true });
            } catch (err) {
                logger.warn(`Failed to clean up socket file ${socketPathJson}: ${err instanceof Error ? err.message : String(err)}`, { source: "DA", isConsole: true });
            }
        });
    }

    dispose() {
        CliTelemetry.endSession(this.telemetryId); // no-op if already ended or opted out
        this.notesManager.flushNow();
        SerialPortManager.Dispose();
    }
}
