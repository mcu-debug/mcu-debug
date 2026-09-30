// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0

//! Says, at the top of every session, which processes it is actually made of.
//!
//! This exists because of an evening lost to three false leads with one shape: *you are talking to
//! an older process than you think.* A daemonised Agent still serving a binary that had been
//! replaced on disk; a VSIX suspected of shipping stale binaries; and the real culprit,
//! `"debugServer"` in a `launch.json`, which makes VS Code **attach to an already-running debug
//! adapter** instead of starting one -- in that case an adapter that had been up for hours, under
//! the debugger, from older code. Every process involved reported the same version, 0.1.18, and
//! every one of them was wrong.
//!
//! So a version is not enough, and two things are added to it:
//!
//! - **The build** -- the commit, plus `+dirty`. `version` is bumped per release, so every build
//!   between two releases shares it, which is exactly the window in which a stale process is
//!   likeliest. The Agent reports its own on `initialize`, which is the strongest identity going,
//!   because it comes over the connection this session will actually use.
//! - **How long the process has been up.** A freshly started adapter is seconds old. One that says
//!   "4h 12m" was reused, and that is the whole `debugServer` story visible at a glance.
//!
//! Reported, never enforced. A build difference is ordinary mid-development and is usually
//! something to *see* rather than be stopped by; `version` remains the compatibility gate.

/** Compact and readable at both ends of the range, which is the point -- `4h 12m` must not read as `4s`. */
export function fmtDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) {
        return `${s}s`;
    }
    if (s < 3600) {
        return `${Math.floor(s / 60)}m ${s % 60}s`;
    }
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** An adapter younger than this was started for this session; older, and it was reused. */
export const FRESH_ADAPTER_SECONDS = 30;

export interface AdapterIdentity {
    version: string;
    build: string;
    pid: number;
    /** `process.uptime()`. */
    uptimeSec: number;
    /** How many sessions this adapter process has served, including this one. */
    sessionCount: number;
}

/**
 * The first line of a session: what this adapter is, and whether it is the one you just built.
 *
 * The warning fires on either signal, because they catch different cases. A second session in one
 * process is unambiguous -- an adapter started per session never sees two. But the *first* session
 * through a reused adapter has a count of 1, and only its uptime gives it away.
 */
export function adapterIdentityLine(id: AdapterIdentity): string {
    const reused = id.uptimeSec > FRESH_ADAPTER_SECONDS || id.sessionCount > 1;
    const nth = id.sessionCount > 1 ? `, session #${id.sessionCount} in this process` : "";
    let line = `MCU-Debug ${id.version} (${id.build}) — adapter pid ${id.pid}, up ${fmtDuration(id.uptimeSec)}${nth}.`;
    if (reused) {
        line +=
            ` NOTE: this adapter was already running, so it may predate your last build.` +
            ` That is what "debugServer" in launch.json does — VS Code attaches to an existing adapter instead of starting one.`;
    }
    return line;
}

export interface AgentIdentity {
    version: string;
    build: string;
    pid: number;
    /** What this side is, for comparison. */
    ourVersion: string;
    ourBuild: string;
}

/**
 * What the Agent on the other end of this session's connection is.
 *
 * The comparison is the reason for the line. A matching version with a differing build is the
 * signature of a daemon that never exited to pick up a rebuild -- `setDevelopmentModeEnvVars` gives
 * the `dev` instance `MDBG_PROXY_IDLE_TIMEOUT=0`, so it never does. The version check passes,
 * because both are the same release.
 */
export function agentIdentityLine(id: AgentIdentity): string {
    let line = `Probe Agent ${id.version} (${id.build || "build unknown"}) — pid ${id.pid}.`;
    if (id.version !== id.ourVersion) {
        // Already fatal elsewhere; named here too so the console shows why, in the same place as
        // everything else about this session's identity.
        line += ` MISMATCH: this adapter is ${id.ourVersion}. They must match exactly.`;
    } else if (id.build && id.ourBuild && stripDirty(id.build) !== stripDirty(id.ourBuild)) {
        line +=
            ` NOTE: same version, different build — this adapter is ${id.ourBuild}.` +
            ` The Agent is a singleton and a running one is reused, so a rebuild does not replace it;` +
            ` in dev mode it never exits on idle either. Shut it down to pick up your build: mdbg proxy --shutdown --instance <name>`;
    }
    return line;
}

/**
 * Compare builds by commit, ignoring `+dirty`.
 *
 * Both sides are usually built from one tree, so both carry `+dirty` together and it says nothing
 * about whether they match. What matters is the commit -- and flagging `abc123` against
 * `abc123+dirty` would cry wolf on every single dev session.
 */
function stripDirty(build: string): string {
    return build.replace(/\+dirty$/, "");
}
