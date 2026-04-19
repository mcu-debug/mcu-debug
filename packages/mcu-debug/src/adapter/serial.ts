import * as fs from "fs";
import * as os from "os";
import * as tmp from "tmp";
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { ConfigurationArguments, getHelperExecutable, SerialConfig } from "./servers/common";
import * as child_process from "child_process";
import { GDBDebugSession } from "./gdb-session";
import { Stderr, Stdout } from "./gdb-mi/mi-types";

interface SerialPortMap {
    path: string;
    tcp_port: number;
}

type SerialPortMapList = SerialPortMap[];

export class SerialHelper {
    private args: ConfigurationArguments;
    private childProcess: child_process.ChildProcess | null = null;
    private stdoutBuffer: string = "";
    private doneParsingStdout: boolean = false;
    private pathDict: { [key: string]: SerialParams } = {};

    constructor(private session: GDBDebugSession) {
        this.args = session.args;
        const serialConfig = this.args.serialConfig as any as SerialConfig | undefined;
        const ports: SerialParams[] = [];
        if (serialConfig?.enabled && ports && ports.length > 0) {
            for (const portConfig of ports) {
                if (!portConfig.path || !portConfig.decoders || portConfig.decoders.length === 0) {
                    this.session.handleMsg(Stderr, `Invalid serial port configuration: ${JSON.stringify(portConfig)}. Each port must have a path and at least one decoder configured. This port configuration will be ignored.`);
                } else {
                    this.pathDict[portConfig.path] = portConfig;
                    ports.push(portConfig);
                }
            }
            serialConfig.ports = ports;
        }
        if (!serialConfig || !serialConfig.enabled || !serialConfig.ports || serialConfig.ports.length === 0) {
            if (serialConfig) {
                delete this.args.serialConfig;
            }
            return;
        }
    }

    private handleError(message: string) {
        this.session.handleMsg(Stderr, message);
    }
    private handleMessage(message: string) {
        this.session.handleMsg(Stdout, message);
    }

    public createConfigJSON(): string {
        const serialConfig = this.args.serialConfig;
        if (!serialConfig || !serialConfig.enabled) {
            return "";
        }
        const params: SerialParams[] = [];
        for (const portConfig of serialConfig.ports) {
            this.pathDict[portConfig.path] = portConfig;
            portConfig.tcp_port = 0;    // This must be zero, let the helper assign an available port and report it back to us
            const tmp = {
                ...portConfig
            };
            delete tmp.decoders;
            params.push(tmp);
        }
        return JSON.stringify(params, null, 2);
    }

    private handleSerialConfig() {
        try {
            if (!this.args.serialConfig) {
                return;
            }
            const helperExe = getHelperExecutable(this.args.extensionPath);
            try {
                const jsonString = this.createConfigJSON();
                if (!jsonString) {
                    return;
                }
                const tmpFile = tmp.fileSync({ postfix: ".tmp", prefix: "mcu-debug-helper-serial", dir: os.tmpdir() });
                fs.writeFileSync(tmpFile.name, jsonString, "utf-8");
                try {
                    this.handleMessage(`Starting mcu-debug-helper for serial configuration with config file ${tmpFile.name}`);
                    const process = child_process.spawn(helperExe, ["serial", "-j", tmpFile.name]);
                    process.on("error", (err) => {
                        this.handleError(`Failed to start mcu-debug-helper for serial configuration. Serial features will be unavailable. Please report this problem if you intend to use serial features. Error: ${err}`);
                    });
                    process.on("exit", (code, signal) => {
                        if (code !== 0) {
                            this.handleError(`mcu-debug-helper for serial configuration exited with code ${code} and signal ${signal}. Serial features may be unavailable. Please report this problem if you intend to use serial features.`);
                        } else {
                            this.handleMessage(`mcu-debug-helper for serial configuration exited successfully.`);
                        }
                    });
                    process.on("spawn", () => {
                        this.handleMessage(`mcu-debug-helper for serial configuration started successfully.`);
                        this.childProcess = process;
                    });
                    process.stderr.on("data", (data) => {
                        this.handleError(`mcu-debug-helper for serial configuration error: ${data.toString()}`);
                    });
                    process.stdout.on("data", (data) => {
                        this.handleStdout(data);
                    });
                }
                catch (e) {
                    this.handleError(`Failed to start mcu-debug-helper for serial configuration. Serial features will be unavailable. Please report this problem if you intend to use serial features. Error: ${e}`);
                }
            } catch (e) {
                this.handleError(`Failed to create/write temporary file for serial configuration. Serial features will be unavailable. Please report this problem if you intend to use serial features. Error: ${e}`);
            }
        } catch (e) {
            this.handleError(`mcu-debug-helper executable not found or not usable. Serial features will be unavailable. Please report this problem if you intend to use serial features. Error: ${e}`);
        }
    }

    private handleStdout(data: Buffer) {
        const buffer = data.toString();
        this.handleMessage(`mcu-debug-helper for serial configuration output: ${buffer}`);
        this.stdoutBuffer += buffer;
        let newlineIndex: number;
        while (!this.doneParsingStdout && (newlineIndex = this.stdoutBuffer.indexOf("\n")) >= 0) {
            const line = this.stdoutBuffer.substring(0, newlineIndex).trim();
            if (line) {
                try {
                    this.applySerialHelperOutput(line);
                } catch (e) {
                    this.handleError(`Received malformed-JSON output from mcu-debug-helper for serial configuration: ${line}`);
                    this.stdoutBuffer = this.stdoutBuffer.substring(newlineIndex + 1);
                    continue;
                }
            }
        }
    }

    public applySerialHelperOutput(line: string) {
        const obj = JSON.parse(line) as SerialPortMapList;
        for (const portMap of obj) {
            const config = this.pathDict[portMap.path];
            if (config) {
                const port = this.pathDict[portMap.path];
                if (port) {
                    port.tcp_port = portMap.tcp_port;
                    this.handleMessage(`Serial port ${port.path} is available at TCP port ${port.tcp_port}`);
                } else {
                    this.handleError(`Received TCP port mapping for unknown serial path ${portMap.path}`);
                }
            } else {
                this.handleError(`Received TCP port mapping for unconfigured serial path ${portMap.path}`);
            }
            this.doneParsingStdout = true;
            break;
        }
    }

    public dispose() {
        if (this.childProcess) {
            if (this.childProcess.stdin?.writable) {
                this.childProcess.stdin.end();
            }
            this.childProcess.kill();
            this.childProcess = null;
        }
    }
}
