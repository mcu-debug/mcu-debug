// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// The live-watch display formatter. The cases that matter are the ones gdb actually produces and the
// panel's old `BigInt(value)` threw on: a uint8_t (`6 '\006'`), a float, an enum, a negative number.

import test from "node:test";
import assert from "node:assert/strict";

import { formatLiveValue } from "../common/live-watch-format";

test("natural, or no format, returns gdb's value untouched", () => {
    assert.equal(formatLiveValue("42", "natural", 4), "42");
    assert.equal(formatLiveValue("42", undefined, 4), "42");
});

test("integers are padded to their size", () => {
    assert.equal(formatLiveValue("42", "hex", 4), "0x0000002a");
    assert.equal(formatLiveValue("42", "hex", 2), "0x002a");
    assert.equal(formatLiveValue("5", "binary", 1), "0b00000101");
});

test("negatives are two's complement at their size, not 0x-5", () => {
    assert.equal(formatLiveValue("-5", "hex", 4), "0xfffffffb");
    assert.equal(formatLiveValue("-1", "hex", 1), "0xff");
    assert.equal(formatLiveValue("-5", "decimal", 4), "-5");
});

test("a uint8_t keeps its character; this is the value gdb gives for one", () => {
    assert.equal(formatLiveValue("6 '\\006'", "hex", 1), "0x06 '\\006'");
    assert.equal(formatLiveValue("65 'A'", "hex", 1), "0x41 'A'");
});

test("a pointer keeps its symbol", () => {
    assert.equal(formatLiveValue("0x20000400 <buf+12>", "hex", 4), "0x20000400 <buf+12>");
    assert.equal(formatLiveValue("0x10", "decimal", 4), "16");
});

test("anything that is not an integer passes through", () => {
    for (const v of ["3.5", "1e5", "-0.25", "RUNNING", "true", "{...}", "<out of scope>", "", "0x"]) {
        assert.equal(formatLiveValue(v, "hex", 4), v, v);
    }
});

test("without a size, 32 bits unless the number needs 64", () => {
    assert.equal(formatLiveValue("-5", "hex"), "0xfffffffb");
    assert.equal(formatLiveValue("4294967296", "hex"), "0x0000000100000000");
});
