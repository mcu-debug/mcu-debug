import * as net from "net";
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createTerminalUniqueName, getUUid, ManagedTabConsole } from "./views/ManagedTab";
import { magentaWrite } from "./ansi-helpers";
import { getAnyFreePort } from "../adapter/servers/common";

//      vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'myName' });

let consoleLogFd = -1;
export class GDBServerConsoleInstance {
    protected static allConsoles: GDBServerConsoleInstance[] = [];
    public terminal: ManagedTabConsole | null = null;
    protected toBackend: net.Socket | null = null;

    constructor() {
    }

    public static disposeAll() {
        const saved = GDBServerConsoleInstance.allConsoles;
        GDBServerConsoleInstance.allConsoles = [];
        for (const c of saved) {
            if (c.toBackend) {
                c.toBackend.destroy();
                c.toBackend = null;
            }
        }
    }

    public newBackendConnection(socket: net.Socket) {
        this.createAndShowTerminal();
        this.toBackend = socket;
        if (!this.terminal) {
            throw new Error("PTY terminal not created");
        }
        this.terminal?.enableInput();
        this.terminal?.setState({ kind: "active" });
        this.clearTerminal();
        this.debugMsg('onBackendConnect: gdb-server session connected. You can switch to "DEBUG CONSOLE" to see GDB interactions.');
        socket.setKeepAlive(true);
        socket.on("close", () => {
            this.debugMsg("onBackendConnect: gdb-server session closed");
            magentaWrite("GDB server session ended. This terminal will be reused, waiting for next session to start...", this.terminal!);
            this.toBackend = null;
            this.freeTerminal();
        });
        socket.on("data", (data) => {
            this.terminal?.send(data.toString());
            this.logData(data);
        });
        socket.on("error", (e) => {
            this.debugMsg(`GDBServerConsole: onBackendConnect: gdb-server program client error ${e}`);
            this.toBackend = null;
            this.freeTerminal();
        });
    }

    private freeTerminal() {
        if (this.terminal) {
            this.terminal.disableInput();
            this.terminal.setState({ kind: "inactive" });
            this.terminal.removeAllListeners();
            this.terminal = null;
        }
    }

    public isClosed() {
        return this.toBackend === null;
    }

    protected createAndShowTerminal() {
        if (!this.terminal) {
            this.setupTerminal();
        }
    }

    public clearTerminal() {
        this.terminal?.clear();
    }

    private setupTerminal() {
        const baseName = "gdb-server";
        const uuid = getUUid(baseName);
        const [name, terminal, isNew] = createTerminalUniqueName(baseName, (nm: string) => {
            const ret = new ManagedTabConsole(uuid, nm, "console", "both", "Enter input for gdb-server");
            return ret;
        });
        this.terminal = terminal;
        this.terminal?.setState({ kind: "inactive" });
        this.terminal?.clear();
        this.terminal?.setLabel(name);
        this.terminal.addCloseHandler(() => {
            this.onTerminalClosed();
        });
        this.terminal.on("data", (data) => {
            this.sendToBackend(data);
        });
        if (this.toBackend === null) {
            magentaWrite("Waiting for gdb server to start...\n", this.terminal);
            this.terminal.disableInput();
        } else {
            magentaWrite("Resuming connection to gdb server...\n", this.terminal);
            this.terminal.enableInput();
        }
    }

    private onTerminalClosed() {
        this.terminal = null;
        if (this.toBackend) {
            // Let the terminal close completely and try to re-launch
            setTimeout(() => {
                vscode.window.showInformationMessage("gdb-server terminal closed unexpectedly. Trying to reopen it");
                this.setupTerminal();
            }, 100);
        }
    }

    public sendToBackend(data: string | Buffer) {
        if (this.toBackend) {
            this.toBackend.write(data.toString());
            this.toBackend.uncork();
        }
    }

    public logData(data: Buffer | string) {
        GDBServerConsole.logDataStatic(data);
    }

    public debugMsg(msg: string) {
        GDBServerConsole.debugMsgStatic(this.terminal, msg);
    }
}

export class GDBServerConsole {
    protected toBackendServer: net.Server | null = null;
    protected toBackend: net.Socket | null = null;
    protected toBackendPort: number = -1;
    protected logFName = "";
    protected allConsoles: GDBServerConsoleInstance[] = [];
    public static BackendPort: number = -1;

    constructor(
        public context: vscode.ExtensionContext,
        public logFileName = "",
    ) {
        this.createLogFile(logFileName);
    }

    public createLogFile(logFileName: string) {
        this.logFName = logFileName;
        const showErr = !!this.logFName;

        if (consoleLogFd >= 0) {
            try {
                fs.closeSync(consoleLogFd);
            } finally {
                consoleLogFd = -1;
            }
        }

        try {
            if (this.logFName) {
                const dir = path.dirname(this.logFName);
                if (dir) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                this.logFName = this.logFName.replace("${PID}", process.pid.toString());
            } else {
                const tmpdir = os.tmpdir();
                this.logFName = `${tmpdir}/gdb-server-console-${process.pid}.log`;
            }
            consoleLogFd = fs.openSync(this.logFName, "w");
        } catch (error) {
            if (showErr) {
                vscode.window.showErrorMessage(`Could not open log file: ${this.logFName}\n${error}`);
            }
        }
    }

    public isServerAlive() {
        return this.toBackendServer !== null;
    }

    public static debugMsgStatic(console: ManagedTabConsole | null, msg: string) {
        const date = new Date();
        msg = `[${date.toISOString()}] SERVER CONSOLE DEBUG: ` + msg;
        // console.log(msg);
        if (console) {
            msg += msg.endsWith("\n") ? "" : "\n";
            magentaWrite(msg, console);
        }
        GDBServerConsole.logDataStatic(msg);
    }

    // Create a server for the GDBServer running in the adapter process. Any data
    // from the gdb-server (like OpenOCD) is sent here and sent to the terminal
    // and any usr input in the terminal is sent back (like semi-hosting)
    public startServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            getAnyFreePort(56878)
                .then((p) => {
                    this.toBackendPort = p;
                    const newServer = net.createServer(this.onBackendConnect.bind(this));
                    newServer.listen(this.toBackendPort, "127.0.0.1", () => {
                        this.toBackendServer = newServer;
                        GDBServerConsole.BackendPort = this.toBackendPort;
                        resolve();
                    });
                    newServer.on("error", (e) => {
                        console.error(e);
                        reject(e);
                    });
                    newServer.on("close", () => {
                        this.toBackendServer = null;
                    });
                })
                .catch((e) => {
                    reject(e);
                });
        });
    }

    // The gdb-server running in the backend (debug adapter)
    protected onBackendConnect(socket: net.Socket) {
        const inst = new GDBServerConsoleInstance();
        inst.newBackendConnection(socket);
    }

    public static logDataStatic(data: Buffer | string) {
        try {
            if (consoleLogFd >= 0) {
                fs.writeFileSync(consoleLogFd, data.toString());
                fs.fdatasyncSync(consoleLogFd);
            }
        } catch (e) {
            consoleLogFd = -1;
        }
    }

    public dispose() {
        GDBServerConsoleInstance.disposeAll();
    }
}
