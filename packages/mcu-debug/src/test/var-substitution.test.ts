// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Variable substitution, and specifically the two things that are easy to get wrong together.
//
// A variable's value may itself be a template -- `builtins.executable` is seeded from the raw
// `config.executable`, which is `"${workspaceFolder}/target/app.elf"`. `String.replace` never
// re-examines the text it inserts, so a single pass left that reference standing.
//
// Running the whole substitution twice appears to fix it and must not be used, because the second
// pass also re-runs the *escape* rules. That is what these tests pin: nesting resolves in one pass,
// and escapes are processed exactly once.

import test from "node:test";
import assert from "node:assert/strict";

import { processVarSubstitution, resolveVarMap } from "../adapter/servers/common";

test("a value that is itself a template resolves in one pass", () => {
    // The reported bug, reduced. `${executable}` expands to a value containing `${workspaceFolder}`,
    // which the document pass can never see because it is text `replace` just inserted.
    const vars = {
        workspaceFolder: "/ws",
        executable: "${workspaceFolder}/target/app.elf",
    };
    const out = processVarSubstitution('{"args":["-e","${executable}"]}', vars, "");
    assert.equal(out, '{"args":["-e","/ws/target/app.elf"]}');
    assert.doesNotMatch(out, /\$\{/, "nothing may be left for a second pass");
});

test("nesting resolves to any depth", () => {
    const vars = { A: "/root", B: "${A}/b", C: "${B}/c", D: "${C}/d" };
    assert.equal(processVarSubstitution("${D}", vars, ""), "/root/b/c/d");
});

test("one pass is now a fixed point, which is what makes a second pass unnecessary", () => {
    // Stated as a property rather than a value: the guarantee is that no caller ever needs to run
    // this twice, because running it twice is destructive (see the escape tests below).
    const vars = { workspaceFolder: "/ws", executable: "${workspaceFolder}/app", cwd: "${workspaceFolder}" };
    const doc = JSON.stringify({ cwd: "${cwd}", exe: "${executable}", nested: ["${executable}"] });
    const once = processVarSubstitution(doc, vars, "");
    assert.equal(processVarSubstitution(once, vars, ""), once);
});

test("escapes are processed exactly once, and a second pass would corrupt them", () => {
    // Each of these is stable only because the first pass is sufficient. The assertions on the
    // second pass are the warning, kept executable: this is what "just run it twice" costs.
    const vars = { VAR: "VALUE" };
    const pass = (s: string) => processVarSubstitution(s, vars, "");

    // A literal backslash survives; a second pass would eat it.
    assert.equal(pass("C:\\\\new"), "C:\\new");
    // Worse than losing it: the surviving backslash pairs with the `n` and becomes a newline.
    assert.equal(pass(pass("C:\\\\new")), "C:\new", "a second pass turns the path into a newline");

    // An escaped reference stays literal -- and a second pass defeats the escape entirely, which is
    // the worst of the three: the text written precisely to prevent substitution gets substituted.
    assert.equal(pass("\\${VAR}"), "${VAR}");
    assert.equal(pass(pass("\\${VAR}")), "VALUE", "a second pass substitutes what was escaped");
});

test("references inside values are expanded without applying escape rules to them", () => {
    // Values are data. On Windows they are full of backslashes, and running escape rules over
    // `C:\Users\me\new` would turn `\n` into a newline and eat the rest.
    const vars = resolveVarMap({ W: "C:\\Users\\me\\new\\target", P: "${W}\\app.elf" }, "");
    assert.equal(vars.W, "C:\\Users\\me\\new\\target");
    assert.equal(vars.P, "C:\\Users\\me\\new\\target\\app.elf");
});

test("a self-reference is left exactly as authored, and reported", () => {
    const warnings: string[] = [];
    const vars = resolveVarMap({ A: "${A}/x" }, "", (m) => warnings.push(m));
    assert.equal(vars.A, "${A}/x", "not half-expanded into ${A}/x/x");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /refers to itself/);
});

test("every member of a longer cycle is left as authored, not just the first", () => {
    // The subtle half: once A is recorded with its authored text, B must not mistake that text for a
    // resolution and build on it. B used to come back as "${B}/a/b".
    const warnings: string[] = [];
    const vars = resolveVarMap({ A: "${B}/a", B: "${A}/b" }, "", (m) => warnings.push(m));
    assert.equal(vars.A, "${B}/a");
    assert.equal(vars.B, "${A}/b");
    assert.equal(warnings.length, 2, "both names are unresolvable and both are said so");
});

test("a name that merely points at a cycle is not itself poisoned for unrelated lookups", () => {
    const vars = resolveVarMap({ A: "${A}", ok: "/fine", uses: "${ok}/x" }, "");
    assert.equal(vars.ok, "/fine");
    assert.equal(vars.uses, "/fine/x");
});

test("a missing variable is left in place and reported, from a value as well as the document", () => {
    const fromDoc: string[] = [];
    assert.equal(
        processVarSubstitution("${nope}", {}, "", (m) => fromDoc.push(m)),
        "${nope}",
    );
    assert.equal(fromDoc.length, 1);

    const fromValue: string[] = [];
    const vars = resolveVarMap({ A: "${nope}/x" }, "", (m) => fromValue.push(m));
    assert.equal(vars.A, "${nope}/x");
    assert.equal(fromValue.length, 1, "a dangling reference inside a value is worth the same warning");
});

test("a prefix confines both the document pass and the value pass", () => {
    // `${env:FOO}` must not be read as a bare variable named "env:FOO", and the same rule has to
    // hold when expanding values or a prefixed map would resolve against the wrong names.
    assert.equal(processVarSubstitution("${env:FOO}", { FOO: "bare" }, ""), "${env:FOO}", "bare pass must skip prefixed refs");
    assert.equal(processVarSubstitution("${env:FOO}", { FOO: "prefixed" }, "env:"), "prefixed");
    const vars = resolveVarMap({ A: "${env:B}/a", B: "/b" }, "env:");
    assert.equal(vars.A, "/b/a");
});
