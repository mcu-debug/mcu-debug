// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// The parts of `!!watch` / `!!live-watch` that need no target: the watch file, and the shared core
// driven through a fake transport. The transports themselves (DA requests) need a board.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GdbProtocolVariable } from "../adapter/custom-requests";
import { CliWatchOptions } from "../adapter/servers/common";
import { EvalResult, LIVE_WATCH_DEFAULTS, resolveWatchOptions, WATCH_DEFAULTS, WatchNode, WatchProviderBase } from "../cli/cli-watch-core";
import { WatchStore } from "../cli/cli-watch-store";

function tmpStore(): WatchStore {
    return new WatchStore("My Config", fs.mkdtempSync(path.join(os.tmpdir(), "watch-store-")));
}

// ---- store -------------------------------------------------------------------------------------

test("store: file is named after the sanitized config name", () => {
    assert.match(tmpStore().file, /My_Config\.watch\.json$/);
});

test("store: saving one kind keeps the other", () => {
    const store = tmpStore();
    store.save("watch", [{ id: 1, expr: "a", depth: 1, format: "natural", quiet: false }]);
    store.save("liveWatch", [{ id: 4, expr: "b", depth: 2, format: "hex", quiet: true }]);
    assert.deepEqual(
        store.load("watch").map((r) => r.expr),
        ["a"],
    );
    assert.deepEqual(store.load("liveWatch"), [{ id: 4, expr: "b", depth: 2, format: "hex", quiet: true }]);
});

test("store: hand-edited entries get defaults; unusable ones are skipped", () => {
    const store = tmpStore();
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, JSON.stringify({ watch: [{ id: 2, expr: " x " }, { id: 0, expr: "bad id" }, { id: 3 }, "junk"] }));
    assert.deepEqual(store.load("watch"), [{ id: 2, expr: "x", depth: 1, format: "natural", quiet: false }]);
});

test("store: a broken file is kept as .bad before it is overwritten", () => {
    const store = tmpStore();
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, "{ not json");
    store.save("watch", []);
    assert.equal(fs.readFileSync(`${store.file}.bad`, "utf8"), "{ not json");
    assert.equal(store.unparsable, true);
});

// ---- core, through a fake transport ------------------------------------------------------------

type Rec = { msg: string; meta: any };

/** Variables by expression/path; children by parent path. */
class FakeProvider extends WatchProviderBase {
    ready = true;
    vars = new Map<string, GdbProtocolVariable>();
    kids = new Map<string, GdbProtocolVariable[]>();
    failures = new Map<string, EvalResult["failure"]>();
    records: Rec[] = [];

    constructor(store: WatchStore, options: CliWatchOptions = {}) {
        super("!!watch", "watch", store, options, WATCH_DEFAULTS, "TEST");
        const sink = (msg: string, meta: any = {}) => this.records.push({ msg, meta });
        (this as any).out = { info: sink, warn: sink, error: sink };
    }
    protected async notReadyReason() {
        return this.ready ? undefined : "not ready";
    }
    protected async evaluate(expr: string): Promise<EvalResult> {
        const v = this.vars.get(expr);
        return v ? { variable: v, gdbName: `var-${expr}` } : { failure: this.failures.get(expr) ?? { state: "unavailable", reason: "No such thing" } };
    }
    protected async children(node: WatchNode) {
        return this.kids.get(node.path) ?? [];
    }
    protected async release() {}
    protected helpNotes() {
        return [];
    }
    stop() {
        this.records = [];
        this.printAtStop();
        return this.records;
    }
    rootList() {
        return [...this.roots.values()];
    }
}

function v(name: string, value: string, extra: Partial<GdbProtocolVariable> = {}): GdbProtocolVariable {
    return { name, evaluateName: name, value, variablesReference: 0, ...extra } as GdbProtocolVariable;
}

function motor(p: FakeProvider) {
    p.vars.set("motor", v("motor", "{...}", { variablesReference: 7, numchild: 2 }));
    p.kids.set("motor", [v("motor.speed", "100"), v("motor.state", "IDLE")]);
}

test("core: add expands to the default depth, numbers roots, and persists", async () => {
    const store = tmpStore();
    const p = new FakeProvider(store);
    motor(p);
    assert.equal(await p.handleCommand("add motor"), true);
    const root = p.rootList()[0];
    assert.equal(root.id, 1);
    assert.deepEqual(
        root.node!.children.map((c) => `${c.path}=${c.value}`),
        ["motor.speed=100", "motor.state=IDLE"],
    );
    assert.deepEqual(store.load("watch"), [{ id: 1, expr: "motor", depth: 1, format: "natural", quiet: false }]);
});

test("core: ids continue after restored ones and are never reused", async () => {
    const store = tmpStore();
    store.save("watch", [{ id: 5, expr: "a", depth: 0, format: "natural", quiet: false }]);
    const p = new FakeProvider(store);
    p.vars.set("b", v("b", "1"));
    await p.handleCommand("add b");
    await p.handleCommand("delete 6");
    await p.handleCommand("add b");
    assert.deepEqual(
        p.rootList().map((r) => r.id),
        [5, 7],
    );
});

test("core: ',x' and --hex set hex; the suffix is not part of the expression", async () => {
    const p = new FakeProvider(tmpStore());
    p.vars.set("n", v("n", "255", { sizeof: 1 } as any));
    await p.handleCommand("add n,x");
    assert.equal(p.rootList()[0].expr, "n");
    assert.equal(p.rootList()[0].format, "hex");
    assert.ok(p.records.some((r) => r.meta.value === "0xff"));
});

test("core: a failed evaluation is rejected; out-of-scope is kept", async () => {
    const p = new FakeProvider(tmpStore());
    assert.equal(await p.handleCommand("add typo"), false);
    p.failures.set("local_i", { state: "out-of-scope", reason: 'No symbol "local_i" in current context.' });
    assert.equal(await p.handleCommand("add local_i"), true);
    assert.deepEqual(
        p.rootList().map((r) => r.expr),
        ["local_i"],
    );
});

test("core: when not ready, add keeps the root as unavailable, with the reason", async () => {
    const p = new FakeProvider(tmpStore());
    p.ready = false;
    assert.equal(await p.handleCommand("add later"), true);
    const rec = p.records.find((r) => r.meta.path === "later")!;
    assert.equal(rec.meta.state, "unavailable");
    assert.equal(rec.meta.reason, "not ready");
});

test("core: a node whose children exceed the budget is left unexpanded, not partly listed", async () => {
    const p = new FakeProvider(tmpStore());
    p.vars.set("buf", v("buf", "[512]", { variablesReference: 3, numchild: 512 }));
    await p.handleCommand("add buf");
    const node = p.rootList()[0].node!;
    assert.equal(node.notExpanded, true);
    assert.equal(node.children.length, 0);
    assert.ok(p.records.some((r) => /512 values, not tracked/.test(r.msg)));
});

test("core: one record per value, the #id and indentation on the console only", async () => {
    const p = new FakeProvider(tmpStore(), { onStop: "tree" });
    motor(p);
    await p.handleCommand("add motor");
    const recs = p.stop();
    assert.deepEqual(
        recs.map((r) => r.msg),
        ["motor = {...}  [2 tracked]", "motor.speed = 100", "motor.state = IDLE"],
    );
    assert.deepEqual(
        recs.map((r) => r.meta.consolePrefix),
        ["#1 ", "   ", "   "],
    );
    assert.deepEqual(recs[1].meta, { consolePrefix: "   ", kind: "watch", watchId: 1, path: "motor.speed", value: "100", state: "current" });
});

test("core: onStop 'changes' reports everything once, then only what changed, with prev", async () => {
    const p = new FakeProvider(tmpStore());
    motor(p);
    await p.handleCommand("add motor");
    assert.equal(p.stop().length, 2); // first stop: every leaf is new
    p.kids.set("motor", [v("motor.speed", "120"), v("motor.state", "IDLE")]);
    await (p as any).trackRoot(p.rootList()[0]);
    const recs = p.stop();
    assert.deepEqual(
        recs.map((r) => r.msg),
        ["motor.speed = 120  (was 100)"],
    );
    assert.equal(recs[0].meta.prev, "100");
    assert.equal(p.stop().length, 0); // nothing changed since
});

test("core: quiet roots are never printed at a stop", async () => {
    const p = new FakeProvider(tmpStore(), { onStop: "tree" });
    motor(p);
    await p.handleCommand("add --quiet motor");
    assert.equal(p.stop().length, 0);
});

test("core: printing for a frame change does not move the stop baseline", async () => {
    const p = new FakeProvider(tmpStore());
    motor(p);
    await p.handleCommand("add motor");
    p.stop(); // baseline: speed 100
    // `up`: another frame's values are printed, but this is not a stop.
    p.kids.set("motor", [v("motor.speed", "7"), v("motor.state", "IDLE")]);
    await (p as any).trackRoot(p.rootList()[0]);
    (p as any).printAll("roots");
    // Next stop, back in the first frame with speed 120: compared with the last *stop* (100), not 7.
    p.kids.set("motor", [v("motor.speed", "120"), v("motor.state", "IDLE")]);
    await (p as any).trackRoot(p.rootList()[0]);
    assert.deepEqual(
        p.stop().map((r) => r.msg),
        ["motor.speed = 120  (was 100)"],
    );
});

// ---- defaults ------------------------------------------------------------------------------------

test("options: launch.json overrides field by field; null or missing keeps the default", () => {
    assert.deepEqual(resolveWatchOptions(undefined, WATCH_DEFAULTS), WATCH_DEFAULTS);
    assert.deepEqual(resolveWatchOptions({ defaultDepth: 3, onStop: null as any }, WATCH_DEFAULTS), { ...WATCH_DEFAULTS, defaultDepth: 3 });
});

test("options: the schema's documented defaults match the ones the code applies", () => {
    // package.json is generated from manifest-src/definitions.js, whose `default`s are documentation
    // only. This is what keeps them honest.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    let checked = 0;
    for (const dbg of pkg.contributes.debuggers) {
        for (const request of Object.values<any>(dbg.configurationAttributes ?? {})) {
            const cli = request.properties?.cliOptions?.properties;
            for (const [kind, defaults] of [
                ["watch", WATCH_DEFAULTS],
                ["liveWatch", LIVE_WATCH_DEFAULTS],
            ] as const) {
                for (const [key, schema] of Object.entries<any>(cli[kind].properties)) {
                    assert.ok(key in defaults, `cliOptions.${kind}.${key} is in the schema but has no default in code`);
                    assert.equal(schema.default, (defaults as any)[key], `cliOptions.${kind}.${key}`);
                    checked++;
                }
            }
        }
    }
    assert.ok(checked >= 7, `only ${checked} schema defaults found; did the schema move?`);
});
