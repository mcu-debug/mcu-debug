import test from "node:test";
import assert from "node:assert/strict";
import { parseFloat, parseQ, parseSigned, parseUQ, parseUnsigned } from "../common/swo/decoders/utils";

test("parseSigned decodes 32-bit little-endian values", () => {
    const buffer = Buffer.from([0xfe, 0xff, 0xff, 0xff]);

    assert.equal(parseSigned(buffer), -2);
});

test("parseUnsigned decodes 32-bit little-endian values", () => {
    const buffer = Buffer.from([0xfe, 0xff, 0xff, 0xff]);

    assert.equal(parseUnsigned(buffer), 0xfffffffe);
});

test("parseFloat decodes 32-bit little-endian values", () => {
    const buffer = Buffer.from([0x00, 0x00, 0xc0, 0x3f]);

    assert.equal(parseFloat(buffer), 1.5);
});

test("parseSigned zero-pads short buffers", () => {
    const buffer = Buffer.from([0x34, 0x12]);

    assert.equal(parseSigned(buffer), 0x1234);
});

test("parseUnsigned zero-pads short buffers", () => {
    const buffer = Buffer.from([0x34, 0x12]);

    assert.equal(parseUnsigned(buffer), 0x1234);
});

test("parseFloat zero-pads short buffers", () => {
    const buffer = Buffer.from([0x00]);

    assert.equal(parseFloat(buffer), 0);
});

test("parseQ decodes Q16_16 positive values", () => {
    const buffer = Buffer.from([0x00, 0x80, 0x01, 0x00]);

    assert.equal(parseQ(buffer, 0xffff, 16), 1.5);
});

test("parseQ decodes Q16_16 negative values", () => {
    const buffer = Buffer.from([0x00, 0x80, 0xfe, 0xff]);

    assert.equal(parseQ(buffer, 0xffff, 16), -1.5);
});

test("parseQ decodes Q8_24 fractional values", () => {
    const buffer = Buffer.from([0x00, 0x00, 0x80, 0x00]);

    assert.equal(parseQ(buffer, 0xffffff, 24), 0.5);
});

test("parseUQ decodes UQ24_8 values", () => {
    const buffer = Buffer.from([0x80, 0x01, 0x00, 0x00]);

    assert.equal(parseUQ(buffer, 0xff, 8), 1.5);
});

test("parseUQ decodes UQ8_24 values", () => {
    const buffer = Buffer.from([0x00, 0x00, 0x40, 0x00]);

    assert.equal(parseUQ(buffer, 0xffffff, 24), 0.25);
});
