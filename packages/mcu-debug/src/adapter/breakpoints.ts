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
    functionName: string;
    breakpoints: Map<number, DebugProtocol.FunctionBreakpoint>;

    constructor(functionName: string) {
        this.functionName = functionName;
        this.breakpoints = new Map<number, DebugProtocol.FunctionBreakpoint>();
    }
}

export class BreakpointManager {
    functionBreakpoints: Map<string, FunctionBreakpoints>;
    fileBreakpoints: Map<string, SourceBreakpoints>;

    constructor(
        private gdbInstance: GdbInstance,
        private gdbSession: GDBDebugSession,
    ) {
        this.functionBreakpoints = new Map<string, FunctionBreakpoints>();
        this.fileBreakpoints = new Map<string, SourceBreakpoints>();
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
                let args = `--source "${sourceFile}" --line ${bp.line}`;
                if (bp.condition) {
                    args += ` -c "${escapeGdbString(bp.condition)}"`;
                }
                if (bp.hitCondition) {
                    args += ` ${this.parseHitContion(bp.hitCondition)}`;
                }
                if (this.gdbSession.args.hardwareBreakpoints?.require) {
                    args += ` -h`;
                }
                const p = this.gdbInstance.sendCommand(`-break-insert ${args}`);
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

    private async deleteBreakpoints(list: number[]): Promise<void> {
        try {
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
