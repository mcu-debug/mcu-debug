export interface GdbMiError extends Error {
    readonly name: string;
    readonly message: string;
    readonly source: string;
}

export interface GdbMiFrameIF {
    level: number;
    addr: string;
    func: string;
    file?: string;
    fullname?: string;
    line?: number;
    from?: string;
    addr_flags?: string;
}

export interface GdbMiThreadIF {
    setFake(): unknown;
    id: number;
    name: string;
    target_id?: string;
    frames: GdbMiFrameIF[]; // These are the frames from -stack-list-frames
    state?: string;
    core?: number;

    setFrame(frame: GdbMiFrameIF, ix: number): void;
}

export interface GdbMiBreakpoint {
    number: number | string; // We should just use string here to handle multiple locations numbering
    type: string;
    disp: string;
    enabled: "y" | "n" | "N";
    addr: string;
    addr_flags?: string;
    func?: string;
    filename?: string;
    fullname?: string;
    line?: number;
    times?: number;
    original_location?: string;
    locations?: GdbMiBreakpoint[];
    // There are more fields, but these are the most common ones
}

export type GdbMiRecordType = "result" | "async" | "stream";
export type GdbMiOutputType = "result" | "console" | "log" | "target" | "exec" | "status" | "notify";
export type GdbMiStreamType = "console" | "target" | "log";

export type GdbRecordResult = { [key: string]: any } | GdbMiRecord[] | string;
export interface GdbMiRecord {
    token: string;
    recordType: GdbMiRecordType;
    outputType: GdbMiOutputType;
    class: string;
    result: GdbRecordResult;
    prefix: string; // Actual character used as prefix ~, @, &, ^, *, =, etc
}

export interface GdbMiOutput {
    hasTerminator: boolean;
    outOfBandRecords: GdbMiRecord[];
    resultRecord?: GdbMiRecord;
}

export type GdbStopReason =
    | "breakpoint-hit"
    | "watchpoint-trigger"
    | "read-watchpoint-trigger"
    | "access-watchpoint-trigger"
    | "function-finished"
    | "location-reached"
    | "watchpoint-scope"
    | "end-stepping-range"
    | "exited-signalled"
    | "exited"
    | "exited-normally"
    | "signal-received"
    | "solib-event"
    | "fork"
    | "vfork"
    | "syscall-entry"
    | "syscall-return"
    | "exec"
    | "no-history";

export type GdbAsyncRecordClass =
    | "stopped"
    | "running"
    | "thread-group-added"
    | "thread-group-removed"
    | "thread-group-started"
    | "thread-group-exited"
    | "thread-created"
    | "thread-exited"
    | "thread-selected"
    | "library-loaded"
    | "library-unloaded"
    | "breakpoint-created"
    | "breakpoint-modified"
    | "breakpoint-deleted"
    | "memory-changed";

export enum GdbEventNames {
    Stopped = "stopped",
    Running = "running",
    Exited = "exited",
    ThreadCreated = "thread-created",
    ThreadExited = "thread-exited",
    ThreadSelected = "thread-selected",

    // There are really just a few message types for VSSCode
    Console = "console", // Intended for the debugger normal messages
    Stderr = "stderr", // Intended for debuggee messages. But we use it for GDB errors ans our errors too
    Stdout = "stdout",
    Telemetry = "telemetry",
}

export const Stderr = GdbEventNames.Stderr;
export const Stdout = GdbEventNames.Stdout;
export const Console = GdbEventNames.Console;
export const Telemetry = GdbEventNames.Telemetry;

/// Temporary types for gdb-mi2 parser, to be obsoleted later

export interface MIError extends Error {
    readonly name: string;
    readonly message: string;
    readonly source: string;
}

export interface MIInfo {
    token: number;
    outOfBandRecord: { isStream: boolean; type: string; asyncClass: string; output: [string, any][]; content: string }[];
    resultRecords: { resultClass: string; results: [string, any][] };
}

export class MINode implements MIInfo {
    public token: number;
    public outOfBandRecord: { isStream: boolean; type: string; asyncClass: string; output: [string, any][]; content: string }[];
    public resultRecords: { resultClass: string; results: [string, any][] };
    public output: string = "";

    public static valueOf(start: any, path: string): any {
        if (!start) {
            return undefined;
        }
        const pathRegex = /^\.?([a-zA-Z_-][a-zA-Z0-9_-]*)/;
        const indexRegex = /^\[(\d+)\](?:$|\.)/;
        path = path.trim();
        if (!path) {
            return start;
        }
        let current = start;
        do {
            let target = pathRegex.exec(path);
            if (target) {
                path = path.substr(target[0].length);
                if (current.length && typeof current !== "string") {
                    const found = [];
                    for (const element of current) {
                        if (element[0] === target[1]) {
                            found.push(element[1]);
                        }
                    }
                    if (found.length > 1) {
                        current = found;
                    } else if (found.length === 1) {
                        current = found[0];
                    } else {
                        return undefined;
                    }
                } else {
                    return undefined;
                }
            } else if (path[0] === "@") {
                current = [current];
                path = path.substr(1);
            } else {
                target = indexRegex.exec(path);
                if (target) {
                    path = path.substr(target[0].length);
                    const i = parseInt(target[1]);
                    if (current.length && typeof current !== "string" && i >= 0 && i < current.length) {
                        current = current[i];
                    } else if (i !== 0) {
                        return undefined;
                    }
                } else {
                    return undefined;
                }
            }
            path = path.trim();
        } while (path);
        return current;
    }

    constructor(token: number, info: { isStream: boolean; type: string; asyncClass: string; output: [string, any][]; content: string }[], result: { resultClass: string; results: [string, any][] }) {
        this.token = token;
        this.outOfBandRecord = info;
        this.resultRecords = result;
    }

    public record(path: string): any {
        if (!this.outOfBandRecord || this.outOfBandRecord.length === 0) {
            return undefined;
        }
        return MINode.valueOf(this.outOfBandRecord[0].output, path);
    }

    public result(path: string): any {
        if (!this.resultRecords) {
            return undefined;
        }
        return MINode.valueOf(this.resultRecords.results, path);
    }
}

export interface VarUpdateRecord {
    name: string;
    value: string;
    in_scope: "true" | "false" | "invalid";
    type_changed: "true" | "false";
    new_type?: string;
    new_num_children?: string;
    displayhint?: string;
    has_more?: "1";
    dynamic?: "1";
    new_children?: any[];
}
