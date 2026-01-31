import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { SymbolTable } from "./symbols";
import { TargetArchitecture } from "./target-info";
import { formatAddress, parseAddress } from "../frontend/utils";

export interface InstrSize {
    minSize: number;
    maxSize: number;
    alignment: number;
}

export const InstructionSizes: Map<TargetArchitecture, InstrSize> = new Map([
    [TargetArchitecture.X86, { minSize: 1, maxSize: 15, alignment: 1 }],
    [TargetArchitecture.X64, { minSize: 1, maxSize: 15, alignment: 1 }],

    [TargetArchitecture.ARM, { minSize: 2, maxSize: 4, alignment: 2 }],
    [TargetArchitecture.ARM64, { minSize: 4, maxSize: 4, alignment: 4 }],

    [TargetArchitecture.RISCV, { minSize: 2, maxSize: 24, alignment: 2 }],
    [TargetArchitecture.RISCV64, { minSize: 4, maxSize: 24, alignment: 2 }],

    [TargetArchitecture.MIPS, { minSize: 4, maxSize: 4, alignment: 4 }],
    [TargetArchitecture.POWERPC, { minSize: 4, maxSize: 4, alignment: 4 }],
    [TargetArchitecture.V850, { minSize: 2, maxSize: 4, alignment: 2 }],
    [TargetArchitecture.XTENSA, { minSize: 1, maxSize: 16, alignment: 1 }], // variable length, average to 3
]);

/*
export class Instruction implements DebugProtocol.DisassembledInstruction {
    address: string;
    instruction: string;
    symbol?: string;
}
*/
// Implementation of disassembly adapter methods would go here
export class DisassemblyAdapter {
    private gdbInstance: GdbInstance;
    private symbolTable: SymbolTable;
    constructor(private session: GDBDebugSession) {
        this.gdbInstance = session.gdbInstance;
        this.symbolTable = session.symbolTable;
    }

    protected async gdbDisassemble(start: bigint, length: number): Promise<void> {
        const end = start + BigInt(length);
        const count = Math.ceil(length / 5); // assuming average instruction size of 5 bytes
        const cmd = `-data-disassemble -s ${formatAddress(start)} -c ${formatAddress(end)} -- 5`;
        const miOutput = await this.gdbInstance.sendCommand(cmd);
    }

    protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): void {
        const startAddress = args.memoryReference;
        const instructionCount = args.instructionCount || 10;
    }
}
