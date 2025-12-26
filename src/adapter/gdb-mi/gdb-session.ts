import * as os from "os";
import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { parseGdbMiOut } from "./mi-parser";
import { GdbMiOutputType } from "./mi-types";
import { GdbMiRecordType } from "./mi-types";

const logFilePath = os.tmpdir() + "/mcu-debug-process-log.txt";
export function processLogging(message: string) {
    try {
        const fs = require("fs");
        fs.appendFileSync(logFilePath, `[Mcu-debug-adapter] ${message}\n`);
    } catch (e) {
        // ignore
    }
    console.log(`[GDB-MI] ${message}`);
}

class PendingCmdPromise {
    constructor(
        public readonly seq: number,
        public readonly resolve: (value: string) => void,
        public readonly reject: (reason?: any) => void,
    ) {}
}

export class GdbSession extends EventEmitter {
    // ... other methods and properties ...
    pid: number = 0;
    process: ChildProcess | null = null;
    public debugMiOutput: boolean = false;
    private cmdSeq: number = 1;
    private pendingCmds: Map<number, PendingCmdPromise> = new Map();

    constructor(
        private gdbPath: string,
        private gdbArgs: string[] = [],
    ) {
        super();
    }

    start(cwd: string | undefined, init: string[], timeout: number = 5000): Promise<void> {
        return new Promise((resolve, reject) => {
            const processstartTimeout = setTimeout(() => {
                reject(new Error("GDB start timeout"));
            }, timeout);

            processLogging(`Starting GDB: ${this.gdbPath} ${this.gdbArgs.join(" ")}, cwd=${cwd}`);
            const child = spawn(this.gdbPath, this.gdbArgs, { cwd: cwd, env: process.env });
            clearTimeout(processstartTimeout);
            this.process = child;
            this.pid = child.pid!;
            processLogging(`Started GDB: PID=${this.pid}`);
            child.on("exit", (code, signal) => {
                this.emit("exit", code, signal);
            });
            child.on("error", (err) => {
                this.emit("error", err);
            });
            child.stderr.on("data", (data) => {
                this.handleStderrData(data);
            });
            child.stdout.on("data", (data) => {
                this.handleStdoutData(data);
            });
            resolve();
            // Implementation to start GDB process
            // and handle timeout
        });
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
            this.emit("stdout", line);
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
                    pendingCmd.resolve(line);
                    this.pendingCmds.delete(token);
                } else {
                    this.emit("stderr", `No pending command for token ${token}`);
                }
            }
            for (const record of miOutput.outOfBandRecords) {
                if (record.recordType === "async") {
                    this.emit("async", record);
                } else if (record.recordType === "stream") {
                    if (record.outputType === "console") {
                        this.emit("stdout", record);
                    } else if (record.outputType === "target") {
                        this.emit("stdout", record);
                    } else if (record.outputType === "log") {
                        this.emit("log", record);
                    }
                }
            }
        }
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
                processLogging(`GDB process error during stop: ${err}`);
                doResolve();
            });

            // Try to exit nicely
            try {
                if (proc.stdin && proc.stdin.writable) {
                    const seq = this.cmdSeq++;
                    proc.stdin.write(`${seq}-gdb-exit\n`);
                }
            } catch (e) {
                processLogging(`Error sending exit command: ${e}`);
            }

            // Force kill if it doesn't exit
            setTimeout(() => {
                if (!isResolved) {
                    processLogging(`GDB (PID ${pid}) did not exit, sending SIGKILL`);
                    proc.kill("SIGKILL");
                    // Fallback if even SIGKILL doesn't trigger exit event
                    setTimeout(doResolve, 100);
                }
            }, 500);
        });
    }

    sendCommand(command: string, timeout: number = 10000): Promise<string> {
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
