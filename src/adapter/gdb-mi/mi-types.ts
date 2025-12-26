export interface GdbMiFrame {
    level: number;
    addr: string;
    func: string;
    file?: string;
    fullname?: string;
    line?: number;
    from?: string;
    addr_flags?: string;
}

export interface GdbMiThread {
    id: number;
    target_id?: string;
    frame: GdbMiFrame;
    state?: string;
    core?: number;
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

export interface GdbMiRecord {
    token: string;
    recordType: GdbMiRecordType;
    outputType: GdbMiOutputType;
    class: string;
    result: any;
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
