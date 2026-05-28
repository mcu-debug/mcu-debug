import { EventEmitter } from "events";
import * as child_process from "child_process";
import * as net from "net";
import path from "path";
import { JLinkServerController } from "./servers/jlink";
import { OpenOCDServerController } from "./servers/openocd";
import { STUtilServerController } from "./servers/stutil";
import { STLinkServerController } from "./servers/stlink";
import { PyOCDServerController } from "./servers/pyocd";
import { BMPServerController } from "./servers/bmp";
import { PEServerController } from "./servers/pemicro";
import { QEMUServerController } from "./servers/qemu";
import { ExternalServerController } from "./servers/external";
import { GDBDebugSession } from "./gdb-session";
import { createPortName, GDBServerController, GenericCustomEvent, quoteShellCmdLine, TcpPortDef, TcpPortDefMap } from "./servers/common";
import { GdbEventNames, Stderr } from "./gdb-mi/mi-types";
import { TcpPortScanner } from "@mcu-debug/shared";
import { greenFormat } from "../common/ansi-helpers";
import { ProxyClient } from "./proxy-client";
import { ProbeRsServerController } from "./servers/probe-rs";

const SERVER_TYPE_MAP: { [key: string]: any } = {
    jlink: JLinkServerController,
    openocd: OpenOCDServerController,
    stutil: STUtilServerController,
    stlink: STLinkServerController,
    pyocd: PyOCDServerController,
    pe: PEServerController,
    bmp: BMPServerController,
    qemu: QEMUServerController,
    "probe-rs": ProbeRsServerController,
    external: ExternalServerController,
};

export class GDBServerSession extends EventEmitter {
    public serverController: GDBServerController;
    private process: child_process.ChildProcess | null = null;
    private consoleSocket: net.Socket | null = null;
    public ports: TcpPortDefMap = {};
    public usingParentServer: boolean = false;
    private clientRequestedStop: boolean = false;
    private proxyClient: ProxyClient | null = null;

    constructor(private session: GDBDebugSession) {
        super();
        const serverType = session.args.servertype || "openocd";
        const ServerControllerClass = SERVER_TYPE_MAP[serverType.toLowerCase()];
        if (!ServerControllerClass) {
            throw new Error(`Unsupported server type: ${serverType}`);
        }
        this.serverController = new ServerControllerClass();
        this.serverController.setArguments(session.args);
    }

    private async connectConsole(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.consoleSocket = new net.Socket();
            this.consoleSocket.connect(port, "127.0.0.1", () => {
                resolve();
            });
            this.consoleSocket.on("error", (e) => {
                reject(e);
            });
        });
    }

    public async startServer(): Promise<void> {
        if (this.session.args.servertype === "external") {
            return;
        }

        if (this.session.args.hostConfig) {
            this.proxyClient = new ProxyClient(this.session, this);
            try {
                await this.proxyClient.start();
            } catch (e: any) {
                throw new Error(`Failed to connect to proxy server: ${e}`);
            }
        }

        try {
            this.usingParentServer = this.session.args.pvtMyConfigFromParent && !this.session.args.pvtMyConfigFromParent.detached;
            await this.getTCPPorts(this.usingParentServer);
            await this.serverController.allocateRTTPorts(); // Must be done before serverArguments()
        } catch (e: any) {
            throw new Error(`Error allocating TCP ports for gdb-server: ${e.message}`);
        }

        const executable = this.usingParentServer ? null : this.serverController.serverExecutable();
        const args = this.usingParentServer ? [] : this.serverController.serverArguments();
        this.session.sendEvent(new GenericCustomEvent("ports-done", undefined)); // Should be no more TCP ports allocation

        if (!executable) {
            return;
        }

        const serverCwd = this.getServerCwd(executable);
        return new Promise<void>(async (resolve, reject) => {
            // Connect to the frontend console
            if (this.session.args.gdbServerConsolePort) {
                try {
                    await this.connectConsole(this.session.args.gdbServerConsolePort);
                } catch (e: any) {
                    this.session.handleMsg(GdbEventNames.Stderr, `Could not connect to debug console: ${e.message}\n`);
                    reject(e);
                    return;
                }
            }

            const argsStr = quoteShellCmdLine([executable]) + " " + args.map((a) => quoteShellCmdLine([a])).join(" ") + "\n ";
            this.session.handleMsg(GdbEventNames.Stderr, `Starting GDB-Server: ${argsStr}`);
            if (!this.session.args.isCli) {
                this.consoleSocket?.write(greenFormat(argsStr));
            }
            const matchRegex = this.serverController.initMatch();

            if (this.proxyClient) {
                this.session.handleMsg(GdbEventNames.Stderr, "Starting gdb-server via proxy...\n");
                try {
                    this.proxyClient.on("streamStarted", (data: TcpPortDef) => {
                        if (data.name.startsWith("gdb")) {
                            this.session.handleMsg(GdbEventNames.Stderr, `GDB-Server stream ready on port server ${data.remotePort}\n`);
                            resolved = true;
                            resolve();
                        }
                    });
                    this.proxyClient?.on("serverExited", (code: number, signal: NodeJS.Signals) => {
                        serverExited(code, signal);
                    });
                    await this.proxyClient.launchServer(executable, args, serverCwd, matchRegex ? [matchRegex] : []);
                } catch (e: any) {
                    reject(new Error(`Failed to launch gdb-server via proxy: ${e.message}`));
                    return;
                }
            } else {
                const env = { ...process.env, ...(this.session.args.env || {}) };
                this.process = child_process.spawn(executable, args, {
                    cwd: serverCwd,
                    env: env,
                    detached: true,
                });
            }

            this.serverController.serverLaunchStarted();

            let timer: NodeJS.Timeout | null = null;
            let timeout: NodeJS.Timeout | null = null;
            let resolved = false;
            const killTimers = () => {
                if (timer) {
                    clearInterval(timer);
                    timer = null;
                }
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
            };

            if (!matchRegex && !this.proxyClient) {
                const timeoutMs = 2000;
                const serverType = this.session.args.servertype || "openocd";
                const gdbport = this.ports["gdbPort"]?.localPort;
                if (gdbport && serverType.toLowerCase() === "qemu") {
                    // We don't care about the result, just wait and bail early if listening
                    await isPortListening(gdbport, timeoutMs);
                    this.serverController.serverLaunchCompleted();
                    resolve();
                } else {
                    setTimeout(() => {
                        // No match needed, resolve immediately
                        this.serverController.serverLaunchCompleted();
                        resolved = true;
                        resolve();
                    }, timeoutMs);
                }
            } else {
                let count = 0;
                timer = setInterval(() => {
                    if (resolved || this.clientRequestedStop) {
                        killTimers();
                    }
                    this.session.handleMsg(GdbEventNames.Stderr, `Waiting for gdb-server to start ${++count}...\n`);
                }, 5000);

                timeout = setTimeout(
                    () => {
                        if (this.process) {
                            this.process.kill();
                        }
                        if (!resolved) {
                            resolved = true;
                            reject(new Error("Timeout waiting for gdb-server to start"));
                        }
                    },
                    5 * 60 * 1000,
                );
            }

            if (this.process) {
                const handleOutput = (data: Buffer, doConsole: boolean) => {
                    if (doConsole) {
                        this.writeToConsole(data);
                    }

                    if (matchRegex && !resolved) {
                        const str = data.toString();
                        if (matchRegex.test(str)) {
                            resolved = true;
                            killTimers();
                            this.serverController.serverLaunchCompleted();
                            resolve();
                        }
                    }
                };
                // If we are in CLI mode, both gdb and servers output goes to the same console. So it would create
                // duplicaes if we write both to console. So only write server output to console when not in CLI mode.
                const doConsoleForStdout = this.session.args.isCli ? false : true;
                this.process.stdout?.on("data", (data) => handleOutput(data, doConsoleForStdout));
                this.process.stderr?.on("data", (data) => handleOutput(data, true));

                this.process.on("error", (err) => {
                    killTimers();
                    if (!resolved) {
                        resolved = true;
                        timeout && clearTimeout(timeout);
                        reject(err);
                    }
                });

                this.process.on("exit", (code, signal) => {
                    serverExited(code, signal);
                });
            }

            const serverExited = (code: number | null, signal: NodeJS.Signals | null) => {
                killTimers();
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Server exited with code ${code}`));
                } else if (!this.clientRequestedStop) {
                    this.emit("server-exited", code, signal);
                }
                this.process = null;
                if (this.consoleSocket) {
                    this.consoleSocket.destroy();
                    this.consoleSocket = null;
                }
            };
        });
    }

    public writeToConsole(data: Buffer) {
        if (this.consoleSocket && !this.consoleSocket.destroyed) {
            this.consoleSocket.write(data);
        }
    }

    public async stopServer(): Promise<void> {
        this.clientRequestedStop = true;
        if (this.process) {
            // Check if process is still running before killing
            if (this.process.exitCode === null && this.process.signalCode === null) {
                this.process.kill();
            }
            this.process = null;
        } else if (this.proxyClient) {
            try {
                const tmp = this.proxyClient;
                this.proxyClient = null;
                await tmp.stop();
            } catch (e: any) {
                this.session.handleMsg(Stderr, `Error stopping gdb-server via proxy: ${e.message}\n`);
            }
        }
        if (this.consoleSocket) {
            this.consoleSocket.destroy();
            this.consoleSocket = null;
        }
    }

    // When we have a multi-core device, we have to allocate as many ports as needed
    // for each core. As of now, we can only debug one core at a time but we have to know
    // which one. This is true of OpenOCD and pyocd but for now, we apply the policy for all
    // This was only needed because gdb-servers allow a port setting for the first core, but
    // then they increment for additional cores.
    private calculatePortsNeeded() {
        const portsNeeded = this.serverController.portsNeeded.length;
        const numProcs = Math.max(this.session.args.numberOfProcessors ?? 1, 1);
        let targProc = this.session.args.targetProcessor || 0;
        if (targProc < 0 || targProc >= numProcs) {
            targProc = numProcs - 1; // Use the last processor as it likely has the main application
            this.session.handleMsg(Stderr, `launch.json: 'targetProcessor' must be >= 0 && < 'numberOfProcessors'. Setting it to ${targProc}` + "\n");
        }
        const totalPortsNeeded = portsNeeded * numProcs;
        this.session.args.numberOfProcessors = numProcs;
        this.session.args.targetProcessor = targProc;
        return totalPortsNeeded;
    }

    private createPortsMap(ports: number[]) {
        const numProcs = this.session.args.numberOfProcessors;
        this.ports = {};
        let idx = 0;
        // Ports are allocated so that all ports of same type come consecutively, then next and
        // so on. This is the method used by most gdb-servers.
        for (const pName of this.serverController.portsNeeded) {
            for (let proc = 0; proc < numProcs; proc++) {
                const nm = createPortName(proc, pName);
                this.ports[nm] = new TcpPortDef(nm, ports[idx], ports[idx]);
                idx++;
            }
        }
        this.session.args.pvtPorts = this.ports;
    }

    private getTCPPorts(useParent: boolean): Thenable<void> {
        return new Promise((resolve, reject) => {
            const startPort = 35000;
            if (useParent) {
                this.ports = this.session.args.pvtPorts = this.session.args.pvtParent.pvtPorts;
                this.serverController.ports = this.ports;
                if (this.session.args.debugFlags.anyFlags) {
                    this.session.handleMsg(Stderr, JSON.stringify({ configFromParent: this.session.args.pvtMyConfigFromParent }, undefined, 4) + "\n");
                }
                return resolve();
            }
            const totalPortsNeeded = this.calculatePortsNeeded();
            const needConsecutive = this.proxyClient ? false : true; // If using proxy, we don't require consecutive ports as proxy will handle the mapping
            TcpPortScanner.findFreePorts(totalPortsNeeded, {
                start: startPort,
                consecutive: needConsecutive,
            }).then(
                (ports) => {
                    this.createPortsMap(ports);
                    if (this.proxyClient) {
                        this.proxyClient.allocatePorts(this.ports).then(
                            (ports: { [key: string]: TcpPortDef }) => {
                                this.ports = ports;
                                this.serverController.ports = ports;
                                if (this.session.args.debugFlags.anyFlags) {
                                    this.session.handleMsg(Stderr, `Allocated TCP ports for gdb-server via proxy: ${JSON.stringify(ports)}\n`);
                                }
                                resolve();
                            },
                            (e: any) => {
                                reject(e);
                            },
                        );
                    } else {
                        this.serverController.ports = this.ports;
                        if (this.session.args.debugFlags.anyFlags) {
                            this.session.handleMsg(Stderr, `Allocated TCP ports for gdb-server: ${JSON.stringify(this.ports)}\n`);
                        }
                        resolve();
                    }
                },
                (e: any) => {
                    reject(e);
                },
            );
        });
    }

    //
    // Following function should never exist. The only way ST tools work is if the are run from the dir. where the
    // executable lives. Tried setting LD_LIBRARY_PATH, worked for some people and broke other peoples environments.
    // Normally, we NEED the server's CWD to be same as what the user wanted from the config. Because this where
    // the server scripts (OpenOCD, JLink, etc.) live and changing cwd for all servers will break for other servers
    // that are not so quirky.
    //
    private getServerCwd(serverExe: string) {
        let serverCwd = this.session.args.cwd || process.cwd();
        if (this.session.args.serverCwd) {
            serverCwd = this.session.args.serverCwd;
        } else if (this.session.args.servertype === "stlink") {
            serverCwd = path.dirname(serverExe) || ".";
            if (serverCwd !== ".") {
                this.session.handleMsg(Stderr, `Setting GDB-Server CWD: ${serverCwd}\n`);
            }
        }
        return serverCwd;
    }
}

// Helper function to see if a TCP port is listening
async function isPortListening(port: number, timeoutMs: number, host: string = "127.0.0.1"): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            const socket = new net.Socket();
            socket.once("connect", () => {
                socket.destroy();
                clearInterval(timer);
                resolve(true);
            });
            socket.once("error", () => {
                clearInterval(timer);
                resolve(false);
            });
            socket.connect(port, host);
        }, 100);

        setTimeout(() => {
            clearInterval(timer);
            resolve(false);
        }, timeoutMs);
    });
}
