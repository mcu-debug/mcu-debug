import { start } from "node:repl";
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

    async sendThreadInfoAll(): Promise<GdbMiThreadInfoList> {
        try {
            const cmd = "-thread-info";
            const output = await this.gdbInstance.sendCommand(cmd);
            const record = output.resultRecord.result;
            if (!record) {
                throw new Error("No result record in thread-info output");
            }
            const threadInfoList = new GdbMiThreadInfoList(output);
            return threadInfoList;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async sendStackListFrames(thread: GdbMiThreadIF, startFrame: number, endFrame: number): Promise<void> {
        try {
            const threadId = thread.id;
            const cmd = `-stack-list-frames --thread ${threadId} ${startFrame} ${endFrame}`;
            const output = await this.gdbInstance.sendCommand(cmd);
            const record = output.resultRecord.result;
            if (!record) {
                throw new Error("No result record in stack-list-frames output");
            }
            const framesRaw = (record as any)["stack"];
            const frames: GdbMiFrame[] = [];
            if (Array.isArray(framesRaw)) {
                for (const fr of framesRaw) {
                    frames.push(new GdbMiFrame(fr));
                }
            }
            for (const frame of frames) {
                thread.setFrame(frame, frame.level);
            }
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async sendFlushRegs(): Promise<void> {
        try {
            const cmd = `-interpreter-exec console "maintenance flush register-cache"`;
            await this.gdbInstance.sendCommand(cmd);
            return Promise.resolve();
        } catch (e) {
            try {
                const cmd = `-interpreter-exec console "flushregs"`;
                await this.gdbInstance.sendCommand(cmd);
                return Promise.resolve();
            } catch (e) {
                return Promise.reject(e);
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
    frames: GdbMiFrame[]; // Unlike threads, levels start at 0, so it is safe to use an array here
    name: string;
    details?: string;
    state?: string;
    core?: number;

    constructor(miThreadInfo: any) {
        this.id = parseInt(miThreadInfo["id"]);
        this.targetId = miThreadInfo["target-id"];
        this.name = miThreadInfo["name"];
        this.details = miThreadInfo["details"];
        this.frames = [];
        if (miThreadInfo["frame"]) {
            this.frames.push(new GdbMiFrame(miThreadInfo["frame"]));
        }
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
    setFrame(frame: GdbMiFrame, ix: number) {
        if (ix > this.frames.length) {
            throw new Error("Frame index out of bounds");
        } else if (ix === this.frames.length) {
            this.frames.push(frame);
        } else {
            this.frames[ix] = frame;
        }
    }
}

export class GdbMiThreadInfoList {
    threadMap: Map<number, GdbMiThreadIF>;
    currentThreadId: number | undefined;

    constructor(miOutput: GdbMiOutput) {
        this.threadMap = new Map<number, GdbMiThreadIF>();
        const record = miOutput.resultRecord;
        if (record && record.result) {
            const threadInfos = (record.result as any)["threads"];
            if (Array.isArray(threadInfos)) {
                for (const ti of threadInfos) {
                    const thread = new GdbMiThread(ti);
                    this.threadMap.set(thread.id, thread);
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

    getSortedThreadList(): GdbMiThreadIF[] {
        const threadsAry = Array.from(this.threadMap.values());
        threadsAry.sort((a, b) => a.id - b.id);
        return threadsAry;
    }
}

// will not throw exceptions
export async function DataEvaluateExpression(gdbInstance: GdbInstance, expr: string): Promise<string | null> {
    try {
        const cmd = `-data-evaluate-expression "${expr}"`;
        const miOutput = await gdbInstance.sendCommand(cmd, 100);
        const record = miOutput.resultRecord?.result;
        if (record && record["value"]) {
            return record["value"];
        }
    } catch (e) {}
    return null;
}

// will not throw exceptions
export async function DataEvaluateExpressionAsNumber(gdbInstance: GdbInstance, expr: string): Promise<number | null> {
    const strVal = await DataEvaluateExpression(gdbInstance, expr);
    if (strVal !== null) {
        const numVal = Number(strVal);
        if (!isNaN(numVal)) {
            return numVal;
        }
    }
    return null;
}

// will trow exceptions
// Use the following function to execute either a GDB/MI command or a CLI command
// depending on whether the command starts with a '-' character or not. If is starts with a '-',
// then it is assumed to be a full GDB/MI command. Otherwise it is treated as a CLI command and
// wrapped in an appropriate GDB/MI command to execute it.
export async function GdbMiOrCliCommandForOob(gdbInstance: GdbInstance, cmd: string): Promise<string[] | Object | Array<any>> {
    if (!cmd.startsWith("-")) {
        cmd = `-interpreter-exec console "${cmd}"`;
    }
    const miOutput = await gdbInstance.sendCommand(cmd, 100);
    const outputLines: string[] = [];
    if (miOutput.outOfBandRecords) {
        for (const oob of miOutput.outOfBandRecords) {
            if (oob.outputType === "console") {
                const line = oob.result.trim();
                outputLines.push(line);
            }
        }
    }
    if (miOutput.resultRecord) {
        const record = miOutput.resultRecord;
        // Is the result an object with any properties?
        if (typeof record.result === "object" && record.result !== null && Object.keys(record.result).length > 0) {
            const resObj = record.result as any;
            return resObj;
        }
        if (Array.isArray(record.result)) {
            return record.result;
        }
        if (typeof record.result === "string") {
            outputLines.push(record.result);
        }
    }
    return outputLines;
}
