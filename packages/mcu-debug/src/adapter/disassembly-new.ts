/*
 * Copyright (c) 2026 MCU-Debug Authors.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE-MIT file in the root directory of this source tree.
 */

/**
 * In this file we implement a new disassembly view that is more tightly integrated with the debug
 * helper's symbol information. The primary source of the disassembly is from objdumo which contains the
 * full disassembly with symbol information, and we will augment it with live information from the debug.
 * This especially concerns data intermixed with code, which is common in embedded firmware and can be
 * difficult to handle with a pure disassembly approach.
 *
 * The second issue is producing instructions backwards from the current PC. The DAP protocol's DisassembleRequest
 * requires backwards disassembly, and this not easyly done with a pure disassembly approach since we may not know
 * the instruction boundaries without disassembling from the start of the function or code section.
 *
 * There is one big drawback to this approach in that if you have dynamically generated code or self-modifying code,
 * the objdump disassembly may not match the actual code in memory. However, for typical embedded firmware this is
 * not a common case, and the benefits of having a more accurate and symbol-aware disassembly view outweigh this
 * drawback. Additionally, we can consider adding a "refresh" mechanism to update the disassembly view with live
 * information from the target if needed.
 *
 * In the future, we may want to consider implementing a hybrid approach where we use objdump for the initial disassembly
 * and then augment it with live information from the target, including dynamically disassembling code sections as needed.
 * This would allow us to handle cases where the code in memory differs from the objdump disassembly, while still
 * benefiting from the rich symbol information provided by objdump.
 *
 */

import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { SymbolInformation, SymbolTable, SymbolType, SymbolNode, MemoryRegion } from "./symbols";
import { TargetArchitecture, TargetInfo, TargetMemoryRegion, TargetMemoryRegions } from "./target-info";
import { formatAddress, formatAddress32, formatAddress64, parseAddress } from "../frontend/utils";
import { Stdout } from "./gdb-mi/mi-types";
import { SortedArray } from "sorted-array-type";
import { start } from "node:repl";
import { DebugHelper } from "./helper";
import { InstrRange } from "./disassebly-gdb";
import { SerInstruction } from "@mcu-debug/shared/dasm-helper/SerInstruction";

let dasmFormatAddress = formatAddress32;

export interface InstrSize {
    minSize: number;
    maxSize: number;
    alignment: number;
}

interface ProtocolInstruction extends DebugProtocol.DisassembledInstruction {
    pvtAddress: bigint;
    pvtOpcodes?: string;
    pvtLength?: number;
    pvtIsData?: boolean;
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

// Implementation of disassembly adapter methods would go here
export class DisassemblyAdapterNew {
    private gdbInstance: GdbInstance;
    private debugHelper: DebugHelper;
    private instrInfo: InstrSize | undefined;

    // In the following two memory regions, neither is the actual memory of the device.
    public targetMemoryRegions: TargetMemoryRegions | undefined = undefined; // As defined by the target architecture
    public memoryRegions: MemoryRegion[] | undefined = undefined; // Actually retrieved from the executable

    debugDisassembly: boolean = false;
    constructor(private session: GDBDebugSession) {
        this.gdbInstance = session.gdbInstance;
        this.debugHelper = session.debugHelper;
    }

    // This should be called after the symbol table and the target info are initialized
    initialize(): void {
        const archType = TargetInfo.Instance!.getArchitectureType();
        this.instrInfo = InstructionSizes.get(archType);
        this.debugDisassembly = this.session.args.debugFlags?.debugDisassembly ?? false;
        this.targetMemoryRegions = TargetInfo.Instance!.getMemoryRegions();
        if (TargetInfo.Instance!.getPointerSize() === 8) {
            // 64-bit
            dasmFormatAddress = formatAddress64;
        } else {
            // 32-bit
            dasmFormatAddress = formatAddress32;
        }
        this.msg(`Disassembly adapter initialized for architecture ${TargetArchitecture[archType]}`);
    }

    private formatSym(symName: string, offset: number): string | undefined {
        if (!symName) {
            return undefined;
        }
        const nm = symName.length > 22 ? ".." + symName.substring(symName.length - 20) : symName;
        return `<${nm}+${offset}>`;
    }

    protected dMsg(msg: string): void {
        if (this.debugDisassembly) {
            this.session.handleMsg(Stdout, `[Disassembly] ${msg}\n`);
        }
    }
    protected msg(msg: string): void {
        this.session.handleMsg(Stdout, `[Disassembly] ${msg}\n`);
    }

    public async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
        if (false && this.session.isBusy()) {
            // Not sure this should be an error. But for now, we do this way, unttil we figure if gdb is okay with it
            this.session.handleErrResponse(response, "GDB/FW is busy, Cannot disassemble now");
            return;
        }
        try {
            await this.disassembleRequestInternal(response, args);
        } catch (err) {
            this.session.handleErrResponse(response, `Disassembly request failed: ${(err as Error).message}`);
        }
    }

    private async disassembleRequestInternal(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
        if (this.instrInfo === undefined) {
            throw new Error("Target architecture not supported for disassembly");
        }

        const rsp = await this.debugHelper.disassemble(args);
        const funcTable = rsp.func_table;
        const fileTable = rsp.file_table;
        const instrs = rsp.instructions.map((instr: SerInstruction) => {
            const func = funcTable[instr.f] ? this.formatSym(funcTable[instr.f], instr.o) : undefined;
            const el = instr.el !== undefined && instr.sl !== undefined ? (instr.el - instr.sl > 5 ? instr.sl + 5 : instr.el) : undefined; // limit the max line range to 5 for better UI display, can be adjusted as needed
            const pvtInstr: DebugProtocol.DisassembledInstruction = {
                // pvtAddress: parseAddress("0x" + instr.a),
                //pvtOpcodes: instr.b,
                // pvtIsData: instr.i.startsWith("."),
                address: dasmFormatAddress(parseAddress("0x" + instr.a)),
                instruction: instr.i,
                instructionBytes: instr.b,
                symbol: func,
                location: { path: instr.F >= 0 ? fileTable[instr.F] : undefined },
                line: instr.sl !== undefined && instr.sl >= 0 ? instr.sl : undefined,
                endLine: el,
            };
            return pvtInstr;
        });

        response.body = {
            instructions: instrs,
        };
        this.session.sendResponse(response);
    }
}
