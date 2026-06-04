// Example TypeScript converter: compact array -> DAP DisassembleResponse
// Input compact format (Value):
// { t: 'disasm', id: 42, start: '0x1000', final: true, lines: [ [addr, bytes, instr, raw], ... ] }

export type CompactLine = [string, string, string, string];

export interface CompactDisasm {
    t: "disasm";
    id: number;
    start: string;
    final: boolean;
    lines: CompactLine[];
}

// Minimal DAP 'Instruction' representation
export interface DisassembledInstruction {
    address: string; // hex
    instruction: string;
    // optional fields that DAP's 'disassemble' response expects
    // raw bytes and raw text kept in 'data' field or 'instruction' as needed
    rawBytes?: string;
    raw?: string;
}

// Convert compact message to DAP DisassembleResponse format's 'instructions' array
export function compactToDAP(msg: CompactDisasm) {
    const instructions: DisassembledInstruction[] = msg.lines.map((l) => {
        const [addr, bytes, instr, raw] = l;
        return {
            address: addr,
            instruction: instr,
            rawBytes: bytes,
            raw: raw,
        };
    });

    // DAP DisassembleResponse has shape: { instructions: Instruction[] }
    return { instructions };
}

// Usage example (node):
// const parsed = JSON.parse(compactJson);
// const dap = compactToDAP(parsed as CompactDisasm);
// send 'dap' to VS Code as the response body for the Disassemble request.
