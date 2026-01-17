import { IValueIdentifiable, ValueHandleRegistry, ValueHandleRegistryPrimitive } from "@mcu-debug/shared";
import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbEventNames, GdbMiOutput, GdbMiRecord, VarUpdateRecord } from "./gdb-mi/mi-types";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { copyInterfaceProperties, toStringDecHexOctBin } from "./servers/common";
import { GdbProtocolVariable, GdbProtocolVariableTemplate } from "./custom-requests";
import { VariableScope, VariableTypeMask, decodeReference, encodeReference, ActualScopeMask, ScopeBits, ScopeMask } from "./var-scopes";

// These are the fields that uniquely identify a variable
export class VariableKeys implements IValueIdentifiable {
    constructor(
        public readonly parent: number,
        public readonly name: string,
        public readonly frameRef: number,
    ) {}
    toValueKey(): string {
        return `${this.parent}|${this.name}|${this.frameRef}`;
    }
}

export class VariableObject extends VariableKeys implements GdbProtocolVariable {
    public variablesReference: number = 0; // This is set only if the variable has children
    public handle = 0; // This comes from  VariableManager, can be used as variablesReference if needed
    public gdbVarName?: string; // The GDB variable name associated with this object, if any
    public fileName?: string; // For global/static variables, the file they belong to
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

    toProtocolVariable(): GdbProtocolVariable {
        return copyInterfaceProperties<GdbProtocolVariable, VariableObject>(this, GdbProtocolVariableTemplate);
    }

    public getThreadFrameInfo(): [number, number, VariableScope] {
        return decodeReference(this.frameRef);
    }

    public applyChanges(record: VarUpdateRecord): void {
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
    protected gdbVarNameToObjMap = new Map<string, VariableObject>();
    private variableHandles = new ValueHandleRegistry<VariableKeys>();
    constructor(
        public readonly scope: VariableScope,
        public readonly prefix: string,
    ) {}

    public calcFrameRef(threadIdOrFileId: number, frameId: number, scope: VariableScope): number {
        return encodeReference(threadIdOrFileId, frameId, scope & ActualScopeMask);
    }
    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number): [VariableObject, number] {
        const varRef = this.calcFrameRef(threadId, frameId, scope & ActualScopeMask);
        const variable = new VariableObject(scope, parent, name, varRef, value, type);
        const handle = this.variableHandles.addObject(variable);
        variable.handle = (handle << ScopeBits) | (scope & ScopeMask); // Shift left to make room for scope bits
        return [variable, variable.handle];
    }

    public parseMiVariable(name: string, record: GdbMiRecord, scope: VariableScope, parent: number, threadId: number, frameId: number): [VariableObject | undefined, number | undefined] {
        const value = record["value"] ?? "";
        const type = record["type"] || "unknown";
        if (name === undefined) {
            return [undefined, undefined];
        }
        // Mi variables don't have scope, parent, frameRef, evaluateName info
        const [varObj, handle] = this.createVariable(scope, parent, name, value, type, threadId, frameId);
        varObj.gdbVarName = record["name"];
        this.gdbVarNameToObjMap.set(varObj.gdbVarName, varObj);
        varObj.exp = record["exp"] || name;
        varObj.evaluateName = varObj.exp; // For now, fullExp is same as exp. It may change later. For root variables, they are the same
        varObj.applyChanges(record as any as VarUpdateRecord);
        return [varObj, handle];
    }
    public createGlobalVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, fileName: string): [VariableObject, number] {
        throw new Error("Use VariableContainerForGlobals for global/static variables. Wrongly constructed VariableContainer.");
    }
    public parseMiGlobalVariable(name: string, record: GdbMiRecord, scope: VariableScope, parent: number, fileName: string): [VariableObject | undefined, number | undefined] {
        throw new Error("Use VariableContainerForGlobals for global/static variables. Wrongly constructed VariableContainer.");
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
    public async clear(gdbInstance: GdbInstance, delErr?: (str: string) => void): Promise<void> {
        this.variableHandles.clear();
        const promises: Promise<any>[] = [];
        for (const key of this.gdbVarNameToObjMap.keys()) {
            const obj = this.gdbVarNameToObjMap.get(key);
            if (obj.parent === 0) {
                // only delete roots. that will also delete children
                const p = gdbInstance?.sendCommand(`-var-delete ${key}`).catch(() => {
                    delErr?.(key);
                });
                if (p) {
                    promises.push(p);
                }
            }
        }
        await Promise.all(promises);
        this.gdbVarNameToObjMap.clear();
    }
    public async deleteObjectByGdbName(gdbVarName: string, gdbInstance: GdbInstance, delErr?: (str: string) => void): Promise<boolean> {
        const obj = this.gdbVarNameToObjMap.get(gdbVarName);
        if (obj) {
            this.variableHandles.release(obj.handle >>> ScopeBits);
            if (obj.parent === 0) {
                gdbInstance?.sendCommand(`-var-delete ${gdbVarName}`).catch(() => {
                    delErr?.(gdbVarName);
                });
                this.gdbVarNameToObjMap.delete(gdbVarName);
                return true;
            } else {
                this.gdbVarNameToObjMap.delete(gdbVarName);
                return true;
            }
        }
        return false;
    }
    public hasGdbName(gdbVarName: string): boolean {
        return this.gdbVarNameToObjMap.has(gdbVarName);
    }
    public numberOfGdbVariables(): number {
        return this.gdbVarNameToObjMap.size;
    }
}

// This container is for locals and globals only. These don't have a thread/frame associated with them
// But we will use the ThreadID for a file identifier for globals/statics. ThreadID = 0 means all files.
export class VariableContainerForGlobals extends VariableContainer {
    private fileToIdMap = new Map<string, number>();
    private fileIdToFile = new Map<number, string>();
    private nextFileId = 1; // Start from 1, 0 means all files

    public createGlobalVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, fileName: string): [VariableObject, number] {
        const fileId = this.getFileId(fileName);
        const [varObj, handle] = super.createVariable(scope, parent, name, value, type, fileId || 0, 0);
        varObj.fileName = fileName;
        return [varObj, handle];
    }

    public getFileId(fileName: string) {
        let fileId = fileName ? this.fileToIdMap.get(fileName) : 0;
        if (fileName && fileId === undefined) {
            fileId = this.nextFileId++;
            this.fileToIdMap.set(fileName, fileId);
            this.fileIdToFile.set(fileId, fileName);
        }
        return fileId;
    }

    public createVariable(scope: VariableScope, parent: number, name: string, value: string, type: string, threadId: number, frameId: number): [VariableObject, number] {
        throw new Error("Use createGlobalVariable for globals/statics, Wrongly constructed VariableContainerForGlobals.");
    }

    public parseMiVariable(name: string, record: GdbMiRecord, scope: VariableScope, parent: number, threadId: number, frameId: number): [VariableObject | undefined, number | undefined] {
        throw new Error("Use parseMiGlobalVariable for globals/statics, Wrongly constructed VariableContainerForGlobals.");
    }

    public parseMiGlobalVariable(name: string, record: GdbMiRecord, scope: VariableScope, parent: number, fileName: string): [VariableObject | undefined, number | undefined] {
        const value = record["value"] ?? "";
        const type = record["type"] || "unknown";
        if (name === undefined) {
            return [undefined, undefined];
        }

        // Mi variables don't have scope, parent, frameRef, evaluateName info
        const [varObj, handle] = this.createGlobalVariable(scope, parent, name, value, type, fileName);
        varObj.gdbVarName = record["name"];
        this.gdbVarNameToObjMap.set(varObj.gdbVarName, varObj);
        varObj.exp = record["exp"] || name;
        varObj.evaluateName = varObj.exp; // For now, fullExp is same as exp. It may change later. For root variables, they are the same
        varObj.applyChanges(record as any as VarUpdateRecord);
        return [varObj, handle];
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
    public static readonly GlobalFileName = ":global:";
    private globalContainer: VariableContainerForGlobals = new VariableContainerForGlobals(VariableScope.Global, "G-");
    private localContainer: VariableContainer = new VariableContainer(VariableScope.Local, "L-");
    private dynamicContainer: VariableContainer = new VariableContainer(VariableScope.Watch, "W-");
    private frameHandles = new ValueHandleRegistryPrimitive<number>();
    private containers = new Map<VariableScope, VariableContainer>();
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
    }

    // All containers are created in the constructor. Then are make for the
    // roots of type of the variables they are and dictates their lifecycle
    // Local variables (on the stack) are released on continue, Global/static
    // variables are never released, are a not associated with a thread/frame
    public getContainer(scope: VariableScope): VariableContainer {
        const container = this.containers.get(scope & ActualScopeMask);
        if (!container) {
            throw new Error(`No container for scope ${VariableScope[scope]}`);
        }
        return container;
    }

    //
    // This is only for variables with children. Leaf variables don't have a variablesReference
    //  but they do have a handle but no way to tell VSCode that.
    //
    public getVariableObject(handle: VariableReference): VariableObject | undefined {
        if (handle & VariableTypeMask) {
            const scope = handle & ScopeMask;
            const container = this.getContainer(scope);
            if (container) {
                const variable = container.getVariableByRef(handle);
                return variable;
            }
        }
        return undefined;
    }

    public getVariableFullName(parentRef: VariableReference, name: string): string | undefined {
        try {
            const [_threadId, _frameId, scope] = this.getVarOrFrameInfo(parentRef);
            if ((scope & VariableTypeMask) === 0) {
                return name;
            }
            const container = this.getContainer(scope);
            const variable = container.getVariableByRef(parentRef);
            if (variable === undefined) {
                return undefined;
            }
            const parentName = variable.evaluateName;
            for (const child of variable.children || []) {
                if (child.name === name) {
                    return child.evaluateName;
                }
            }
            return `${parentName}.${name}`;
        } catch {
            return undefined;
        }
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
        const err = (str: string) => {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error deleting GDB variable ${str} on stop/continue\n`);
            }
        };
        await this.localContainer.clear(this.gdbInstance, err);
        await this.dynamicContainer.clear(this.gdbInstance, err);
        this.frameHandles.clear();
        this.registerValuesMap.clear();
    }

    public async prepareForStopped() {
        await this.clearForContinue();
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

    public getVariables(args: DebugProtocol.VariablesArguments, container?: VariableContainer): Promise<GdbProtocolVariable[]> {
        const [threadId, frameId, scope] = this.getVarOrFrameInfo(args.variablesReference);
        if (scope === VariableScope.Local) {
            return this.getLocalVariables(threadId, frameId);
        } else if (scope === VariableScope.Registers) {
            return this.getRegisterVariables(threadId, frameId);
        } else if (scope === VariableScope.Global) {
            return this.getGlobalVariables();
        } else if (scope === VariableScope.Static) {
            return this.getStaticVariables(threadId, frameId);
        } else if (scope & VariableTypeMask) {
            // If this is a variable, we need to get is thread/frame ids from the variable itself
            container = container ? container : this.getContainer(scope);
            const variable = container.getVariableByRef(args.variablesReference);
            if (variable === undefined) {
                Promise.reject(new Error(`No variable found for reference ${args.variablesReference}`));
            }
            return this.getVariableChildren(variable);
        }
    }

    public async varListChildren(container: VariableContainer | VariableContainerForGlobals, parent: VariableObject, gdbName: string, threadId: number, frameId: number): Promise<VariableObject[]> {
        const createVariable = (name: string, item: any) => {
            const scope = parent.scope & ActualScopeMask;
            if (scope === VariableScope.Global || scope === VariableScope.Static) {
                return container.parseMiGlobalVariable(name, item, parent.scope, parent.handle, parent.fileName);
            } else {
                return container.parseMiVariable(name, item, parent.scope, parent.handle, threadId, frameId);
            }
        };
        const miOutput = await this.gdbInstance.sendCommand(`var-list-children --all-values "${gdbName}"`);
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
                const [child, handle] = createVariable(exp, item);
                if (!child) {
                    this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Warning: Could not parse child variable ${item["exp"]} of parent ${gdbName}\n`);
                    continue;
                }
                if (item["numchild"] && parseInt(item["numchild"]) > 0) {
                    child.variablesReference = handle!;
                }
                child.applyChanges(item);
                child.evaluateName = constructEvaluateName(parent.evaluateName, parent.type, child.exp);
                if (/[^\d\w\.]/i.test(parent.evaluateName) && !/^\d+$/.test(child.exp)) {
                    try {
                        const cmd = "-var-info-path-expression " + child.gdbVarName;
                        const pathOutput = await this.gdbInstance.sendCommand(cmd);
                        const pathRecord = pathOutput.resultRecord?.result;
                        if (pathRecord && pathRecord["path_expr"]) {
                            child.evaluateName = pathRecord["path_expr"];
                        }
                    } catch (e) {
                        // Ignore errors here
                    }
                }
                // this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Created child ${handle} ${child.evaluateName}: ${JSON.stringify(child)}\n`);
                ret.push(child);
            }
        }
        return ret;
    }

    async getVariableChildren(parent: VariableObject): Promise<GdbProtocolVariable[]> {
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
            const protoVars: GdbProtocolVariable[] = [];
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
    private async getRegistersForGroup(groupVar: VariableObject): Promise<GdbProtocolVariable[]> {
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

            const variables: GdbProtocolVariable[] = [];
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
                            const gdbVarName = this.createGdbName(container, regName.replaceAll("$", "reg-"), threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${regName}`;
                            const varCreateRecord = await this.gdbInstance.sendCommand(cmd);
                            const record = varCreateRecord.resultRecord.result;
                            const [varObj] = container.parseMiVariable(regName, record, VariableScope.RegistersVariable, groupVar.handle, threadId, frameId);
                            varObj.value = r["value"]; // Use this because it is better formatted
                            if (varObj !== undefined) {
                                this.setFields(varObj);
                                variables.push(varObj.toProtocolVariable());
                            }
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

    createGdbName(container: VariableContainer, base: string, thread: number, frame: number): string {
        const prefix = container.prefix;
        const template = `${prefix}${base}-${thread}-${frame}`;
        let ret = template;
        let count = 1;
        while (container.hasGdbName(ret)) {
            ret = `${template}-${count}`;
            count++;
        }
        return ret;
    }

    private async getLocalVariables(threadId: number, frameId: number): Promise<GdbProtocolVariable[]> {
        const cmd = `-stack-list-variables --thread ${threadId} --frame ${frameId} --all-values`;
        return await this.gdbInstance.sendCommand(cmd).then(async (miOutput) => {
            const variables: GdbProtocolVariable[] = [];
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
                            const gdbVarName = this.createGdbName(container, varName, threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${varName}`;
                            const varCreateRecord = await this.gdbInstance.sendCommand(cmd);
                            const record = varCreateRecord.resultRecord.result;
                            const [varObj, handle] = container.parseMiVariable(varName, record, VariableScope.LocalVariable, 0, threadId, frameId);
                            if (varObj !== undefined) {
                                if (record["numchild"] && parseInt(record["numchild"]) > 0) {
                                    varObj.variablesReference = handle!;
                                }
                                variables.push(varObj.toProtocolVariable());
                            }
                        } else {
                            const varUpdateRecord = await this.gdbInstance.sendCommand(`-var-update --all-values ${existingVar.gdbVarName}`);
                            const record = varUpdateRecord.resultRecord?.result["changelist"]?.[0];
                            if (record && (!record["in_scope"] || record["in_scope"] === "true")) {
                                existingVar.applyChanges(record);
                            } else if (record && record["in_scope"] && record["in_scope"] !== "true") {
                                existingVar.value = "not in scope?";
                            }
                            variables.push(existingVar.toProtocolVariable());
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
    private async getRegisterVariables(threadId: number, frameId: number): Promise<GdbProtocolVariable[]> {
        // Fetch register groups and mappings
        await this.getRegisterGroups();
        await this.getRegisterGroupMappings();

        if (this.registerGroups.length === 0) {
            // Fallback to old behavior if groups are not available
            return this.getRegisterVariablesFlat(threadId, frameId);
        }

        const variables: GdbProtocolVariable[] = [];
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

    public async getGlobalVariables(): Promise<GdbProtocolVariable[]> {
        try {
            const vars = this.debugSession.symbolTable.getGlobalVariables();
            const variables: GdbProtocolVariable[] = [];
            const container = this.globalContainer;
            const fileId = container.getFileId(VariableManager.GlobalFileName);
            const useRef = container.calcFrameRef(fileId, 0, VariableScope.GlobalVariable);
            for (const v of vars) {
                if (this.gdbInstance.IsRunning()) {
                    break;
                }
                const key = new VariableKeys(0, v.name, useRef);
                const existingVar = container.getVariableByKey(key);
                try {
                    if (existingVar === undefined) {
                        const gdbVarName = this.createGdbName(container, v.name, 0, 0);
                        // There should be a better way to create a global variable by name but gdb mi doesn't seem to
                        // have a way to do it directly. So we use var-create with @ for scope which works for globals/statics
                        // because it can still collide with a local variable of same name in current frame, but that is rare enough to ignore for now.
                        // There HAS to be a better way to do this, I just couldn't find it in gdb mi docs.
                        const cmd = `-var-create ${gdbVarName} @ ${v.name}`;
                        const varCreateRecord = await this.gdbInstance.sendCommand(cmd);
                        const record = varCreateRecord.resultRecord.result;
                        const [varObj, handle] = container.parseMiGlobalVariable(v.name, record, VariableScope.GlobalVariable, 0, VariableManager.GlobalFileName);
                        if (varObj !== undefined) {
                            if (record["numchild"] && parseInt(record["numchild"]) > 0) {
                                varObj.variablesReference = handle!;
                            }
                            variables.push(varObj.toProtocolVariable());
                        }
                    } else {
                        const varUpdateRecord = await this.gdbInstance.sendCommand(`-var-update --all-values ${existingVar.gdbVarName}`);
                        const record = varUpdateRecord.resultRecord?.result["changelist"]?.[0];
                        if (record && (!record["in_scope"] || record["in_scope"] === "true")) {
                            existingVar.applyChanges(record);
                        } else if (record && record["in_scope"] && record["in_scope"] !== "true") {
                            existingVar.value = "not in scope?";
                        }
                        variables.push(existingVar.toProtocolVariable());
                    }
                } catch (e) {
                    if (this.debugSession.args.debugFlags.anyFlags) {
                        this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting global variable ${v.name}: ${e}\n`);
                    }
                }
            }
            return variables;
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting global variables: ${e}\n`);
            }
        }
        return [];
    }

    public async getStaticVariables(fileId: number, fullFileId: number): Promise<GdbProtocolVariable[]> {
        try {
            const variables: GdbProtocolVariable[] = [];
            const container = this.globalContainer;
            const fileName = this.debugSession.getFileById(fileId);
            const fullFileName = this.debugSession.getFileById(fullFileId);
            let useName = fullFileName;
            let vars = this.debugSession.symbolTable.getStaticVariables(fullFileName);
            if (vars.length === 0 && fullFileId !== fileId) {
                // Try again with just file name
                vars = this.debugSession.symbolTable.getStaticVariables(fileName);
                useName = fileName;
            }
            const useFileId = container.getFileId(useName);
            const useRef = container.calcFrameRef(useFileId, 0, VariableScope.StaticVariable);
            for (const v of vars) {
                if (this.gdbInstance.IsRunning()) {
                    break;
                }
                const key = new VariableKeys(0, v.name, useRef);
                const existingVar = container.getVariableByKey(key);
                try {
                    if (existingVar === undefined) {
                        const gdbVarName = this.createGdbName(container, v.name, fileId, fullFileId);
                        // There should be a better way to create a global variable by name but gdb mi doesn't seem to
                        // have a way to do it directly. So we use var-create with @ for scope which works for globals/statics
                        // because it can still collide with a local variable of same name in current frame, but that is rare enough to ignore for now.
                        // There HAS to be a better way to do this, I just couldn't find it in gdb mi docs.
                        const cmd = `-var-create ${gdbVarName} @ ${v.name}`;
                        const varCreateRecord = await this.gdbInstance.sendCommand(cmd);
                        const record = varCreateRecord.resultRecord.result;
                        const [varObj, handle] = container.parseMiGlobalVariable(v.name, record, VariableScope.StaticVariable, 0, useName);
                        if (varObj !== undefined) {
                            if (record["numchild"] && parseInt(record["numchild"]) > 0) {
                                varObj.variablesReference = handle!;
                            }
                            variables.push(varObj.toProtocolVariable());
                        }
                    } else {
                        const varUpdateRecord = await this.gdbInstance.sendCommand(`-var-update --all-values ${existingVar.gdbVarName}`);
                        const record = varUpdateRecord.resultRecord?.result["changelist"]?.[0];
                        if (record && (!record["in_scope"] || record["in_scope"] === "true")) {
                            existingVar.applyChanges(record);
                        } else if (record && record["in_scope"] && record["in_scope"] !== "true") {
                            existingVar.value = "not in scope?";
                        }
                        variables.push(existingVar.toProtocolVariable());
                    }
                } catch (e) {
                    if (this.debugSession.args.debugFlags.anyFlags) {
                        this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting global variable ${v.name}: ${e}\n`);
                    }
                }
            }
            return variables;
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error getting global variables: ${e}\n`);
            }
        }
        return [];
    }

    /**
     * Fallback method that returns a flat list of all registers.
     * Used when register grouping information is not available.
     */
    private async getRegisterVariablesFlat(threadId: number, frameId: number): Promise<GdbProtocolVariable[]> {
        const cmd = `-data-list-register-values --thread ${threadId} --frame ${frameId} ${this.regFormat}`;
        await this.getRegisterNames();
        if (this.registerNames.size === 0) {
            return [];
        }
        return await this.gdbInstance.sendCommand(cmd).then(async (miOutput) => {
            const variables: GdbProtocolVariable[] = [];
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
                            const gdbVarName = this.createGdbName(container, regName.replaceAll("$", "reg-"), threadId, frameId);
                            const cmd = `-var-create --thread ${threadId} --frame ${frameId} ${gdbVarName} * ${regName}`;
                            const varCreateRecord = await this.gdbInstance.sendCommand(cmd);
                            const record = varCreateRecord.resultRecord.result;
                            const [varObj] = container.parseMiVariable(regName, record, VariableScope.Registers, 0, threadId, frameId);
                            varObj.value = r["value"]; // Use this because it is better formatted
                            if (varObj !== undefined) {
                                this.setFields(varObj);
                                variables.push(varObj.toProtocolVariable());
                            }
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

    private fmtExpr(container: VariableContainer, expr: string, thread: number, frame: number): [string, string, string] {
        expr = expr.trim();
        let newExpr = "";
        let suffix = expr.match(/,[bdtonxX]$/)?.[0];
        if (suffix) {
            newExpr = expr.slice(0, -suffix.length);
            suffix = suffix.slice(1); // Remove leading comma
        } else {
            newExpr = expr;
            suffix = "";
        }

        const okChars = /[^a-zA-Z0-9_,]/g;
        const gdbName = newExpr.replaceAll(okChars, "-");

        return [this.createGdbName(container, gdbName, thread, frame), newExpr, suffix];
    }

    public async evaluateExpression(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, container?: VariableContainer): Promise<void> {
        try {
            const [thread, frame, _] = args.frameId ? this.getVarOrFrameInfo(args.frameId!) : [0, 0, VariableScope.Global];
            const scope = VariableScope.WatchVariable;
            container = container ? container : this.getContainer(scope);
            const existingVar = container.getVariableByKey(new VariableKeys(0, args.expression.trim(), encodeReference(thread, frame, scope)));
            if (existingVar === undefined) {
                const [gdbName, expr, suffix] = this.fmtExpr(container, args.expression, thread, frame);
                let cmd = `-var-create --thread ${thread} --frame ${frame} ${gdbName} * "${expr}"`;
                if (thread === 0 && frame === 0) {
                    cmd = `-var-create ${gdbName} @ "${expr}"`;
                }
                const miOutput = await this.gdbInstance.sendCommand(cmd);
                const record = miOutput.resultRecord.result;
                if (!record) {
                    throw new Error(`No result record for expression ${args.expression}`);
                }
                let value = record["value"] ?? "";
                if (suffix) {
                    const fmt = formatMap[suffix];
                    if (!fmt) {
                        throw new Error(`Invalid format suffix: ${suffix}`);
                    }
                    const formatCmd = `-var-set-format ${gdbName} ${fmt}`;
                    const fmtOutput = await this.gdbInstance.sendCommand(formatCmd);
                    value = fmtOutput.resultRecord.result["value"];
                    record.value = value;
                }
                // const [newVar, handle] = container.createVariable(scope, 0, args.expression.trim(), value, record["type"], thread, frame);
                const [newVar, handle] = container.parseMiVariable(args.expression.trim(), record, scope, 0, thread, frame);
                newVar.applyChanges(record);
                newVar.gdbVarName = gdbName;
                if (record["numchild"] && parseInt(record["numchild"]) > 0) {
                    newVar.variablesReference = handle;
                }
                response.body = {
                    result: newVar.value,
                    variablesReference: newVar.variablesReference,
                };
                (response.body as any).variableObject = newVar.toProtocolVariable();
                return;
            } else {
                // Update existing variable
                const cmd = `-var-update  --all-values ${existingVar.gdbVarName}`;
                const miOutput = await this.gdbInstance.sendCommand(cmd);
                const record = miOutput.resultRecord?.result["changelist"]?.[0];
                if (record && (!record["in_scope"] || record["in_scope"] === "true")) {
                    existingVar.applyChanges(record);
                } else if (record && record["in_scope"] && record["in_scope"] !== "true") {
                    existingVar.value = "not in scope?";
                }
                response.body = {
                    result: existingVar.value,
                    variablesReference: existingVar.variablesReference,
                };
                (response.body as any).variableObject = existingVar.toProtocolVariable();
                return;
            }
        } catch (e) {
            if (args.context === "watch") {
                return Promise.reject(e);
            }
            response.body = {
                result: "",
                variablesReference: 0,
            };
        }
    }

    /**
     * This method for all items in the Varianles view and children of Watch expressions, but not for
     * top-level Watch expressions (those are handled by setExpression).
     */
    public async setVariable(args: DebugProtocol.SetVariableArguments): Promise<DebugProtocol.SetVariableResponse["body"]> {
        let [threadId, frameId, scope] = this.getVarOrFrameInfo(args.variablesReference);
        const actualScope = scope & ActualScopeMask; // Scope for the container
        let targetKey: VariableKeys;
        const container = this.getContainer(actualScope);
        if (args.variablesReference & VariableTypeMask) {
            const parentObject = this.getVariableObject(args.variablesReference);
            targetKey = new VariableKeys(parentObject.handle, args.name, encodeReference(threadId, frameId, actualScope));
        } else {
            targetKey = new VariableKeys(0, args.name, encodeReference(threadId, frameId, actualScope));
        }

        const targetVar = container.getVariableByKey(targetKey);
        if (!targetVar || !targetVar.gdbVarName) {
            throw new Error(`Variable ${args.name} not found or has no GDB name`);
        }
        // Use -var-assign to set the value
        const cmd = `-var-assign ${targetVar.gdbVarName} "${args.value}"`;
        const miOutput = await this.gdbInstance.sendCommand(cmd);
        const record = miOutput.resultRecord.result;

        if (!record || !record["value"]) {
            throw new Error(`Failed to set variable ${args.name}`);
        }

        // Update the variable with the new value
        targetVar.value = record["value"];
        // targetVar.variablesReference = 0; // Reset children when value changes

        return {
            value: targetVar.value,
            variablesReference: targetVar.variablesReference,
        };
    }

    /**
     * This method is called to set the value of top-level expressions (watches)
     */
    public async setExpression(args: DebugProtocol.SetExpressionArguments): Promise<DebugProtocol.SetExpressionResponse["body"]> {
        const [thread, frame, _] = args.frameId ? this.getVarOrFrameInfo(args.frameId!) : [0, 0, VariableScope.Global];
        const scope = VariableScope.WatchVariable;
        const container = this.getContainer(scope);

        // Check if this expression already exists as a watch variable
        const existingVar = container.getVariableByKey(new VariableKeys(0, args.expression.trim(), encodeReference(thread, frame, scope)));

        let gdbVarName: string;

        if (existingVar && existingVar.gdbVarName) {
            // Use existing variable
            gdbVarName = existingVar.gdbVarName;
        } else {
            // Create a new variable for this expression
            const [gdbName, expr, _suffix] = this.fmtExpr(container, args.expression, thread, frame);
            let cmd = `-var-create --thread ${thread} --frame ${frame} ${gdbName} * "${expr}"`;
            if (thread === 0 && frame === 0) {
                cmd = `-var-create ${gdbName} @ "${expr}"`;
            }
            const miOutput = await this.gdbInstance.sendCommand(cmd);
            const record = miOutput.resultRecord.result;
            if (!record) {
                throw new Error(`Failed to create variable for expression ${args.expression}`);
            }
            gdbVarName = gdbName;

            // Store the variable
            const value = record["value"] ?? "";
            const [newVar, _handle] = container.createVariable(scope, 0, args.expression.trim(), value, record["type"], thread, frame);
            newVar.applyChanges(record);
            newVar.gdbVarName = gdbName;
        }

        // Use -var-assign to set the value
        const cmd = `-var-assign ${gdbVarName} "${args.value}"`;
        const miOutput = await this.gdbInstance.sendCommand(cmd);
        const record = miOutput.resultRecord.result;

        if (!record || !record["value"]) {
            throw new Error(`Failed to set expression ${args.expression}`);
        }

        return {
            value: record["value"],
            variablesReference: 0,
        };
    }

    public async updateAllVariables(): Promise<VarUpdateRecord[]> {
        try {
            const cmd = `-var-update --all-values *`;
            const miOutput = await this.gdbInstance.sendCommand(cmd);
            const records = miOutput.resultRecord.result["changelist"];
            return records;
        } catch (e) {
            if (this.debugSession.args.debugFlags.anyFlags) {
                this.debugSession.handleMsg(GdbEventNames.Console, `mcu-debug: Error updating all variables: ${e}\n`);
            }
            return [];
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

export const formatMap: { [key: string]: string } = {
    t: "binary",
    b: "binary",
    o: "octal",
    d: "decimal",
    n: "natural",
    x: "hexadecimal",
    X: "zero-hexadecimal",
};

/**
 *
 * This method can only handle simple parent expressions and child names. In real life, GDB makes up
 * some impresive contusions for children of expressions like: &x -> *&x -> [0] as exp's returned
 * where x is and arrau of (say) ints (int x[10];). If you look carefully it makes sense. &x is a pointer
 * to the array, *&x dereferences it back to the array, and [0] gets the first element.
 *
 * Simply concatenating them creates invalid expressions
 *
 * This is our best effort to reconstruct valid expressions for GDB to evaluate.
 */
function constructEvaluateName(parentExpr: string, parentType: string, childName: string): string {
    const isNumeric = /^\d+$/.test(childName);
    const isArrayLike = isNumeric || childName.startsWith("[");
    const isPointer = checkIsPointer(parentType);

    let separator = "";
    let suffix = childName;

    if (isArrayLike) {
        if (isNumeric) {
            suffix = `[${childName}]`;
        }
        separator = "";
    } else {
        separator = isPointer ? "->" : ".";
    }

    // Wrap parent if it's complex to avoid precedence issues.
    // Allowed safe characters for "simple names" or chained access: alphanumeric, _, [], ., >, - (for ->)
    // If we encounter *, &, +, etc, we define it as unsafe/complex.
    // Cases handled:
    // *p + [0] -> (*p)[0]
    // &s + .x -> (&s).x
    // (cast)v + .x -> ((cast)v).x
    const isSafeSequence = /^[a-zA-Z0-9_\[\]\.\->]+$/.test(parentExpr);

    // Check for already wrapped (simple heuristic)
    const isAlreadyWrapped = parentExpr.startsWith("(") && parentExpr.endsWith(")");

    let safeParent = parentExpr;
    // Apply wrapping if unsafe.
    if (!isSafeSequence && !isAlreadyWrapped) {
        safeParent = `(${parentExpr})`;
    }

    let ret = `${safeParent}${separator}${suffix}`;
    ret = ret.replaceAll("*&", ""); // Simplify *& to nothing
    ret = ret.replaceAll("..", "."); // Simplify .. to .
    return ret;
}

function checkIsPointer(type: string): boolean {
    if (!type) return false;
    type = type.trim();
    // Standard pointer: "int *"
    if (type.endsWith("*")) return true;
    // A cast pointer: "(int *)"
    if (/\*\)+$/.test(type)) return true;
    // Pointer to array or function: "int (*)[10]"
    if (/\(\*\)/.test(type)) return true;
    return false;
}
