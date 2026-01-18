import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { parseGdbMiOut } from "./mi-parser";
import { GdbEventNames, GdbMiOutputType, GdbMiRecord, Stderr, Stdout, Console, GdbMiOutput, MINode } from "./mi-types";
import { GdbMiRecordType } from "./mi-types";
import { ServerConsoleLog } from "../server-console-log";
import { receiveMessageOnPort } from "worker_threads";
import { VariableObject } from "../variables";
import { DebugFlags } from "../servers/common";
import { MiCommands } from "./mi-commands";

class PendingCmdPromise {
    constructor(
        public readonly seq: number,
        public readonly cmd: string,
        public readonly resolve: (value: GdbMiOutput) => void,
        public readonly reject: (reason?: any) => void,
    ) {}
}

export class GdbInstance extends EventEmitter {
    private sessionEnding: boolean = false;
    // ... other methods and properties ...
    pid: number = 0;
    process: ChildProcess | null = null;
    public debugFlags: DebugFlags = {};
    private cmdSeq: number = 1;
    private pendingCmds: Map<number, PendingCmdPromise> = new Map();
    public status: "running" | "stopped" | "none" = "none";
    public readonly miCommands: MiCommands;
    public suppressConsoleOutput: boolean = false;
    public gdbPath: string = "arm-none-eabi-gdb";
    public gdbArgs: string[] = ["--interpreter=mi3", "-q"];
    gdbMajorVersion: number = 0;
    gdbMinorVersion: number = 0;

    constructor() {
        super();
        this.miCommands = new MiCommands(this);
    }

    IsRunning() {
        return this.status === "running";
    }

    IsGdbRunning() {
        return this.process !== null;
    }

    start(gdbPath: string, gdbArgs: string[], cwd: string | undefined, init: string[], timeout: number = 1000, checkVers = true): Promise<void> {
        this.gdbPath = gdbPath;
        this.gdbArgs = gdbArgs;
        return new Promise(async (resolve, reject) => {
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

            ServerConsoleLog(`Starting GDB: ${gdbPath} ${gdbArgs.join(" ")}, cwd=${cwd}`);
            const child = spawn(gdbPath, gdbArgs, { cwd: cwd, env: process.env });
            this.process = child;
            this.pid = child.pid!;
            ServerConsoleLog(`Started GDB: PID=${this.pid}`);
            child.on("exit", this.handleExit.bind(this));
            child.on("error", this.handleError.bind(this));
            child.stderr.on("data", this.handleStderrData.bind(this));
            child.stdout.on("data", this.handleStdoutData.bind(this));
            child.stdout.on("close", this.handleStdoutClose.bind(this));
            child.stderr.on("close", this.handleStderrClose.bind(this));

            if (checkVers) {
                try {
                    const major = await this.miCommands.sendDataEvaluateExpression<string>("$_gdb_major");
                    const minor = await this.miCommands.sendDataEvaluateExpression<string>("$_gdb_minor");
                    this.gdbMajorVersion = parseInt(major);
                    this.gdbMinorVersion = parseInt(minor);
                    if (this.gdbMajorVersion < 9 || (this.gdbMajorVersion === 9 && this.gdbMinorVersion < 1)) {
                        this.log(GdbEventNames.Stderr, `ERROR: GDB version ${this.gdbMajorVersion}.${this.gdbMinorVersion} is not supported. Please upgrade to GDB version 9.1 or higher.`);
                        this.log(GdbEventNames.Stderr, "    This can result in silent failures");
                    }
                    try {
                        doInitCmds();
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                    return;
                } catch (e) {
                    // these convenience variables don't exist in older GDB versions
                    ServerConsoleLog("Failed to get GDB version using $_gdb_major/minor variables");
                    reject(new Error("Failed to get GDB version using $_gdb_major/minor variables. GDB version 9.1 or higher is required."));
                }
                /*
                this.sendCommand("-gdb-version", timeout)
                    .then((output) => {
                        this.log(GdbEventNames.Stdout, output.toString());
                        const lines = output.outOfBandRecords.filter((rec) => rec.recordType === "stream" && rec.outputType === "console");
                        this.parseVersionInfo(lines.map((rec) => rec.result));
                        try {
                            doInitCmds();
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    })
                    .catch(() => {
                        reject(new Error("GDB did not respond to -gdb-version command"));
                    });
                    */
            } else {
                try {
                    doInitCmds();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
        });
    }

    public log(type: GdbEventNames, msg: string): void {
        this.emit("msg", type, msg);
    }

    private parseVersionInfo(lines: string[]) {
        const regex = RegExp(/^GNU gdb.*\s(\d+)\.(\d+)\.(\d+)[^\r\n]*/gm);
        for (const str of lines) {
            const match = regex.exec(str);
            if (match !== null) {
                this.gdbMajorVersion = parseInt(match[1]);
                this.gdbMinorVersion = parseInt(match[2]);
                if (this.gdbMajorVersion < 9 || (this.gdbMajorVersion === 9 && this.gdbMinorVersion < 1)) {
                    this.log(GdbEventNames.Stderr, `ERROR: GDB version ${this.gdbMajorVersion}.${this.gdbMinorVersion} is not supported. Please upgrade to GDB version 9.1 or higher.`);
                    this.log(GdbEventNames.Stderr, "    This can result in silent failures");
                }
                return;
            }
        }
        this.log(Stderr, "ERROR: Could not determine gdb-version number (regex failed). We need version >= 9.1. Please report this problem.");
        this.log(Stderr, "    This can result in silent failures");
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null) {
        if (this.process) {
            this.process = null;
            const codestr = code === null || code === undefined ? "none" : code.toString();
            const sigstr = signal ? `, signal: ${signal}` : "";
            const how = this.sessionEnding ? "" : code || signal ? " unexpectedly" : "";
            const msg = `GDB session ended${how}. exit-code: ${codestr}${sigstr}\n`;
            this.emit("quit", how ? "stderr" : "stdout", msg);
        }
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

    private handleStdoutClose() {
        if (this.stdoutBuf.length > 0) {
            const line = this.stdoutBuf.trim();
            this.stdoutBuf = "";
            this.handleStdoutData(Buffer.from(line));
        }
        this.pendingCmds.clear();
    }

    private handleStderrClose() {
        if (this.stderrBuf.length > 0) {
            const line = this.stderrBuf.trim();
            this.stderrBuf = "";
            this.emit("stderr", line);
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

    private currentOutofBandRecords: GdbMiRecord[] = [];
    private handleOutputLine(line: string) {
        // Implementation to parse and handle a line of GDB output
        if (line === "(gdb)") {
            this.currentOutofBandRecords = [];
            return;
        }
        if (this.debugFlags.gdbTraces) {
            this.log(Console, "-> " + line);
        }
        let miOutput = parseGdbMiOut(line);
        if (miOutput) {
            if (this.debugFlags.gdbTracesParsed) {
                this.log(Console, "~~ " + JSON.stringify(miOutput));
            }
            if (miOutput.resultRecord) {
                const token = parseInt(miOutput.resultRecord.token);
                const pendingCmd = this.pendingCmds.get(token);
                if (pendingCmd) {
                    if (miOutput.resultRecord?.class === "error") {
                        const errorMsg = miOutput.resultRecord.result["msg"] || "Unknown error";
                        pendingCmd.reject(new Error(`GDB: ${errorMsg}`));
                    } else {
                        if (miOutput.resultRecord?.class === "connected") {
                            this.emit("connected");
                        }
                        const saved = { ...miOutput };
                        if (miOutput.outOfBandRecords.length == 0 && this.currentOutofBandRecords.length > 0) {
                            // We don't have any outOfBandRecords in this output, but we have some saved, these
                            // are from a console output from a previous command like -interpreter-exec
                            miOutput.outOfBandRecords = this.currentOutofBandRecords;
                        }
                        pendingCmd.resolve(miOutput);
                        miOutput = saved;
                    }
                    this.currentOutofBandRecords = [];
                    this.pendingCmds.delete(token);
                } else if (!this.sessionEnding) {
                    this.log(Stderr, `No pending command for token ${token}`);
                }
            }
            for (const record of miOutput.outOfBandRecords) {
                if (record.recordType === "async") {
                    const className = record.class;
                    if (className === "stopped") {
                        this.handleStopped(miOutput);
                    } else if (className === "running") {
                        this.status = "running";
                        if (this.debugFlags.gdbTraces) {
                            this.log(Stderr, `mi2.status = ${this.status}`);
                        }
                        this.emit(GdbEventNames.Running);
                    } else if (record.outputType === "notify") {
                        if (className === "thread-created") {
                            this.emit(GdbEventNames.ThreadCreated, record);
                        } else if (className === "thread-exited") {
                            this.emit(GdbEventNames.ThreadExited, record);
                        } else if (className === "thread-selected") {
                            this.emit(GdbEventNames.ThreadSelected, record);
                        }
                    }
                } else if (record.recordType === "stream") {
                    if (record.outputType === Console) {
                        this.currentOutofBandRecords.push(record);
                        if (!this.suppressConsoleOutput) {
                            this.log(Console, record.result);
                        }
                    } else if (record.outputType === "target") {
                        this.log(Stdout, record.result);
                    } else if (record.outputType === "log") {
                        this.log(Stderr, record.result);
                    }
                }
            }
        }
    }

    private firstStop = true;
    handleStopped(output: GdbMiOutput) {
        this.status = "stopped";
        if (this.debugFlags.gdbTraces) {
            this.log(Stderr, `mi2.status = ${this.status}`);
        }
        // FIXME: It should always be a single outOfBandRecord here, but just in case...
        const record = output.outOfBandRecords.length > 0 ? output.outOfBandRecords[0] : output.resultRecord!;
        let reason = (record.result as any)["reason"];
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
            reason = "entry";
            this.log(Console, "Program stopped, probably due to a reset and/or halt issued by debugger");
        } else {
            reason = reason || "unknown";
            this.log(Console, "Not implemented stop reason (assuming exception): " + reason || "Unknown reason");
        }
        this.firstStop = false;
        this.emit(GdbEventNames.Stopped, record, reason);
        this.emit("generic-stopped", record);
    }

    // Method to stop the GDB process. There are so many things that can go wrong here...
    // Not sure why GDB sometimes refuses to exit cleanly, even after a proper detach/disconnect
    // The code here looks silly, but it's an attempt to cover all bases. Also, some gdb-servers
    // misbehave and do not handle detach/disconnect properly, perhaps causing GDB to hang on exit.
    async stop(): Promise<void> {
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

            this.sessionEnding = true;
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
                ServerConsoleLog(`Error sending -gdb-exit command: ${e}`);
            }

            // Force kill if it doesn't exit
            setTimeout(() => {
                if (!isResolved) {
                    ServerConsoleLog(`GDB (PID ${pid}) did not exit when requested, sending SIGKILL`);
                    proc.kill("SIGKILL");
                    // Fallback if even SIGKILL doesn't trigger exit event
                    setTimeout(doResolve, 100);
                }
            }, 500);
        });
    }

    sendCommand(command: string, timeout: number = 10000): Promise<GdbMiOutput> {
        if (!command.startsWith("-")) {
            command = "-" + command;
        }
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin || !this.process.stdin.writable || this.sessionEnding || !this.process.stdout || !this.process.stdout.readable) {
                return reject(new Error("GDB process is not running or its stdin/stdout is not writable/readable"));
            }

            const seq = this.cmdSeq++;
            const fullCommand = `${seq}${command}\n`;

            if (this.debugFlags.gdbTraces) {
                this.log(Console, fullCommand);
            }

            const clearTimer = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
            };

            let timer: NodeJS.Timeout | undefined;
            if (timeout > 250 && !this.debugFlags.disableGdbTimeouts) {
                timer = setTimeout(() => {
                    timer = undefined;
                    if (this.pendingCmds.has(seq)) {
                        this.pendingCmds.delete(seq);
                        reject(new Error(`GDB command timer expired after ${timeout / 1000.0}s: '${command}'. May not be recoverable from this error.`));
                    }
                }, timeout);
            }

            this.pendingCmds.set(
                seq,
                new PendingCmdPromise(
                    seq,
                    command,
                    (val) => {
                        clearTimer();
                        resolve(val);
                    },
                    (err) => {
                        clearTimer();
                        reject(err);
                    },
                ),
            );

            try {
                this.process.stdin.write(fullCommand);
            } catch (e) {
                this.pendingCmds.delete(seq);
                clearTimer();
                reject(e);
            }
        });
    }

    public sendUserInput(command: string): Thenable<any> {
        if (command.startsWith("-")) {
            return this.sendCommand(command.substr(1));
        } else {
            return this.sendCommand(`interpreter-exec console "${command}"`);
        }
    }
}
