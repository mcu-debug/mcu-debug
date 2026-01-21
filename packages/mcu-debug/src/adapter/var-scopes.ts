export const VariableTypeMask = 1 << 3; // Indicates this is a variable type key for a given scope
export enum VariableScope {
    Global = 0,
    Static = 1,
    Local = 2,
    Registers = 3,
    Scope = 4, // Dummy scope for top level variable categories
    Watch = 5,
    LocalVariable = VariableTypeMask | VariableScope.Local, // Local variable
    RegistersVariable = VariableTypeMask | VariableScope.Registers, // Register variable
    GlobalVariable = VariableTypeMask | VariableScope.Global, // Global variable
    StaticVariable = VariableTypeMask | VariableScope.Static, // Static variable
    WatchVariable = VariableTypeMask | 0x5, // Dynamic watch variable
}

// We have a total of 53 bits of precision in a JavaScript number
// So, we use 24 bits for the frame ID and 25 bits for the thread ID and 4 bits for scope.
// MSB of Scope identifies if this is a variable or a frame reference
export const ActualScopeMask = 0x7;
export const FrameIDMask = 0xffffff;
export const ThreadIDMask = 0x1ffffff;
export const ScopeMask = 0xf;
export const ScopeBits = 4;
export const FrameIDBits = 24;
export const ThreadIDBits = 25;

export function isVariableReference(variablesReference: number): boolean {
    return (variablesReference & VariableTypeMask) !== 0;
}

export function isVarRefGlobalOrStatic(variablesReference: number): boolean {
    const scope = variablesReference & ActualScopeMask;
    return scope === VariableScope.Global || scope === VariableScope.Static || scope === VariableScope.Scope;
}

export function decodeReference(varRef: number): [number, number, VariableScope] {
    return [varRef >>> (FrameIDBits + ScopeBits), (varRef >>> ScopeBits) & FrameIDMask, varRef & ScopeMask];
}

function encodeReference(threadId: number, frameId: number, scope: VariableScope): number {
    return ((threadId & ThreadIDMask) << (FrameIDBits + ScopeBits)) | ((frameId & FrameIDMask) << ScopeBits) | (scope & ScopeMask);
}

export function getScopeFromReference(varRef: number): VariableScope {
    return varRef & ScopeMask;
}

export function getVariableClass(scope: VariableScope): VariableScope {
    return scope & ActualScopeMask;
}

export function encodeVarReference(threadId: number, frameId: number, scope: VariableScope): number {
    return encodeReference(threadId, frameId, scope | VariableTypeMask);
}

export function encodeScopeReference(threadId: number, frameId: number, scope: VariableScope): number {
    return encodeReference(threadId, frameId, scope & ActualScopeMask);
}
