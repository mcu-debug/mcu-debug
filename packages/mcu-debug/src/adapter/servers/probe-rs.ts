import { DebugProtocol } from "@vscode/debugprotocol";
import { ConfigurationArguments, GDBServerController, SWOConfigureEvent, TcpPortDef, TcpPortDefMap, createPortName, genDownloadCommands, getGDBSWOInitCommands } from "./common";
import { EventEmitter } from "events";

export class ProbeRsServerController extends EventEmitter implements GDBServerController {
    public readonly name: string = "probe-rs";
    public readonly portsNeeded: string[] = ["gdbPort", "consolePort", "swoPort"];

    private args = {} as ConfigurationArguments;
    public ports: TcpPortDefMap = {};

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
            `target-select extended-remote localhost:${gdbport}`,
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

    public swoAndRTTCommands(): string[] {
        const commands: string[] = [];
        if (this.args.swoConfig.enabled) {
            const swocommands = this.SWOConfigurationCommands();
            commands.push(...swocommands);
        }
        return commands;
    }

    private SWOConfigurationCommands(): string[] {
        const commands = getGDBSWOInitCommands(this.args.swoConfig);
        return commands.map((c) => `interpreter-exec console "${c}"`);
    }

    public serverExecutable(): string {
        const exeName = "probe-rs";
        const ret = this.args.serverpath ? this.args.serverpath : exeName;
        return ret;
    }

    public allocateRTTPorts(): Promise<void> {
        return Promise.resolve();
    }

    public serverArguments(): string[] {
        const gdbport = this.ports["gdbPort"].remotePort;
        const telnetport = this.ports["consolePort"].remotePort;

        let serverargs = ["gdb", "--non-interactive", `--gdb-connection-string=127.0.0.1:${gdbport}`];

        if (this.args.interface) {
            serverargs.push("--protocol");
            serverargs.push(this.args.interface);
        }

        if (this.args.serialNumber) {
            serverargs.push("--probe");
            serverargs.push(this.args.serialNumber);
        }

        if (this.args.device) {
            serverargs.push("--chip");
            serverargs.push(this.args.device);
        }

        if (this.args.serverArgs) {
            serverargs = serverargs.concat(this.args.serverArgs);
        }
        return serverargs;
    }

    public initMatch(): RegExp {
        return /Firing up GDB/;
    }

    public serverLaunchStarted(): void { }
    public serverLaunchCompleted(): void { }

    public debuggerLaunchStarted(): void { }
    public debuggerLaunchCompleted(): void { }
}

