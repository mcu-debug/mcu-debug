import { EventEmitter } from "events";
import * as child_process from "child_process";
import * as net from "net";
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
import { createPortName, GDBServerController, GenericCustomEvent, quoteShellCmdLine } from "./servers/common";
import { GdbEventNames, Stderr } from "./gdb-mi/mi-types";
import { TcpPortScanner } from "@mcu-debug/shared";
import path from "path";
import { greenFormat } from "../frontend/ansi-helpers";

const SERVER_TYPE_MAP: { [key: string]: any } = {
    jlink: JLinkServerController,
    openocd: OpenOCDServerController,
    stutil: STUtilServerController,
    stlink: STLinkServerController,
    pyocd: PyOCDServerController,
    pe: PEServerController,
    bmp: BMPServerController,
    qemu: QEMUServerController,
    external: ExternalServerController,
};

export class GDBServerSession extends EventEmitter {
    public serverController: GDBServerController;
    private process: child_process.ChildProcess | null = null;
    private consoleSocket: net.Socket | null = null;
    public ports: { [name: string]: number } = {};
    public usingParentServer: boolean = false;
    private clientRequestedStop: boolean = false;

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
            this.session.handleMsg(GdbEventNames.Console, `Starting GDB-Server: ${argsStr}`);
            this.consoleSocket?.write(greenFormat(argsStr));

            this.process = child_process.spawn(executable, args, {
                cwd: serverCwd,
                env: process.env,
                detached: true,
            });

            this.serverController.serverLaunchStarted();

            const matchRegex = this.serverController.initMatch();
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

            if (!matchRegex) {
                const timeoutMs = 2000;
                const serverType = this.session.args.servertype || "openocd";
                const gdbport = this.ports["gdbPort"];
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
                    if (resolved) {
                        killTimers();
                    }
                    this.session.handleMsg(GdbEventNames.Console, `Waiting for gdb-server to start ${++count}...\n`);
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

            const handleOutput = (data: Buffer) => {
                if (this.consoleSocket && !this.consoleSocket.destroyed) {
                    this.consoleSocket.write(data);
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

            this.process.stdout?.on("data", handleOutput);
            this.process.stderr?.on("data", handleOutput);

            this.process.on("error", (err) => {
                killTimers();
                if (!resolved) {
                    resolved = true;
                    timeout && clearTimeout(timeout);
                    reject(err);
                }
            });

            this.process.on("exit", (code, signal) => {
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
            });
        });
    }

    public async stopServer(): Promise<void> {
        this.clientRequestedStop = true;
        if (this.process) {
            // Check if process is still running before killing
            if (this.process.exitCode === null && this.process.signalCode === null) {
                this.process.kill();
            }
            this.process = null;
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
                this.ports[nm] = ports[idx++];
            }
        }
        this.session.args.pvtPorts = this.ports;
    }

    private getTCPPorts(useParent: boolean): Thenable<void> {
        return new Promise((resolve, reject) => {
            const startPort = 35000;
            if (useParent) {
                this.ports = this.session.args.pvtPorts = this.session.args.pvtParent.pvtPorts;
                this.serverController.setPorts(this.ports);
                if (this.session.args.debugFlags.anyFlags) {
                    this.session.handleMsg(Stderr, JSON.stringify({ configFromParent: this.session.args.pvtMyConfigFromParent }, undefined, 4) + "\n");
                }
                return resolve();
            }
            const totalPortsNeeded = this.calculatePortsNeeded();
            TcpPortScanner.findFreePorts(totalPortsNeeded, {
                start: startPort,
                consecutive: true,
            }).then(
                (ports) => {
                    this.createPortsMap(ports);
                    this.serverController.setPorts(this.ports);
                    resolve();
                },
                (e) => {
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
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            resolve(false);
        });
        socket.once("timeout", () => {
            resolve(false);
        });
        socket.connect(port, host);
    });
}
