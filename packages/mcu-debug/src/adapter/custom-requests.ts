import { DebugProtocol } from "@vscode/debugprotocol";
import { VarUpdateRecord } from "./gdb-mi/mi-types";

export type LiveSessionVersion = "1.1";
export const LatestLiveSessionVersion: LiveSessionVersion = "1.1";
export interface CustomLiveCommand {
    command: string;
    sessionId: string;
}

export interface CustomLiveResponse extends DebugProtocol.Response {
    body: any;
}

export interface CustomLiveEvent extends DebugProtocol.Event {
    body: any;
}

// Live Watch Requests. Once called, if successful, the GDB Live instance will track this variable's children
export interface VariablesRequestLiveArguments extends DebugProtocol.VariablesArguments, CustomLiveCommand {
    command: "variablesLive";
    gdbVarName?: string;
}

export interface GdbProtocolVariable extends DebugProtocol.Variable {
    gdbVarName?: string;
}

// TODO: use copyInterfaceProperties utility, or similar, to create a template object,
// need all properties set to default values inluding optional strings
export const GdbProtocolVariableTemplate: GdbProtocolVariable = {
    evaluateName: "",
    name: "",
    value: "",
    type: "",
    variablesReference: 0,
    namedVariables: 0,
    indexedVariables: 0,
    presentationHint: {},
    memoryReference: "",
    declarationLocationReference: 0,
    valueLocationReference: 0,
    gdbVarName: "",
};

export interface VariablesLiveResponse extends DebugProtocol.VariablesResponse {
    body: {
        /** All (or a range) of variables for the given variable reference. */
        variables: GdbProtocolVariable[];
    };
}

// Evaluate expression in the Live GDB instance, return its value. If 'track' is true, the variable will be
// tracked for changes
export interface EvaluateRequestLiveArguments extends DebugProtocol.EvaluateArguments, CustomLiveCommand {
    command: "evaluateLive";
    expression: string;
    context: string | "watch";
    track?: boolean;
}

export interface EvaluateLiveResponse extends DebugProtocol.EvaluateResponse {
    body: DebugProtocol.EvaluateResponse["body"] & {
        gdbName?: string;
        variableObject?: GdbProtocolVariable;
    };
}

// Update all tracked variables in the Live GDB instance and return their updated values and states
export interface DeleteLiveGdbVariables extends CustomLiveCommand {
    command: "deleteLiveGdbVariables";
    deleteGdbVars: string[];
}

export interface RegisterClientRequest extends CustomLiveCommand {
    command: "registerClient";
    clientId: string;
    version: LiveSessionVersion;
}

export interface RegisterClientResponse extends DebugProtocol.Response {
    body: {
        clientId: string;
        sessionId: string;
    };
}

export interface LiveUpdateEvent extends DebugProtocol.Event {
    event: "custom-live-watch-updates";
    body: {
        sessionId: string;
        clientId: string;
        updates: VarUpdateRecord[];
    };
}

export interface LiveConnectedEvent extends DebugProtocol.Event {
    event: "custom-live-watch-connected";
    body: {};
}

export interface MemoryReadRequestLiveArguments extends DebugProtocol.ReadMemoryArguments {
    command: "readMemoryLive";
    memoryReference: string;
    offset?: number;
    count: number;
}

export interface MemoryReadLiveResponse extends DebugProtocol.ReadMemoryResponse {
    body: {
        address: string;
        unreadableBytes?: number;
        data: string;
    };
}

export interface MemoryWriteRequestLiveArguments extends DebugProtocol.WriteMemoryArguments {
    command: "writeMemoryLive";
    memoryReference: string;
    offset?: number;
    data: string;
}

export interface MemoryWriteLiveResponse extends DebugProtocol.WriteMemoryResponse {
    body: {
        bytesWritten: number;
    };
}

// SetVariableArgumentsLive is used to set a variable that is a leaf-child of another variable
export interface SetVariableArgumentsLive extends DebugProtocol.SetVariableArguments, CustomLiveCommand {
    command: "setVariableLive";
    variablesReference: number;
    gdbVarName?: string; // If supplied, this is the preferred method to identify the variable to set
    name: string; // Required but not used if gdbVarName works.
    value: string;
}

export interface SetVariableLiveResponse extends DebugProtocol.SetVariableResponse {
    body: DebugProtocol.SetVariableResponse["body"] & {
        gdbVarName?: string;
        variableObject?: GdbProtocolVariable;
    };
}

// SetExpressionArgumentsLive is used to set a expression/variable that may be a root variable in a watch window
export interface SetExpressionArgumentsLive extends DebugProtocol.SetExpressionArguments, CustomLiveCommand {
    command: "setExpressionLive";
    expression: string;
    gdbVarName?: string; // If supplied, this is the preferred method to identify the variable to set
    value: string;
}

export interface SetExpressionLiveResponse extends DebugProtocol.SetExpressionResponse {
    body: DebugProtocol.SetExpressionResponse["body"] & {
        gdbVarName?: string;
        variableObject?: GdbProtocolVariable;
    };
}
