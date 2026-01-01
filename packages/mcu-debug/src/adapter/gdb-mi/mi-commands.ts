import { GDBDebugSession } from "../gdb-session";
import { GdbInstance } from "./gdb-instance";
import { GdbMiFrameIF, GdbMiOutput, GdbMiThreadIF } from "./mi-types";

export class MiCommands {
    constructor(public readonly gdbInstance: GdbInstance) {}

    sendContinue(threadGroup: number | undefined): Promise<GdbMiOutput> {
        const cmd = "-exec-continue" + (threadGroup !== undefined ? ` --thread-group ${threadGroup}` : "");
        return this.gdbInstance.sendCommand(cmd);
    }
    sendStepIn(instr = false): Promise<GdbMiOutput> {
        const cmd = `-exec-step${instr ? "-instruction" : ""}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendStepOut(): Promise<GdbMiOutput> {
        const cmd = "-exec-finish";
        return this.gdbInstance.sendCommand(cmd);
    }
    sendNext(instr = false): Promise<GdbMiOutput> {
        const cmd = `-exec-next${instr ? "-instruction" : ""}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendGotoFileLine(file: string, line: number): Promise<GdbMiOutput> {
        return this.sendGoto(`"${file}":${line}`);
    }
    sendGoto(locSpec: string): Promise<GdbMiOutput> {
        const cmd = `-exec-jump ${locSpec}`;
        return this.gdbInstance.sendCommand(cmd);
    }
    sendHalt(threadGroup: number | undefined): Promise<GdbMiOutput> {
        const cmd = "-exec-interrupt" + (threadGroup !== undefined ? ` --thread-group ${threadGroup}` : "");
        return this.gdbInstance.sendCommand(cmd);
    }

    /// Evaluates the given expression and returns the value as type T. Note that t
    /// must either be a string or an any[] or an object. The children can again be
    /// any of those three types. Using 'any' for T is fine. Regardlessm chect the
    /// returned value at runtime for its actual type.
    sendDataEvaluateExpression<T>(expr: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const cmd = `-data-evaluate-expression \"${expr}\"`;
            this.gdbInstance
                .sendCommand(cmd)
                .then((output) => {
                    const record = output.resultRecord ?? (output.outOfBandRecords && output.outOfBandRecords.length > 0 ? output.outOfBandRecords[0] : undefined);
                    if (record) {
                        const value = (record.result as any)["value"];
                        if (value !== undefined) {
                            resolve(value as T);
                            return;
                        }
                    }
                    reject(new Error(`Failed to evaluate expression '${expr}'`));
                })
                .catch(reject);
        });
    }

    /// Execution context commands

    /// Thread commands. Note that GDB MI has some redundancy here. It gives an object
    /// with duplicate keys for thread id and number of threads according to the docs.
    /// That does not seem to be the case in practice, so we just use one of them.
    sendThreadListInfo(): Promise<GdbMiThreadsList> {
        return new Promise<GdbMiThreadsList>((resolve, reject) => {
            const cmd = "-thread-list-ids";
            this.gdbInstance
                .sendCommand(cmd)
                .then((output) => {
                    try {
                        const threadList = new GdbMiThreadsList(output);
                        if (threadList.numberOfThreads != threadList.threadIds.length) {
                            reject(new Error(`numberOfThreads=${threadList.numberOfThreads} does not match ${threadList.threadIds.length} thread IDs ${JSON.stringify(output)}`));
                            return;
                        }
                        resolve(threadList);
                    } catch (e) {
                        reject(e);
                    }
                })
                .catch(reject);
        });
    }

    sendThreadInfoAll(): Promise<GdbMiThreadInfoList> {
        return new Promise<GdbMiThreadInfoList>((resolve, reject) => {
            const cmd = "-thread-info";
            this.gdbInstance
                .sendCommand(cmd)
                .then((output) => {
                    try {
                        const record = output.resultRecord;
                        if (!record) {
                            reject(new Error("No result record in thread-info output"));
                            return;
                        }
                        const threadInfoList = new GdbMiThreadInfoList(output);
                        resolve(threadInfoList);
                    } catch (e) {
                        reject(e);
                        return;
                    }
                })
                .catch(reject);
        });
    }
}

export class GdbMiThreadsList {
    threadIds: number[];
    currentThreadId: number;
    numberOfThreads: number;

    constructor(miOutput: GdbMiOutput) {
        this.threadIds = [];
        this.currentThreadId = -1;
        this.numberOfThreads = 0;

        const record = miOutput.resultRecord;
        if (record) {
            const threadIdsResult = (record.result as any)["thread-ids"];
            // Unfortunately GDB MI returns duplicate keys here according to the docs, so we have to
            // handle that case. The MI parser appends suffixes to duplicate keys.
            if (threadIdsResult && typeof threadIdsResult === "object") {
                for (const key in threadIdsResult) {
                    if (key.startsWith("thread-id")) {
                        const tId = parseInt(threadIdsResult[key] as string);
                        if (!isNaN(tId)) {
                            this.threadIds.push(tId);
                        }
                    }
                }
            }
            const currentThreadIdStr = (record.result as any)["current-thread-id"];
            if (currentThreadIdStr) {
                const tid = parseInt(currentThreadIdStr);
                if (!isNaN(tid)) {
                    this.currentThreadId = tid;
                }
            }
            const numberOfThreadsStr = (record.result as any)["number-of-threads"];
            if (numberOfThreadsStr) {
                const num = parseInt(numberOfThreadsStr);
                if (!isNaN(num)) {
                    this.numberOfThreads = num;
                }
            }
        }
    }
}
export class GdbMiFrame implements GdbMiFrameIF {
    level: number;
    addr: string;
    func: string;
    file?: string;
    fullname?: string;
    line?: number;
    from?: string;
    arch?: string;
    addr_flags?: string;
    args?: Array<{ name: string; value: any }>;

    constructor(miFrame: any) {
        this.level = parseInt(miFrame["level"]);
        this.addr = miFrame["addr"];
        this.func = miFrame["func"];
        this.file = miFrame["file"];
        this.fullname = miFrame["fullname"];
        if (miFrame["line"] !== undefined) {
            this.line = parseInt(miFrame["line"]);
        }
        this.from = miFrame["from"];
        this.arch = miFrame["arch"];
        this.addr_flags = miFrame["addr_flags"];
        this.args = [];
        if (Array.isArray(miFrame["args"])) {
            for (const arg of miFrame["args"]) {
                this.args.push({ name: arg["name"], value: arg["value"] });
            }
        }
    }
}

export class GdbMiThread implements GdbMiThreadIF {
    id: number;
    targetId: string;
    frame: GdbMiFrameIF;
    name: string;
    details?: string;
    state?: string;
    core?: number;

    constructor(miThreadInfo: any) {
        this.id = parseInt(miThreadInfo["id"]);
        this.targetId = miThreadInfo["target-id"];
        this.name = miThreadInfo["name"];
        this.details = miThreadInfo["details"];
        this.frame = new GdbMiFrame(miThreadInfo["frame"]);
        if (miThreadInfo["state"]) {
            this.state = miThreadInfo["state"];
        }
        if (miThreadInfo["core"] !== undefined) {
            this.core = parseInt(miThreadInfo["core"]);
        }

        let name = this.name;
        if (name && this.details && name !== this.details) {
            // Try to emulate how gdb shows thread info. Nice for servers like pyocd.
            name += ` (${this.details})`;
        } else {
            name = name || this.details || this.id.toString();
        }
        this.name = name;
    }
}

export class GdbMiThreadInfoList {
    threads: GdbMiThread[];
    currentThreadId: number | undefined;

    constructor(miOutput: GdbMiOutput) {
        this.threads = [];
        const record = miOutput.resultRecord;
        if (record) {
            const threadInfos = (record.result as any)["threads"];
            if (Array.isArray(threadInfos)) {
                for (const ti of threadInfos) {
                    this.threads.push(new GdbMiThread(ti));
                }
            }
        }
        const currentThreadIdStr = (record.result as any)["current-thread-id"];
        if (currentThreadIdStr) {
            const tid = parseInt(currentThreadIdStr);
            if (!isNaN(tid)) {
                this.currentThreadId = tid;
            }
        }
    }
}
