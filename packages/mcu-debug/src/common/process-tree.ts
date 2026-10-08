// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Stopping a gdb-server *and everything it started*. Killing only the direct child leaves its own
// children behind: pyavrocd starts `simavr`, and once pyavrocd was gone simavr kept the gdb port open,
// orphaned, for as long as nobody noticed.
//
// The proxy (mdbg common/process.rs) solves this with a process group of the gdb-server's own. Here
// that would mean `spawn({ detached: true })`, which on Unix is `setsid` -- a new *session*, not just
// a group -- so a gdb-server started by the CLI in a terminal would stop getting the terminal's hangup
// when the window closes. Walking the process tree instead keeps the terminal behaviour as it was.

import * as child_process from "child_process";

/** Every descendant of `pid` (not `pid` itself), parents before their children. Unix only. */
export function descendantsOf(pid: number): number[] {
    let table: string;
    try {
        table = child_process.execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    } catch {
        return []; // no `ps`: fall back to the direct child only
    }
    const children = new Map<number, number[]>();
    for (const line of table.split("\n")) {
        const [p, pp] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(p) && Number.isInteger(pp)) {
            children.set(pp, [...(children.get(pp) ?? []), p]);
        }
    }
    const found: number[] = [];
    const queue = [...(children.get(pid) ?? [])];
    while (queue.length > 0) {
        const p = queue.shift()!;
        found.push(p);
        queue.push(...(children.get(p) ?? []));
    }
    return found;
}

function signal(pid: number, sig: NodeJS.Signals) {
    try {
        process.kill(pid, sig);
    } catch {
        // ESRCH: already gone, which is the point.
    }
}

/**
 * Stop `child` and its descendants: SIGTERM to all of them, so a gdb-server can release the probe and
 * stop its own children; then SIGKILL, after `graceMs`, to whatever is still there.
 *
 * The tree is read *before* anything is signalled: once the parent dies its children are re-parented
 * to init and can no longer be found from it. Something started during the grace period is missed --
 * a narrow window during teardown. On Windows only the direct child is stopped (a Job Object would be
 * the equivalent there).
 */
export function terminateProcessTree(child: child_process.ChildProcess, graceMs = 1000): void {
    const pid = child.pid;
    if (!pid || process.platform === "win32") {
        child.kill();
        return;
    }
    const tree = [pid, ...descendantsOf(pid)];
    for (const p of tree) {
        signal(p, "SIGTERM");
    }
    const timer = setTimeout(() => {
        for (const p of tree) {
            signal(p, "SIGKILL");
        }
    }, graceMs);
    timer.unref(); // teardown must never be what keeps this process alive
}
