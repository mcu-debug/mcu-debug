import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SpawnLineReader, SymbolFile, validateELFHeader, canonicalizePath } from "./servers/common";
// import { IntervalTree, Interval } from "node-interval-tree";
import { Interval, IntervalTree } from "@flatten-js/interval-tree";

import { GDBDebugSession } from "./gdb-session";
import { formatAddress, parseAddress, parseBigint } from "../frontend/utils";
import { GdbMiOutput } from "./gdb-mi/mi-types";
import { Stderr } from "./gdb-mi/mi-types";
import { DisassemblyInstruction } from "../adapter/servers/common";

export enum SymbolType {
    Function,
    File,
    Object,
    Normal,
}

export enum SymbolScope {
    Local,
    Global,
    Neither,
    Both,
}

export interface SymbolInformation {
    addressOrig: bigint;
    address: bigint;
    length: number;
    name: string;
    file: /* number |*/ string; // The actual file name parsed (more reliable with nm)
    section?: string; // Not available with nm
    type: SymbolType;
    scope: SymbolScope;
    isStatic: boolean;
    // line?: number;                // Only available when using nm
    instructions: DisassemblyInstruction[];
    hidden: boolean;
}

const OBJDUMP_SYMBOL_RE = RegExp(/^([0-9a-f]+)\s([lg !])([w ])([C ])([W ])([I ])([dD ])([FfO ])\s(.*?)\t([0-9a-f]+)\s(.*)$/);
const NM_SYMBOL_RE = RegExp(/^([0-9a-f]+).*\t(.+):[0-9]+/); // For now, we only need two things
const debugConsoleLogging = false;
const TYPE_MAP: { [id: string]: SymbolType } = {
    F: SymbolType.Function,
    f: SymbolType.File,
    O: SymbolType.Object,
    " ": SymbolType.Normal,
};

const SCOPE_MAP: { [id: string]: SymbolScope } = {
    l: SymbolScope.Local,
    g: SymbolScope.Global,
    " ": SymbolScope.Neither,
    "!": SymbolScope.Both,
};

/**
 * While parsing output of nm/objdump (both are line oriented), how you parse a line changes depending on where
 * you are in the output. This context object helps keep track of that. The callback is the current line parser function
 * which change as we progress through the output. This way, we have a simple state machine for parsing. Not every field
 * is needed by every parser, but the most important is the callback.
 */
export class ObjectReaderContext {
    public curObjFile: string | null = null; // Current object file being processed from nm/objdump
    constructor(public reader: SpawnLineReader) {}

    public setCallback(cb: (line: string, err?: any) => boolean) {
        this.reader.callback = cb;
    }

    public getCallback() {
        return this.reader.callback;
    }
}

export class SymbolNode extends Interval {
    // readonly addrRange: [bigint, bigint];
    constructor(
        public readonly symbol: SymbolInformation, // Only functions and objects
        low: bigint, // Inclusive near as I can tell
        high: bigint, // Inclusive near as I can tell
    ) {
        super(low, high);
    }
    clone(): Interval {
        return new SymbolNode(this.symbol, this.low as bigint, this.high as bigint);
    }
}

interface IMemoryRegion {
    name: string;
    size: bigint;
    vmaStart: bigint; // Virtual memory address
    vmaStartOrig: bigint;
    lmaStart: bigint; // Load memory address
    attrs: string[];
}
export class MemoryRegion implements IMemoryRegion {
    public vmaEnd: bigint; // Inclusive
    public lmaEnd: bigint; // Exclusive
    public name: string;
    public size: bigint;
    public vmaStart: bigint;
    public lmaStart: bigint;
    public vmaStartOrig: bigint;
    public attrs: string[];
    constructor(obj: IMemoryRegion) {
        Object.assign(this, obj);
        this.vmaEnd = this.vmaStart + this.size + 1n;
        this.lmaEnd = this.lmaStart + this.size + 1n;
    }

    public inVmaRegion(addr: bigint) {
        return addr >= this.vmaStart && addr < this.vmaEnd;
    }

    public inLmaRegion(addr: bigint) {
        return addr >= this.lmaStart && addr < this.lmaEnd;
    }

    public inRegion(addr: bigint) {
        return this.inVmaRegion(addr) || this.inLmaRegion(addr);
    }
}

interface ISymbolTableSerData {
    version: number;
    memoryRegions: MemoryRegion[];
    fileTable: string[];
    symbolKeys: string[];
    allSymbols: any[][];
}

// Replace last part of the path containing a program to another. If search string not found
// or replacement the same as search string, then null is returned
function replaceProgInPath(filepath: string, search: string | RegExp, replace: string): string {
    if (os.platform() === "win32") {
        filepath = filepath.toLowerCase().replace(/\\/g, "/");
    }
    const ix = filepath.lastIndexOf("/");
    const prefix = ix >= 0 ? filepath.substring(0, ix + 1) : "";
    const suffix = filepath.substring(ix + 1);
    const replaced = suffix.replace(search, replace);
    if (replaced === suffix) {
        return null;
    }
    const ret = prefix + replaced;
    return ret;
}

const trace = true;

interface ExecPromise {
    args: string[];
    promise: Promise<any>;
}

class AddressToSym extends Map<bigint, SymbolInformation[]> {
    constructor(...args: any[]) {
        super(...args);
    }
}
export class SymbolTable {
    private allSymbols: SymbolInformation[] = [];
    private fileTable: string[] = [];
    public memoryRegions: MemoryRegion[] = [];

    // The following are caches that are either created on demand or on symbol load. Helps performance
    // on large executables since most of our searches are linear. Or, to avoid a search entirely if possible
    // Case sensitivity for path names is an issue: We follow just what gcc records so inherently case-sensitive
    // or case-preserving. We don't try to re-interpret/massage those path-names (but we do Normalize).
    private staticsByFile: { [file: string]: SymbolInformation[] } = {};
    private globalVars: SymbolInformation[] = [];
    private globalFuncsMap: { [key: string]: SymbolInformation } = {}; // Key is function name
    private staticVars: SymbolInformation[] = [];
    private staticFuncsMap: { [key: string]: SymbolInformation[] } = {}; // Key is function name
    private fileMap: { [key: string]: string[] } = {}; // Potential list of file aliases we found
    private processedPathVariations = new Set<string>(); // Track files already processed for path variations
    public symbolsAsIntervalTree: IntervalTree<SymbolNode> = new IntervalTree<SymbolNode>();
    public symbolsByAddress: AddressToSym = new AddressToSym();
    public symbolsByAddressOrig: AddressToSym = new AddressToSym();
    // private varsByFile: { [path: string]: VariablesInFile } = null;
    private nmPromises: ExecPromise[] = [];
    private executables: SymbolFile[] = [];

    private objdumpPath: string;

    constructor(private gdbSession: GDBDebugSession) {}

    public initialize(executables: SymbolFile[]) {
        this.executables = executables;
        const args = this.gdbSession.args;
        this.objdumpPath = args.objdumpPath;
        if (!this.objdumpPath) {
            this.objdumpPath = os.platform() !== "win32" ? `${args.toolchainPrefix}-objdump` : `${args.toolchainPrefix}-objdump.exe`;
            if (args.toolchainPath) {
                this.objdumpPath = path.normalize(path.join(args.toolchainPath, this.objdumpPath));
            } else if (args.gdbPath) {
                const tmp = replaceProgInPath(args.gdbPath, /gdb/i, "objdump");
                this.objdumpPath = tmp || this.objdumpPath;
            }
        }
        if (this.objdumpPath) {
            this.objdumpPath = this.objdumpPath.replace(/\\/g, "/");
        }
    }

    /**
     * Problem statement:
     * We need a read the symbol table for multiple types of information and none of the tools so far
     * give all all we need
     *
     * 1. List of static variables by file
     * 2. List of globals
     * 3. Functions (global and static) with their addresses and lengths
     *
     * Things we tried:
     * 1.-Wi option objdump -- produces super large output (100MB+) and take minutes to produce and parse
     * 2. Using gdb: We can get variable/function to file information but no addresses -- not super fast but
     *    inconvenient. We have a couple of different ways and it is still ugly
     * 3. Use nm: This looked super promising until we found out it is super inacurate in telling the type of
     *    symbol. It classifies variables as functions and vice-versa. But for figuring out which variable
     *    belongs to which file that is pretty accurate
     * 4. Use readelf. This went nowhere because you can't get even basic file to symbol mapping from this
     *    and it is not as universal for handling file formats as objdump.
     *
     * So, we are not using option 3 and fall back to option 2. We will never go back to option 1
     *
     * Another problem is that we may have to query for symbols using different ways -- partial file names,
     * full path names, etc. So, we keep a map of file to statics.
     *
     * Other uses for objdump is to get a section headers for memory regions that can be used for disassembly
     *
     * We avoid splitting the output(s) into lines and then parse line at a time.
     */
    public async loadSymbols(): Promise<void> {
        try {
            await this.loadFromObjdumpAndNm();
            this.categorizeSymbols();
            this.sortGlobalVars();
        } catch (e) {
            // We treat this is non-fatal, but why did it fail?
            this.gdbSession.handleMsg(Stderr, `Error: objdump failed! statics/globals/functions may not be properly classified: ${e.toString()}\n`);
            this.gdbSession.handleMsg(Stderr, "    ENOENT means program not found. If that is not the issue, please report this problem.\n");
        }
    }

    private rttSymbol: SymbolInformation;
    public readonly rttSymbolName = "_SEGGER_RTT";
    private addSymbol(sym: SymbolInformation) {
        if (sym.length === 0 && /^\$[atdbfpm]$/.test(sym.name)) {
            // see https://docs.adacore.com/live/wave/binutils-stable/html/as/as.html#ARM-Mapping-Symbols
            // These are special markers for start of (a)RM, (t)humb, (d)ata sections and other not yet implemented
            return;
        }

        if (!this.rttSymbol && sym.name === this.rttSymbolName && sym.type === SymbolType.Object && sym.length > 0) {
            this.rttSymbol = sym;
        }

        this.allSymbols.push(sym);
        if (sym.type === SymbolType.Function || sym.length > 0) {
            const treeSym = new SymbolNode(sym, sym.address, sym.address + BigInt(Math.max(1, sym.length) - 1));
            this.symbolsAsIntervalTree.insert(treeSym, treeSym);
        }
        this.addSymbolToTrees(sym);
    }

    private addSymbolToTrees(sym: SymbolInformation) {
        const add = (symt: AddressToSym, address: bigint) => {
            const info = symt.get(address);
            if (info) {
                info.push(sym);
            } else {
                symt.set(address, [sym]);
            }
        };
        add(this.symbolsByAddress, sym.address);
        add(this.symbolsByAddressOrig, sym.addressOrig);
    }

    private readObjdumpHeaderLine(cxt: ObjectReaderContext, symF: SymbolFile, line: string, err: any): boolean {
        if (!line) {
            return line === "" ? true : false;
        }
        const entry = /^\s*[0-9]+\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.*)$/;
        // Header:
        // Idx Name          Size      VMA       LMA       File off  Algn
        // Sample entry:
        //   0 .cy_m0p_image 000025d4  10000000  10000000  00010000  2**2 CONTENTS, ALLOC, LOAD, READONLY, DATA
        //                                    1          2          3          4          5          6         7
        // const entry = RegExp(/^\s*[0-9]+\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)[^\n]+\n\s*([^\r\n]*)\r?\n/gm);
        const match = line.match(entry);
        if (match) {
            const attrs = match[7]
                .trim()
                .toLowerCase()
                .split(/[,\s]+/g);
            if (!attrs.find((s) => s === "alloc")) {
                // Technically we only need regions marked for code but lets get all non-debug, non-comment stuff
                return true;
            }
            const name = match[1];
            const offset = symF.offset || 0n;
            const vmaOrig = BigInt("0x" + match[3].trim());
            let vmaStart = vmaOrig + offset;
            const section = symF.sectionMap[name];
            if (name === ".text" && typeof symF.textaddress === "bigint") {
                vmaStart = symF.textaddress;
                if (!section) {
                    symF.sections.push({
                        address: vmaStart,
                        addressOrig: vmaOrig,
                        name: name,
                    });
                    symF.sectionMap[name] = symF.sections[symF.sections.length - 1];
                }
            }
            if (section) {
                section.addressOrig = vmaStart;
                vmaStart = section.address;
            }
            const region = new MemoryRegion({
                name: name,
                size: parseBigint("0x" + match[2].trim()), // size
                vmaStart: vmaStart, // vma
                vmaStartOrig: vmaOrig,
                lmaStart: parseBigint("0x" + match[4].trim()), // lma
                attrs: attrs,
            });
            this.memoryRegions.push(region);
        } else {
            if (line.startsWith("SYMBOL TABLE:")) {
                // Switch the parser to symbol line parser mode
                cxt.setCallback(this.readObjdumpSymbolLine.bind(this, cxt, symF));
            }
        }
        return true;
    }

    private readObjdumpSymbolLine(cxt: ObjectReaderContext, symF: SymbolFile, line: string, err: any): boolean {
        if (!line) {
            return line === "" ? true : false;
        }
        const match = line.match(OBJDUMP_SYMBOL_RE);
        if (match) {
            if (match[7] === "d" && match[8] === "f") {
                if (match[11]) {
                    cxt.curObjFile = canonicalizePath(match[11].trim());
                } else {
                    // This can happen with C++. Inline and template methods/variables/functions/etc. are listed with
                    // an empty file association. So, symbols after this line can come from multiple compilation
                    // units with no clear owner. These can be locals, globals or other.
                    cxt.curObjFile = null;
                }
                // We don't really use the symbol except know that the symbol following this belong to this file
                return true;
            } else if (match[7] === "d" && match[8] === " ") {
                // This is a pure debug symbol. No use for them
                return true;
            }
            const type = TYPE_MAP[match[8]];
            const scope = SCOPE_MAP[match[2]];
            let name = match[11].trim();
            let hidden = false;

            if (name.startsWith(".hidden")) {
                name = name.substring(7).trim();
                hidden = true;
            }

            const secName = match[9].trim();
            const size = parseInt(match[10], 16);
            if (secName === "*ABS*" || secName === "*UND*") {
                // These are not true symbols, AFAIK and can be safely ignored as there can be hundreds of these
                // junk symbols. We already handled file names above
                return true;
            }

            const offset = symF.offset || 0n;
            const addr: bigint = parseBigint("0x" + match[1].trim());
            const section = symF.sectionMap[secName];
            const newaddr = addr + (section ? addr - section.addressOrig : offset);

            // Canonicalize file path and add variations
            let canonicalFile = cxt.curObjFile;
            if (canonicalFile) {
                this.addPathVariations(canonicalFile);
            }

            const sym: SymbolInformation = {
                addressOrig: addr,
                address: newaddr,
                name: name,
                file: canonicalFile,
                type: type,
                scope: scope,
                section: secName,
                length: size,
                isStatic: scope === SymbolScope.Local && cxt.curObjFile ? true : false,
                instructions: null,
                hidden: hidden,
            };
            this.addSymbol(sym);
        }
        return true;
    }

    private async loadFromObjdumpAndNm(): Promise<void> {
        const objdumpPromises: ExecPromise[] = [];
        for (const symbolFile of this.executables) {
            const executable = symbolFile.file;
            if (!validateELFHeader(executable)) {
                this.gdbSession.handleMsg(Stderr, `Warn: ${executable} is not an ELF file format. Some features won't work -- Globals, Locals, disassembly, etc.`);
                continue;
            }
            try {
                const spawnOpts = { cwd: this.gdbSession.args.cwd };
                // eslint-disable-next-line no-constant-condition
                if (true) {
                    const objdumpStart = Date.now();
                    const objDumpArgs = [
                        "--syms", // Of course, we want symbols
                        "-C", // Demangle
                        "-h", // Want section headers
                        "-w", // Don't wrap lines (wide format)
                        executable,
                    ];
                    const cxt = new ObjectReaderContext(new SpawnLineReader());
                    cxt.setCallback(this.readObjdumpHeaderLine.bind(this, cxt, symbolFile));
                    cxt.reader.on("error", (e) => {
                        this.gdbSession.handleMsg(Stderr, `Error: objdump failed for ${executable}: ${e.toString()}\n`);
                    });
                    cxt.reader.on("exit", (code, signal) => {
                        if (code !== 0) {
                            this.gdbSession.handleMsg(Stderr, `'objdump' exited with a nonzero exit status ${code}, ${signal}. File: ${executable}\n`);
                        }
                    });
                    cxt.reader.on("close", (code, signal) => {
                        if (trace || this.gdbSession.args.showDevDebugOutput) {
                            const ms = Date.now() - objdumpStart;
                            this.gdbSession.handleMsg(Stderr, `Finished reading symbols from objdump: Time: ${ms} ms. File: ${executable}\n`);
                        }
                    });

                    if (trace || this.gdbSession.args.showDevDebugOutput) {
                        this.gdbSession.handleMsg(Stderr, `Reading symbols from ${this.objdumpPath} ${objDumpArgs.join(" ")}\n`);
                    }
                    objdumpPromises.push({
                        args: [this.objdumpPath, ...objDumpArgs],
                        promise: cxt.reader.startWithProgram(this.objdumpPath, objDumpArgs, spawnOpts, cxt.getCallback()),
                    });
                }

                // eslint-disable-next-line no-constant-condition
                if (true) {
                    const nmStart = Date.now();
                    const nmProg = replaceProgInPath(this.objdumpPath, /objdump/i, "nm");
                    const nmArgs = [
                        "--defined-only",
                        "-S", // Want size as well
                        "-l", // File/line info
                        "-C", // Demangle
                        "-p", // don't bother sorting
                        // Do not use posix format. It is inaccurate
                        executable,
                    ];
                    const cxt = new ObjectReaderContext(new SpawnLineReader());
                    cxt.setCallback(this.readNmSymbolLine.bind(this, cxt, symbolFile));
                    cxt.reader.on("error", (e) => {
                        // eslint-disable-next-line @stylistic/max-len
                        this.gdbSession.handleMsg(Stderr, `Error: ${nmProg} failed for ${executable}! File-to-symbol mapping for this file may be incomplete: ${e.toString()}\n`);
                        this.gdbSession.handleMsg(Stderr, "    Expecting `nm` next to `objdump`. If that is not the problem please report this.\n");
                    });
                    cxt.reader.on("exit", (code, signal) => {
                        if (code !== 0) {
                            this.gdbSession.handleMsg(Stderr, `'nm' exited with a nonzero exit status ${code}, ${signal}. File: ${executable}\n`);
                        }
                    });
                    cxt.reader.on("close", () => {
                        if (trace || this.gdbSession.args.showDevDebugOutput) {
                            const ms = Date.now() - nmStart;
                            this.gdbSession.handleMsg(Stderr, `Finished reading symbols from nm: Time: ${ms} ms. File: ${executable}\n`);
                        }
                    });

                    if (trace || this.gdbSession.args.showDevDebugOutput) {
                        this.gdbSession.handleMsg(Stderr, `Reading symbols from ${nmProg} ${nmArgs.join(" ")}\n`);
                    }
                    this.nmPromises.push({
                        args: [nmProg, ...nmArgs],
                        promise: cxt.reader.startWithProgram(nmProg, nmArgs, spawnOpts, cxt.getCallback()),
                    });
                }
            } catch (e) {
                this.gdbSession.handleMsg(Stderr, `Error launching objdump/nm for ${executable}: ${e.toString()}\n`);
            }
        }
        // Yes, we launch both programs and wait for both to finish. Running them back to back
        // takes almost twice as much time. Neither should technically fail.
        await this.waitOnProgs(objdumpPromises);

        // Don't wait for nm to finish - it continues in background (lazy loading)
        // File-to-symbol mappings will be completed when first accessed
        this.finishNmSymbols().catch((e) => {
            this.gdbSession.handleMsg(Stderr, `Error processing nm symbols: ${e.toString()}\n`);
        });
    }

    private async waitOnProgs(promises: ExecPromise[]): Promise<void> {
        for (const p of promises) {
            try {
                await p.promise;
            } catch (e) {
                this.gdbSession.handleMsg(Stderr, `Failed running: ${p.args.join(" ")}.\n    ${e}`);
            }
        }
        return Promise.resolve();
    }

    private finishNmSymbolsPromise: Promise<void> | null = null;
    private finishNmSymbols(): Promise<void> {
        if (!this.nmPromises.length) {
            return Promise.resolve();
        }
        if (!this.finishNmSymbolsPromise) {
            this.finishNmSymbolsPromise = this.doFinishNmSymbols();
        }
        return this.finishNmSymbolsPromise;
    }

    private async doFinishNmSymbols(): Promise<void> {
        try {
            await this.waitOnProgs(this.nmPromises);
            // This part needs to run after nm processes finished
            // Maps addresses to source files for better symbol classification
            for (const item of this.addressToFileOrig) {
                const syms = this.symbolsByAddressOrig.get(item[0]);
                if (syms) {
                    for (const sym of syms) {
                        sym.file = item[1];
                    }
                } else {
                    console.error("Unknown symbol address. Need to investigate", formatAddress(item[0]), item);
                }
            }
        } catch (e) {
            this.gdbSession.handleMsg(Stderr, `Error in nm symbol processing: ${e.toString()}\n`);
        } finally {
            this.addressToFileOrig.clear();
            this.nmPromises = [];
        }
    }

    private addressToFileOrig: Map<bigint, string> = new Map<bigint, string>(); // These are addresses used before re-mapped via symbol-files
    private readNmSymbolLine(cxt: ObjectReaderContext, symF: SymbolFile, line: string, err: any): boolean {
        const match = line && line.match(NM_SYMBOL_RE);
        if (match) {
            const offset = symF.offset || 0n;
            const address = parseAddress("0x" + match[1].trim()) + offset;
            const file = canonicalizePath(match[2]);
            this.addressToFileOrig.set(address, file);
            this.addPathVariations(file);
        }
        return true;
    }

    public updateSymbolSize(node: SymbolNode, len: number) {
        this.symbolsAsIntervalTree.remove(node, node);
        node.symbol.length = len;
        node = new SymbolNode(node.symbol, node.low as bigint, (node.high as bigint) + BigInt(len) - 1n);
        this.symbolsAsIntervalTree.insert(node, node);
    }

    private sortGlobalVars() {
        // We only sort globalVars. Want to preserve statics original order though.
        this.globalVars.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

        // double underscore variables are less interesting. Push it down to the bottom
        const doubleUScores: SymbolInformation[] = [];
        while (this.globalVars.length > 0) {
            if (this.globalVars[0].name.startsWith("__")) {
                doubleUScores.push(this.globalVars.shift());
            } else {
                break;
            }
        }
        this.globalVars = this.globalVars.concat(doubleUScores);
    }

    private categorizeSymbols() {
        for (const sym of this.allSymbols) {
            const scope = sym.scope;
            const type = sym.type;
            if (scope !== SymbolScope.Local) {
                if (type === SymbolType.Function) {
                    sym.scope = SymbolScope.Global;
                    this.globalFuncsMap[sym.name] = sym;
                } else if (type === SymbolType.Object) {
                    if (scope === SymbolScope.Global) {
                        this.globalVars.push(sym);
                    } else {
                        // These fail gdb create-vars. So ignoring them. C++ generates them.
                        if (debugConsoleLogging) {
                            console.log("SymbolTable: ignoring non local object: " + sym.name);
                        }
                    }
                }
            } else if (sym.file) {
                // Yes, you can have statics with no file association in C++. They are neither
                // truly global or local. Some can be considered global but not sure how to filter.
                if (type === SymbolType.Object) {
                    this.staticVars.push(sym);
                } else if (type === SymbolType.Function) {
                    const tmp = this.staticFuncsMap[sym.name];
                    if (tmp) {
                        tmp.push(sym);
                    } else {
                        this.staticFuncsMap[sym.name] = [sym];
                    }
                }
            } else if (type === SymbolType.Function) {
                sym.scope = SymbolScope.Global;
                this.globalFuncsMap[sym.name] = sym;
            } else if (type === SymbolType.Object) {
                // We are currently ignoring Local objects with no file association for objects.
                // Revisit later with care and decide how to classify them
                if (debugConsoleLogging) {
                    console.log("SymbolTable: ignoring local object: " + sym.name);
                }
            }
        }
    }

    public printSyms(cb?: (str: string) => any) {
        cb = cb || console.log;
        for (const sym of this.allSymbols) {
            let str = sym.name;
            if (sym.type === SymbolType.Function) {
                str += " (f)";
            } else if (sym.type === SymbolType.Object) {
                str += " (o)";
            }
            if (sym.file) {
                str += " (s)";
            }
            cb(str);
            if (sym.file) {
                const maps = this.fileMap[sym.file];
                if (maps) {
                    for (const f of maps) {
                        cb("\t" + f);
                    }
                } else {
                    cb("\tNoMap for? " + sym.file);
                }
            }
        }
    }

    public printToFile(fName: string): void {
        try {
            const outFd = fs.openSync(fName, "w");
            this.printSyms((str) => {
                fs.writeSync(outFd, str);
                fs.writeSync(outFd, "\n");
            });
            fs.closeSync(outFd);
        } catch (e) {
            console.log("printSymsToFile: failed" + e);
        }
    }

    private addToFileMap(key: string, newMap: string): string[] {
        newMap = SymbolTable.NormalizePath(newMap);
        const value = this.fileMap[key] || [];
        if (value.indexOf(newMap) === -1) {
            value.push(newMap);
        }
        this.fileMap[key] = value;
        return value;
    }

    private addPathVariations(fileString: string) {
        const canonical = canonicalizePath(fileString);

        // Only process each unique file once
        if (this.processedPathVariations.has(canonical)) {
            return { curSimpleName: path.basename(canonical), curName: canonical };
        }
        this.processedPathVariations.add(canonical);

        const basename = path.basename(canonical);

        // Bidirectional mapping: basename <-> canonical
        this.addToFileMap(basename, canonical);
        this.addToFileMap(canonical, basename);

        // Add partial paths (e.g., src/utils/helper.c -> utils/helper.c, helper.c)
        const parts = canonical.split("/");
        for (let i = 1; i < parts.length; i++) {
            const partial = parts.slice(i).join("/");
            this.addToFileMap(partial, canonical);
            this.addToFileMap(canonical, partial);
        }

        this.logPathResolution(`Added variations for ${fileString} -> canonical: ${canonical}, basename: ${basename}`);
        return { curSimpleName: basename, curName: canonical };
    }

    public getFunctionAtAddress(address: bigint): SymbolInformation {
        const symNodes = this.symbolsAsIntervalTree.search(new Interval(address, address));
        for (const symNode of symNodes) {
            if (symNode && symNode.symbol.type === SymbolType.Function) {
                return symNode.symbol;
            }
        }
        return null;
        // return this.allSymbols.find((s) => s.type === SymbolType.Function && s.address <= address && (s.address + s.length) > address);
    }

    public getFunctionSymbols(): SymbolInformation[] {
        return this.allSymbols.filter((s) => s.type === SymbolType.Function);
    }

    public getGlobalVariables(): SymbolInformation[] {
        return this.globalVars;
    }

    public async getStaticVariableNames(file: string): Promise<string[]> {
        await this.finishNmSymbols();
        const syms = this.getStaticVariables(file);
        const ret = syms.map((s) => s.name);
        return ret;
    }

    public getStaticVariables(file: string): SymbolInformation[] {
        if (!file) {
            return [];
        }

        const canonical = canonicalizePath(file);
        this.logPathResolution(`Looking up static variables for: ${file} (canonical: ${canonical})`);

        // Check cache with canonical path
        let ret = this.staticsByFile[canonical];
        if (ret) {
            this.logPathResolution(`  Found ${ret.length} cached statics for ${canonical}`);
            return ret;
        }

        // Build list of search variants
        const searchVariants = new Set<string>([canonical, path.basename(canonical)]);
        const knownVariants = this.fileMap[canonical];
        if (knownVariants) {
            knownVariants.forEach((v) => searchVariants.add(v));
        }

        ret = [];
        for (const s of this.staticVars) {
            if (!s.file) continue;

            // Direct match
            if (searchVariants.has(s.file)) {
                ret.push(s);
                continue;
            }

            // Check symbol's file variants
            const symFileVariants = this.fileMap[s.file];
            if (symFileVariants) {
                for (const variant of searchVariants) {
                    if (symFileVariants.includes(variant)) {
                        ret.push(s);
                        break;
                    }
                }
            }
        }

        this.logPathResolution(`  Found ${ret.length} static variables after variant search`);
        this.staticsByFile[canonical] = ret;
        return ret;
    }

    public getFunctionByName(name: string, file?: string): SymbolInformation {
        if (file) {
            const canonical = canonicalizePath(file);
            this.logPathResolution(`Looking up function ${name} in file: ${file} (canonical: ${canonical})`);

            const syms = this.staticFuncsMap[name];
            if (syms) {
                // Build search variants
                const searchVariants = new Set<string>([canonical, path.basename(canonical)]);
                const knownVariants = this.fileMap[canonical];
                if (knownVariants) {
                    knownVariants.forEach((v) => searchVariants.add(v));
                }

                // Try direct matches first
                for (const s of syms) {
                    if (s.file && searchVariants.has(s.file)) {
                        this.logPathResolution(`  Found static function ${name} via direct match: ${s.file}`);
                        return s;
                    }
                }

                // Try variant matches
                for (const s of syms) {
                    if (!s.file) continue;
                    const symFileVariants = this.fileMap[s.file];
                    if (symFileVariants) {
                        for (const variant of searchVariants) {
                            if (symFileVariants.includes(variant)) {
                                this.logPathResolution(`  Found static function ${name} via variant match: ${s.file} ~ ${variant}`);
                                return s;
                            }
                        }
                    }
                }
                this.logPathResolution(`  No static match found for ${name}, trying global scope`);
            }
        }

        // Fall back to global scope
        const ret = this.globalFuncsMap[name];
        if (ret) {
            this.logPathResolution(`  Found global function: ${name}`);
        }
        return ret;
    }

    public getGlobalOrStaticVarByName(name: string, file?: string): SymbolInformation {
        if (!file && this.rttSymbol && name === this.rttSymbolName) {
            return this.rttSymbol;
        }

        if (file) {
            // If a file is given only search for static variables by file
            const canonical = canonicalizePath(file);
            this.logPathResolution(`Looking up variable ${name} in file: ${file} (canonical: ${canonical})`);

            const searchVariants = new Set<string>([canonical, path.basename(canonical)]);
            const knownVariants = this.fileMap[canonical];
            if (knownVariants) {
                knownVariants.forEach((v) => searchVariants.add(v));
            }

            for (const s of this.staticVars) {
                if (s.name !== name || !s.file) continue;

                if (searchVariants.has(s.file)) {
                    this.logPathResolution(`  Found static variable ${name} in ${s.file}`);
                    return s;
                }

                const symFileVariants = this.fileMap[s.file];
                if (symFileVariants) {
                    for (const variant of searchVariants) {
                        if (symFileVariants.includes(variant)) {
                            this.logPathResolution(`  Found static variable ${name} via variant: ${s.file} ~ ${variant}`);
                            return s;
                        }
                    }
                }
            }
            this.logPathResolution(`  No static variable ${name} found in ${file}`);
            return null;
        }

        // Try globals first and then statics
        for (const s of this.globalVars.concat(this.staticVars)) {
            if (s.name === name) {
                this.logPathResolution(`Found ${s.scope === SymbolScope.Global ? "global" : "static"} variable: ${name}`);
                return s;
            }
        }

        return null;
    }

    /**
     * @deprecated Use canonicalizePath from common.ts instead
     */
    public static NormalizePath(pathName: string): string {
        return canonicalizePath(pathName);
    }

    private logPathResolution(message: string): void {
        if (this.gdbSession.args.debugFlags?.pathResolution) {
            this.gdbSession.handleMsg(Stderr, `[PathRes] ${message}\n`);
        }
    }
}
