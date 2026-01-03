import { IValueIdentifiable, ValueHandleRegistry, ValueHandleRegistryPrimitive } from "@mcu-debug/shared";
import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbEventNames, GdbMiRecord } from "./gdb-mi/mi-types";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { toStringDecHexOctBin } from "./servers/common";

const VariableTypeMask = 1 << 3; // Indicates this is a variable type key for a given scope

export enum VariableScope {
    Global = 0,
    Static = 1,
    Local = 2,
    Registers = 3,
    Scope = 4, // Dummy scope for top level variable categories
    LocalVariable = VariableTypeMask | VariableScope.Local, // Local variable
    RegistersVariable = VariableTypeMask | VariableScope.Registers, // Register variable
    GlobalVariable = VariableTypeMask | VariableScope.Global, // Global variable
    StaticVariable = VariableTypeMask | VariableScope.Static, // Static variable
    Watch = VariableTypeMask | 0x5, // Dynamic watch variable
    Hover = VariableTypeMask | 0x6, // Dynamic hover variable
}

// We have a total of 53 bits of precision in a JavaScript number
// So, we use 24 bits for the frame ID and 25 bits for the thread ID and 4 bits for scope.
// MSB of Scope identifies if this is a variable or a frame reference
const ActualScopeMask = 0x7;
const FrameIDMask = 0xffffff;
const ThreadIDMask = 0x1ffffff;
const ScopeMask = 0xf;
const ScopeBits = 4;
const FrameIDBits = 24;
const ThreadIDBits = 25;
export function decodeReference(varRef: number): [number, number, VariableScope] {
    return [varRef >>> (FrameIDBits + ScopeBits), (varRef >>> ScopeBits) & FrameIDMask, varRef & ScopeMask];
}

export function encodeReference(threadId: number, frameId: number, scope: VariableScope): number {
    return ((threadId & ThreadIDMask) << (FrameIDBits + ScopeBits)) | ((frameId & FrameIDMask) << ScopeBits) | (scope & ScopeMask);
}

export function getScopeFromReference(varRef: number): VariableScope {
    return varRef & ScopeMask;
}

// These are the fields that uniquely identify a variable
export class VariableKeys implements IValueIdentifiable {
    constructor(
        public readonly parent: number,
        public readonly name: string,
        public readonly frameRef: number,
        public readonly evaluateName?: string,
    ) {}
    toValueKey(): string {
        return `${this.frameRef}|${this.name}|${this.parent}|${this.evaluateName || ""}`;
    }
}

export class VariableObject extends VariableKeys implements DebugProtocol.Variable {
    public variablesReference: number = 0; // This is set only if the variable has children
    public handle = 0; // This comes from  VariableManager, can be used as variablesReference if needed
    public gdbVarName?: string; // The GDB variable name associated with this object, if any
    constructor(
        public readonly scope: VariableScope,
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
        public dynamic: boolean = false, // Mi field
        public hasMore: boolean = false, // Mi field
        public displayHint: string = "", // Mi field
    ) {
        super(parent, name, frameRef, evaluateName);
        this.scope |= VariableTypeMask;
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
    }

    public getThreadFrameInfo(): [number, number, VariableScope] {
        return decodeReference(this.frameRef);
    }

    public applyChanges(record: GdbMiRecord): void {
        if (record["value"] !== undefined) {
            // How can this be undefined?
            this.value = record["value"];
        }
        const typeChanged = record["type_changed"];
        if (typeChanged === "true") {
            this.type = record["new_type"] ?? this.type;
        }
        this.dynamic = !!parseInt(record["dynamic"] ?? "0");
        this.displayHint = record["displayhint"];
        this.hasMore = !!parseInt(record["has_more"] ?? "0");
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
    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number, evaluateName?: string): [VariableObject, number] {
        const varRef = encodeReference(threadId, frameId, scope & ActualScopeMask);
        const variable = new VariableObject(scope, parent, name, varRef, evaluateName, value, type);
        const handle = this.variableHandles.addObject(variable);
        variable.handle = (handle << ScopeBits) | (scope & ScopeMask); // Shift left to make room for scope bits
        return [variable, variable.handle];
    }

    public parseMiVariable(name: string, record: GdbMiRecord, scope: VariableScope, parent: number, threadId: number, frameId: number): [VariableObject | undefined, number | undefined] {
        const gdbVarName = record["name"];
        const value = record["value"];
        const type = record["type"] || "unknown";
        if (name === undefined || value === undefined) {
            return [undefined, undefined];
        }
        // Mi variables don't have scope, parent, frameRef, evaluateName info
        const [varObj, handle] = this.createVariable(scope, parent, name, value, type, threadId, frameId);
        varObj.gdbVarName = gdbVarName;
        varObj.applyChanges(record);
        return [varObj, handle];
    }

    public getVariableByKey(key: VariableKeys): VariableObject | undefined {
        return this.variableHandles.getObjectByKey(key) as VariableObject | undefined;
    }
    public getHandleByKey(key: VariableKeys): number | undefined {
        return this.variableHandles.getHandle(key);
    }
    // handle is the same as variable.variablesReference but variablesReference may be 0
    public getVariableByRef(handle: number): VariableObject | undefined {
        handle = handle >>> ScopeBits; // Just to avoid lint warning
        return this.variableHandles.getObject(handle) as VariableObject | undefined;
    }
    public releaseVariable(handle: number): boolean {
        handle = handle >>> ScopeBits; // Just to avoid lint warning
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

    public createGlobalVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, fileName?: string, evaluateName?: string): [VariableObject, number] {
        let fileId = fileName ? this.fileToIdMap.get(fileName) : 0;
        if (fileName && fileId === undefined) {
            fileId = this.nextFileId++;
            this.fileToIdMap.set(fileName, fileId);
            this.fildIdToFile.set(fileId, fileName);
        }
        return super.createVariable(scope, parent, name, value, type, fileId || 0, 0, evaluateName);
    }

    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number, evaluateName?: string): [VariableObject, number] {
        throw new Error("Use createGlobalVariable for globals/statics");
    }
}

/**
 * A Note about handles and VariableReferences
 *
 * In the DAP protocol, variables are referenced using a 'variablesReference' number.
 * In this implementation, we use a combination of a ValueHandleRegistry and encoded
 * information within the handle itself to manage variable references efficiently.
 *
 * Each variable is assigned a unique handle by the ValueHandleRegistry. This handle
 *
 * Then there are global frame handles that encode thread/frame/scope information for stack frames.
 * These handles are managed separately in the VariableManager. The handles encode has the ValueTypeMask
 * bit set to 0 for frame references. and 1 for variable references.
 * This allows us to distinguish between frame references and variable references easily.
 *
 * The VariableManager class provides methods to create and manage these handles,
 * ensuring that each variable and frame can be uniquely identified and accessed
 * throughout the debugging session.
 */

export type VariableReference = number;
export class VariableManager {
    private globalContainer: VariableContainerForGlobals = new VariableContainerForGlobals();
    private localContainer: VariableContainer = new VariableContainer();
    private dynamicContainer: VariableContainer = new VariableContainer();
    private frameHandles = new ValueHandleRegistryPrimitive<number>();
    private containers = new Map<VariableScope, VariableContainer>();
    private localGdbNames: Set<string> = new Set<string>();
    private regFormat = "x"; // Default to Natural format

    constructor(
        private gdbInstance: GdbInstance,
        private debugSession: GDBDebugSession,
    ) {
        // These two scopes need a thread/frame associated with them
        this.containers.set(VariableScope.Global, this.globalContainer);
        this.containers.set(VariableScope.Static, this.globalContainer);

        //These two scopes are for globals and statics only
        this.containers.set(VariableScope.Local, this.localContainer);
        this.containers.set(VariableScope.Registers, this.localContainer);

        // These scopes are dynamic and can be released individually
        this.containers.set(VariableScope.Watch, this.dynamicContainer);
        this.containers.set(VariableScope.Hover, this.dynamicContainer);
    }

    public getContainer(scope: VariableScope): VariableContainer {
        let container = this.containers.get(scope);
        if (!container) {
            throw new Error(`No container for scope ${VariableScope[scope]}`);
        }
        return container;
    }

    public hasFrameHandle(handle: VariableReference): boolean {
        return this.frameHandles.get(handle) !== undefined;
    }
    public getFrameInfo(handle: VariableReference): [number, number, VariableScope] {
        const encoded = this.frameHandles.get(handle);
        if (encoded === undefined) {
            throw new Error(`No frame info for handle ${handle}`);
        }
        return decodeReference(encoded);
    }

    public addFrameInfo(threadId: number, frameId: number, scope: VariableScope): VariableReference {
        const h = encodeReference(threadId, frameId, scope);
        return this.frameHandles.add(h);
    }

    public async clearForContinue() {
        this.localContainer.clear();
        this.dynamicContainer.clear();
        this.frameHandles.clear();
        await this.clearGdbNames();
        if (this.localGdbNames.size > 0) {
            // This will prevent future name clashes, but indicates a bug
            this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Internal error: Not all local GDB variables were deleted on continue: ${Array.from(this.localGdbNames).join(", ")}\n`);
        }
    }

    private async clearGdbNames() {
        let promises = [];
        for (const name of this.localGdbNames) {
            const p = this.gdbInstance
                .sendCommand(`-var-delete ${name}`)
                .then(() => {
                    this.localGdbNames.delete(name);
                })
                .catch((e) => {
                    if (this.debugSession.args.debugFlags.anyFlags) {
                        this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error deleting GDB variable ${name} on continue: ${e}\n`);
                    }
                });
            promises.push(p);
        }
        try {
            await Promise.all(promises);
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error deleting GDB variables on continue: ${e}\n`);
            }
        }
    }

    public async prepareForStopped() {
        this.frameHandles.clear();
        await this.clearGdbNames();
    }

    public getVariables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
        const [threadId, frameId, scope] = this.getFrameInfo(args.variablesReference);
        if (scope === VariableScope.Local) {
            return this.getLocalVariables(threadId, frameId);
        } else if (scope === VariableScope.Registers) {
            return this.getRegisterVariables(threadId, frameId);
        } else if (scope & VariableTypeMask) {
            // If this is a variable, we need to get is thread/frame ids from the variable itself
            const variable = this.localContainer.getVariableByRef(args.variablesReference);
            if (variable === undefined) {
                Promise.reject(new Error(`No variable found for reference ${args.variablesReference}`));
            }
            return this.getVariableChildren(variable);
        }
    }

    getVariableChildren(parent: VariableObject): Promise<DebugProtocol.Variable[]> {
        const cmd = `-var-list-children --simple-values ${parent.gdbVarName}`;
        return this.gdbInstance.sendCommand(cmd).then(async (miOutput) => {
            const variables: DebugProtocol.Variable[] = [];
            const children = miOutput.resultRecord.result["children"];
            if (Array.isArray(children)) {
                const container = this.getContainer(parent.scope);
                for (const child of children) {
                    if (this.gdbInstance.IsRunning()) {
                        break;
                    }
                    const exp = child["exp"];
                    const fullExp = `${parent.fullExp}.${exp}`;
                    const key = new VariableKeys(parent.handle, child["name"], parent.frameRef);
                    const existingVar = container.getVariableByKey(key);
                    try {
                        if (existingVar === undefined) {
                            const [threadId, frameId, _] = parent.getThreadFrameInfo();
                            const varName = child["name"];
                            const gdbVarName = this.creatGdbName(varName, threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${parent.gdbVarName}.${varName}`;
                            await this.gdbInstance.sendCommand(cmd).then((varCreateRecord) => {
                                const record = varCreateRecord.resultRecord.result;
                                const [varObj, handle] = container.parseMiVariable(varName, record, parent.scope, parent.handle, threadId, frameId);
                                if (varObj !== undefined) {
                                    variables.push(varObj.toProtocolVariable());
                                    if (record["numchildren"] && parseInt(record["numchildren"]) > 0) {
                                        varObj.variablesReference = handle!;
                                    }
                                }
                            });
                        } else {
                            await this.gdbInstance.sendCommand(`-var-update --simple-values ${existingVar.gdbVarName}`).then((varUpdateRecord) => {
                                const record = varUpdateRecord.resultRecord.result;
                                if (record["in_scope"] && record["in_scope"] !== "true") {
                                    return; // Variable is out of scope, skip it. Not sure why this would happen
                                }
                                existingVar.applyChanges(record);
                                variables.push(existingVar.toProtocolVariable());
                            });
                        }
                    } catch (e) {
                        if (this.debugSession.args.debugFlags.anyFlags) {
                            this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting child variable ${child["name"]}: ${e}\n`);
                        }
                    }
                }
            }
            return variables;
        });
    }

    creatGdbName(base: string, thread: number, frame: number): string {
        let ret = `${base}-${thread}-${frame}`;
        let count = 1;
        while (this.localGdbNames.has(ret)) {
            ret = `${base}-${thread}-${frame}-${count}`;
            count++;
        }
        this.localGdbNames.add(ret);
        return ret;
    }

    private async getLocalVariables(threadId: number, frameId: number): Promise<DebugProtocol.Variable[]> {
        const cmd = `-stack-list-variables --thread ${threadId} --frame ${frameId} --simple-values`;
        return await this.gdbInstance.sendCommand(cmd).then(async (miOutput) => {
            const variables: DebugProtocol.Variable[] = [];
            const vars = miOutput.resultRecord.result["variables"];
            if (Array.isArray(vars)) {
                const container = this.getContainer(VariableScope.Local);
                for (const v of vars) {
                    if (this.gdbInstance.IsRunning()) {
                        break;
                    }
                    const key = new VariableKeys(0, v["name"], encodeReference(threadId, frameId, VariableScope.Local));
                    const existingVar = container.getVariableByKey(key);
                    try {
                        if (existingVar === undefined) {
                            const varName = v["name"];
                            const gdbVarName = this.creatGdbName(varName, threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${varName}`;
                            await this.gdbInstance.sendCommand(cmd).then((varCreateRecord) => {
                                const record = varCreateRecord.resultRecord.result;
                                const [varObj, handle] = container.parseMiVariable(varName, record, VariableScope.LocalVariable, 0, threadId, frameId);
                                if (varObj !== undefined) {
                                    variables.push(varObj.toProtocolVariable());
                                    if (record["numchildren"] && parseInt(record["numchildren"]) > 0) {
                                        varObj.variablesReference = handle!;
                                    }
                                }
                            });
                        } else {
                            await this.gdbInstance.sendCommand(`-var-update --simple-values ${existingVar.gdbVarName}`).then((varUpdateRecord) => {
                                const record = varUpdateRecord.resultRecord.result;
                                if (record["in_scope"] && record["in_scope"] !== "true") {
                                    return; // Variable is out of scope, skip it. Not sure why this would happen
                                }
                                existingVar.applyChanges(record);
                                variables.push(existingVar.toProtocolVariable());
                            });
                        }
                    } catch (e) {
                        if (this.debugSession.args.debugFlags.anyFlags) {
                            this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting local variable ${v["name"]}: ${e}\n`);
                        }
                    }
                }
            }
            return variables;
        });
    }

    private registerNames = new Map<number, string>();
    private async getRegisterNames(): Promise<void> {
        if (this.registerNames.size > 0) {
            return;
        }
        const cmd = `-data-list-register-names`;
        await this.gdbInstance
            .sendCommand(cmd)
            .then(async (miOutput) => {
                const names = miOutput.resultRecord.result["register-names"];
                if (Array.isArray(names)) {
                    let count = 0;
                    for (const n of names) {
                        this.registerNames.set(count, `$${n}`);
                        count++;
                    }
                }
            })
            .catch((e) => {
                if (this.debugSession.args.debugFlags.anyFlags) {
                    this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting register names: ${e}\n`);
                }
            });
    }

    /**
     *
     * TODO: Current implementation is too simple. We create one flat list of all registers. What we want
     * is to create groups for different register sets (core, fpu, mpu, etc.) and have those as
     * top level variables with children. Of course the groups vary by architecture so we need to get
     * that info from somewhere. Not sure GDB provides that. This is what I know
     *
     * `maint print reggroups` -> shows the register groups known to GDB. We can ignore groups marked
     *  as "internal" type. Sample output:
     *  Group      Type
     * general    user
     * float      user
     * system     user
     * vector     user
     * all        user
     * save       internal
     * restore    internal
     * cp_regs    user
     *
     * `maint print register-groups` -> shows all the registers. The first column is the register name
     * and the last column is the comma separated set of groups it belongs to. We can use the first
     * group as the parent group for the register. First line is the header. You can have blanks names
     * which we can ignore.
     *
     * Example output:
     *  Name         Nr  Rel Offset    Size  Type            Groups
     *    r0          0    0      0       4  long            general,all,save,restore
     *    ''         16   16     64       0 int0_t
     *
     * We are interested in columns 0, 1 and last. Anything less than 6 columns is ignored.
     * If groups is empty, we can put it in a "misc" group. Capitalize the first letter of the group
     * name for display.
     */
    private async getRegisterVariables(threadId: number, frameId: number): Promise<DebugProtocol.Variable[]> {
        const cmd = `-data-list-register-values --thread ${threadId} --frame ${frameId} ${this.regFormat}`;
        await this.getRegisterNames();
        if (this.registerNames.size === 0) {
            return [];
        }
        return await this.gdbInstance.sendCommand(cmd).then(async (miOutput) => {
            const variables: DebugProtocol.Variable[] = [];
            const regs = miOutput.resultRecord.result["register-values"];
            if (Array.isArray(regs)) {
                const container = this.getContainer(VariableScope.Registers);
                for (const r of regs) {
                    if (this.gdbInstance.IsRunning()) {
                        break;
                    }
                    const regName = this.registerNames.get(parseInt(r["number"]));
                    if (regName === undefined) {
                        this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Invalid register number: ${r["number"]}\n`);
                        continue;
                    }
                    const key = new VariableKeys(0, regName, encodeReference(threadId, frameId, VariableScope.Registers));
                    const existingVar = container.getVariableByKey(key);
                    try {
                        if (existingVar === undefined) {
                            // We create a gdb variable in case the user wants to set it. Not really needed for viewing
                            const gdbVarName = this.creatGdbName(regName.replace("$", "reg-"), threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${regName}`;
                            await this.gdbInstance.sendCommand(cmd).then((varCreateRecord) => {
                                const record = varCreateRecord.resultRecord.result;
                                const [varObj] = container.parseMiVariable(regName, record, VariableScope.Registers, 0, threadId, frameId);
                                varObj.value = r["value"]; // Use this because it is better formatted
                                if (varObj !== undefined) {
                                    this.setFields(varObj);
                                    variables.push(varObj.toProtocolVariable());
                                }
                            });
                        } else {
                            existingVar.value = r["value"]; // No need for var-update for registers. AFAIK they are fresh each time
                            this.setFields(existingVar);
                            variables.push(existingVar.toProtocolVariable());
                        }
                    } catch (e) {
                        if (this.debugSession.args.debugFlags.anyFlags) {
                            this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting register variable ${regName}: ${e}\n`);
                        }
                    }
                }
            }
            return variables;
        });
    }

    private setFields(reg: VariableObject): void {
        const name = reg.name.toLowerCase();
        if (name !== "$xpsr" && name !== "$control") {
            return;
        }
        const [threadId, frameId, _] = reg.getThreadFrameInfo();
        const field = (nm: string, offset: number, width: number): string => {
            const v = extractBits(intval, offset, width);
            return `\n    ${nm}: ${v.toString()}`;
        };
        const intval = parseInt(reg.value.toLowerCase());
        let rType = `Register: $${reg} Thread#${threadId}, Frame#${frameId}\n` + toStringDecHexOctBin(intval);
        if (name === "$xpsr") {
            rType += field("Negative Flag (N)", 31, 1);
            rType += field("Zero Flag (Z)", 30, 1);
            rType += field("Carry or borrow flag (C)", 29, 1);
            rType += field("Overflow Flag (V)", 28, 1);
            rType += field("Saturation Flag (Q)", 27, 1);
            rType += field("GE", 16, 4);
            rType += field("Interrupt Number", 0, 8);
            rType += field("ICI/IT", 25, 2);
            rType += field("ICI/IT", 10, 6);
            rType += field("Thumb State (T)", 24, 1);
        } else if (name === "$control") {
            rType += field("FPCA", 2, 1);
            rType += field("SPSEL", 1, 1);
            rType += field("nPRIV", 0, 1);
        }
        reg.type = rType;
    }

    public setRegFormat(format: string) {
        if (format != "N") {
            format = format.toLowerCase();
        }
        const allowedFormats = "xotbdrN";
        if (format.length !== 1 || allowedFormats.indexOf(format) === -1) {
            this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Invalid register format specified: ${format}. Allowed formats are: ${allowedFormats.split("").join(", ")}\n`);
            return;
        }
        if (format === "b") {
            format = "t"; // GDB uses 't' for binary
        }
        if (this.regFormat !== format) {
            this.regFormat = format;
            // TODO: Update existing variables?
        }
    }
}

export function createMask(offset: number, width: number) {
    let r = 0;
    const a = offset;
    const b = offset + width - 1;
    for (let i = a; i <= b; i++) {
        r = (r | (1 << i)) >>> 0;
    }
    return r;
}

export function extractBits(value: number, offset: number, width: number) {
    const mask = createMask(offset, width);
    const bvalue = ((value & mask) >>> offset) >>> 0;
    return bvalue;
}

/// Junk types to be removed later
export class ExtendedVariable {
    constructor(
        public name: string,
        public options: any,
    ) {}
}
