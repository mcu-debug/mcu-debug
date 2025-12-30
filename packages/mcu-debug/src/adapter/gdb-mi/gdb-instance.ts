import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { parseGdbMiOut } from "./mi-parser";
import { GdbEventNames, GdbMiOutputType, GdbMiRecord, Stderr, Stdout, Console, GdbMiOutput } from "./mi-types";
import { GdbMiRecordType } from "./mi-types";
import { ServerConsoleLog } from "../server-console-log";
import { receiveMessageOnPort } from "worker_threads";

class PendingCmdPromise {
    constructor(
        public readonly seq: number,
        public readonly resolve: (value: GdbMiRecord) => void,
        public readonly reject: (reason?: any) => void,
    ) {}
}

export class GdbInstance extends EventEmitter {
    // ... other methods and properties ...
    pid: number = 0;
    process: ChildProcess | null = null;
    public debugMiOutput: boolean = false;
    private cmdSeq: number = 1;
    private pendingCmds: Map<number, PendingCmdPromise> = new Map();
    private capturedStdout: string[] = [];
    private captureStdoutMode: boolean = false;
    public status: "running" | "stopped" | "none" = "none";
    gdbMajorVersion: number = 0;
    gdbMinorVersion: number = 0;

    constructor(
        private gdbPath: string,
        private gdbArgs: string[] = [],
    ) {
        super();
    }

    start(cwd: string | undefined, init: string[], timeout: number = 1000, checkVers = true): Promise<void> {
        return new Promise((resolve, reject) => {
            const doInitCmds = () => {
                const promises = [];
                for (const cmd of init) {
                    promises.push(this.sendCommand(cmd, timeout));
                }
                Promise.all(promises)
                    .then(() => {
                        resolve();
                    })
                    .catch((err) => {
                        reject(err);
                    });
            };

            ServerConsoleLog(`Starting GDB: ${this.gdbPath} ${this.gdbArgs.join(" ")}, cwd=${cwd}`);
            const child = spawn(this.gdbPath, this.gdbArgs, { cwd: cwd, env: process.env });
            this.process = child;
            this.pid = child.pid!;
            ServerConsoleLog(`Started GDB: PID=${this.pid}`);
            child.on("exit", this.handleExit.bind(this));
            child.on("error", this.handleError.bind(this));
            child.stderr.on("data", this.handleStderrData.bind(this));
            child.stdout.on("data", this.handleStdoutData.bind(this));

            if (!checkVers) {
                this.captureStdoutMode = true;
                this.sendCommand("-gdb-version", timeout)
                    .then(() => {
                        this.parseVersionInfo();
                        doInitCmds();
                    })
                    .catch(() => {
                        this.captureStdoutMode = false;
                        reject(new Error("GDB did not respond to -gdb-version command"));
                    });
            } else {
                doInitCmds();
            }
        });
    }

    public log(type: GdbEventNames, msg: string): void {
        this.emit("msg", type, msg);
    }

    private parseVersionInfo() {
        const regex = RegExp(/^GNU gdb.*\s(\d+)\.(\d+)[^\r\n]*/gm);
        for (const str of this.capturedStdout) {
            const match = regex.exec(str);
            if (match !== null) {
                this.gdbMajorVersion = parseInt(match[1]);
                this.gdbMinorVersion = parseInt(match[2]);
                if (this.gdbMajorVersion < 9 || (this.gdbMajorVersion === 9 && this.gdbMinorVersion < 1)) {
                    this.log(GdbEventNames.Stderr, `ERROR: GDB version ${this.gdbMajorVersion}.${this.gdbMinorVersion} is not supported. Please upgrade to GDB version 9.1 or higher.`);
                    this.log(GdbEventNames.Stderr, "    This can result in silent failures");
                }
                this.captureStdoutMode = false;
                this.capturedStdout = [];
                return;
            }
        }
        this.log(Stderr, "ERROR: Could not determine gdb-version number (regex failed). We need version >= 9.1. Please report this problem.");
        this.log(Stderr, "    This can result in silent failures");
        this.captureStdoutMode = false;
        this.capturedStdout = [];
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null) {
        this.process = null;
        this.emit("exit", code, signal);
    }

    private handleError(code: number | null, signal: NodeJS.Signals | null) {
        this.emit("error", code, signal);
    }

    private stdoutBuf: string = "";
    private handleStdoutData(data: Buffer) {
        // Implementation to handle data from GDB stdout
        const str = data.toString();
        this.stdoutBuf += str;
        let index: number;
        while ((index = this.stdoutBuf.indexOf("\n")) >= 0) {
            const line = this.stdoutBuf.slice(0, index).trim();
            this.stdoutBuf = this.stdoutBuf.slice(index + 1);
            this.handleOutputLine(line);
        }
    }

    private stderrBuf: string = "";
    private handleStderrData(data: Buffer) {
        // Implementation to handle data from GDB stdout
        const str = data.toString();
        this.stderrBuf += str;
        let index: number;
        while ((index = this.stderrBuf.indexOf("\n")) >= 0) {
            const line = this.stderrBuf.slice(0, index).trim();
            this.stderrBuf = this.stderrBuf.slice(index + 1);
            this.emit("stderr", line);
        }
    }

    private handleOutputLine(line: string) {
        // Implementation to parse and handle a line of GDB output
        if (this.debugMiOutput) {
            this.emit("output", "<-- " + line);
        }
        const miOutput = parseGdbMiOut(line);
        if (miOutput) {
            if (miOutput.resultRecord) {
                const token = parseInt(miOutput.resultRecord.token);
                const pendingCmd = this.pendingCmds.get(token);
                if (pendingCmd) {
                    pendingCmd.resolve(miOutput.resultRecord);
                    this.pendingCmds.delete(token);
                } else {
                    this.emit("stderr", `No pending command for token ${token}`);
                }
            }
            for (const record of miOutput.outOfBandRecords) {
                if (record.recordType === "async") {
                    const className = record.class.startsWith("*") ? record.class.slice(1) : record.class;
                    if (className === "stopped") {
                        this.handleSetopped(miOutput);
                    } else if (className === "running") {
                        this.status = "running";
                        if (this.debugMiOutput) {
                            this.log(Stderr, `mi2.status = ${this.status}`);
                        }
                        this.emit(GdbEventNames.Running);
                    }
                } else if (record.recordType === "stream") {
                    if (record.outputType === Console) {
                        if (this.captureStdoutMode) {
                            this.capturedStdout.push(record.result);
                        }
                        this.emit(Console, record);
                    } else if (record.outputType === "target") {
                        this.emit(Stdout, record);
                    } else if (record.outputType === "log") {
                        this.emit(Stderr, record);
                    }
                }
            }
        }
    }

    private firstStop = true;
    handleSetopped(output: GdbMiOutput) {
        this.status = "stopped";
        if (this.debugMiOutput) {
            this.log(Stderr, `mi2.status = ${this.status}`);
        }
        // FIXME: It should always be a single outOfBandRecord here, but just in case...
        const record = output.outOfBandRecords.length > 0 ? output.outOfBandRecords[0] : output.resultRecord!;
        const reason = (record.result as any)["reason"];
        if (reason === "breakpoint-hit") {
            this.emit("breakpoint", record);
        } else if (reason && (reason as string).includes("watchpoint-trigger")) {
            this.emit("watchpoint", record);
        } else if (reason && (reason as string).includes("watchpoint-scope")) {
            // When a local variable goes out of scope
            this.emit("watchpoint-scope", record);
        } else if (reason === "end-stepping-range") {
            this.emit("step-end", record);
        } else if (reason === "function-finished") {
            this.emit("step-out-end", record);
        } else if (reason === "signal-received") {
            this.emit("signal-stop", record);
        } else if (reason === "exited-normally") {
            this.emit("exited-normally", record);
        } else if (reason === "exited") {
            // exit with error code != 0
            this.log(Stderr, "Program exited with code " + record.result["exit-code"]);
            this.emit("exited-normally", record);
        } else if (reason === undefined && this.firstStop) {
            this.log(Console, "Program stopped, probably due to a reset and/or halt issued by debugger");
            this.emit(GdbEventNames.Stopped, record, "entry");
        } else {
            this.log(Console, "Not implemented stop reason (assuming exception): " + reason || "Unknown reason");
            this.emit(GdbEventNames.Stopped, record);
        }
        this.firstStop = false;
        this.emit("generic-stopped", record);
    }

    // Method to stop the GDB process. There are so many things that can go wrong here...
    // Not sure why GDB sometimes refuses to exit cleanly, even after a proper detach/disconnect
    // The code here looks silly, but it's an attempt to cover all bases. Also, some gdb-servers
    // misbehave and do not handle detach/disconnect properly, perhaps causing GDB to hang on exit.
    stop(): Promise<void> {
        if (!this.process) {
            return Promise.resolve();
        }

        const proc = this.process;
        const pid = this.pid;

        // Reject all pending commands
        for (const [seq, cmd] of this.pendingCmds) {
            cmd.reject(new Error("GDB session stopping"));
        }
        this.pendingCmds.clear();

        return new Promise<void>((resolve) => {
            let isResolved = false;
            const doResolve = () => {
                if (!isResolved) {
                    isResolved = true;
                    this.process = null;
                    resolve();
                }
            };

            // Set up listeners for process exit
            proc.removeAllListeners();
            proc.on("exit", doResolve);
            proc.on("close", doResolve);
            proc.on("error", (err) => {
                ServerConsoleLog(`GDB process error during stop: ${err}`);
                doResolve();
            });

            // Try to exit nicely
            try {
                if (proc.stdin && proc.stdin.writable) {
                    const seq = this.cmdSeq++;
                    proc.stdin.write(`${seq}-gdb-exit\n`);
                }
            } catch (e) {
                ServerConsoleLog(`Error sending exit command: ${e}`);
            }

            // Force kill if it doesn't exit
            setTimeout(() => {
                if (!isResolved) {
                    ServerConsoleLog(`GDB (PID ${pid}) did not exit, sending SIGKILL`);
                    proc.kill("SIGKILL");
                    // Fallback if even SIGKILL doesn't trigger exit event
                    setTimeout(doResolve, 100);
                }
            }, 500);
        });
    }

    sendCommand(command: string, timeout: number = 10000): Promise<GdbMiRecord> {
        if (!command.startsWith("-")) {
            command = "-" + command;
        }
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin || !this.process.stdin.writable) {
                return reject(new Error("GDB process is not running or its stdin is not writable"));
            }

            const seq = this.cmdSeq++;
            const fullCommand = `${seq}-${command}\n`;

            if (this.debugMiOutput) {
                this.emit("stderr", "--> " + fullCommand.trim());
            }

            const timer = setTimeout(() => {
                if (this.pendingCmds.has(seq)) {
                    this.pendingCmds.delete(seq);
                    reject(new Error(`GDB command timed out: ${command}`));
                }
            }, timeout);

            this.pendingCmds.set(
                seq,
                new PendingCmdPromise(
                    seq,
                    (val) => {
                        clearTimeout(timer);
                        resolve(val);
                    },
                    (err) => {
                        clearTimeout(timer);
                        reject(err);
                    },
                ),
            );

            try {
                this.process.stdin.write(fullCommand);
            } catch (e) {
                this.pendingCmds.delete(seq);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    // ... other methods and properties ...
}
