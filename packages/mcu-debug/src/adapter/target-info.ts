import { parseAddress } from "../frontend/utils";
import { GdbInstance } from "./gdb-mi/gdb-instance";
import { DataEvaluateExpressionAsNumber, GdbMiOrCliCommandForOob } from "./gdb-mi/mi-commands";
import { Stderr, Stdout } from "./gdb-mi/mi-types";
import { GDBDebugSession } from "./gdb-session";

/*
-interpreter-exec console "info mem"
Using memory regions provided by the target.
Num Enb Low Addr   High Addr  Attrs 
0   y  	0x00000000 0x10000000 rw nocache 
1   y  	0x10000000 0x10100000 flash blocksize 0x200 nocache 
2   y  	0x10100000 0x14000000 rw nocache 
3   y  	0x14000000 0x14008000 flash blocksize 0x200 nocache 
4   y  	0x14008000 0x16000000 rw nocache 
5   y  	0x16000000 0x16008000 flash blocksize 0x200 nocache 
6   y  	0x16008000 0x18000000 rw nocache 
7   y  	0x18000000 0x1c000000 flash blocksize 0x40000 nocache 
8   y  	0x1c000000 0x90700000 rw nocache 
9   y  	0x90700000 0x90700400 flash blocksize 0x400 nocache 
10  y  	0x90700400 0x100000000 rw nocache 

Attrs:
Access: ro, wo, rw, flash
Addr Range: [low, high)
GDB cache modes: nocache, cache -- nothing to do with actual HW caches
*/

// Source: https://gitlab-beta.engr.illinois.edu/fanglu2/saenaios-binutils/-/blob/ae0c2d3f7265941b8d4b7a04052cea65250954ea/gdb/configure.tgt
// A map of GDB shell patterns to TypeScript RegExp
const gdbArchPatterns: RegExp[] = [
    /^i[3-7]86$/, // i[34567]86
    /^x86_64$/,
    /^arm.*/, // arm*
    /^aarch64.*/, // aarch64*
    /^riscv(32|64)?.*/, // riscv*
    /^mips.*/, // mips*
    /^powerpc.*/, // powerpc*
    /^sh.*/, // sh*
    /^xtensa.*/, // xtensa*
    /^v850.*/, // v850*
    // Add others from the list as needed
];

const ARM_VERSIONS =
    "arm, armv2, armv2a, armv3, armv3m, armv4, armv4t, armv5, armv5t, armv5te, xscale, iwmmxt, iwmmxt2, armv5tej, armv6, armv6kz, armv6t2, armv6k, armv7, armv6-m, armv6s-m, armv7e-m, armv8-a, armv8-r, armv8-m.base, armv8-m.main, armv8.1-m.main, armv9-a, arm_any";

const ARCH_REGISTRY: Record<string, { gdbName: string; isEmbedded: boolean }> = {
    arm: { gdbName: "arm", isEmbedded: true },
    aarch64: { gdbName: "aarch64", isEmbedded: true },
    riscv: { gdbName: "riscv", isEmbedded: true },
    i386: { gdbName: "i386", isEmbedded: false },
};

function isSupportedArch(arch: string): boolean {
    return gdbArchPatterns.some((pattern) => pattern.test(arch));
}

export class TargetMemoryRegion {
    public readonly access: "ro" | "wo" | "rw" | "flash";
    public readonly attrs: string[];
    constructor(
        public readonly lowAddress: bigint, // inclusive
        public readonly highAddress: bigint, // exclusive
        attributes: string,
    ) {
        this.attrs = attributes.split(" ").map((a) => a.trim());
        this.access = this.attrs.find((attr) => ["ro", "wo", "rw", "flash"].includes(attr)) as "ro" | "wo" | "rw" | "flash";
    }

    public containsAddress(address: bigint): boolean {
        return address >= this.lowAddress && address < this.highAddress;
    }

    public isWritable(): boolean {
        return this.access === "wo" || this.access === "rw";
    }
    public isReadable(): boolean {
        return this.access === "ro" || this.access === "rw" || this.access === "flash";
    }
    public isReadWritable(): boolean {
        return this.access === "rw";
    }

    public isWritableAtAddress(address: bigint): boolean {
        return this.isWritable() && this.containsAddress(address);
    }
}

export class TargetMemoryRegions {
    private regions: TargetMemoryRegion[] = [];
    constructor(regions: TargetMemoryRegion[]) {
        this.regions = regions;
    }

    public findRegionForAddress(address: bigint): TargetMemoryRegion | undefined {
        for (const region of this.regions) {
            if (region.containsAddress(address)) {
                return region;
            }
        }
        return undefined;
    }

    public testAccessAtAddress(address: bigint, accessFunc: (region: TargetMemoryRegion) => boolean): boolean {
        if (this.regions.length === 0) {
            // No region info available, assume accessible
            return true;
        }
        for (const region of this.regions) {
            if (region.containsAddress(address) && accessFunc(region)) {
                return true;
            }
        }
        return false;
    }

    public isReadableAtAddress(address: bigint): boolean {
        return this.testAccessAtAddress(address, (region) => region.isReadable());
    }

    public isReadWritableAtAddress(address: bigint): boolean {
        return this.testAccessAtAddress(address, (region) => region.isReadWritable());
    }

    public isWritableAtAddress(address: bigint): boolean {
        return this.testAccessAtAddress(address, (region) => region.isWritable());
    }
}

export class TargetInfo {
    public static Instance: TargetInfo | undefined;
    public architecture: string | undefined;
    private targetMemoryRegions: TargetMemoryRegions | undefined;
    private PointerSize: number = 4; // default to 32-bit pointers

    constructor(
        private gdbInstance: GdbInstance,
        private session: GDBDebugSession,
    ) {
        TargetInfo.Instance = this;
    }

    public getMemoryRegions(): TargetMemoryRegions {
        return this.targetMemoryRegions!;
    }
    public getPointerSize(): number {
        return this.PointerSize;
    }

    public async initialize(): Promise<void> {
        try {
            await this._getMemoryRegions();
        } catch (e) {
            this.session.handleMsg(Stderr, `Warning: Unable to determine target memory regions. ${e}\n`);
        }
        try {
            const tmp = await DataEvaluateExpressionAsNumber(this.gdbInstance, `sizeof(void*)`);
            this.PointerSize = tmp !== null ? tmp : 4;
        } catch {
            this.session.handleMsg(Stderr, "Warning: Unable to determine target pointer size. Defaulting to 4 bytes.\n");
        }
        try {
            const lines = (await GdbMiOrCliCommandForOob(this.gdbInstance, "show architecture")) as string[];
            for (const line of lines) {
                let match = /.*architecture.*currently \"(.+)\"/.exec(line);
                if (match) {
                    let arch = match[1];
                    if (arch === "auto") {
                        match = /.*architecture.*\"(.+)\"/.exec(line);
                        if (match) {
                            arch = match[1];
                        }
                    }
                    this.architecture = arch;
                    this.session.handleMsg(Stdout, `Target architecture: ${arch}\n`);
                    break;
                }
            }
            if (!this.architecture) {
                this.session.handleMsg(Stderr, "Warning: Unable to determine target architecture.\n");
            } else if (!isSupportedArch(this.architecture)) {
                this.session.handleMsg(Stderr, `Warning: Target architecture '${this.architecture}' may not be fully supported.\n`);
            }
        } catch {
            this.session.handleMsg(Stderr, "Warning: Unable to determine target architecture.\n");
        }
    }

    private async _getMemoryRegions(): Promise<void> {
        try {
            const outputLines = (await GdbMiOrCliCommandForOob(this.gdbInstance, "info mem")) as string[];
            // Parse the lines to extract region info
            const regions: TargetMemoryRegion[] = [];
            let inTable = false;
            for (const line of outputLines) {
                if (line.startsWith("Num Enb Low Addr")) {
                    inTable = true;
                    continue;
                }
                if (inTable) {
                    if (line.length === 0) {
                        break; // end of table
                    }
                    const parts = line.split(/\s+/);
                    if (parts.length >= 5) {
                        const lowAddr = parts[2];
                        const highAddr = parts[3];
                        const attrs = parts.slice(4).join(" ");
                        regions.push(new TargetMemoryRegion(parseAddress(lowAddr), parseAddress(highAddr), attrs));
                    }
                }
            }
            if (regions.length === 0) {
                this.session.handleMsg(Stdout, "No memory region information available from target. All variables are considered accessible(read/write).\n");
            }
            this.targetMemoryRegions = new TargetMemoryRegions(regions);
        } catch (error: any) {
            throw new Error(`Error getting memory regions: ${error.toString()}`);
        }
    }
}
