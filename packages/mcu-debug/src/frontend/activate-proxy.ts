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

import * as vscode from "vscode";
import { logger } from "../common/logger";
import { compareVersions, isPreReleaseVersion, PROXY_EXT_ID, PROXY_NAME, PROXY_PING_CMD, shouldPinInstall } from "./proxy-ext-policy";

export { needsProxyExtension } from "./proxy-ext-policy";

const OUR_EXT_ID = "mcu-debug.mcu-debug";
const NAG_DISMISSED_KEY = "mcu-debug.proxyInstallPrompt.dismissed";

interface PingResult {
    version: string;
}

/** Set once the proxy has answered, so the hot path costs nothing after the first success. */
let proxyReachable = false;

/**
 * Trace every decision on the way to installing the proxy.
 *
 * This path is nearly impossible to follow from the outside: several dialogs can appear in
 * sequence, VS Code raises its own error notifications for a failed install on top of ours, and
 * which branch ran depends on marketplace state nobody can see. When someone reports that the
 * proxy would not install, this log is the only account of what was actually attempted.
 *
 * `step` is a stable identifier, not prose -- grep the output channel or cli.log for
 * `"step":"install.attempt"` rather than reading sentences.
 */
function trace(step: string, meta: Record<string, unknown> = {}) {
    // Details go in the meta, not the message: VscodeOutputChannelTransport already renders
    // every extra key as `key=<json>`, so formatting them into the text too prints them twice.
    logger.info(`[proxy-ext] ${step}`, { source: "DA", ...meta });
}


/**
 * Ask the proxy extension to identify itself; `undefined` means it is not reachable.
 *
 * This is the only way to detect it. We are `workspace`-kind and it is `ui`-kind, so in a
 * remote window we run in different extension hosts — and `vscode.extensions.getExtension()`
 * only sees its *own* host's registry, returning undefined however healthy the proxy is.
 * Commands are proxied between hosts; extension registries are not. The call also activates
 * the proxy, via its `onCommand:` activation event.
 */
async function pingProxy(): Promise<PingResult | undefined> {
    try {
        const res = await vscode.commands.executeCommand<PingResult | undefined>(PROXY_PING_CMD);
        if (res && typeof res.version === "string") {
            trace("ping.ok", { version: res.version });
            return res;
        }
        // Answered, but not with what we expect -- an older proxy, or someone else's command.
        trace("ping.unexpected-reply", { reply: JSON.stringify(res) });
        return undefined;
    } catch (e) {
        // Rejects with "command not found" when the proxy is absent — that is the answer.
        trace("ping.unreachable", { error: `${e}` });
        return undefined;
    }
}

/** Open the proxy's page in the Extensions view so the user can install it themselves. */
async function showProxyExtensionPage(): Promise<void> {
    try {
        await vscode.commands.executeCommand("extension.open", PROXY_EXT_ID);
        trace("page.opened", { via: "extension.open" });
    } catch (e) {
        trace("page.open-failed", { via: "extension.open", error: `${e}` });
        try {
            await vscode.commands.executeCommand("workbench.extensions.search", `@id:${PROXY_EXT_ID}`);
            trace("page.opened", { via: "workbench.extensions.search" });
        } catch (e2) {
            trace("page.open-failed", { via: "workbench.extensions.search", error: `${e2}` });
        }
    }
}

/**
 * Wait for the proxy to answer after an install.
 *
 * `installExtension` resolves when the *install* completes, not when the extension has been
 * activated and its commands registered. Pinging straight away therefore reports failure for an
 * install that actually worked -- observed in the wild: `install.command-ok` followed
 * immediately by `ping.unreachable`, after which we wrongly told the user nothing happened.
 */
async function waitForProxy(attempts = 8, delayMs = 500): Promise<PingResult | undefined> {
    for (let i = 0; i < attempts; i++) {
        const pong = await pingProxy();
        if (pong) {
            trace("wait.answered", { afterMs: i * delayMs });
            return pong;
        }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    trace("wait.timed-out", { afterMs: attempts * delayMs });
    return undefined;
}

/**
 * What a local window can see of the proxy, purely for the log.
 *
 * `getExtension` is host-scoped and is useless as *detection* -- in a remote window it returns
 * undefined however healthy the proxy is, which is why ping exists. But in a local window it is
 * the only thing that can say which version was just installed when the proxy has not activated
 * yet, and an undefined here is never treated as an answer.
 */
function installedVersionForLog(): string {
    const ext = vscode.extensions.getExtension(PROXY_EXT_ID);
    return ext ? `${ext.packageJSON.version}${ext.isActive ? "" : " (not yet active)"}` : "not visible from this host";
}

type InstallOutcome = "verified" | "installed-not-answering" | "failed";

/**
 * Install the proxy and confirm it by ping.
 *
 * The two ids are tried in this order for a reason:
 *
 *   1. **Unpinned.** Nothing installed, or we do not know what is: take the marketplace's latest
 *      on our channel. This is the case that virtually always succeeds, and it must come first
 *      because a pinned miss raises VS Code's own error dialog before rejecting to us — the
 *      marketplace routinely lags a local build, so pinning first means a scary dialog on every
 *      single install for no benefit.
 *   2. **Pinned to our exact version.** Reached only when step 1 produced a proxy at a version
 *      other than ours, which is the only situation where pinning changes the outcome. Guarded
 *      by {@link shouldPinInstall} so it can only move *forwards*: pinning over a newer proxy
 *      would silently downgrade it, and on a remote setup that is a downgrade of the machine the
 *      user is sitting at. When the installed one is newer we leave it and warn instead.
 *
 * Everything here is internal VS Code API -- the options bag and the `id@version` form are
 * undocumented. Every failure falls through to the extension page, so being wrong about them
 * costs a click rather than the feature.
 */
async function tryInstallProxy(ourVersion: string): Promise<InstallOutcome> {
    const options = { installPreReleaseVersion: isPreReleaseVersion(ourVersion), enable: true };
    trace("install.begin", { ourVersion, preRelease: options.installPreReleaseVersion });

    let installedSomething = false;
    for (const id of [PROXY_EXT_ID, `${PROXY_EXT_ID}@${ourVersion}`]) {
        trace("install.attempt", { id });
        try {
            await vscode.commands.executeCommand("workbench.extensions.installExtension", id, options);
            installedSomething = true;
            trace("install.command-ok", { id, installed: installedVersionForLog() });
        } catch (e) {
            // VS Code raises its own notification before we ever see this rejection -- which is
            // where a chain of unexplained dialogs comes from. Ours is only the record.
            trace("install.command-failed", { id, error: `${e}` });
            continue;
        }
        const pong = await waitForProxy();
        if (pong) {
            trace("install.verified", { id, version: pong.version });
            if (pong.version === ourVersion) {
                return "verified";
            }
            // Right extension, wrong version: an exact pin is worth one try, but only upwards.
            if (!shouldPinInstall(pong.version, ourVersion)) {
                // Newer than us: keep it and say which side is actually stale, rather than
                // pinning our version over the top and downgrading the user's own machine.
                trace("install.newer-kept", { got: pong.version, ours: ourVersion });
                void reportVersionMismatch(pong.version, ourVersion);
                return "verified";
            }
            trace("install.version-differs", { got: pong.version, ours: ourVersion });
            continue;
        }
        trace("install.installed-not-answering", { id, installed: installedVersionForLog() });
    }
    if (installedSomething) {
        // Either it never answered, or it answered with a version other than ours. Both are
        // usable; neither is a failure to report as "nothing happened".
        return (await pingProxy()) ? "verified" : "installed-not-answering";
    }
    trace("install.exhausted", {});
    return "failed";
}

/** Offer a window reload. Always the user's choice — reloading under someone is rude. */
async function offerReload(reason: string, message: string): Promise<void> {
    trace("reload.offered", { reason });
    const choice = await vscode.window.showWarningMessage(message, "Reload Window");
    trace("reload.choice", { reason, choice: choice ?? "dismissed" });
    if (choice === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
}

/**
 * Explain a version mismatch in terms of whichever side is actually behind.
 *
 * The two extensions are published in lockstep, so a mismatch means one of them did not update.
 * Which one decides both the message and the remedy, and getting it backwards sends the user to
 * fix the wrong machine:
 *
 * - **Proxy behind us.** It lives on the UI side; updating it is the local, obvious action, and
 *   a reload is usually all it takes once VS Code has fetched it.
 * - **We are behind the proxy.** This is the confusing one. In a remote window *we* are the
 *   extension installed on the far side — in WSL, in the container, on the SSH host — and that
 *   is the copy that is stale. Nothing about the proxy needs touching, and a reload will not
 *   help; the workspace-side MCU-Debug has to be updated. We never fix this by downgrading the
 *   proxy: that would roll back the machine the user is sitting at to satisfy a stale extension
 *   somewhere else.
 */
async function reportVersionMismatch(proxyVersion: string, ourVersion: string): Promise<void> {
    const cmp = compareVersions(proxyVersion, ourVersion);
    const pair = `${PROXY_NAME} is ${proxyVersion}, MCU-Debug is ${ourVersion}`;

    if (cmp < 0) {
        trace("mismatch.proxy-behind", { proxy: proxyVersion, ours: ourVersion });
        void offerReload("proxy-behind", `${pair}. The proxy is out of date; updating it and reloading this window should settle it.`);
        return;
    }
    if (cmp > 0) {
        const where = vscode.env.remoteName ? ` in this ${vscode.env.remoteName} window` : "";
        trace("mismatch.we-are-behind", { proxy: proxyVersion, ours: ourVersion, remote: vscode.env.remoteName ?? "local" });
        const choice = await vscode.window.showWarningMessage(
            `${pair}. The copy of MCU-Debug installed${where} is the one that is out of date — ` +
            `the proxy runs on your local machine and has already updated. Update MCU-Debug there; reloading alone will not help.`,
            "Update MCU-Debug",
        );
        trace("mismatch.choice", { choice: choice ?? "dismissed" });
        if (choice === "Update MCU-Debug") {
            try {
                await vscode.commands.executeCommand("extension.open", OUR_EXT_ID);
            } catch (e) {
                trace("mismatch.open-failed", { error: `${e}` });
            }
        }
        return;
    }
    // Versions differ as strings but do not compare -- say so plainly rather than guess a side.
    trace("mismatch.incomparable", { proxy: proxyVersion, ours: ourVersion });
    void offerReload("version-incomparable", `${pair}. These are published as a matched pair; reloading the window picks up an updated extension.`);
}

/**
 * Ensure the proxy extension is present and reachable before a launch that needs it.
 *
 * Returns false only when the user cannot debug: not installed and not installed on request.
 * A version mismatch warns and proceeds — a mismatched proxy usually still works, and refusing
 * to start would be a worse outcome than trying.
 */
export async function ensureProxyForLaunch(ourVersion: string): Promise<boolean> {
    if (proxyReachable) {
        trace("launch.cached-ok", {});
        return true;
    }
    trace("launch.begin", { ourVersion, remote: vscode.env.remoteName ?? "local" });
    const pong = await pingProxy();
    if (pong) {
        proxyReachable = true;
        if (pong.version !== ourVersion) {
            trace("launch.version-mismatch", { proxy: pong.version, ours: ourVersion });
            // Nothing is broken yet, so do not block: just explain, and offer the reload that
            // fixes the usual cause (one of the pair was updated while the window stayed open).
            void offerReload(
                "version-mismatch",
                `The ${PROXY_NAME} extension is version ${pong.version} but MCU-Debug is ${ourVersion}. ` +
                `They are published as a matched pair. If debugging misbehaves, reloading the window picks up the updated extension.`,
            );
        }
        trace("launch.ok", { proxyVersion: pong.version });
        return true;
    }

    trace("launch.prompt", {});
    const choice = await vscode.window.showErrorMessage(
        `The '${PROXY_NAME}' extension is required to reach a debug probe from this window, and it is not installed. ` +
        `It runs on your local machine and is what lets MCU-Debug talk to a probe that is not attached to the machine your workspace lives on.`,
        "Install",
        "Show Extension",
    );
    trace("launch.prompt-choice", { choice: choice ?? "dismissed" });
    if (choice === "Install") {
        const outcome = await tryInstallProxy(ourVersion);
        if (outcome === "verified") {
            proxyReachable = true;
            trace("launch.ok", { via: "install" });
            return true;
        }
        if (outcome === "installed-not-answering") {
            // Installed but not yet live in this host. Nothing is wrong except the window.
            await offerReload(
                "installed-needs-reload",
                `'${PROXY_NAME}' was installed but is not active in this window yet. Reload to finish, then start debugging again.`,
            );
            trace("launch.failed", { reason: "installed-needs-reload" });
            return false;
        }
    }
    if (choice) {
        // The install could not be done for us; let them drive it from the page.
        await showProxyExtensionPage();
        void offerReload(
            "after-manual-install",
            `Install '${PROXY_NAME}' from the page that just opened, then reload the window so MCU-Debug can see it.`,
        );
    }
    trace("launch.failed", { choice: choice ?? "dismissed" });
    return false;
}

/**
 * One-time nudge at activation, before anything is broken.
 *
 * The whole failure mode this guards against is discovering the proxy is missing at the moment
 * you press F5. Asking early — even in a local window, where it is not needed yet — means the
 * extension is already in place the first time a workspace turns out to be remote. It installs
 * locally either way, being `ui`-kind.
 *
 * Dismissal is remembered in global state, not workspace state: it is a statement about this
 * user's setup, not about one folder. It suppresses only this reminder — {@link
 * ensureProxyForLaunch} still speaks up, because by then it is the reason debugging failed.
 */
export async function promptProxyInstallOnce(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>(NAG_DISMISSED_KEY)) {
        trace("nag.suppressed", { reason: "dont-ask-again" });
        return;
    }
    trace("nag.begin", { remote: vscode.env.remoteName ?? "local" });
    const ourVersion = context.extension.packageJSON.version as string;
    // Short wait, not a single ping: this runs during our own activation, and the proxy may not
    // have activated yet on its host. A false negative here nags someone who already has it.
    const pong = await waitForProxy(4, 500);
    if (pong) {
        proxyReachable = true;
        trace("nag.not-needed", { reason: "already-installed", version: pong.version });
        if (pong.version !== ourVersion) {
            // Report it here or nowhere: ensureProxyForLaunch short-circuits on the cache we
            // just set, so a skew found at activation would otherwise never be mentioned.
            void reportVersionMismatch(pong.version, ourVersion);
        }
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        `MCU-Debug can debug a probe attached to a different machine than your workspace (WSL, a dev container, or a remote host). ` +
        `That needs the '${PROXY_NAME}' companion extension, which is not installed.`,
        "Install",
        "Show Extension",
        "Don't Ask Again",
    );
    trace("nag.choice", { choice: choice ?? "dismissed" });
    if (choice === "Don't Ask Again") {
        await context.globalState.update(NAG_DISMISSED_KEY, true);
        trace("nag.dismissed-forever", {});
        return;
    }
    if (choice === "Install") {
        const outcome = await tryInstallProxy(ourVersion);
        if (outcome === "verified") {
            proxyReachable = true;
            trace("nag.end", { installed: true });
            return;
        }
        if (outcome === "installed-not-answering") {
            // Do not open the extension page here: it *is* installed, and sending the user to a
            // page showing an Install button they have already pressed reads as a failure.
            void offerReload(
                "installed-needs-reload",
                `'${PROXY_NAME}' was installed. Reload the window when convenient so MCU-Debug can use it.`,
            );
            trace("nag.end", { installed: true, needsReload: true });
            return;
        }
        await showProxyExtensionPage();
        trace("nag.end", { installed: false });
        return;
    }
    if (choice) {
        await showProxyExtensionPage();
    }
    trace("nag.end", { installed: false });
}

/**
 * `Developer: Check MCU-Debug Proxy` — report what we can actually see of the proxy.
 *
 * Written for support as much as for testing. "Remote debugging does not work" is otherwise a
 * log-hunting expedition, and the three facts that resolve most of those reports — is the proxy
 * reachable, which version, and is this window remote at all — are all here in one message.
 * It deliberately reports the *ping* result rather than anything from `vscode.extensions`,
 * because that is the only view that is true across extension hosts.
 */
export async function checkProxyCommand(context: vscode.ExtensionContext): Promise<void> {
    const ourVersion = context.extension.packageJSON.version as string;
    const remote = vscode.env.remoteName ?? "none (local window)";
    trace("check.begin", { ourVersion, remote });
    const pong = await pingProxy();

    const lines = [
        `MCU-Debug: ${ourVersion}`,
        `${PROXY_NAME}: ${pong ? pong.version : "not reachable"}`,
        `Remote: ${remote}`,
    ];
    if (!pong) {
        lines.push("", `The proxy is needed only to reach a probe attached to a different machine than your workspace.`);
        const choice = await vscode.window.showWarningMessage(lines.join("  •  "), "Install", "Show Extension");
        if (choice === "Install") {
            const outcome = await tryInstallProxy(ourVersion);
            if (outcome === "verified") {
                void vscode.window.showInformationMessage(`'${PROXY_NAME}' installed and responding.`);
            } else if (outcome === "installed-not-answering") {
                void offerReload("installed-needs-reload", `'${PROXY_NAME}' was installed but is not active in this window yet.`);
            } else {
                await showProxyExtensionPage();
            }
        } else if (choice) {
            await showProxyExtensionPage();
        }
        return;
    }
    if (pong.version !== ourVersion) {
        void vscode.window.showInformationMessage(lines.join("  •  "));
        void reportVersionMismatch(pong.version, ourVersion);
        return;
    }
    void vscode.window.showInformationMessage(lines.join("  •  "));
}
