// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// Persistence for the CLI's `!!watch` and `!!live-watch` lists: `.mcu-debug/<config>.watch.json`.
//
// One file per launch config, like `<config>.bkpts`, because expressions depend on the ELF -- the two
// cores of a dual-core project have different globals. It is keyed by the config's *name*, so renaming
// a config orphans its file; renaming the file to match brings the watches back.
//
// Written on every change, atomically (temp file + rename), never only at exit: a session that is
// killed, or a laptop that sleeps through it, must not lose the list. Not shared with the VS Code
// panel, which keeps its own list in the workspace state and evolves separately.

import * as fs from "node:fs";
import * as path from "node:path";

export type WatchKind = "watch" | "liveWatch";

/** What is persisted per root: everything needed to rebuild it, nothing about its values. */
export interface WatchRootSpec {
    id: number;
    expr: string;
    depth: number;
    format: "natural" | "hex";
    quiet: boolean;
}

interface WatchFile {
    version: 1;
    watch: WatchRootSpec[];
    liveWatch: WatchRootSpec[];
}

export class WatchStore {
    public readonly file: string;

    constructor(configName: string, dir = path.join(process.cwd(), ".mcu-debug")) {
        // Same sanitizing as the breakpoints file, so the two sit side by side with the same stem.
        const safe = configName.replace(/[^a-zA-Z0-9-_]/g, "_");
        this.file = path.join(dir, `${safe}.watch.json`);
    }

    /** Roots of one kind. A missing or unreadable file is an empty list, never an error. */
    public load(kind: WatchKind): WatchRootSpec[] {
        return this.read()[kind];
    }

    /** Replace one kind's roots, keeping the other kind's as they are on disk. */
    public save(kind: WatchKind, roots: WatchRootSpec[]): void {
        const data = this.read();
        if (this.unparsable) {
            // A hand edit broke the JSON. Saving would replace the other kind's list with the empty
            // one read() fell back to, so keep the broken file for the user to recover from.
            fs.copyFileSync(this.file, `${this.file}.bad`);
        }
        data[kind] = roots;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 4) + "\n");
        fs.renameSync(tmp, this.file);
    }

    /** Set by the last read when the file exists but is not valid JSON. */
    public unparsable = false;

    private read(): WatchFile {
        this.unparsable = false;
        let text: string;
        try {
            text = fs.readFileSync(this.file, "utf8");
        } catch {
            return { version: 1, watch: [], liveWatch: [] }; // no file yet
        }
        try {
            const data = JSON.parse(text);
            return { version: 1, watch: toSpecs(data?.watch), liveWatch: toSpecs(data?.liveWatch) };
        } catch {
            this.unparsable = true;
            return { version: 1, watch: [], liveWatch: [] };
        }
    }
}

/**
 * Hand-edited files are expected. An entry needs an id and an expression; anything else missing or
 * invalid gets its default, and an entry without even those is skipped rather than failing the load.
 */
function toSpecs(list: unknown): WatchRootSpec[] {
    if (!Array.isArray(list)) {
        return [];
    }
    const specs: WatchRootSpec[] = [];
    for (const x of list) {
        if (!Number.isInteger(x?.id) || x.id <= 0 || typeof x?.expr !== "string" || !x.expr.trim()) {
            continue;
        }
        specs.push({
            id: x.id,
            expr: x.expr.trim(),
            depth: Number.isInteger(x.depth) && x.depth >= 0 ? x.depth : 1,
            format: x.format === "hex" ? "hex" : "natural",
            quiet: x.quiet === true,
        });
    }
    return specs;
}
