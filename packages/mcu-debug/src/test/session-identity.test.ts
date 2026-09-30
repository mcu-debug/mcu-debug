// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// The session's opening lines, which exist to answer "am I talking to what I just built".
//
// Worth pinning because the whole value is in the warning firing. Three separate stale-process
// hunts preceded this -- a daemonised Agent on a replaced binary, a suspected stale VSIX, and
// `"debugServer"` attaching to a hours-old adapter -- and in all three every version string agreed.
// A test that only checked the happy path would not have caught any of them.

import test from "node:test";
import assert from "node:assert/strict";

import { adapterIdentityLine, agentIdentityLine, fmtDuration, FRESH_ADAPTER_SECONDS } from "../adapter/session-identity";

function adapter(over: Partial<Parameters<typeof adapterIdentityLine>[0]> = {}) {
    return adapterIdentityLine({ version: "0.1.18", build: "abc1234", pid: 31022, uptimeSec: 2, sessionCount: 1, ...over });
}

function agent(over: Partial<Parameters<typeof agentIdentityLine>[0]> = {}) {
    return agentIdentityLine({ version: "0.1.18", build: "abc1234", pid: 24992, ourVersion: "0.1.18", ourBuild: "abc1234", ...over });
}

test("a freshly started adapter names itself and says nothing more", () => {
    const line = adapter();
    assert.match(line, /MCU-Debug 0\.1\.18 \(abc1234\)/);
    assert.match(line, /debug adapter, pid 31022, up 2s\./);
    assert.doesNotMatch(line, /NOTE/, "a normal session must not carry a warning");
});

test("an adapter that has been up for hours is flagged, and debugServer named", () => {
    // The real cause, and the one no version string could reveal: VS Code attached to an adapter
    // that had been running for hours under the debugger, from older code.
    const line = adapter({ uptimeSec: 15_120 });
    assert.match(line, /up 4h 12m/);
    assert.match(line, /already running/);
    assert.match(line, /debugServer/);
});

test("a second session in one process is flagged even when it is young", () => {
    // An adapter started per session never sees two, so the count alone is conclusive -- and it
    // fires on a session that began seconds ago, where uptime would not.
    const line = adapter({ uptimeSec: 3, sessionCount: 2 });
    assert.match(line, /session #2 in this process/);
    assert.match(line, /already running/);
});

test("the first session through a reused adapter is caught by uptime alone", () => {
    // The complement: count is 1, so only the clock gives it away. Both signals are needed.
    assert.match(adapter({ uptimeSec: FRESH_ADAPTER_SECONDS + 1 }), /already running/);
    assert.doesNotMatch(adapter({ uptimeSec: FRESH_ADAPTER_SECONDS }), /already running/);
});

test("an Agent of the same version and build is reported plainly", () => {
    const line = agent();
    assert.match(line, /MCU-Debug 0\.1\.18 \(abc1234\) — proxy \(the Probe Agent\), pid 24992\./);
    assert.doesNotMatch(line, /NOTE|MISMATCH/);
});

test("same version, different build is the reused-daemon signature and says how to clear it", () => {
    // Exactly the case the version check cannot see, because both sides are the same release.
    const line = agent({ build: "0011223" });
    assert.match(line, /same version, different build/);
    assert.match(line, /the debug adapter is abc1234/);
    assert.match(line, /--shutdown --instance/);
});

test("`+dirty` alone is not a mismatch", () => {
    // Both sides are normally built from one tree, so both carry it together and it says nothing
    // about whether the commits agree. Flagging it would cry wolf on every dev session.
    assert.doesNotMatch(agent({ build: "abc1234+dirty", ourBuild: "abc1234" }), /NOTE/);
    assert.doesNotMatch(agent({ build: "abc1234", ourBuild: "abc1234+dirty" }), /NOTE/);
    assert.match(agent({ build: "abc1234+dirty", ourBuild: "0011223+dirty" }), /different build/);
});

test("a version mismatch is called out as such, not as a build difference", () => {
    const line = agent({ version: "0.1.17", build: "0011223" });
    assert.match(line, /MISMATCH/);
    assert.doesNotMatch(line, /different build/, "the version is the fatal one; do not bury it");
});

test("an Agent that predates the build field is not accused of anything", () => {
    const line = agent({ build: "" });
    assert.match(line, /build unknown/);
    assert.doesNotMatch(line, /NOTE/, "an absent field is not a mismatch we can assert");
});

test("durations stay readable at both ends of the range", () => {
    // 4h 12m must not be mistakable for 4s, which is the entire diagnostic.
    assert.equal(fmtDuration(0), "0s");
    assert.equal(fmtDuration(2.7), "2s");
    assert.equal(fmtDuration(59), "59s");
    assert.equal(fmtDuration(60), "1m 0s");
    assert.equal(fmtDuration(3599), "59m 59s");
    assert.equal(fmtDuration(3600), "1h 0m");
    assert.equal(fmtDuration(15_120), "4h 12m");
    assert.equal(fmtDuration(-5), "0s");
});

test("the two lines name their roles, so neither can be read as the other", () => {
    // They are two processes of one product, lockstep-versioned, and the codebase calls the second
    // "Probe Agent", "Proxy Agent" and "proxy server" in roughly equal measure -- so the role has to
    // be in the text rather than left to the reader.
    const a = adapterIdentityLine({ version: "0.1.18", build: "abc1234", pid: 1, uptimeSec: 1, sessionCount: 1 });
    const p = agentIdentityLine({ version: "0.1.18", build: "abc1234", pid: 2, ourVersion: "0.1.18", ourBuild: "abc1234" });
    assert.match(a, /debug adapter/);
    assert.doesNotMatch(a, /proxy/i, "the adapter line must not mention the proxy at all");
    assert.match(p, /proxy/);
    assert.doesNotMatch(p, /debug adapter/, "...and vice versa, in the clean case");
    // Same leading prefix, so a version difference between the two is visible side by side.
    assert.ok(a.startsWith("MCU-Debug 0.1.18 (abc1234)") && p.startsWith("MCU-Debug 0.1.18 (abc1234)"));
});
