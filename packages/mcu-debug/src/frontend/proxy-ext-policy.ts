//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//
// Pure decision logic for the companion proxy extension. Deliberately free of any `vscode`
// import so it can be unit-tested with plain node; activate-proxy.ts holds everything that
// actually touches the VS Code API.
//

export const PROXY_EXT_ID = "mcu-debug.mcu-debug-proxy";
export const PROXY_PING_CMD = "mcu-debug-proxy.ping";
export const PROXY_NAME = "MCU-Debug Proxy Server";

/**
 * Does this debug configuration need the UI-side proxy extension?
 *
 * `hostConfig` may be `true` (shorthand for the defaults) or an object, and its `enabled`
 * property defaults to **true** in the manifest schema — so the ordinary `{"type": "auto"}`
 * form has no `enabled` at all and must still count as enabled. Requiring `enabled === true`
 * was the bug that made this whole check silently do nothing.
 *
 * `type: "ssh"` is the exception: that path deploys the helper binary and starts the agent
 * over SSH itself (see `resolvedMode === "ssh"` in common/proxy.ts), never calling into the
 * proxy extension. Only the `auto-*` modes route through it.
 */
export function needsProxyExtension(hc: any): boolean {
    if (hc === true) {
        return true; // shorthand: object defaults, i.e. type "auto"
    }
    if (hc === false || typeof hc !== "object" || hc === null) {
        return false; // absent, or explicitly disabled
    }
    const obj = hc as { enabled?: boolean; type?: string };
    if (obj.enabled === false) {
        return false;
    }
    // Anything that is not "ssh" -- including a missing or malformed type -- needs the proxy.
    // `!==` against a literal is total, so no guard is needed for non-string values.
    return obj.type !== "ssh";
}

/**
 * Is `version` one of our pre-release builds?
 *
 * Odd minor = pre-release, even minor = release — the same convention `package-extensions.sh`
 * uses when publishing. Deriving it rather than hardcoding a flag means the installer stops
 * asking for pre-releases by itself once an even-minor release ships, with nothing to remember.
 */
export function isPreReleaseVersion(version: string): boolean {
    const minor = Number(version.split(".")[1]);
    return Number.isFinite(minor) && minor % 2 === 1;
}

/**
 * Compare dotted numeric versions: negative if `a` < `b`, positive if `a` > `b`, 0 if equal.
 *
 * Only the numeric `x.y.z` form is understood, which is all we ever publish. Anything that does
 * not parse compares as 0 — "cannot tell", which callers should read as "do nothing".
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const x = pa[i];
        const y = pb[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return 0; // unparseable: report "equal" so nobody acts on a guess
        }
        if (x !== y) {
            return x - y;
        }
    }
    return 0;
}

/**
 * Should we try to install our exact version over what is already there?
 *
 * Only to move *forwards*. The pinned install exists to pull a proxy up to the version it is
 * published in lockstep with; using it to drag a newer proxy backwards would be a downgrade the
 * user never asked for — and on a remote setup, a downgrade of the machine they are sitting at.
 * When the installed one is newer, the version-mismatch warning is the right response instead.
 */
export function shouldPinInstall(installed: string, ours: string): boolean {
    return compareVersions(installed, ours) < 0;
}
