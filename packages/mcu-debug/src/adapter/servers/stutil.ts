import { DebugProtocol } from "@vscode/debugprotocol";
import { GDBServerController, ConfigurationArguments, SWOConfigureEvent, createPortName, genDownloadCommands, getGDBSWOInitCommands, TcpPortDef, TcpPortDefMap } from "./common";
import * as os from "os";
import { EventEmitter } from "events";

export class STUtilServerController extends EventEmitter implements GDBServerController {
    public readonly name: string = "ST-Util";
    public readonly portsNeeded: string[] = ["gdbPort"];

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

        return [`target-select extended-remote 127.0.0.1:${gdbport}`];
    }

    public launchCommands(): string[] {
        const commands = ['interpreter-exec console "monitor halt"', ...genDownloadCommands(this.args, ['interpreter-exec console "monitor reset"']), 'interpreter-exec console "monitor reset"'];
        return commands;
    }

    public attachCommands(): string[] {
        const commands = ['interpreter-exec console "monitor halt"'];
        return commands;
    }

    public resetCommands(): string[] {
        const commands: string[] = ['interpreter-exec console "monitor halt"', 'interpreter-exec console "monitor reset"'];
        return commands;
    }

    public swoAndRTTCommands(): string[] {
        const commands: string[] = [];
        if (this.args.swoConfig.enabled && this.args.swoConfig.source !== "probe") {
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
        if (this.args.serverpath) {
            return this.args.serverpath;
        }
        return os.platform() === "win32" ? "st-util.exe" : "st-util";
    }

    public allocateRTTPorts(): Promise<void> {
        return Promise.resolve();
    }

    public serverArguments(): string[] {
        const gdbport = this.ports["gdbPort"].remotePort;

        let serverargs = ["-p", gdbport.toString(), "--no-reset"];
        if (this.args.v1) {
            serverargs.push("--stlinkv1");
        }

        if (this.args.serialNumber) {
            serverargs.push("--serial", this.args.serialNumber);
        }

        if (this.args.serverArgs) {
            serverargs = serverargs.concat(this.args.serverArgs);
        }

        return serverargs;
    }

    public initMatch(): RegExp {
        return /Listening at \*/g;
    }

    public serverLaunchStarted(): void {}
    public serverLaunchCompleted(): void {
        if (this.args.swoConfig.enabled && this.args.swoConfig.source !== "probe") {
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

    public debuggerLaunchStarted(): void {}
    public debuggerLaunchCompleted(): void {}
}
