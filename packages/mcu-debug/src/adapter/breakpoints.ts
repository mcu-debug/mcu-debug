import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { canonicalizePath } from "./servers/common";
import { GDBDebugSession } from "./gdb-session";
import { Stderr } from "./gdb-mi/mi-types";

//
// TODO: Strategy for managing breakppints
//
// Source Breakpoints:
// For each source file, maintain a list of breakpoints set in that file. But first, we need a canonical
// way to identify source files. The source file path provided in the SetBreakpointsRequest may
// not match the path used by GDB (e.g., relative vs absolute paths, different drive letters on Windows, etc).
// We need to resolve the source file path to a canonical form (e.g., absolute path) before storing/retrieving
// breakpoints for that file.
//
// We remove any existing breakpoints in the file before setting new ones, as per the DAP spec. We then return
// the actual breakpoints set (which may differ from the requested ones, e.g., if a requested line has no
// executable code). We must set the verified flag for each breakppoint accordingly. The number one cause
// of failures for breakpoints is that there are no more breakpoints available in the target (e.g., limited
// hardware resources). We need to handle this gracefully and inform the user appropriately.
//
//  We also have to allow for forced HW breakpoints (e.g., for flash breakpoints on MCUs that also have code in RAM).
//
// Note: These breakpoints are have additional attributes such as condition, hit count, log message, etc. This may be trie
// for all kinds of breakpoints. But we can only do what GDB supports.
//
// Function Breakpoints:
// Similar to source breakpoints, but keyed by function name. We need to ensure that function names are

export class SourceBreakpoints {
    sourceFile: string;
    breakpoints: Map<number, DebugProtocol.SourceBreakpoint>;

    constructor(sourceFile: string) {
        this.sourceFile = sourceFile;
        this.breakpoints = new Map<number, DebugProtocol.SourceBreakpoint>();
    }
}

export class FunctionBreakpoints {
    breakpoints: Map<number, DebugProtocol.FunctionBreakpoint>;

    constructor() {
        this.breakpoints = new Map<number, DebugProtocol.FunctionBreakpoint>();
    }
}

export class DataBreakpoint {
    breakpoints: Map<number, DebugProtocol.DataBreakpoint>;
    constructor() {
        this.breakpoints = new Map<number, DebugProtocol.DataBreakpoint>();
    }
}
export class BreakpointManager {
    functionBreakpoints: FunctionBreakpoints;
    fileBreakpoints: Map<string, SourceBreakpoints>;
    dataBreakpoints: DataBreakpoint;

    constructor(
        private gdbInstance: GdbInstance,
        private gdbSession: GDBDebugSession,
    ) {
        this.functionBreakpoints = new FunctionBreakpoints();
        this.fileBreakpoints = new Map<string, SourceBreakpoints>();
        this.dataBreakpoints = new DataBreakpoint();
    }

    /**
     * Executes an operation, stopping the target first if it's running.
     * Automatically resumes execution after the operation completes.
     */
    private async executeWhileStopped<T>(operation: () => Promise<T>): Promise<T> {
        const wasRunning = this.gdbInstance.IsRunning();
        try {
            if (wasRunning) {
                const stoppedPromise = new Promise<T>((resolve, reject) => {
                    this.gdbInstance.once("stopped", async () => {
                        try {
                            const result = await operation();
                            resolve(result);
                        } catch (err) {
                            reject(err);
                        }
                    });
                });

                await this.gdbInstance.sendCommand("-exec-interrupt");
                return await stoppedPromise;
            } else {
                return await operation();
            }
        } finally {
            if (wasRunning) {
                await this.gdbInstance.sendCommand("-exec-continue");
            }
        }
    }

    /**
     *
     * @param hitCondition If it is >X, then we set a permanent bkpt with the hit count. Otherwise, we set a
     * temporary breakpoint so if it hits once, the breakpoint is then cleared
     * @returns one or more gdb breakpoint arguments wth no leading or trailing spaces
     */
    protected parseHitContion(hitCondition: string): string {
        let bkptArgs = "";
        const numRegex = /\d+/;
        hitCondition = hitCondition.trim();
        if (hitCondition) {
            if (hitCondition[0] === ">") {
                bkptArgs = "-i " + numRegex.exec(hitCondition.slice(1))[0];
            } else {
                const match = numRegex.exec(hitCondition)[0];
                if (match.length !== hitCondition.length) {
                    this.gdbSession.handleMsg(
                        Stderr,
                        "Unsupported break count expression: '" + hitCondition + "'. " + "Only supports 'X' for breaking once after X times or '>X' for ignoring the first X breaks",
                    );
                } else if (parseInt(match) !== 0) {
                    bkptArgs = "-t -i " + parseInt(match);
                }
            }
        }
        return bkptArgs;
    }

    public async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
        await this.executeWhileStopped(async () => {
            const sourceFile = canonicalizePath(args.source.path!);
            let fileBps = this.fileBreakpoints.get(sourceFile);
            if (fileBps) {
                const toDelete: number[] = [];
                for (const [id, bp] of fileBps.breakpoints) {
                    toDelete.push(id);
                }
                await this.deleteBreakpoints(toDelete);
                fileBps.breakpoints.clear();
            } else {
                fileBps = new SourceBreakpoints(sourceFile);
            }
            const promises: Promise<any>[] = [];
            for (const bp of args.breakpoints || []) {
                // Prepopulate with unverified breakpoints
                let isHwBp = false;
                let args = `--source "${sourceFile}" --line ${bp.line}`;
                if (bp.condition) {
                    args += ` -c "${escapeGdbString(bp.condition)}"`;
                }
                if (bp.hitCondition) {
                    args += ` ${this.parseHitContion(bp.hitCondition)}`;
                }
                if (this.gdbSession.args.hardwareBreakpoints?.require) {
                    isHwBp = true;
                    args += " -h";
                }
                const cmd = bp.logMessage ? "dprintf-insert" : "break-insert";
                if (bp.logMessage) {
                    if (isHwBp) {
                        this.gdbSession.handleMsg(
                            Stderr,
                            `Warning: GDB does not support hardware dprintf breakpoints. Ignoring hardware breakpoint request for breakpoint at ${sourceFile}:${bp.line}\n`,
                        );
                    } else {
                        args += " " + bp.logMessage;
                    }
                }
                const p = this.gdbInstance.sendCommand(`-${cmd} ${args}`);
                promises.push(p);
            }
            const bps: DebugProtocol.Breakpoint[] = [];
            let counter = 0;
            for (const p of promises) {
                try {
                    const miOutput = await p;
                    const bp = args.breakpoints[counter];
                    const bpInfo = miOutput.resultRecord.result["bkpt"];
                    const actualLine = parseInt(bpInfo["line"]);
                    const bpId = parseInt(bpInfo["number"]);
                    const dbgBp: DebugProtocol.Breakpoint = {
                        id: bpId,
                        verified: true,
                        source: args.source,
                        line: actualLine,
                        instructionReference: bpInfo["address"],
                    };
                    bps.push(dbgBp);
                    bp.line = actualLine;
                    fileBps!.breakpoints.set(bpId, bp);
                } catch (err) {
                    const line = args.breakpoints ? args.breakpoints[counter].line : 0;
                    this.gdbSession.handleMsg(Stderr, `Error setting breakpoint ${sourceFile}:${line} ${err}`);
                    bps.push({
                        verified: false,
                        message: err.message,
                    } as DebugProtocol.Breakpoint);
                }
                counter++;
            }
            this.fileBreakpoints.set(sourceFile, fileBps);
            response.body = {
                breakpoints: bps,
            };
        });
    }

    public async setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments,
        request?: DebugProtocol.Request,
    ): Promise<void> {
        await this.executeWhileStopped(async () => {
            const toDelete: number[] = [];
            for (const [id, bp] of this.functionBreakpoints.breakpoints) {
                toDelete.push(id);
            }
            await this.deleteBreakpoints(toDelete);
            this.functionBreakpoints.breakpoints.clear();

            const promises: Promise<any>[] = [];
            for (const bp of args.breakpoints || []) {
                // Prepopulate with unverified breakpoints
                let bkptArgs = `--function "${bp.name}"`;
                if (bp.condition) {
                    bkptArgs += ` -c "${escapeGdbString(bp.condition)}"`;
                }
                if (bp.hitCondition) {
                    bkptArgs += ` ${this.parseHitContion(bp.hitCondition)}`;
                }
                if (this.gdbSession.args.hardwareBreakpoints?.require) {
                    bkptArgs += " -h";
                }
                const p = this.gdbInstance.sendCommand(`-break-insert ${bkptArgs}`);
                promises.push(p);
            }
            const bps: DebugProtocol.Breakpoint[] = [];
            let counter = 0;
            for (const p of promises) {
                try {
                    const miOutput = await p;
                    const bp = args.breakpoints ? args.breakpoints[counter] : null;
                    const bpInfo = miOutput.resultRecord.result["bkpt"];
                    const actualLine = parseInt(bpInfo["line"]);
                    const bpId = parseInt(bpInfo["number"]);
                    const dbgBp: DebugProtocol.Breakpoint = {
                        id: bpId,
                        verified: true,
                        source: {
                            name: bpInfo["file"] || bpInfo["fullname"],
                            path: bpInfo["fullname"] || bpInfo["file"],
                        } as DebugProtocol.Source,
                        line: actualLine,
                        instructionReference: bpInfo["addr"],
                    };
                    bps.push(dbgBp);
                    if (bp) {
                        this.functionBreakpoints.breakpoints.set(bpId, bp);
                    }
                } catch (err) {
                    const name = args.breakpoints ? args.breakpoints[counter].name : "<unknown>";
                    this.gdbSession.handleMsg(Stderr, `Error setting function breakpoint ${name}: ${err}`);
                    bps.push({
                        verified: false,
                        message: err.message,
                    } as DebugProtocol.Breakpoint);
                }
                counter++;
            }
            response.body = { breakpoints: bps };
        });
    }

    async setDataBreakPointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request: DebugProtocol.Request): Promise<void> {
        await this.executeWhileStopped(async () => {
            const toDelete: number[] = [];
            for (const [id, bp] of this.dataBreakpoints.breakpoints) {
                toDelete.push(id);
            }
            await this.deleteBreakpoints(toDelete);
            this.dataBreakpoints.breakpoints.clear();

            const promises: Promise<any>[] = [];
            for (const bp of args.breakpoints || []) {
                const aType = bp.accessType === "read" ? "-r" : bp.accessType === "readWrite" ? "-a" : "";
                let bkptArgs = `--access ${aType}`;
                /**
                * These options have to set separately as GDB MI does not parse them correctly
                if (bp.condition) {
                    bkptArgs += ` -c "${escapeGdbString(bp.condition)}"`;
                }
                */
                const p = this.gdbInstance.sendCommand(`-break-watch ${bkptArgs} "${bp.dataId}"`);
                promises.push(p);
            }
            const bps: DebugProtocol.Breakpoint[] = [];
            let counter = 0;
            for (const p of promises) {
                try {
                    const miOutput = await p;
                    const bp = args.breakpoints ? args.breakpoints[counter] : null;
                    const bpInfo = miOutput.resultRecord.result["wpt"];
                    const bpId = parseInt(bpInfo["number"]);
                    const dbgBp: DebugProtocol.Breakpoint = {
                        id: bpId,
                        verified: true,
                    };
                    bps.push(dbgBp);
                    if (bp) {
                        this.dataBreakpoints.breakpoints.set(bpId, bp);
                    }
                } catch (err) {
                    const dataId = args.breakpoints ? args.breakpoints[counter].dataId : "<unknown>";
                    this.gdbSession.handleMsg(Stderr, `Error setting data breakpoint for ${dataId}: ${err}`);
                    bps.push({
                        verified: false,
                        message: err.message,
                    } as DebugProtocol.Breakpoint);
                }
                counter++;
            }
            response.body = {
                breakpoints: bps,
            };
        });
    }

    private async deleteBreakpoints(list: number[]): Promise<void> {
        try {
            if (list.length === 0) {
                return;
            }
            await this.gdbInstance.sendCommand(`-break-delete ${list.join(" ")}`);
        } catch (err) {
            throw new Error(`Error deleting old breakpoints, so new ones can be set: ${err}`);
        }
    }
    // ... existing code ...
}

export function escapeGdbString(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
