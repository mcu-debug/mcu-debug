import { RTTCommonDecoderOpts, RTTConsoleDecoderOpts } from "../adapter/servers/common";
import { getHostAdapter, IDebugSession } from "./host-adapter";
import { CDebugSession } from "./cli-session";
import { JLinkSocketRTTSource, SocketRTTSource } from "./swo/sources/socket";
import { RTTPipeDecoderOpts, RTTPipeSource } from "./rtt-pipe";
import { ThroughputMonitor } from "./throughput-monitor";

/**
 * Substitute the launch.json variables a decoder program's arguments may use.
 *
 * `${executable}` used to be substituted in exactly one place -- `rtt-builtin.ts` -- while the
 * gdb-server RTT path spawns the program out here. So the schema's own default arguments,
 * `["-e", "${executable}"]`, reached `defmt-print` as a literal `${executable}` and it exited
 * immediately. That is why pre-decoders appeared to work only with built-in RTT.
 *
 * Substitution is idempotent, so doing it in place is safe if a caller repeats it.
 */
export function substituteDecoderVars<T extends { args?: string[]; cwd?: string }>(spec: T, config: any): T {
    const executable = config?.executable || "unknown.elf";
    const workspace = config?.cwd || process.cwd();
    const sub = (str: string) => str.split("${executable}").join(executable).split("${workspaceFolder}").join(workspace);
    if (spec.args) {
        spec.args = spec.args.map(sub);
    }
    if (spec.cwd) {
        spec.cwd = sub(spec.cwd);
    }
    return spec;
}

/**
 * Report byte rates for a decoder that is not a pipe.
 *
 * The comparison the `pipe` decoder exists to make needs both sides of it: a `console` decoder
 * with `stats` measures the rate *with* a terminal in the path, and a `pipe` with
 * `output: "none"` measures it without. Same monitor, same place in the flow, so the difference
 * is the terminal and nothing else.
 */
function attachStats(decoder: RTTCommonDecoderOpts, src: SocketRTTSource) {
    const label = (decoder as RTTConsoleDecoderOpts).label || `RTT CH:${decoder.port}`;
    const interval = (decoder as any).statsInterval;
    const monitor = new ThroughputMonitor((msg) => getHostAdapter().debugConsoleMessage(msg), label, interval > 0 ? interval * 1000 : undefined);
    src.on("data", (data: Buffer) => monitor.record(data));
    src.once("disconnected", () => monitor.flush());
}

export function createRTTSource(mySession: CDebugSession, tcpPort: string, channel: number): Promise<SocketRTTSource> {
    return new Promise((resolve, reject) => {
        let src = mySession.rttPortMap[channel];
        if (src) {
            resolve(src);
            return;
        }
        let decoderSpec = mySession.config.rttConfig?.enabled && mySession.config.rttConfig?.pre_decoder;
        if (decoderSpec && mySession.config.rttConfig?.useBuiltinRTT?.enabled) {
            // Built-in RTT applies the pre-decoder itself, in the debug adapter, where it also
            // honours `pre_decoder.channels`. Running it here as well would decode twice.
            decoderSpec = undefined;
        }
        if (decoderSpec) {
            substituteDecoderVars(decoderSpec, mySession.config);
        }
        if (mySession.config.servertype === "jlink") {
            src = new JLinkSocketRTTSource(channel, tcpPort, decoderSpec);
        } else {
            src = new SocketRTTSource(channel, tcpPort, decoderSpec);
        }
        mySession.rttPortMap[channel] = src; // Yes, we put this in the list even if start() can fail
        resolve(src); // Yes, it is okay to resolve it even though the connection isn't made yet
        getHostAdapter().debugConsoleMessage(`Connecting to RTT TCP port ${tcpPort} for channel ${channel}...`);
        src.start()
            .then(() => {
                getHostAdapter().debugConsoleMessage(`Connected to RTT TCP port ${tcpPort} for channel ${channel}`);
                if (!mySession.config.rttConfig?.useBuiltinRTT?.enabled) {
                    mySession.session.customRequest("rtt-poll");
                }
            })
            .catch((e) => {
                getHostAdapter().showError(`Could not connect to RTT TCP port ${tcpPort} ${e}`);
            });
    });
}

export function handleRTTConfigureEvent(body: any, session: CDebugSession, createCb: (opts: RTTConsoleDecoderOpts, src: SocketRTTSource) => void) {
    if (body.type === "socket") {
        const decoder: RTTCommonDecoderOpts = body.decoder;
        if (decoder.type === "console" || decoder.type === "binary") {
            createRTTSource(session, decoder.tcpPort, decoder.port).then((src: SocketRTTSource) => {
                if ((decoder as any).stats) {
                    attachStats(decoder, src);
                }
                createCb(decoder as RTTConsoleDecoderOpts, src);
            });
        } else if (decoder.type === "pipe") {
            // A decorator over the channel's source, not a consumer of it, so the host's own
            // terminal can be built from it unchanged -- see `RTTPipeSource`.
            createRTTSource(session, decoder.tcpPort, decoder.port).then((src: SocketRTTSource) => {
                const opts = substituteDecoderVars({ ...(decoder as unknown as RTTPipeDecoderOpts) }, session.config);
                const pipe = new RTTPipeSource(src, opts);
                pipe.start()
                    .then(() => {
                        if ((opts.output ?? "terminal") !== "none") {
                            createCb(pipeTerminalOpts(opts), pipe);
                        }
                    })
                    .catch(() => {
                        // `RTTPipeSource.start` has already reported it. Nothing is created,
                        // so the channel's data goes nowhere -- which is better than a
                        // terminal that silently shows nothing because the program is missing.
                    });
            });
        } else {
            if (!decoder.ports) {
                createRTTSource(session, decoder.tcpPort, decoder.port);
            } else {
                for (let ix = 0; ix < decoder.ports.length; ix = ix + 1) {
                    // Hopefully ports and tcpPorts are a matched set
                    createRTTSource(session, decoder.tcpPorts[ix], decoder.ports[ix]);
                }
            }
        }
    } else {
        getHostAdapter().debugMessage("Error: receivedRTTConfigureEvent: unknown type: " + body.type);
    }
}

/**
 * The console options a pipe's terminal is built with.
 *
 * `type` becomes `console` because what the program emits is text by construction -- that is
 * what a pipe decoder is for. Anything wanting the raw bytes formatted as numbers should use a
 * `binary` decoder on the same channel instead; both can be attached at once.
 */
function pipeTerminalOpts(opts: RTTPipeDecoderOpts): RTTConsoleDecoderOpts {
    return {
        ...opts,
        type: "console",
        label: opts.label || `RTT CH:${opts.port} (pipe)`,
    } as unknown as RTTConsoleDecoderOpts;
}
