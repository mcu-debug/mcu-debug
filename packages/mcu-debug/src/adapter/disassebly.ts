import { DebugProtocol } from "@vscode/debugprotocol";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { GDBDebugSession } from "./gdb-session";
import { SymbolInformation, SymbolTable, SymbolType, SymbolNode, MemoryRegion } from "./symbols";
import { TargetArchitecture, TargetInfo, TargetMemoryRegion, TargetMemoryRegions } from "./target-info";
import { formatAddress32, formatAddress64, parseAddress } from "../frontend/utils";
import { Stdout } from "./gdb-mi/mi-types";
import { SortedArray } from "sorted-array-type";

let dasmFormatAddress = formatAddress32;

export interface InstrSize {
    minSize: number;
    maxSize: number;
    alignment: number;
}
export class InstrRange {
    public low: bigint;
    public high: bigint;
    protected symbols: SortedArray<SymbolInformation> = new SortedArray<SymbolInformation>((a, b) => {
        if (a.address < b.address) return -1;
        if (a.address > b.address) return 1;
        return 0;
    });
    protected instructions: SortedArray<ProtocolInstruction> = new SortedArray<ProtocolInstruction>((a, b) => {
        if (a.pvtAddress < b.pvtAddress) return -1;
        if (a.pvtAddress > b.pvtAddress) return 1;
        return 0;
    });

    constructor(low: bigint, high: bigint) {
        this.low = low;
        this.high = high;
    }
    static fromSymbolNode(symNode: SymbolNode): InstrRange {
        const range = new InstrRange(symNode.low as bigint, symNode.high as bigint);
        range.addSymbol(symNode.symbol);
        return range;
    }
    addSymbol(sym: SymbolInformation): void {
        this.high = BigInt(Math.max(Number(this.high), Number(sym.address + BigInt(sym.length) - 1n)));
        if (!this.symbols.includes(sym)) {
            this.symbols.insert(sym);
        }
    }
    addSymbols(syms: SymbolInformation[]): void {
        if (this.symbols.length === 0) {
            this.symbols.push(...syms);
            return;
        }
        for (const sym of syms) {
            this.addSymbol(sym);
        }
    }
    getSymbols(): SymbolInformation[] {
        return this.symbols;
    }
    addInstructions(instrs: ProtocolInstruction[]): void {
        if (this.instructions.length === 0) {
            this.instructions.push(...instrs);
            return;
        }
        for (const instr of instrs) {
            if (!this.instructions.includes(instr)) {
                this.instructions.insert(instr);
            }
        }
    }
    getInstructions(): ProtocolInstruction[] {
        return this.instructions;
    }
    overlaps(other: InstrRange): boolean {
        return this.low <= other.high && other.low <= this.high;
    }
    contains(address: bigint): boolean {
        return this.low <= address && address <= this.high;
    }
    containsRange(other: InstrRange): boolean {
        return this.low <= other.low && other.high <= this.high;
    }

    merge(other: InstrRange): InstrRange {
        const newLow = this.low < other.low ? this.low : other.low;
        const newHigh = this.high > other.high ? this.high : other.high;
        const mergedRange = new InstrRange(newLow, newHigh);
        mergedRange.symbols.insertSorted(this.getSymbols());
        mergedRange.symbols.insertSorted(other.getSymbols());
        mergedRange.instructions.insertSorted(this.getInstructions());
        mergedRange.instructions.insertSorted(other.getInstructions());
        return mergedRange;
    }
}

class InstrRangeCache {
    cache: SortedArray<InstrRange>;
    constructor() {
        this.cache = new SortedArray<InstrRange>((a, b) => {
            if (a.low < b.low) return -1;
            if (a.low > b.low) return 1;
            return 0;
        });
    }

    // Returns overlapping ranges and their indexes in the cache
    getOverlappingRanges(range: InstrRange): [InstrRange[], number[]] {
        const ret: InstrRange[] = [];
        const retIxs: number[] = [];
        let ix = 0;
        for (const cachedRange of this.cache) {
            if (cachedRange.overlaps(range)) {
                ret.push(cachedRange);
                retIxs.push(ix);
            }
            ix++;
        }
        return [ret, retIxs];
    }

    get length(): number {
        return this.cache.length;
    }

    [Symbol.iterator](): Iterator<InstrRange> {
        return this.cache[Symbol.iterator]();
    }

    addRange(range: InstrRange): void {
        let [ovRanges, _] = this.getOverlappingRanges(range);
        if (ovRanges.length === 0) {
            this.cache.insert(range);
            return;
        }
        for (const or of ovRanges) {
            this.cache.remove(or);
        }
        const mergedRange = ovRanges.reduce((prev, curr) => prev.merge(curr), range);
        // Insert merged range
        this.cache.insert(mergedRange);
    }

    insert(range: InstrRange): void {
        for (let i = 0; i < this.cache.length; i++) {
            const cachedRange = this.cache[i];
            if (cachedRange.containsRange(range)) {
                return;
            }
            const nxtRange = i + 1 < this.cache.length ? this.cache[i + 1] : undefined;
            if (cachedRange.overlaps(range)) {
                // Merge ranges
                if (range.high > cachedRange.high) {
                    cachedRange.high = range.high;
                }
                if (range.low < cachedRange.low) {
                    cachedRange.low = range.low;
                }
                for (const sym of range.getSymbols() || []) {
                    cachedRange.addSymbol(sym);
                }
                cachedRange.addInstructions(range.getInstructions());
                if (nxtRange && cachedRange.overlaps(nxtRange)) {
                    // Merge with next also
                    if (nxtRange.high > cachedRange.high) {
                        cachedRange.high = nxtRange.high;
                    }
                    for (const sym of nxtRange.getSymbols() || []) {
                        cachedRange.addSymbol(sym);
                    }
                    cachedRange.addInstructions(nxtRange.getInstructions());
                    this.cache.remove(nxtRange);
                }
                return;
            }
        }
        this.cache.insert(range);
    }
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
    private instrInfo: InstrSize | undefined;

    // In the following two memory regions, neither is the actual memory of the device.
    public targetMemoryRegions: TargetMemoryRegions | undefined = undefined; // As defined by the target architecture
    public memoryRegions: MemoryRegion[] | undefined = undefined; // Actually retrieved from the executable

    debugDisassembly: boolean = false;
    constructor(private session: GDBDebugSession) {
        this.gdbInstance = session.gdbInstance;
        this.symbolTable = session.symbolTable;
    }

    // This should be called after the symbol table and the target info are initialized
    initialize(): void {
        const archType = TargetInfo.Instance!.getArchitectureType();
        this.instrInfo = InstructionSizes.get(archType);
        this.debugDisassembly = this.session.args.debugFlags?.debugDisassembly ?? false;
        this.targetMemoryRegions = TargetInfo.Instance!.getMemoryRegions();
        this.memoryRegions = this.symbolTable.getMemoryRegions();
        if (TargetInfo.Instance!.getPointerSize() === 8) {
            // 64-bit
            dasmFormatAddress = formatAddress64;
        } else {
            // 32-bit
            dasmFormatAddress = formatAddress32;
        }
        this.msg(`Disassembly adapter initialized for architecture ${TargetArchitecture[archType]}`);
    }

    private clipLow(base: bigint, addr: bigint): bigint {
        for (const region of this.memoryRegions!) {
            if (region.inVmaRegion(base)) {
                return region.inVmaRegion(addr) ? addr : region.vmaStart;
            }
            if (region.inLmaRegion(base)) {
                return region.inLmaRegion(addr) ? addr : region.lmaStart;
            }
        }
        return addr;
    }

    private clipHigh(base: bigint, addr: bigint): bigint {
        for (const region of this.memoryRegions!) {
            if (region.inVmaRegion(base)) {
                return region.inVmaRegion(addr) ? addr : region.vmaEnd;
            }
            if (region.inLmaRegion(base)) {
                return region.inLmaRegion(addr) ? addr : region.lmaEnd;
            }
        }
        return addr;
    }

    private formatSym(symName: string, offset: number): string | undefined {
        if (!symName) {
            return undefined;
        }
        const nm = symName.length > 22 ? ".." + symName.substring(symName.length - 20) : symName;
        return `<${nm}+${offset}>`;
    }

    private dummyInstr(tmp: bigint): ProtocolInstruction {
        return {
            address: dasmFormatAddress(tmp),
            instruction: "<mem-out-of-bounds?>",
            pvtAddress: tmp,
            presentationHint: "invalid",
        };
    }

    protected async gdbDisassembleRange(range: InstrRange): Promise<ProtocolInstruction[]> {
        const end = range.high + 1n;
        const cmd = `-data-disassemble -s ${dasmFormatAddress(range.low)} -e ${dasmFormatAddress(end)} -- 5`;
        const miOutput = await this.gdbInstance.sendCommand(cmd);
        this.dMsg(`Disassembled from ${dasmFormatAddress(range.low)} to ${dasmFormatAddress(end)}`);
        const instrs = (miOutput.resultRecord?.result as any).asm_insns;
        if (instrs === undefined) {
            throw new Error("No instructions returned from GDB disassemble ${cmd}");
        }
        const ret: ProtocolInstruction[] = [];
        let startLine: number | undefined = undefined;
        let endLine: number | undefined = undefined;
        let lastFile: string | undefined = undefined;
        for (const instr of instrs) {
            const file = (instr.fullname || instr.file) as string | "<unknown file>";
            const line = parseInt(instr.line || "1", 10);
            if (startLine === undefined) {
                startLine = line;
            }
            endLine = line;
            if (!lastFile || lastFile !== file) {
                startLine = line;
                endLine = line;
                lastFile = file;
            }
            const lines = instr.line_asm_insn as any[];
            if (lines === undefined || lines.length === 0) {
                continue;
            }
            for (const asmLine of lines) {
                const addressStr: string = asmLine.address;
                const funcName = asmLine["func-name"] as string | undefined;
                const opcodes: string = asmLine.opcodes;
                const offset = parseInt(asmLine.offset ?? "0", 10);
                const instr = asmLine.inst as string;
                const useInstr = opcodes.replace(/\s/g, "").padEnd(2 * this.instrInfo!.maxSize + 2) + /* flag + */ instr;
                const pInstr: ProtocolInstruction = {
                    address: addressStr,
                    pvtAddress: parseAddress(addressStr),
                    instruction: useInstr,
                    pvtOpcodes: opcodes,
                    pvtLength: opcodes.split(" ").length,
                    pvtIsData: instr.startsWith(".byte") || instr.startsWith(".word") || instr.startsWith(".hword") || instr.startsWith(".4byte") || instr.startsWith(".2byte"),
                    location: { path: lastFile || "<unknown file>" },
                    line: startLine,
                    endLine: endLine,
                };
                if (funcName) {
                    pInstr.symbol = this.formatSym(funcName, offset);
                }
                if (this.debugDisassembly) {
                    const jStr = JSON.stringify(pInstr, (key, value) => {
                        if (typeof value === "bigint") {
                            return value.toString();
                        }
                        return value;
                    });
                    this.dMsg(`  ${addressStr}: ${jStr}`);
                }
                ret.push(pInstr);
            }
            startLine = undefined;
            endLine = undefined;
            lastFile = undefined;
        }
        return ret;
    }

    protected dMsg(msg: string): void {
        if (this.debugDisassembly) {
            this.session.handleMsg(Stdout, `[Disassembly] ${msg}\n`);
        }
    }
    protected msg(msg: string): void {
        this.session.handleMsg(Stdout, `[Disassembly] ${msg}\n`);
    }

    //
    // This is not normal disassembly. We have to conform to what VSCode expects even beyond
    // what the DAP spec says. This is how VSCode is working
    //
    // * They hinge off of the addresses reported during the stack trace that we gave them. Which btw, is a
    //   hex-string (memoryReference)
    // * Initially, they ask for 400 instructions with 200 instructions before and 200 after the frame PC address
    // * While it did (seem to) work if we return more than 400 instructions, that is violating the spec. and may not work
    //   so we have to return precisely the number of instruction demanded (not a request)
    // * Since this is all based on strings (I don't think they interpret the address string). Yet another
    //   reason why we have to be careful
    // * When you scroll just beyond the limits of what is being displayed, they make another request. They use
    //   the address string for the last (or first depending on direction) instruction previously returned by us
    //   as a base address for this request. Then they ask for +/- 50 instructions from that base address NOT
    //   including the base address.  But we use the instruction at the baseAddress to validate what we are returning
    //   since we know that was valid.
    // * All requests are in terms of instruction counts and not addresses (understandably from their POV)
    //
    // Other notes: We know that most ARM instructions are either 2 or 4 bytes. So we translate insruction counts
    // multiple of 4 bytes as worst case. We can easily go beyond the boundaries of the memory and at this point,
    // not sure what to do. Code can be anywhere in non-contiguous regions and we have no idea to tell what is even
    // valid.
    //
    public async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
        if (this.session.isBusy()) {
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
        const anchorAddress = parseAddress(args.memoryReference);
        let startAddress = anchorAddress + BigInt(args.offset ?? 1); // worst case
        const instructionCount = args.instructionCount || 100;
        const instrOffset = args.instructionOffset || 0;

        const aveInsrSize = BigInt(Math.ceil((this.instrInfo.minSize + this.instrInfo.maxSize) / 2));
        let startSearchAddress = startAddress + (BigInt(instrOffset) * aveInsrSize * 125n) / 100n; // 25% more
        if (startSearchAddress < 0n) {
            startSearchAddress = 0n;
        }
        let endSearchAddress = startAddress + (BigInt(instructionCount) * aveInsrSize * 125n) / 100n; // 25% more
        startSearchAddress = this.clipLow(anchorAddress, startSearchAddress);
        endSearchAddress = this.clipHigh(anchorAddress, endSearchAddress);
        const ranges = this.findSymbolsInRange(startSearchAddress, endSearchAddress);
        this.dMsg(`Disassemble request at ${dasmFormatAddress(anchorAddress)} with offset ${args.offset}, instructionCount ${instructionCount}, instructionOffset ${instrOffset}`);
        this.dMsg(`Calculated start address ${dasmFormatAddress(startAddress)}`);
        this.dMsg(`Searching symbols between ${dasmFormatAddress(startSearchAddress)} and ${dasmFormatAddress(endSearchAddress)}`);
        if (ranges === undefined) {
            throw new Error(`No symbols found in the requested range ${dasmFormatAddress(startSearchAddress)} - ${dasmFormatAddress(endSearchAddress)}`);
        }

        const instrs: ProtocolInstruction[] = [];
        for (const range of ranges) {
            const rangeInstrs = await this.disassembleRange(range);
            instrs.push(...rangeInstrs);
        }
        let anchorIx = instrs.findIndex((instr) => instr.pvtAddress === anchorAddress);
        if (anchorIx === -1) {
            // Find nearest instruction
            let nearestIx = -1;
            let nearestDiff = BigInt("0xFFFFFFFFFFFFFFFF");
            let nearestAddress = BigInt(0);
            for (let i = 0; i < instrs.length; i++) {
                const instr = instrs[i];
                const diff = instr.pvtAddress > anchorAddress ? instr.pvtAddress - anchorAddress : anchorAddress - instr.pvtAddress;
                if (diff < nearestDiff) {
                    nearestDiff = diff;
                    nearestIx = i;
                    nearestAddress = instr.pvtAddress;
                }
            }
            this.dMsg(`Nearest instruction to anchor address ${dasmFormatAddress(anchorAddress)} is at index ${nearestIx} with address ${dasmFormatAddress(instrs[nearestIx].pvtAddress)}`);
            anchorIx = nearestIx;
        }
        const offsetInstrIx = anchorIx + instrOffset;
        if (offsetInstrIx < 0) {
            for (let i = offsetInstrIx; i < 0; i++) {
                instrs.unshift(this.dummyInstr(startAddress - BigInt(Math.abs(i) * this.instrInfo.maxSize)));
            }
            anchorIx += Math.abs(offsetInstrIx);
        } else if (offsetInstrIx >= instrs.length) {
            for (let i = instrs.length; i <= offsetInstrIx; i++) {
                instrs.push(this.dummyInstr(startAddress + BigInt(i * this.instrInfo.maxSize)));
            }
        }
        if (offsetInstrIx + instructionCount > instrs.length) {
            const toAdd = offsetInstrIx + instructionCount - instrs.length;
            for (let i = 0; i < toAdd; i++) {
                instrs.push(this.dummyInstr(startAddress + BigInt((instrs.length + i) * this.instrInfo.maxSize)));
            }
        }
        if (instrs.length > instructionCount) {
            // Specs we must send EXACTLY instructionCount instructions. No less for sure. apparently no more either
            this.dMsg(`Trimming instructions from ${instrs.length} to ${instructionCount}`);
            instrs.splice(instructionCount);
        }

        this.dMsg(`Found instruction at anchor address ${dasmFormatAddress(anchorAddress)} at index ${anchorIx} in disassembled instructions`);
        startAddress = instrs[anchorIx].pvtAddress;

        this.dMsg(`Returning instructions from index ${offsetInstrIx} to ${offsetInstrIx + instructionCount - 1}`);

        response.body = {
            // instructions: instrs.slice(instrOffset, instrOffset + instructionCount),
            instructions: instrs.map((instr) => {
                const obj = { ...instr };
                delete (obj as any).pvtAddress;
                delete (obj as any).pvtInstructionBytes;
                delete (obj as any).pvtIsData;
                return obj;
            }),
        };
        this.session.sendResponse(response);
    }

    private findSymbolsInRange(start: bigint, end: bigint): InstrRange[] | undefined {
        this.dMsg(`Searching symbols between ${dasmFormatAddress(start)} and ${dasmFormatAddress(end)}`);
        const symbols = this.symbolTable.searchSymbolsByAddress(start, end);
        const ranges: InstrRange[] = [];
        if (symbols.length === 0) {
            this.dMsg("No symbols found");
            return undefined;
        }
        ranges.push(InstrRange.fromSymbolNode(symbols[0]));
        // Create a list of ranges that are non-overlapping
        for (let i = 1; i < symbols.length; i++) {
            const sym = symbols[i];
            const lastRange = ranges[ranges.length - 1];
            const diff = (sym.low as bigint) - lastRange.high;
            if (diff <= 1n) {
                // Overlapping range, extend the high if needed
                if ((sym.high as bigint) > lastRange.high) {
                    lastRange.high = sym.high as bigint;
                }
                lastRange.addSymbol(sym.symbol);
            } else {
                // New range
                this.dMsg(`New disassembly range from symbol ${sym.symbol.name} at ${dasmFormatAddress(sym.low as bigint)}. diff = ${diff}`);
                ranges.push(InstrRange.fromSymbolNode(sym));
            }
        }
        return ranges;
    }

    private instrRangesCache: InstrRangeCache = new InstrRangeCache();
    private async disassembleRange(range: InstrRange): Promise<ProtocolInstruction[]> {
        const retInstrs = [];
        if (this.instrRangesCache.length > 0) {
            for (const cachedRange of this.instrRangesCache) {
                if (cachedRange.containsRange(range)) {
                    this.dMsg(`Using cached instructions for range ${dasmFormatAddress(range.low)} - ${dasmFormatAddress(range.high)}`);
                    return cachedRange.getInstructions().filter((instr) => {
                        const addr = instr.pvtAddress + BigInt(instr.pvtLength!);
                        return range.contains(addr);
                    });
                }
                if (cachedRange.overlaps(range)) {
                    this.dMsg(`Using cached instructions for range ${dasmFormatAddress(range.low)} - ${dasmFormatAddress(range.high)}`);
                    const instrs = cachedRange.getInstructions().filter((instr) => {
                        return range.contains(instr.pvtAddress);
                    });
                    retInstrs.push(...instrs);
                }
            }
            if (retInstrs.length > 0) {
                const first = retInstrs[0];
                const last = retInstrs[retInstrs.length - 1];
                const newHigh = last.pvtAddress + BigInt(last.pvtLength!);
                if (first.pvtAddress >= range.low || newHigh <= range.high) {
                    return retInstrs;
                }
                const lowRange = new InstrRange(range.low, first.pvtAddress - 1n);
                const highRange = new InstrRange(newHigh + 1n, range.high);
                const allInstrs: ProtocolInstruction[] = [];
                if (lowRange.low > range.low) {
                    const newRange = new InstrRange(range.low, lowRange.low - 1n);
                    this.dMsg(`Disassembling missing low range ${dasmFormatAddress(newRange.low)} - ${dasmFormatAddress(newRange.high)}`);
                    const lowInstrs = await this.gdbDisassembleRange(newRange);
                    allInstrs.push(...lowInstrs);
                }
                allInstrs.push(...retInstrs);
                if (range.high > highRange.high) {
                    const newRange = new InstrRange(highRange.high + 1n, range.high);
                    this.dMsg(`Disassembling missing high range ${dasmFormatAddress(newRange.low)} - ${dasmFormatAddress(newRange.high)}`);
                    const highInstrs = await this.gdbDisassembleRange(newRange);
                    allInstrs.push(...highInstrs);
                }
                const finalRange = new InstrRange(allInstrs[0].pvtAddress, allInstrs[allInstrs.length - 1].pvtAddress + BigInt(allInstrs[allInstrs.length - 1].pvtLength!));
                finalRange.addInstructions(allInstrs);
                for (const sym of range.getSymbols() || []) {
                    finalRange.addSymbol(sym);
                }
                this.instrRangesCache.insert(finalRange);
                return allInstrs;
            }
        }
        const ret = await this.gdbDisassembleRange(range);
        range.addInstructions(ret);
        this.instrRangesCache.insert(range);
        return ret;
    }
}
