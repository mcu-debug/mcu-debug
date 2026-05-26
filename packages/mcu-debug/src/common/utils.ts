import * as net from "net";

export function hexFormat(value: number, padding: number = 8, includePrefix: boolean = true): string {
    let base = (value >>> 0).toString(16);
    base = base.padStart(padding, "0");
    return includePrefix ? "0x" + base : base;
}

export function hexFormat64(value: bigint, padding: number = 16, includePrefix: boolean = true): string {
    let base = value.toString(16);
    base = base.padStart(padding, "0");
    return includePrefix ? "0x" + base : base;
}

// Format as hex with 0x prefix - no padding to allow flexibility for 32/64-bit
export function formatAddress(addr: bigint): string {
    return "0x" + addr.toString(16);
}

// Format as hex with 0x prefix - no padding to allow flexibility for 32/64-bit
export function formatAddress64(addr: bigint): string {
    return "0x" + addr.toString(16).padStart(16, "0");
}

// Format as hex with 0x prefix - no padding to allow flexibility for 32/64-bit
export function formatAddress32(addr: bigint): string {
    return "0x" + addr.toString(16).padStart(8, "0");
}

// Parse memory reference per DAP spec: "0x" prefix = hex, no prefix = decimal

export function parseAddress(addr: string): bigint {
    const trimmed = addr.trim();
    // BigInt handles both "0x..." (hex) and plain numbers (decimal)
    return BigInt(trimmed);
}

export function parseAddressCleaned(addr: string): bigint {
    let trimmed = addr.trim().split(" ")[0]; // in case the address has extra info like "0x1234: someFunc+5"
    trimmed = trimmed.split(":")[0]; // in case the address has extra info like "0x1234: someFunc+5"
    // BigInt handles both "0x..." (hex) and plain numbers (decimal)
    return BigInt(trimmed);
}

export function parseBigint(value: string): bigint {
    return parseAddress(value);
}

// Convert any address representation (number, hex/decimal string, or already-bigint) to bigint.
export function parseAddrVal(val: number | string | bigint): bigint {
    if (typeof val === "bigint") { return val; }
    if (typeof val === "number") { return BigInt(val); }
    return parseAddress(val);
}

export function binaryFormat(value: number, padding: number = 0, includePrefix: boolean = true, group: boolean = false): string {
    let base = (value >>> 0).toString(2);
    while (base.length < padding) {
        base = "0" + base;
    }

    if (group) {
        const nibRem = 4 - (base.length % 4);
        for (let i = 0; i < nibRem; i++) {
            base = "0" + base;
        }
        const groups = base.match(/[01]{4}/g);
        base = groups!.join(" ");

        base = base.substring(nibRem);
    }

    return includePrefix ? "0b" + base : base;
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

export function parseInteger(value: string): number {
    if (/^0b([01]+)$/i.test(value)) {
        return parseInt(value.substring(2), 2);
    }
    if (/^0x([0-9a-f]+)$/i.test(value)) {
        return parseInt(value.substring(2), 16);
    }
    if (/^[0-9]+/i.test(value)) {
        return parseInt(value, 10);
    }
    if (/^#[0-1]+/i.test(value)) {
        return parseInt(value.substring(1), 2);
    }
    return 0;
}

export function parseDimIndex(spec: string, count: number): string[] {
    if (spec.indexOf(",") !== -1) {
        const components = spec.split(",").map((c) => c.trim());
        if (components.length !== count) {
            throw new Error("dimIndex Element has invalid specification.");
        }
        return components;
    }

    if (/^([0-9]+)-([0-9]+)$/i.test(spec)) {
        const parts = spec.split("-").map((p) => parseInteger(p));
        const start = parts[0];
        const end = parts[1];

        const numElements = end - start + 1;
        if (numElements < count) {
            throw new Error("dimIndex Element has invalid specification.");
        }

        const components: string[] = [];
        for (let i = 0; i < count; i++) {
            components.push(`${start + i}`);
        }

        return components;
    }

    if (/^[a-zA-Z]-[a-zA-Z]$/.test(spec)) {
        const start = spec.charCodeAt(0);
        const end = spec.charCodeAt(2);

        const numElements = end - start + 1;
        if (numElements < count) {
            throw new Error("dimIndex Element has invalid specification.");
        }

        const components: string[] = [];
        for (let i = 0; i < count; i++) {
            components.push(String.fromCharCode(start + i));
        }

        return components;
    }

    return [];
}

/** Attempt a TCP connection to host:port within timeoutMs. Returns true if the connection
 *  succeeds (socket connected), false on any error or timeout. Used to pre-flight the
 *  WSL NAT proxy path while we still have access to the VS Code UI. */
export function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, timeoutMs);
        socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

export class LineBuffer {
    private buf = '';
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private source: string,
        private emit: (source: string, line: string) => void,
        private readonly TIMEOUT_MS = 20
    ) { }

    push(chunk: string): void {
        this.buf += chunk;
        // Flush on every complete line
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
            const line = this.buf.slice(0, nl).replace(/\r$/, ''); // strip \r from \r\n
            this.buf = this.buf.slice(nl + 1);
            if (line.length > 0) this.emit(this.source, line);
        }
        // Arm timer for trailing data without \n
        if (this.buf.length > 0 && !this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                if (this.buf.length > 0) {
                    this.emit(this.source, this.buf);
                    this.buf = '';
                }
            }, this.TIMEOUT_MS);
        }
    }

    flush(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.buf.length > 0) { this.emit(this.source, this.buf); this.buf = ''; }
    }
}

export function trimBrackets(str: string): string {
    return str.replace(/^\s*[\[\{(]+/, '').replace(/[\]\}\)]+\s*$/, '');
}
