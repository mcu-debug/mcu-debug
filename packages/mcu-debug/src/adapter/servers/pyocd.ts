import { DebugProtocol } from "@vscode/debugprotocol";
import { ConfigurationArguments, GDBServerController, RTTServerHelper, SWOConfigureEvent, SessionMode, TcpPortDef, TcpPortDefMap, createPortName, genDownloadCommands, getGDBSWOInitCommands } from "./common";
import { EventEmitter } from "events";

export class PyOCDServerController extends EventEmitter implements GDBServerController {
    public readonly name: string = "PyOCD";
    public readonly portsNeeded: string[] = ["gdbPort", "consolePort", "swoPort"];

    private args = {} as ConfigurationArguments;
    public ports: TcpPortDefMap = {};
    private rttHelper: RTTServerHelper = new RTTServerHelper();

    constructor() {
        super();
    }

    public setArguments(args: ConfigurationArguments): void {
        this.args = args;
    }

    public customRequest(command: string, response: DebugProtocol.Response, args: any): boolean {
        return false;
    }

    public connectCommands(): string[] {
        const gdbport = this.ports[createPortName(this.args.targetProcessor)].localPort;

        return [
            `target-select extended-remote 127.0.0.1:${gdbport}`,
            // Following needed for SWO and accessing some peripherals.
            // Generally not a good thing to do
            'interpreter-exec console "set mem inaccessible-by-default off"',
        ];
    }

    public launchCommands(): string[] {
        const commands = [...genDownloadCommands(this.args, ['interpreter-exec console "monitor reset halt"']), 'interpreter-exec console "monitor reset halt"'];
        return commands;
    }

    public attachCommands(): string[] {
        const commands = ['interpreter-exec console "monitor halt"'];
        return commands;
    }

    public resetCommands(): string[] {
        const commands: string[] = ['interpreter-exec console "monitor reset"'];
        return commands;
    }

    public rttCommands(): string[] {
        const commands: string[] = [];
        const usingRtt = this.args.rttConfig.enabled && !this.args.rttConfig.useBuiltinRTT?.enabled;
        if (usingRtt && this.args.pvtSessionMode !== SessionMode.Reset) {
            const cfg = this.args.rttConfig;
            if (this.args.request === "launch" && cfg.clearSearch) {
                // The RTT control block may contain a valid search string from a previous run
                // and RTT ends up outputting garbage. Or, the server could read garbage and
                // misconfigure itself. Following will clear the RTT header which
                // will cause the server to wait for the server to actually be initialized
                // TODO: get the actual monitor command to write to memory
                // commands.push(`interpreter-exec console "monitor mwb ${cfg.address} 0 ${cfg.searchId?.length}"`);
            }
            commands.push(`interpreter-exec console "monitor rtt setup ${cfg.address} ${cfg.searchSize} \\\"${cfg.searchId}\\\""`);
            /*
            * TODO: FInd out if pyocd has a way to configure the RTT polling interval
            if ((cfg.polling_interval ?? 0) > 0) {
                commands.push(`interpreter-exec console "monitor rtt polling_interval ${cfg.polling_interval}"`);
            }
            */

            // tslint:disable-next-line: forin
            for (const channel in this.rttHelper.rttLocalPortMap) {
                const tcpPort = this.rttHelper.rttLocalPortMap[channel];
                commands.push(`interpreter-exec console "monitor rtt server start ${tcpPort} ${channel}"`);
            }

            // Hopefully this server self polls for RTT data
            commands.push('interpreter-exec console "monitor rtt start"');
            /*
            if (this.args.rttConfig.rtt_start_retry === undefined) {
                this.args.rttConfig.rtt_start_retry = 1000;
            }
            */
        }
        return commands;
    }

    public swoAndRTTCommands(): string[] {
        const commands: string[] = [];
        if (this.args.swoConfig.enabled) {
            const swocommands = this.SWOConfigurationCommands();
            commands.push(...swocommands);
        }
        return commands.concat(this.rttCommands());
    }

    private SWOConfigurationCommands(): string[] {
        const commands = getGDBSWOInitCommands(this.args.swoConfig);
        return commands.map((c) => `interpreter-exec console "${c}"`);
    }

    public serverExecutable(): string {
        const exeName = "pyocd";
        const ret = this.args.serverpath ? this.args.serverpath : exeName;
        return ret;
    }

    public allocateRTTPorts(): Promise<void> {
        return this.rttHelper.allocateRTTPorts(this.args.rttConfig);
    }

    public serverArguments(): string[] {
        const gdbport = this.ports["gdbPort"].remotePort;
        const telnetport = this.ports["consolePort"].remotePort;

        let serverargs = ["gdbserver", "--port", gdbport.toString(), "--telnet-port", telnetport.toString()];

        if (this.args.boardId) {
            serverargs.push("--board");
            serverargs.push(this.args.boardId);
        }

        if (this.args.targetId) {
            serverargs.push("--target");
            serverargs.push(this.args.targetId.toString());
        }

        if (this.args.cmsisPack) {
            serverargs.push("--pack");
            serverargs.push(this.args.cmsisPack.toString());
        }

        if (this.args.swoConfig.enabled) {
            const source = this.args.swoConfig.source;
            if (source === "probe" || source === "socket" || source === "file") {
                const swoPort = this.ports[createPortName(this.args.targetProcessor, "swoPort")].remotePort;
                const cpuF = this.args.swoConfig.cpuFrequency;
                const swoF = this.args.swoConfig.swoFrequency || "1";
                const args = ["-O", "enable_swv=1", "-O", "swv_raw_enable=true", "-O", `swv_raw_port=${swoPort}`, "-O", `swv_system_clock=${cpuF}`, "-O", `swv_clock=${swoF}`];
                serverargs.push(...args);
            }
        }

        if (this.args.serverArgs) {
            serverargs = serverargs.concat(this.args.serverArgs);
        }
        return serverargs;
    }

    public initMatch(): RegExp {
        return /GDB server (listening|started) (at|on) port/;
    }

    public serverLaunchStarted(): void { }
    public serverLaunchCompleted(): void {
        if (this.args.swoConfig.enabled) {
            const source = this.args.swoConfig.source;
            if (source === "probe" || source === "socket" || source === "file") {
                const swoPortNm = createPortName(this.args.targetProcessor, "swoPort");
                this.emit(
                    "event",
                    new SWOConfigureEvent({
                        type: "socket",
                        args: this.args,
                        port: this.ports[swoPortNm].localPort.toString(10),
                    }),
                );
            } else if (source === "serial") {
                this.emit(
                    "event",
                    new SWOConfigureEvent({
                        type: "serial",
                        args: this.args,
                        device: this.args.swoConfig.source,
                        baudRate: this.args.swoConfig.swoFrequency,
                    }),
                );
            }
        }
    }

    public debuggerLaunchStarted(): void { }
    public debuggerLaunchCompleted(): void { }
}
