// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Display formatting for live-watch values, shared by the VS Code panel and the CLI.
//
// Formatting is done here, on gdb's natural-format value, rather than with `-var-set-format`:
// gdb applies a varobj's format to that varobj only, never to its children (checked with gdb 1.22
// MI, in either order), so a struct watched as hex would still show every field in decimal.
//
// Only an integer is reformatted. Whatever is not -- floats, enums, booleans, `{...}`, `<errors>` --
// passes through unchanged, so "hex" means "integers in hex" and floats stay floats.

export type LiveWatchFormat = "natural" | "hex" | "decimal" | "binary" | "octal";

// A leading decimal or hex integer that ends the value or is followed by a space: `42`, `-5`,
// `0x2000`, `6 '\006'` (a uint8_t/char), `0x20000400 <buf+12>` (a pointer). Not `3.5`, not `1e5`.
const LEADING_INT = /^(-?\d+|0x[0-9a-f]+)(?=\s|$)/i;

/**
 * Reformat `value` (gdb natural format) as `format`.
 *
 * `sizeof` sizes negative numbers (two's complement) and hex/binary padding; when unknown, 4 bytes,
 * or 8 if the number does not fit in 32 bits. The text after the number is kept -- the character
 * of `65 'A'`, the symbol of `0x20000400 <buf+12>` -- so formatting never loses information.
 */
export function formatLiveValue(value: string, format: LiveWatchFormat | undefined, sizeof?: number): string {
    if (!format || format === "natural") {
        return value;
    }
    const m = LEADING_INT.exec(value);
    if (!m) {
        return value;
    }
    const n = BigInt(m[1]);
    const rest = value.slice(m[1].length);
    const bytes = sizeof && sizeof > 0 ? sizeof : n >= -(1n << 31n) && n < 1n << 32n ? 4 : 8;
    const bits = bytes * 8;
    // Two's complement, so -5 in an int32 reads 0xfffffffb rather than 0x-5.
    const unsigned = BigInt.asUintN(bits, n);
    switch (format) {
        case "hex":
            return "0x" + unsigned.toString(16).padStart(bytes * 2, "0") + rest;
        case "binary":
            return "0b" + unsigned.toString(2).padStart(bits, "0") + rest;
        case "octal":
            return "0o" + unsigned.toString(8) + rest;
        case "decimal":
            // A negative stays negative; a hex value (a pointer) becomes its decimal address.
            return n.toString(10) + rest;
        default:
            return value;
    }
}
