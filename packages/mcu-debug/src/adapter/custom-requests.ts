import { DebugProtocol } from "@vscode/debugprotocol";
import { VarUpdateRecord } from "./gdb-mi/mi-types";

export interface CustomCommand {
    command: string;
}

// Live Watch Requests. Once called, if successful, the GDB Live instance will track this variable's children
export interface VariablesRequestLiveArguments extends DebugProtocol.VariablesArguments, CustomCommand {
    command: "variablesLive";
    gdbName?: string;
}

export interface GdbProtocolVariable extends DebugProtocol.Variable {
    gdbName?: string;
}

export interface VariablesLiveResponse extends DebugProtocol.VariablesResponse {
    body: {
        /** All (or a range) of variables for the given variable reference. */
        variables: GdbProtocolVariable[];
    };
}

// Evaluate expression in the Live GDB instance, return its value. If 'track' is true, the variable will be
// tracked for changes
export interface EvaluateRequestLiveArguments extends DebugProtocol.EvaluateArguments, CustomCommand {
    command: "evaluateLive";
    expression: string;
    context: string | "watch";
    track?: boolean;
}

export interface EvaluateLiveResponse extends DebugProtocol.EvaluateResponse {
    body: DebugProtocol.EvaluateResponse["body"] & {
        gdbName?: string;
    };
}

// Update all tracked variables in the Live GDB instance and return their updated values and states
export interface UpdateVariablesLiveArguments extends CustomCommand {
    command: "updateVariablesLive";
}

export interface UpdateVariablesLiveResponse extends DebugProtocol.Response {
    body: {
        updates: VarUpdateRecord[];
    };
}
