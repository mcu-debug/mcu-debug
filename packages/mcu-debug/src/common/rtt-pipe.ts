import { Decoder, DecoderSpec } from "@mcu-debug/shared";
import { getHostAdapter } from "./host-adapter";
import { SocketRTTSource } from "./swo/sources/socket";
import { ThroughputMonitor, fmtRate } from "./throughput-monitor";

/**
 * Where a pipe decoder's output goes.
 *
 * `none` is not a degenerate case -- it is the point of the feature for measurement. An RTT
 * firehose into xterm.js is enough work to slow the reads that feed it, so the rate measured
 * with a terminal attached is a rate the terminal had a hand in. With `none` there is nothing
 * downstream of the counter, which gives the number the probe and the gdb-server are actually
 * capable of.
 */
export type PipeOutput = "terminal" | "none";

export interface RTTPipeDecoderOpts {
    type: "pipe";
    port: number;
    tcpPort: string;
    label?: string;
    /** Absent means no child process at all: the bytes are counted and dropped. */
    program?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    output?: PipeOutput;
    /** Report byte rates. Defaults to true -- measurement is why this decoder type exists. */
    stats?: boolean;
    statsInterval?: number;
}

/**
 * An RTT source whose bytes have been through an external program.
 *
 * Deliberately a **decorator over a source** rather than a new kind of consumer. Both hosts
 * build their terminal from a `SocketIOSource` (`IOTerminal` in the extension,
 * `CLIRTTTerminal` in the CLI), so presenting one means the pipe gets a real terminal, input
 * included, without either host knowing this class exists.
 *
 * The flow is:
 *
 * ```text
 *   target --> gdb-server or built-in RTT --> upstream source --> child stdin
 *                                                  |                  |
 *                                            ThroughputMonitor   child stdout --> this "data"
 * ```
 *
 * The monitor sits on the **upstream** side on purpose; see `ThroughputMonitor`.
 *
 * With no `program` the child is skipped and the upstream bytes are emitted unchanged, which
 * makes `{ type: "pipe" }` on its own a pure measurement probe.
 */
export class RTTPipeSource extends SocketRTTSource {
    private pipeProc: Decoder | null = null;
    private monitor: ThroughputMonitor | null = null;
    private closed = false;

    constructor(
        private readonly upstream: SocketRTTSource,
        private readonly opts: RTTPipeDecoderOpts,
    ) {
        // The upstream's port is carried only for labels and log text; this source never
        // opens a socket of its own, and `start()` is overridden so it cannot.
        super(upstream.channel, upstream.tcpPort);
        if (opts.stats !== false) {
            this.monitor = new ThroughputMonitor(
                (msg) => getHostAdapter().debugConsoleMessage(msg),
                this.label(),
                opts.statsInterval && opts.statsInterval > 0 ? opts.statsInterval * 1000 : undefined,
            );
        }
        // Mirror the upstream's connection state, because that is the state a terminal shows.
        this.connected = upstream.connected;
        upstream.on("connected", () => {
            this.connected = true;
            this.emit("connected");
        });
        upstream.on("disconnected", () => {
            this.connected = false;
            this.emit("disconnected");
            // And then go away. The upstream socket closing is the end of the channel -- it does
            // not reconnect -- so this is where the child process must be killed and the final
            // average reported. Nothing else holds a reference to this object to do it.
            this.dispose();
        });
        upstream.on("error", (e) => this.emit("error", e));
        upstream.on("data", (data: Buffer) => this.fromUpstream(data));
    }

    private label(): string {
        return this.opts.label || `RTT CH:${this.channel}`;
    }

    /**
     * Start the child process, if there is one.
     *
     * Overrides the socket connect in `SocketSWOSource`: the upstream source owns the socket,
     * and a second connection to the same RTT port would be a second consumer of the same
     * channel -- which for a gdb-server means competing for the same bytes.
     */
    public async start(): Promise<void> {
        if (!this.opts.program) {
            return;
        }
        const spec: DecoderSpec = {
            program: this.opts.program,
            args: this.opts.args || [],
            cwd: this.opts.cwd,
            env: this.opts.env,
        };
        this.pipeProc = new Decoder(spec);
        try {
            await this.pipeProc.runProgram();
        } catch (e) {
            this.pipeProc = null;
            const msg = `RTT pipe for channel ${this.channel}: could not start '${spec.program}': ${e}`;
            getHostAdapter().showError(msg);
            throw new Error(msg);
        }
        this.pipeProc.on("stdout", (data: Buffer) => {
            this.emit("data", data);
        });
        this.pipeProc.on("stderr", (data: Buffer) => {
            // Its diagnostics, not target output: keep them out of the terminal, where they
            // would be indistinguishable from what the firmware printed.
            getHostAdapter().debugConsoleMessage(`RTT pipe CH:${this.channel} stderr: ${data.toString().trimEnd()}`);
        });
        this.pipeProc.on("close", (code: number) => {
            if (!this.closed) {
                getHostAdapter().debugConsoleMessage(`RTT pipe CH:${this.channel}: '${spec.program}' exited with code ${code}`);
            }
            this.pipeProc = null;
        });
        getHostAdapter().debugConsoleMessage(`RTT pipe CH:${this.channel} started: ${spec.program} ${(spec.args || []).join(" ")}`);
    }

    private fromUpstream(data: Buffer) {
        this.monitor?.record(data);
        if (this.pipeProc) {
            void this.pipeProc.writeStdin(data);
        } else if (this.opts.output !== "none") {
            // No program: pass through, so `{ type: "pipe" }` with a terminal is a plain
            // console that happens to report its rate.
            this.emit("data", data);
        }
    }

    /** Terminal input goes to the target, never to the child: the child is a decoder, not a shell. */
    public write(data: string) {
        this.upstream.write(data);
    }

    public createPromptLabel(): string {
        return this.upstream.createPromptLabel();
    }

    public createTerminalName(): string {
        return this.opts.label || `${this.upstream.createTerminalName()} (pipe)`;
    }

    /** The run's average, reported once at the end -- for a short measurement it is the number that matters. */
    public dispose() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.monitor) {
            this.monitor.flush();
            if (this.monitor.bytesTotal > 0) {
                getHostAdapter().debugConsoleMessage(`[${this.label()} stats] session average ${fmtRate(this.monitor.averageBytesPerSec)} over ${this.monitor.bytesTotal} bytes`);
            }
        }
        this.pipeProc?.dispose();
        this.pipeProc = null;
        super.dispose();
    }
}
