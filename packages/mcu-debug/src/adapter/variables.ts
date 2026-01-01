import { IValueIdentifiable, ValueHandleRegistry } from "@mcu-debug/shared";
import { DebugProtocol } from "@vscode/debugprotocol";

export enum VariableScope {
    Global = 0,
    Static = 1,
    Local = 2,
    Registers = 3,
    Scope = 4,
    Watch = 5,
    Hover = 6,
    Other = 7,
}

// We have a total of 53 bits of precision in a JavaScript number
// So, we use 24 bits for the frame ID and 26 bits for the thread ID and 3 bits for scope
const FrameIDMask = 0xffffff;
const ThreadIDMask = 0x3ffffff;
const ScopeMask = 0x7;
export function decodeReference(varRef: number): number[] {
    return [(varRef & ThreadIDMask) >>> (24 + 3), (varRef & FrameIDMask) >>> 3, varRef & ScopeMask];
}

export function encodeReference(threadId: number, frameId: number, scope: VariableScope): number {
    return (threadId << (24 + 3)) | ((frameId & FrameIDMask) << 3) | (scope & ScopeMask);
}

export function getScopeFromReference(varRef: number): VariableScope {
    return varRef & ScopeMask;
}

// These are the keys that uniquely identify a variable
export class VariableKeys implements IValueIdentifiable {
    constructor(
        public readonly scope: VariableScope,
        public readonly parent: number,
        public readonly name: string,
        public readonly frameRef: number,
        public readonly evaluateName?: string,
    ) {}
    toValueKey(): string {
        return `${this.scope}|${this.frameRef}|${this.name}|${this.parent}|${this.evaluateName || ""}`;
    }
}

export class VariableObject extends VariableKeys implements DebugProtocol.Variable {
    public variablesReference: number = 0; // This is set only if the variable has children
    public handle = 0; // This comes from  VariableManager, can be used as variablesReference if needed
    public gdbVarObjId?: string; // The GDB variable object ID associated with this variable, if any
    constructor(
        scope: VariableScope,
        parent: number,
        name: string,
        frameRef: number,
        evaluateName: string | undefined,
        public value: string,
        public type: string,
        public exp: string = "", // Junk field to be removed later
        public fullExp: string = "", // Junk field to be removed later
        public id: number = 0, // Junk field to be removed later
        public children: { [key: string]: string } = {}, // Junk field to be removed later
    ) {
        super(scope, parent, name, frameRef, evaluateName);
    }

    // Junk methods to be removed later
    public isCompound(): boolean {
        throw new Error("Method not implemented.");
    }
    toProtocolEvaluateResponseBody(): {
        result: string;
        type?: string;
        presentationHint?: DebugProtocol.VariablePresentationHint;
        variablesReference: number;
        namedVariables?: number;
        indexedVariables?: number;
        memoryReference?: string;
        valueLocationReference?: number;
    } {
        throw new Error("Method not implemented.");
    }
    toProtocolVariable(): DebugProtocol.Variable {
        return this;
        // throw new Error("Method not implemented.");
    }
}

// Manages VariableObjects and their handles. We expect that the client will put variables in
// different variables so they can be released when no longer needed in bulk or never released
// 1. For local variables and registers, they are released when stack is no longer valid (on continue)
// 2. For global/static variables, they are never released (could be updated in the future)
// 3. Watch variables are released when the watch is removed
export class VariableManager {
    private variableHandles = new ValueHandleRegistry<VariableKeys>();
    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number, evaluateName?: string): VariableObject {
        const varRef = encodeReference(threadId, frameId, scope);
        const variable = new VariableObject(scope, parent, name, varRef, evaluateName, value, type);
        const handle = this.variableHandles.addObject(variable);
        variable.handle = handle;
        return variable;
    }

    public getVariableByKey(key: VariableKeys): VariableObject | undefined {
        return this.variableHandles.getObjectByKey(key) as VariableObject | undefined;
    }
    public getHandleByKey(key: VariableKeys): number | undefined {
        return this.variableHandles.getHandle(key);
    }
    // handle is the same as variable.variablesReference but variablesReference may be 0
    public getVariableByRef(handle: number): VariableObject | undefined {
        return this.variableHandles.getObject(handle) as VariableObject | undefined;
    }
    public releaseVariable(handle: number): boolean {
        return this.variableHandles.release(handle);
    }
    public clear() {
        this.variableHandles.clear();
    }
}

/// Junk types to be removed later
export class ExtendedVariable {
    constructor(
        public name: string,
        public options: any,
    ) {}
}
