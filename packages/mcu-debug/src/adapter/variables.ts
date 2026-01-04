import { IValueIdentifiable, ValueHandleRegistry, ValueHandleRegistryPrimitive } from "@mcu-debug/shared";
import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbEventNames, GdbMiOutput, GdbMiRecord } from "./gdb-mi/mi-types";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { toStringDecHexOctBin } from "./servers/common";
import { Variable } from "@vscode/debugadapter";

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
const ScopeMaskSimple = 0x7;
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
    ) {}
    toValueKey(): string {
        return `${this.frameRef}|${this.name}|${this.parent} || ""}`;
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
        public value: string,
        public type: string,
        public exp: string = "",
        public evaluateName: string = "",
        public id: number = 0, // Junk field to be removed later
        public children: VariableObject[] = [],
        public dynamic: boolean = false, // Mi field
        public hasMore: boolean = false, // Mi field
        public displayHint: string = "", // Mi field
    ) {
        super(parent, name, frameRef);
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
    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number): [VariableObject, number] {
        const varRef = encodeReference(threadId, frameId, scope & ActualScopeMask);
        const variable = new VariableObject(scope, parent, name, varRef, value, type);
        const handle = this.variableHandles.addObject(variable);
        variable.handle = (handle << ScopeBits) | (scope & ScopeMask); // Shift left to make room for scope bits
        return [variable, variable.handle];
    }

    public parseMiVariable(name: string, record: GdbMiRecord, scope: VariableScope, parent: number, threadId: number, frameId: number): [VariableObject | undefined, number | undefined] {
        const value = record["value"];
        const type = record["type"] || "unknown";
        if (name === undefined || value === undefined) {
            return [undefined, undefined];
        }
        // Mi variables don't have scope, parent, frameRef, evaluateName info
        const [varObj, handle] = this.createVariable(scope, parent, name, value, type, threadId, frameId);
        varObj.gdbVarName = record["name"];
        varObj.exp = record["exp"] || name;
        varObj.evaluateName = varObj.exp; // For now, fullExp is same as exp. It may change later. For root variables, they are the same
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

    public createGlobalVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, fileName?: string): [VariableObject, number] {
        let fileId = fileName ? this.fileToIdMap.get(fileName) : 0;
        if (fileName && fileId === undefined) {
            fileId = this.nextFileId++;
            this.fileToIdMap.set(fileName, fileId);
            this.fildIdToFile.set(fileId, fileName);
        }
        return super.createVariable(scope, parent, name, value, type, fileId || 0, 0);
    }

    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number): [VariableObject, number] {
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
// Register group information
interface RegisterGroupInfo {
    name: string;
    type: string;
    registers: string[];
}

interface RegisterInfo {
    name: string;
    number: number;
    groups: string[];
}

export class VariableManager {
    private globalContainer: VariableContainerForGlobals = new VariableContainerForGlobals();
    private localContainer: VariableContainer = new VariableContainer();
    private dynamicContainer: VariableContainer = new VariableContainer();
    private frameHandles = new ValueHandleRegistryPrimitive<number>();
    private containers = new Map<VariableScope, VariableContainer>();
    private localGdbNames: Set<string> = new Set<string>();
    private regFormat = "x"; // Default to Natural format
    private registerGroups: RegisterGroupInfo[] = [];
    private registerInfoMap = new Map<number, RegisterInfo>();
    private registerValuesMap: Map<number, GdbMiOutput> = new Map<number, GdbMiOutput>();

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
        let container = this.containers.get(scope & ActualScopeMask);
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

    public clearForContinue() {
        this.localContainer.clear();
        this.dynamicContainer.clear();
        this.frameHandles.clear();
        this.registerValuesMap.clear();
    }

    private async clearGdbNames() {
        let promises = [];
        let names: string[] = [];
        for (const name of this.localGdbNames) {
            names.push(name);
            const p = this.gdbInstance.sendCommand(`-var-delete ${name}`);
            promises.push(p);
        }
        let count = 0;
        for (const p of promises) {
            try {
                await p;
                this.localGdbNames.delete(names[count]);
            } catch (e) {
                if (this.debugSession.args.debugFlags.anyFlags) {
                    this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error deleting GDB variable ${names[count]} on continue: ${e}\n`);
                }
            }
            count++;
        }
    }

    public async prepareForStopped() {
        this.clearForContinue();
        // We delete all gdb variable names on stopped rather than on continue to avoid issues with
        // gdb beginning to run before we finish deleted the variables. Execution can continue in many
        // ways (continue, step, next, etc) and it's hard to track them all. So, we do it here when we
        // are sure gdb is stopped. Even if there is a collision, the worst that can happen is a variable name
        // is reused which is unlikely but if the debugger is running fast enough, it could happen. The danger
        // comes when a variable for same thread/frame is reused but it turns from scalar to compound or vice versa.
        await this.clearGdbNames();
    }

    public getVarOrFrameInfo(handle: VariableReference): [number, number, VariableScope] {
        if (handle & VariableTypeMask) {
            const scope = handle & ScopeMask;
            const container = this.getContainer(scope);
            const variable = container.getVariableByRef(handle);
            if (variable === undefined) {
                throw new Error(`No variable found for reference ${handle}`);
            }
            const [threadId, frameId, _] = variable.getThreadFrameInfo();
            return [threadId, frameId, scope];
        } else {
            return this.getFrameInfo(handle);
        }
    }

    public getVariables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
        const [threadId, frameId, scope] = this.getVarOrFrameInfo(args.variablesReference);
        if (scope === VariableScope.Local) {
            return this.getLocalVariables(threadId, frameId);
        } else if (scope === VariableScope.Registers) {
            return this.getRegisterVariables(threadId, frameId);
        } else if (scope & VariableTypeMask) {
            // If this is a variable, we need to get is thread/frame ids from the variable itself
            const container = this.getContainer(scope);
            const variable = container.getVariableByRef(args.variablesReference);
            if (variable === undefined) {
                Promise.reject(new Error(`No variable found for reference ${args.variablesReference}`));
            }
            return this.getVariableChildren(variable);
        }
    }

    public async varListChildren(container: VariableContainer, parent: VariableObject, name: string, threadId: number, frameId: number): Promise<VariableObject[]> {
        const miOutput = await this.gdbInstance.sendCommand(`var-list-children --simple-values "${name}"`);
        const keywords = ["private", "protected", "public"];
        const children = miOutput.resultRecord.result["children"] || [];
        const ret: VariableObject[] = [];
        for (const item of children) {
            const gdbVarName = item["name"];
            const exp = item["exp"];
            if (exp && exp.startsWith("<anonymous ")) {
                ret.push(...(await this.varListChildren(container, parent, gdbVarName, threadId, frameId)));
            } else if (exp && keywords.find((x) => x === exp)) {
                ret.push(...(await this.varListChildren(container, parent, gdbVarName, threadId, frameId)));
            } else {
                const [child, handle] = container.parseMiVariable(item["exp"], item, parent.scope, parent.handle, threadId, frameId);
                child.evaluateName = /^\d+$/.test(child.exp) ? `${parent.evaluateName}[${child.exp}]` : `${parent.evaluateName}.${child.exp}`;
                if (item["numchild"] && parseInt(item["numchild"]) > 0) {
                    child.variablesReference = handle!;
                }
                child.applyChanges(item);
                ret.push(child);
            }
        }
        return ret;
    }

    async getVariableChildren(parent: VariableObject): Promise<DebugProtocol.Variable[]> {
        try {
            // Check if this is a register group variable
            if (parent.scope === VariableScope.RegistersVariable && !parent.gdbVarName) {
                // This is a register group, get registers for this group
                return this.getRegistersForGroup(parent);
            }
            const container = this.getContainer(parent.scope);
            const [threadId, frameId, _] = parent.getThreadFrameInfo();
            const children = await this.varListChildren(container, parent, parent.gdbVarName, threadId, frameId);
            parent.children = children;
            const protoVars: DebugProtocol.Variable[] = [];
            for (const child of children) {
                protoVars.push(child.toProtocolVariable());
            }
            return protoVars;
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting children for variable ${parent.evaluateName}: ${e}\n`);
            }
            return Promise.reject(e);
        }
    }

    /**
     * Gets registers that belong to a specific group.
     */
    private async getRegistersForGroup(groupVar: VariableObject): Promise<DebugProtocol.Variable[]> {
        const [threadId, frameId, _] = groupVar.getThreadFrameInfo();
        const groupName = groupVar.type; // We stored the group name in the type field
        const internalGroups = ["all", "save", "restore"];

        try {
            // Get all register values
            const ref = encodeReference(threadId, frameId, VariableScope.Registers);
            let miOutput: GdbMiOutput = this.registerValuesMap.get(ref);
            if (!miOutput) {
                const cmd = `-data-list-register-values --thread ${threadId} --frame ${frameId} ${this.regFormat}`;
                miOutput = await this.gdbInstance.sendCommand(cmd);
                this.registerValuesMap.set(ref, miOutput);
            }

            const variables: DebugProtocol.Variable[] = [];
            const regs = miOutput.resultRecord.result["register-values"];
            if (Array.isArray(regs)) {
                const container = this.getContainer(VariableScope.Registers);
                for (const r of regs) {
                    if (this.gdbInstance.IsRunning()) {
                        break;
                    }
                    const regNumber = parseInt(r["number"]);
                    const regInfo = this.registerInfoMap.get(regNumber);

                    if (!regInfo) {
                        continue;
                    }

                    // Filter based on group
                    if (groupName === "misc") {
                        // Misc group contains registers that only belong to internal groups
                        const userGroups = regInfo.groups.filter((g) => !internalGroups.includes(g));
                        if (userGroups.length > 0) {
                            continue; // This register belongs to a user group, skip it
                        }
                    } else {
                        // Skip registers that don't belong to this group
                        if (!regInfo.groups.includes(groupName)) {
                            continue;
                        }
                    }

                    const regName = regInfo.name;
                    const key = new VariableKeys(groupVar.handle, regName, encodeReference(threadId, frameId, VariableScope.Registers));
                    const existingVar = container.getVariableByKey(key);

                    try {
                        if (existingVar === undefined) {
                            // Create a gdb variable for this register
                            const gdbVarName = this.creatGdbName(regName.replaceAll("$", "reg-"), threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${regName}`;
                            await this.gdbInstance.sendCommand(cmd).then((varCreateRecord) => {
                                const record = varCreateRecord.resultRecord.result;
                                const [varObj] = container.parseMiVariable(regName, record, VariableScope.RegistersVariable, groupVar.handle, threadId, frameId);
                                varObj.value = r["value"]; // Use this because it is better formatted
                                if (varObj !== undefined) {
                                    this.setFields(varObj);
                                    variables.push(varObj.toProtocolVariable());
                                }
                            });
                        } else {
                            existingVar.value = r["value"];
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
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting registers for group ${groupName}: ${e}\n`);
            }
        }
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
                                    if (record["numchild"] && parseInt(record["numchild"]) > 0) {
                                        varObj.variablesReference = handle!;
                                    }
                                    variables.push(varObj.toProtocolVariable());
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

    private async getRegisterGroups(): Promise<void> {
        if (this.registerGroups.length > 0) {
            return;
        }
        try {
            this.gdbInstance.suppressConsoleOutput = true;
            const miOutput = await this.gdbInstance.sendCommand(`-interpreter-exec console "maint print reggroups"`);
            // Extract console output from out-of-band records
            const consoleLines = miOutput.outOfBandRecords.filter((record) => record.outputType === "console").map((record) => record.result);
            const consoleOutput = consoleLines.join("");
            const lines = consoleOutput.split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("Group")) {
                    continue; // Skip header or empty lines
                }
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 2) {
                    const name = parts[0];
                    const type = parts[1];
                    if (type !== "internal") {
                        this.registerGroups.push({ name, type, registers: [] });
                    }
                }
            }
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting register groups: ${e}\n`);
            }
        } finally {
            this.gdbInstance.suppressConsoleOutput = false;
        }
    }

    private async getRegisterGroupMappings(): Promise<void> {
        if (this.registerInfoMap.size > 0) {
            return;
        }
        try {
            this.gdbInstance.suppressConsoleOutput = true;
            const miOutput = await this.gdbInstance.sendCommand(`-interpreter-exec console "maint print register-groups"`);
            // Extract console output from out-of-band records
            const consoleLines = miOutput.outOfBandRecords.filter((record) => record.outputType === "console").map((record) => record.result);
            for (const line of consoleLines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("Name")) {
                    continue; // Skip header or empty lines
                }
                const parts = trimmed.split(/\s+/);
                if (parts.length < 6) {
                    continue; // Not enough columns
                }
                const name = parts[0];
                if (!name || name === "''") {
                    continue; // Skip blank names
                }
                const numberStr = parts[1];
                const groupsStr = parts[parts.length - 1];
                const number = parseInt(numberStr);
                if (isNaN(number)) {
                    continue;
                }
                const groups = groupsStr
                    .split(",")
                    .map((g) => g.trim())
                    .filter((g) => g);
                this.registerInfoMap.set(number, { name: `$${name}`, number, groups });
                for (const groupName of groups) {
                    const group = this.registerGroups.find((g) => g.name === groupName);
                    if (group) {
                        group.registers.push(`$${name}`);
                    }
                }
            }
            // Delete empty groups
            this.registerGroups = this.registerGroups.filter((g) => g.registers.length > 0);
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting register group mappings: ${e}\n`);
            }
        } finally {
            this.gdbInstance.suppressConsoleOutput = false;
        }
    }

    /**
     * Returns register groups as top-level variables. Each group contains registers as children.
     */
    private async getRegisterVariables(threadId: number, frameId: number): Promise<DebugProtocol.Variable[]> {
        // Fetch register groups and mappings
        await this.getRegisterGroups();
        await this.getRegisterGroupMappings();

        if (this.registerGroups.length === 0) {
            // Fallback to old behavior if groups are not available
            return this.getRegisterVariablesFlat(threadId, frameId);
        }

        const variables: DebugProtocol.Variable[] = [];
        const container = this.getContainer(VariableScope.Registers);

        // Check if there are registers that don't belong to any user group
        const internalGroups = ["all", "save", "restore"];
        let hasMiscRegisters = false;
        for (const [_, regInfo] of this.registerInfoMap) {
            // Check if register only belongs to internal groups or no groups
            const userGroups = regInfo.groups.filter((g) => !internalGroups.includes(g));
            if (userGroups.length === 0) {
                hasMiscRegisters = true;
                break;
            }
        }

        // Create a variable for each register group
        for (const group of this.registerGroups) {
            // Skip "all" group as it contains all registers and internal groups
            if (internalGroups.includes(group.name)) {
                continue;
            }

            // Capitalize first letter for display
            const displayName = group.name.charAt(0).toUpperCase() + group.name.slice(1);

            // Create a group variable
            const key = new VariableKeys(0, displayName, encodeReference(threadId, frameId, VariableScope.Registers));
            let groupVar = container.getVariableByKey(key) as VariableObject | undefined;

            if (groupVar === undefined) {
                const [varObj, handle] = container.createVariable(
                    VariableScope.RegistersVariable,
                    0,
                    displayName,
                    "", // Value will be empty for group
                    group.name, // Store group name in type field for later use
                    threadId,
                    frameId,
                );
                groupVar = varObj;
                groupVar.variablesReference = handle;
            }

            variables.push(groupVar.toProtocolVariable());
        }

        // Add Misc group if there are registers that don't belong to any user group
        if (hasMiscRegisters) {
            const key = new VariableKeys(0, "Misc", encodeReference(threadId, frameId, VariableScope.Registers));
            let groupVar = container.getVariableByKey(key) as VariableObject | undefined;

            if (groupVar === undefined) {
                const [varObj, handle] = container.createVariable(
                    VariableScope.RegistersVariable,
                    0,
                    "Misc",
                    "", // Value will be empty for group
                    "misc", // Store group name in type field for later use
                    threadId,
                    frameId,
                );
                groupVar = varObj;
                groupVar.variablesReference = handle;
            }

            variables.push(groupVar.toProtocolVariable());
        }

        return variables;
    }

    /**
     * Fallback method that returns a flat list of all registers.
     * Used when register grouping information is not available.
     */
    private async getRegisterVariablesFlat(threadId: number, frameId: number): Promise<DebugProtocol.Variable[]> {
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
                            const gdbVarName = this.creatGdbName(regName.replaceAll("$", "reg-"), threadId, frameId);
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
