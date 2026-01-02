import { IValueIdentifiable, ValueHandleRegistry } from "@mcu-debug/shared";
import { DebugProtocol } from "@vscode/debugprotocol";
import { threadId } from "worker_threads";

export enum VariableScope {
    Global = 0,
    Static = 1,
    Local = 2,
    Registers = 3,
    Watch = 4,
    Hover = 5,
    Scope = 6, // Dummy scope for top level variable categories
    Other = 7, // For future use
}

// We have a total of 53 bits of precision in a JavaScript number
// So, we use 24 bits for the frame ID and 26 bits for the thread ID and 3 bits for scope
const FrameIDMask = 0xffffff;
const ThreadIDMask = 0x3ffffff;
const ScopeMask = 0x7;
const ScopeBits = 3;
export function decodeReference(varRef: number): [number, number, VariableScope] {
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
//
// From a handle, we can get the VariableObject which has all the information needed to evaluate
// the variable again if needed. You can also get the scope of a handle by looking at the lower bits of
// the handle (see VariableManager.createVariable)
export class VariableContainer {
    private variableHandles = new ValueHandleRegistry<VariableKeys>();
    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number, evaluateName?: string): VariableObject {
        const varRef = encodeReference(threadId, frameId, scope);
        const variable = new VariableObject(scope, parent, name, varRef, evaluateName, value, type);
        const handle = this.variableHandles.addObject(variable);
        variable.handle = (handle << ScopeBits) | (scope & ScopeMask); // Shift left to make room for scope bits
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
        handle = handle >> ScopeBits; // Just to avoid lint warning
        return this.variableHandles.getObject(handle) as VariableObject | undefined;
    }
    public releaseVariable(handle: number): boolean {
        handle = handle >> ScopeBits; // Just to avoid lint warning
        return this.variableHandles.release(handle);
    }
    public getScopeFromHandle(handle: number): VariableScope {
        return handle & ScopeMask;
    }
    public clear() {
        this.variableHandles.clear();
    }
}

// This containuer is for locals and globals only. These don't have a thread/frame assosciated with them
// But we will use the ThreadID for a file identifier for globals/statics. ThreadID = 0 means all files.
export class VariableContainerForGlobals extends VariableContainer {
    private fileToIdMap = new Map<string, number>();
    private fildIdToFile = new Map<number, string>();
    private nextFileId = 1; // Start from 1, 0 means all files

    public createGlobalVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, fileName?: string, evaluateName?: string): VariableObject {
        let fileId = fileName ? this.fileToIdMap.get(fileName) : 0;
        if (fileName && fileId === undefined) {
            fileId = this.nextFileId++;
            this.fileToIdMap.set(fileName, fileId);
            this.fildIdToFile.set(fileId, fileName);
        }
        return super.createVariable(scope, parent, name, value, type, fileId || 0, 0, evaluateName);
    }

    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number, evaluateName?: string): VariableObject {
        throw new Error("Use createGlobalVariable for globals/statics");
    }
}

export class VariableManager {
    private globalContainer: VariableContainerForGlobals = new VariableContainerForGlobals();
    private localContainer: VariableContainer = new VariableContainer();
    private dynamicContainer: VariableContainer = new VariableContainer();
    private containers = new Map<VariableScope, VariableContainer>();

    constructor() {
        // These two scopes need a thread/frame associated with them
        this.containers[VariableScope.Global] = this.globalContainer;
        this.containers[VariableScope.Static] = this.globalContainer;

        //These two scopes are for globals and statics only
        this.containers[VariableScope.Local] = this.localContainer;
        this.containers[VariableScope.Registers] = this.localContainer;

        // These scopes are dynamic and can be released individually
        this.containers[VariableScope.Watch] = this.dynamicContainer;
        this.containers[VariableScope.Hover] = this.dynamicContainer;
    }

    public getContainer(scope: VariableScope): VariableContainer {
        let container = this.containers.get(scope);
        if (!container) {
            throw new Error(`No container for scope ${VariableScope[scope]}`);
        }
        return container;
    }

    clearForContinue() {
        this.localContainer.clear();
        this.dynamicContainer.clear();
    }
}

/// Junk types to be removed later
export class ExtendedVariable {
    constructor(
        public name: string,
        public options: any,
    ) {}
}
