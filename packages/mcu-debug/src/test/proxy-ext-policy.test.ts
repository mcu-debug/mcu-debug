import assert from "node:assert";
import { describe, it } from "node:test";
import { compareVersions, isPreReleaseVersion, needsProxyExtension, shouldPinInstall } from "../frontend/proxy-ext-policy";

describe("needsProxyExtension", () => {
    it("says no when hostConfig is absent or switched off", () => {
        // Local debugging -- the overwhelmingly common case -- omits hostConfig entirely.
        assert.equal(needsProxyExtension(undefined), false);
        assert.equal(needsProxyExtension(null), false);
        assert.equal(needsProxyExtension(false), false);
        assert.equal(needsProxyExtension({ enabled: false }), false);
        assert.equal(needsProxyExtension({ enabled: false, type: "auto" }), false);
    });

    it("treats `enabled` as defaulting to true, per the manifest schema", () => {
        // The regression this guards: requiring `enabled === true` meant the ordinary object
        // form -- which never carries `enabled`, because the schema defaults it -- silently
        // skipped the proxy check, which is exactly when the proxy is needed.
        assert.equal(needsProxyExtension({ type: "auto" }), true);
        assert.equal(needsProxyExtension({}), true);
        assert.equal(needsProxyExtension({ enabled: true, type: "auto" }), true);
    });

    it("accepts the boolean shorthand", () => {
        assert.equal(needsProxyExtension(true), true);
    });

    it("says no for type ssh, which starts its own agent over SSH", () => {
        assert.equal(needsProxyExtension({ type: "ssh", ssh: { host: "lab" } }), false);
        assert.equal(needsProxyExtension({ enabled: true, type: "ssh" }), false);
    });

    it("does not throw on malformed values", () => {
        // hostConfig is user-authored JSON; validation happens later, in common/proxy.ts.
        assert.equal(needsProxyExtension("auto"), false);
        assert.equal(needsProxyExtension(42), false);
    });
});

describe("isPreReleaseVersion", () => {
    it("treats an odd minor as pre-release", () => {
        assert.equal(isPreReleaseVersion("0.1.15"), true);
        assert.equal(isPreReleaseVersion("0.1.0"), true);
        assert.equal(isPreReleaseVersion("1.3.7"), true);
    });

    it("treats an even minor as a release", () => {
        // The point of deriving this: it flips on its own at 0.2.0, with no flag to remember.
        assert.equal(isPreReleaseVersion("0.2.0"), false);
        assert.equal(isPreReleaseVersion("1.0.0"), false);
        assert.equal(isPreReleaseVersion("2.10.3"), false);
    });

    it("returns false rather than throwing on a version it cannot parse", () => {
        // A wrong answer here only picks the wrong marketplace channel; the install path falls
        // back to the extension page either way. Throwing would take down activation.
        assert.equal(isPreReleaseVersion(""), false);
        assert.equal(isPreReleaseVersion("nonsense"), false);
        assert.equal(isPreReleaseVersion("1"), false);
    });
});

describe("compareVersions", () => {
    it("orders by major, then minor, then patch", () => {
        assert.ok(compareVersions("0.1.14", "0.1.15") < 0);
        assert.ok(compareVersions("0.1.15", "0.1.14") > 0);
        assert.ok(compareVersions("0.2.0", "0.1.99") > 0);
        assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
        assert.equal(compareVersions("0.1.15", "0.1.15"), 0);
    });

    it("reports 0 for anything it cannot parse, so callers do not act on a guess", () => {
        assert.equal(compareVersions("", "0.1.15"), 0);
        assert.equal(compareVersions("0.1", "0.1.15"), 0);
        assert.equal(compareVersions("nonsense", "0.1.15"), 0);
    });
});

describe("shouldPinInstall", () => {
    it("pins forwards, to pull an older proxy up to our version", () => {
        assert.equal(shouldPinInstall("0.1.14", "0.1.15"), true);
    });

    it("never pins backwards -- that would downgrade the user's machine", () => {
        // On a remote setup the proxy runs where the user is sitting. Silently rolling it back
        // to match us is worse than living with a mismatch and warning about it.
        assert.equal(shouldPinInstall("0.1.16", "0.1.15"), false);
        assert.equal(shouldPinInstall("0.2.0", "0.1.15"), false);
    });

    it("does nothing when the versions match or cannot be compared", () => {
        assert.equal(shouldPinInstall("0.1.15", "0.1.15"), false);
        assert.equal(shouldPinInstall("weird", "0.1.15"), false);
    });
});
