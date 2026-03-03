// Copyright (c) 2026 MCU-Debug Authors.
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
import * as fs from "fs";
import { ChildProcess, spawn } from "node:child_process";
import { computeProxyLaunchPolicy, ProxyHostType, resolveProxyNetworkMode, ProxyLaunchPolicy, ProxyLaunchResults } from "@mcu-debug/shared";

let childP: ChildProcess = null as any; // Placeholder for the actual child process that will run the proxy server
let proxyPath: string = "path/to/proxy/server"; // Placeholder for the actual path to the proxy server script
let proxyPolicy: ProxyLaunchPolicy | null = null;
let exiting = false;

const nonce = generateNonce();
const STARTUP_TIMEOUT_MS = 10_000;
const WATCHDOG_WINDOW_MS = 60_000;
const WATCHDOG_MAX_RESTARTS = 5;
const WATCHDOG_BASE_DELAY_MS = 500;
let watchdogWindowStart = Date.now();
let watchdogRestartCount = 0;

function generateNonce(length: number = 16): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function resolveNetworkMode(hostType: ProxyHostType = "auto") {
    return resolveProxyNetworkMode(hostType, vscode.env.remoteName);
}

function computeLaunchPolicy(hostType: ProxyHostType = "auto"): ProxyLaunchPolicy {
    const mode = resolveNetworkMode(hostType);
    return computeProxyLaunchPolicy(mode);
}

function canWatchdogRestart(): boolean {
    const now = Date.now();
    if (now - watchdogWindowStart > WATCHDOG_WINDOW_MS) {
        watchdogWindowStart = now;
        watchdogRestartCount = 0;
    }
    watchdogRestartCount++;
    return watchdogRestartCount <= WATCHDOG_MAX_RESTARTS;
}

function nextWatchdogDelayMs(): number {
    const n = Math.max(0, watchdogRestartCount - 1);
    return Math.min(WATCHDOG_BASE_DELAY_MS * Math.pow(2, n), 5000);
}

async function startProxyServer(policy: ProxyLaunchPolicy): Promise<ProxyLaunchResults> {
    proxyPolicy = policy;
    const ret = await startProxyServerWithPolicy();
    return ret;
}

function startProxyServerWithPolicy(): Promise<ProxyLaunchResults> {
    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        const dummyResolve = () => {
            if (!resolved) {
                resolved = true;
                resolve({
                    policy: proxyPolicy!,
                    consoleMessages: messages,
                    consoleErrors: errors,
                    serverPort: -1,
                    token: nonce,
                });
            }
        };

        const messages: string[] = [];
        const errors: string[] = [];
        const port = 0; // Let the proxy server choose a free port
        let resolved = false;
        let ready = false;
        messages.push(`Starting proxy server with policy: ${JSON.stringify(proxyPolicy)}`);
        const args = ["proxy", "--host", proxyPolicy!.bindHost, "--port", port.toString(), "--token", nonce];
        const proxyProcess = spawn(proxyPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        proxyProcess.on("error", (err) => {
            errors.push(`Failed to start proxy server: ${err}`);
            vscode.window.showErrorMessage(`Failed to start proxy server: ${err.message}`);
            dummyResolve();
        });
        proxyProcess.on("exit", (code, signal) => {
            messages.push(`Proxy server exited with code ${code} and signal ${signal}`);
            childP = null as any;
            if (!ready) {
                dummyResolve();
            }
            if (!exiting && ready) {
                if (!canWatchdogRestart()) {
                    vscode.window.showErrorMessage(`Proxy server restart limit reached (${WATCHDOG_MAX_RESTARTS}/${WATCHDOG_WINDOW_MS / 1000}s). Watchdog is stopping.`);
                    return;
                }
                const delayMs = nextWatchdogDelayMs();
                setTimeout(() => {
                    vscode.window.showErrorMessage(`Restarting proxy server after unexpected exit with code ${code} and signal ${signal} (attempt ${watchdogRestartCount}/${WATCHDOG_MAX_RESTARTS}).`);
                    startProxyServerWithPolicy().catch((restartErr) => {
                        console.error(`Watchdog restart failed: ${restartErr}`);
                    });
                }, delayMs);
            } else if (!exiting) {
                if (code !== 0) {
                    vscode.window.showErrorMessage(`Proxy server exited unexpectedly with code ${code} and signal ${signal}`);
                }
            }
        });
        proxyProcess.on("spawn", () => {
            messages.push("Proxy server process spawned successfully");
            childP = proxyProcess;
        });
        let stdoutData = "";
        proxyProcess.stdout?.on("data", (data) => {
            const msg = data.toString();
            messages.push(`Proxy server stdout: ${msg}`);
            stdoutData += msg;
            try {
                const json = JSON.parse(stdoutData);
                if (json.status === "ready") {
                    ready = true;
                    resolved = true;
                    watchdogWindowStart = Date.now();
                    watchdogRestartCount = 0;
                    resolve({
                        policy: proxyPolicy!,
                        consoleMessages: messages,
                        consoleErrors: errors,
                        serverPort: json.port,
                        token: nonce,
                    });
                }
            } catch (e) {}
        });
        proxyProcess.stderr?.on("data", (data) => {
            const msg = data.toString();
            messages.push(`Proxy server stderr: ${msg}`);
        });
        setTimeout(() => {
            dummyResolve();
            if (proxyProcess) {
                if (!exiting && !ready) {
                    proxyProcess.kill();
                }
                proxyProcess.removeAllListeners();
                childP = null as any;
            }
        }, STARTUP_TIMEOUT_MS); // Wait for proxy server to become ready
    });
}

/**
 * This design is such that this extension doesn't do anything until the workspace extension (mcu-debug) sends a
 * command to start the proxy server. This way, we avoid starting the proxy server unnecessarily if the user is
 * not using the debugging features, and we also avoid any issues with the proxy server running before the user
 * has had a chance to configure it through mcu-debug's settings.
 *
 * We return a token and port as part of the launch results to ensure that the mcu-debug extension can verify
 * that the proxy server it is communicating with is indeed the one it started, and not some other instance that
 * might be running on the system. This adds an extra layer of security and reliability to the communication
 * between the extensions.
 *
 * We can also consider the mcu-debug extension sending us a token we can use. Not sure what is better.
 * It is also not clear if a randomly generated port is okay for all use cases...especially if firewalls
 * are involved. We might want to allow configuring a fixed port (range) through settings
 */

export function activate(context: vscode.ExtensionContext) {
    console.log("[mcu-debug-proxy] Activating MCU Debug Proxy extension");
    const platform = process.platform;
    const exeName = "mcu-debug-helper" + (platform === "win32" ? ".exe" : "");
    proxyPath = context.asAbsolutePath(`bin/${exeName}`);
    if (!fs.existsSync(proxyPath)) {
        proxyPath = context.asAbsolutePath(`bin/${platform}-${process.arch}/${exeName}`);
        if (!fs.existsSync(proxyPath)) {
            console.error(`[mcu-debug-proxy] Proxy server executable not found at ${proxyPath}`);
            vscode.window.showErrorMessage(
                `[mcu-debug-proxy] Proxy server executable not found for platform ${platform} and architecture ${process.arch}. Please ensure it is built and included in the extension.`,
            );
            return;
        }
    }

    const disposables = [
        // Not sure if the follosing is needed. It returns the policy without starting the server, but there
        // is no need to call this as that can be done by a local call to computeLaunchPolicy.
        // We can remove this if we want to simplify the API, but it might be useful for testing and debugging purposes.
        vscode.commands.registerCommand("mcu-debug-proxy.getNetworkPolicy", (hostType?: ProxyHostType) => {
            return computeLaunchPolicy(hostType || "auto");
        }),
        // This is the main command that the mcu-debug extension will call to start the proxy server. It will return
        // the launch results, including the policy, console messages, errors, token, and server port.
        vscode.commands.registerCommand("mcu-debug-proxy.startProxyServer", (policy: ProxyLaunchPolicy) => {
            if (policy) {
                if (childP) {
                    childP.kill();
                    childP = null as any;
                }
                return startProxyServer(policy);
            }
        }),
    ];
    context.subscriptions.push(...disposables);
    return {
        resolveNetworkMode,
        computeLaunchPolicy,
        startProxyServer,
    };
}

export function deactivate() {
    exiting = true;
    if (childP) {
        childP.kill();
        childP = null as any;
    }
}
