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
        // **`pvtRttConfig ?? rttConfig`, and the order matters.** When built-in RTT is enabled the
        // adapter moves the real configuration to `pvtRttConfig` and leaves `rttConfig` as a disabled
        // stub, so that the gdb-server's own RTT setup is skipped. The VS Code frontend maps it back
        // when it fetches the arguments; **the CLI does not**. So reading `rttConfig` directly here
        // sees `{ enabled: false }` under the CLI and every `useBuiltinRTT` test below silently
        // inverts -- which is how the J-Link channel-select string came to be sent to our own RTT
        // server, and how `rtt-poll` is still requested for a server that is not serving RTT.
        const rttCfg = mySession.config.pvtRttConfig ?? mySession.config.rttConfig;
        const builtin = !!rttCfg?.useBuiltinRTT?.enabled;
        let decoderSpec = rttCfg?.enabled && rttCfg?.pre_decoder;
        if (decoderSpec && builtin) {
            // Built-in RTT applies the pre-decoder itself, in the debug adapter, where it also
            // honours `pre_decoder.channels`. Running it here as well would decode twice.
            decoderSpec = undefined;
        }
        if (decoderSpec) {
            substituteDecoderVars(decoderSpec, mySession.config);
        }
        // `servertype` answers "which probe is attached". The question here is **who is serving this
        // TCP port**, and with built-in RTT the answer is `RttTcpServer` -- us. J-Link's gdb-server
        // has a single RTT telnet port and selects the channel with a magic string sent within the
        // first few milliseconds of connecting; that string is meaningless to our own server.
        //
        // Sending it anyway was not merely useless. It arrived as ordinary client input, went down the
        // funnel as RTT *input*, and `fill_down_channel` wrote its 35 bytes to an address derived from
        // memory that was never a descriptor -- `X804a1c,23:$$SEGGER_TELNET_ConfigStr=RTTCh;0$$`, to
        // which the gdb-server replied `OK`. Observed on hardware as a mysterious "35 down" on a
        // firmware with no down channels at all.
        if (mySession.config.servertype === "jlink" && !builtin) {
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
                if (!builtin) {
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
