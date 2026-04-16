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

let childP: ChildProcess | null = null; // Placeholder for the actual child process that will run the proxy server

/**
 * Returns true if the binary at filePath is a native executable for the
 * given platform and CPU architecture. Prevents running a macOS arm64 dev
 * build on a Linux x64 host (container, WSL, etc.) when the unqualified
 * bin/<name> shortcut is present alongside the platform-specific binaries.
 *
 * Same logic as DebugHelper.binaryMatchesPlatform in adapter/helper.ts.
 */
function binaryMatchesPlatform(filePath: string, platform: NodeJS.Platform, arch: string): boolean {
    try {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(20);
        fs.readSync(fd, buf, 0, 20, 0);
        fs.closeSync(fd);

        // ELF (Linux)
        if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
            if (platform !== "linux") {
                return false;
            }
            const machine = buf.readUInt16LE(18);
            if (arch === "x64") {
                return machine === 0x003e;
            } // EM_X86_64
            if (arch === "arm64") {
                return machine === 0x00b7;
            } // EM_AARCH64
            return false;
        }

        // Mach-O 64-bit little-endian (macOS)
        if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) {
            if (platform !== "darwin") {
                return false;
            }
            const cputype = buf.readUInt32LE(4);
            if (arch === "x64") {
                return cputype === 0x01000007;
            } // CPU_TYPE_X86_64
            if (arch === "arm64") {
                return cputype === 0x0100000c;
            } // CPU_TYPE_ARM64
            return false;
        }

        // PE (Windows) — MZ header
        if (buf[0] === 0x4d && buf[1] === 0x5a) {
            return platform === "win32";
        }

        return false; // Unrecognised format — treat as incompatible
    } catch {
        return false;
    }
}
let proxyPath: string = "path/to/proxy/server"; // Placeholder for the actual path to the proxy server script
let proxyPolicy: ProxyLaunchPolicy | null = null;

// ── Soft-kill helper ───────────────────────────────────────────────────────────
// Closes stdin (sends EOF) so the Rust heartbeat watcher fires immediately and
// initiates a graceful shutdown — running Drop on ProxyServer which kills child
// processes (openocd, gdb-server, etc.) before the Rust process exits.
// Falls back to SIGKILL after graceMs if the process has not exited on its own.
// This is safe to call on any ChildProcess, even ones without --heartbeat.
const SOFT_KILL_GRACE_MS = 3_000;

function softKillProcess(proc: ChildProcess, graceMs = SOFT_KILL_GRACE_MS): void {
    // Closing stdin delivers EOF to the Rust reader thread, which drops the tx,
    // causing the watcher to see Disconnected and start graceful shutdown immediately.
    try {
        proc.stdin?.end();
    } catch {
        // ignore — stdin may already be closed
    }
    const timer = setTimeout(() => {
        if (!proc.killed) {
            proc.kill();
        }
    }, graceMs);
    proc.once("exit", () => clearTimeout(timer));
}

// ── SSH reverse tunnel (auto-ssh-remote) ──────────────────────────────────────
// The DA runs on the remote SSH host; the Proxy Agent runs here on the Engineer
// Machine. We establish an ssh -R tunnel so the DA can reach the Proxy Agent by
// connecting to localhost:<remotePort> on the remote side.

const SSH_REV_TUNNEL_TIMEOUT_MS = 15_000;

interface SshRevTunnelConfig {
    sshHost: string;
    localProxyPort: number;
    remotePort: number;
}

let sshRevTunnelProcess: ChildProcess | null = null;
let sshRevTunnelConfig: SshRevTunnelConfig | null = null;

function killSshReverseTunnel() {
    if (sshRevTunnelProcess) {
        sshRevTunnelProcess.kill();
        sshRevTunnelProcess = null;
    }
    sshRevTunnelConfig = null;
}

// Establishes ssh -R localhost:0:127.0.0.1:<localProxyPort> -N <sshHost>.
// OpenSSH prints "Allocated port XXXXX for remote forward" to stderr when the
// OS assigns the port. That's the signal we've been waiting for.
// The process stays alive for the duration of the VS Code session.
function startSshReverseTunnel(sshHost: string, localProxyPort: number): Promise<number> {
    // Reuse: same host + same local port + process still alive
    if (sshRevTunnelProcess && sshRevTunnelConfig && sshRevTunnelConfig.sshHost === sshHost && sshRevTunnelConfig.localProxyPort === localProxyPort) {
        return Promise.resolve(sshRevTunnelConfig.remotePort);
    }
    if (sshRevTunnelProcess) {
        killSshReverseTunnel();
    }

    const args = ["-N", "-R", `localhost:0:127.0.0.1:${localProxyPort}`, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", sshHost];
    const cmdString = `ssh ${args.join(" ")}`;

    return new Promise<number>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const fail = (msg: string) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            proc.kill();
            sshRevTunnelProcess = null;
            reject(new Error(msg));
        };

        const succeed = (remotePort: number) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            sshRevTunnelProcess = proc;
            sshRevTunnelConfig = { sshHost, localProxyPort, remotePort };
            resolve(remotePort);
        };

        const proc = spawn("ssh", args);

        proc.on("error", (err) => {
            fail(`SSH reverse tunnel process error (${cmdString}): ${err.message}`);
        });

        proc.on("exit", (code) => {
            if (!settled) {
                fail(`SSH reverse tunnel exited prematurely (code ${code}). Check host, credentials, and that AllowTcpForwarding is enabled on ${sshHost}`);
            } else {
                sshRevTunnelProcess = null;
                sshRevTunnelConfig = null;
            }
        });

        // OpenSSH prints "Allocated port XXXXX for remote forward to ..." to stderr
        // at INFO level (the default) — no -v required.
        let stderrBuf = "";
        proc.stderr?.on("data", (d: Buffer) => {
            stderrBuf += d.toString();
            const match = stderrBuf.match(/Allocated port (\d+) for remote forward/);
            if (match) {
                succeed(parseInt(match[1], 10));
            }
        });

        timeoutHandle = setTimeout(() => {
            fail(`SSH reverse tunnel timed out after ${SSH_REV_TUNNEL_TIMEOUT_MS / 1000}s waiting for port allocation from ${sshHost}`);
        }, SSH_REV_TUNNEL_TIMEOUT_MS);
    });
}
let currentLaunchResults: ProxyLaunchResults | null = null;
let exiting = false;

const nonce = generateNonce();
const STARTUP_TIMEOUT_MS = 10_000;
const WATCHDOG_WINDOW_MS = 60_000;
const WATCHDOG_MAX_RESTARTS = 5;
const WATCHDOG_BASE_DELAY_MS = 500;
const HEARTBEAT_INTERVAL_MS = 5_000;
let watchdogWindowStart = Date.now();
let watchdogRestartCount = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

async function startProxyServerWithPolicy(): Promise<ProxyLaunchResults> {
    currentLaunchResults = null;
    currentLaunchResults = await startProxyServerWithPolicyInternal();
    return currentLaunchResults;
}
function startProxyServerWithPolicyInternal(): Promise<ProxyLaunchResults> {
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
        const port = proxyPolicy!.fixedPort ?? 0; // 0 → OS-assigned; non-zero → fixed port (WSL NAT firewall scenario)
        let resolved = false;
        let ready = false;
        messages.push(`Starting proxy server with policy: ${JSON.stringify(proxyPolicy)}`);
        const args = ["proxy", "--host", proxyPolicy!.bindHost, "--port", port.toString(), "--token", nonce, "--heartbeat"];
        const proxyProcess = spawn(proxyPath, args, {
            stdio: ["pipe", "pipe", "pipe"],
        });
        proxyProcess.on("error", (err) => {
            errors.push(`Failed to start proxy server: ${err}`);
            vscode.window.showErrorMessage(`Failed to start proxy server: ${err.message}`);
            dummyResolve();
        });
        proxyProcess.on("exit", (code, signal) => {
            messages.push(`Proxy server exited with code ${code} and signal ${signal}`);
            childP = null;
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
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
            // Heartbeat: write a newline to stdin periodically so the proxy can
            // detect a frozen or dead extension even if the pipe stays half-open.
            // The proxy also exits immediately on stdin EOF (VS Code killed).
            heartbeatTimer = setInterval(() => {
                childP?.stdin?.write("\n");
            }, HEARTBEAT_INTERVAL_MS);
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
                    const baseResults: ProxyLaunchResults = {
                        policy: proxyPolicy!,
                        consoleMessages: messages,
                        consoleErrors: errors,
                        serverPort: json.port,
                        token: nonce,
                    };
                    if (proxyPolicy!.reverseTunnelSshHost) {
                        // Start the reverse tunnel here — we already know the local port (json.port)
                        // so there is no need for the workspace extension to make a second round-trip.
                        startSshReverseTunnel(proxyPolicy!.reverseTunnelSshHost, json.port)
                            .then((remotePort) => resolve({ ...baseResults, reverseTunnelPort: remotePort }))
                            .catch((err) => reject(err));
                    } else {
                        resolve(baseResults);
                    }
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
                childP = null;
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
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
    const devPath = context.asAbsolutePath(`bin/${exeName}`);
    if (fs.existsSync(devPath) && binaryMatchesPlatform(devPath, platform, process.arch)) {
        proxyPath = devPath;
    } else {
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
        // This command allows the mcu-debug extension to retrieve the current proxy launch results, including the
        // policy, console messages, errors, token, and server port. It will return null if the proxy server is not
        // currently running or if the launch results are not available.
        vscode.commands.registerCommand("mcu-debug-proxy.getProxyResults", () => {
            if (!childP || !currentLaunchResults || !proxyPolicy || currentLaunchResults.serverPort === -1) {
                return null;
            }
            return currentLaunchResults;
        }),
        // This is the main command that the mcu-debug extension will call to start the proxy server. It will return
        // the launch results, including the policy, console messages, errors, token, and server port.
        vscode.commands.registerCommand("mcu-debug-proxy.startProxyServer", (policy: ProxyLaunchPolicy) => {
            if (policy) {
                if (childP) {
                    softKillProcess(childP);
                    childP = null;
                }
                return startProxyServer(policy);
            }
        }),
        // Establishes an SSH reverse tunnel so the DA (running on the remote SSH host in
        // auto-ssh-remote mode) can connect back to the Proxy Agent on this machine.
        // Returns the remote port number assigned by the SSH server, or rejects on failure.
        // The tunnel is kept alive for the VS Code session and reused on subsequent launches
        // as long as sshHost and localProxyPort are unchanged.
        vscode.commands.registerCommand("mcu-debug-proxy.startReverseTunnel", (sshHost: string, localProxyPort: number) => {
            return startSshReverseTunnel(sshHost, localProxyPort);
        }),
        // Returns the SSH host alias for the current remote session, or null if not in a
        // VS Code SSH Remote session. In a SSH Remote session, workspace folder URIs have
        // authority "ssh-remote+HOSTNAME"; we strip the prefix to return the bare alias.
        // This is stable public API (no proposed API required), making it safe to call from
        // the workspace extension running on the remote host.
        vscode.commands.registerCommand("mcu-debug-proxy.getRemoteSshHost", () => {
            const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "";
            const host = authority.replace(/^ssh-remote\+/, "");
            return host || null;
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
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (childP) {
        softKillProcess(childP);
        childP = null;
    }
    killSshReverseTunnel();
}
