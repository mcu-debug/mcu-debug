// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
// `hostConfig.proxy` says "I started the Probe Agent myself; connect to it and detect
// nothing." These tests pin the rules that make that safe: it is all-or-nothing, the
// token may come from the environment, and nothing is ever silently defaulted.

import test from "node:test";
import assert from "node:assert/strict";

import { PROXY_TOKEN_ENV, resolveProxyOverride } from "../common/proxy";

/** `assert.throws` returns undefined, so capture the error to inspect its message. */
function caught(fn: () => unknown): Error {
    try {
        fn();
    } catch (e) {
        return e as Error;
    }
    throw new Error("expected the call to throw, but it returned normally");
}

const FULL = { host: "172.28.240.1", port: 55555, token: "s3cret" };

test("no override configured resolves to null, not an error", () => {
    // The overwhelmingly common case: nothing set, so normal detection proceeds.
    assert.equal(resolveProxyOverride(undefined, {}), null);
});

test("a complete override resolves to its endpoint", () => {
    assert.deepEqual(resolveProxyOverride(FULL, {}), FULL);
});

test("a partial override throws and names every missing field", () => {
    // The point of failing here is that each alternative fails much later and much less
    // clearly -- a connection timeout, or an auth rejection from the agent.
    const err = caught(() => resolveProxyOverride({ host: "10.0.0.5" }, {}));

    assert.match(err.message, /missing/i);
    assert.match(err.message, /port/, "names the missing port");
    assert.match(err.message, /token/, "names the missing token");
});

test("the token may come from the environment instead of the config", () => {
    // Keeps the secret out of source control; the agent reads the same variable, so one
    // export configures both ends.
    const resolved = resolveProxyOverride({ host: FULL.host, port: FULL.port }, { [PROXY_TOKEN_ENV]: "from-env" });

    assert.deepEqual(resolved, { ...FULL, token: "from-env" });
});

test("a ${env:...} reference is expanded, for hosts that do not preprocess it", () => {
    // VS Code substitutes these in launch.json before the adapter sees them; the CLI
    // does not, so the same config text has to work in both.
    const resolved = resolveProxyOverride({ ...FULL, token: "${env:MY_TOKEN}" }, { MY_TOKEN: "expanded" });

    assert.equal(resolved?.token, "expanded");
});

test("an unset ${env:...} reference is a missing token, not the literal string", () => {
    // Sending "${env:NOPE}" as the token would be rejected by the agent -- an auth
    // failure that says nothing about the real mistake.
    assert.throws(() => resolveProxyOverride({ ...FULL, token: "${env:NOPE}" }, {}), /token/);
});

test("the agent's built-in default token is never assumed", () => {
    // The proxy defaults to a well-known token when started without one. Filling that in
    // here would silently produce a working connection with no authentication worth the
    // name, on a port that may be reachable off-box.
    const err = caught(() => resolveProxyOverride({ host: FULL.host, port: FULL.port }, {}));

    assert.doesNotMatch(err.message, /adis-ababa/);
    assert.match(err.message, new RegExp(PROXY_TOKEN_ENV), "points at the env var instead");
});

test("a nonsense port is rejected rather than dialled", () => {
    for (const port of [0, -1, 70000, 1.5]) {
        assert.throws(() => resolveProxyOverride({ ...FULL, port }, {}), /port/, `port ${port} must be rejected`);
    }
});

test("whitespace-only values count as missing", () => {
    // A half-edited launch.json should fail the same way an empty one does.
    assert.throws(() => resolveProxyOverride({ host: "   ", port: FULL.port, token: FULL.token }, {}), /host/);
    assert.throws(() => resolveProxyOverride({ ...FULL, token: "  " }, {}), /token/);
});
