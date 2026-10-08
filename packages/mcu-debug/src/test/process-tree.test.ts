// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Stopping a gdb-server must stop what it started: pyavrocd's simavr outlived a plain `kill()` and kept
// the gdb port. The shape here is the same -- a child that starts its own child and waits on it.

import test from "node:test";
import assert from "node:assert/strict";
import * as child_process from "node:child_process";

import { descendantsOf, terminateProcessTree } from "../common/process-tree";

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function until(cond: () => boolean, ms: number) {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
    }
}

test("a grandchild dies with its parent", { skip: process.platform === "win32" }, async () => {
    const child = child_process.spawn("sh", ["-c", "sleep 60 & echo $!; wait"], { stdio: "pipe" });
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    assert.ok(alive(grandchild), "grandchild should be running");
    assert.ok(descendantsOf(child.pid!).includes(grandchild), "the tree walk must find the grandchild");

    terminateProcessTree(child, 200);

    await until(() => !alive(grandchild), 2000);
    assert.ok(!alive(grandchild), "the grandchild outlived its parent");
});
