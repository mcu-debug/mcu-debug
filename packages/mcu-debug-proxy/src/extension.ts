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

// ── Singleton model (Tier 1) ─────────────────────────────────────────────────
// `mdbg proxy` is now a per-(user, instance) singleton. Launching it either
// starts the one proxy or *reuses* the running one — the binary does the
// "reuse-if-there, start-if-not" logic itself, so this extension no longer
// implements it. Consequences:
//   • No heartbeat. The proxy's lifetime is driven by active sessions + an
//     idle-timeout, not by pings from us. A dead extension just means its
//     session connections drop, which drops those refs.
//   • No watchdog. If the proxy dies, its in-flight gdb-servers/sessions die
//     with it; spawning a fresh empty proxy recovers nothing.
//   • Spawned *detached*, so the shared proxy OUTLIVES the window that started
//     it — other windows (and the CLI) reuse the same instance.
//   • We never kill it on deactivate; it self-reaps via idle-timeout.
// The one non-deletion: use the token the running proxy REPORTS (json.token).
// On reuse that is the first launcher's token, not our nonce.

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { ChildProcess, spawn } from "node:child_process";
import { computeProxyLaunchPolicy, ProxyHostType, resolveProxyNetworkMode, ProxyLaunchPolicy, ProxyLaunchResults, ProvisioningResults, ProxyProvisionRequest, startProxyServerWithPolicy } from "@mcu-debug/shared";

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

const STARTUP_TIMEOUT_MS = 10_000;

function resolveNetworkMode(hostType: ProxyHostType = "auto") {
    return resolveProxyNetworkMode(hostType, vscode.env.remoteName);
}

function computeLaunchPolicy(hostType: ProxyHostType = "auto"): ProxyLaunchPolicy {
    const mode = resolveNetworkMode(hostType);
    return computeProxyLaunchPolicy(mode);
}

async function startProxyServerWrapper(policy: ProxyLaunchPolicy): Promise<ProxyLaunchResults> {
    proxyPolicy = policy;
    currentLaunchResults = await startProxyServerWithPolicyInternal();
    return currentLaunchResults;
}

// Launch (or reuse) the singleton proxy and read its discovery line. `mdbg proxy`
// self-daemonizes: the process we spawn is a short-lived foreground launcher that
// re-spawns a detached daemon, forwards its discovery line to stdout, and exits.
// The daemon (owner) survives on its own; we never own or manage it.
function startProxyServerWithPolicyInternal(): Promise<ProxyLaunchResults> {
    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        startProxyServerWithPolicy(proxyPolicy!, proxyPath, STARTUP_TIMEOUT_MS)
            .then((result: ProxyLaunchResults) => {
                if (proxyPolicy!.reverseTunnelSshHost) {
                    // Start the reverse tunnel here — we already know the local port (json.port)
                    // so there is no need for the workspace extension to make a second round-trip.
                    startSshReverseTunnel(proxyPolicy!.reverseTunnelSshHost, result.serverPort!)
                        .then((remotePort) => resolve({ ...result, reverseTunnelPort: remotePort }))
                        .catch((err) => reject(err));
                } else {
                    resolve(result);
                }
            })
            .catch((err) => {
                reject(err);
            });
    });
}

/**
 * This design is such that this extension doesn't do anything until the workspace extension (mcu-debug) sends a
 * command to start the proxy server. This way, we avoid starting the proxy server unnecessarily if the user is
 * not using the debugging features, and we also avoid any issues with the proxy server running before the user
 * has had a chance to configure it through mcu-debug's settings.
 *
 * With the singleton model, `startProxyServer` returns whichever proxy is running for the instance (starting one
 * if needed) along with its port and reported token. Callers on the workspace (DA) side should treat these results
 * as fresh-per-request and NOT cache the port across debug sessions — the singleton can idle-exit between sessions,
 * after which a re-launch yields a new port.
 */

export function activate(context: vscode.ExtensionContext) {
    console.log("[mcu-debug-proxy] Activating MCU Debug Proxy extension");
    const platform = process.platform;
    const exeName = "mdbg" + (platform === "win32" ? ".exe" : "");
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

    const uriHandler = new MyUriHandler(context);
    const disposables = [
        // The main command the mcu-debug extension calls to obtain the proxy. It
        // launches-or-reuses the singleton and returns its port + reported token.
        vscode.commands.registerCommand("mcu-debug-proxy.startProxyServer", (policy: ProxyLaunchPolicy) => {
            if (policy) {
                return startProxyServerWrapper(policy);
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
            return getRemoteShhHost();
        }),
        // Returns the IPv4 address of the Windows host's WSL virtual ethernet adapter
        // ("vEthernet (WSL)" or "vEthernet (WSL (Hyper-V firewall))").
        // This is authoritative — the Windows host knows its own adapter IPs directly,
        // whereas the WSL guest's /etc/resolv.conf nameserver entry may point to a
        // Hyper-V DNS relay rather than the actual gateway. Returns null if the adapter
        // is not found (e.g. not on Windows, or WSL not installed).
        vscode.commands.registerCommand("mcu-debug-proxy.getWslHostIp", () => {
            return getWslHostIp();
        }),
        // And register it with VS Code. You can only register a single UriHandler for your extension.
        vscode.window.registerUriHandler(uriHandler),
    ];
    context.subscriptions.push(...disposables);
    return {
        resolveNetworkMode,
        computeLaunchPolicy,
        startProxyServer: startProxyServerWrapper,
    };
}

class MyUriHandler implements vscode.UriHandler {
    constructor(private context: vscode.ExtensionContext) {
        // Nothing to do in the constructor for now
    }
    // This function will get run when something redirects to VS Code
    // with your extension id as the authority.
    handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        vscode.window.showInformationMessage(uri.toString());
        if ((uri.path === "/provision") && uri.query) {
            const obj = Object.fromEntries(new URLSearchParams(uri.query)) as unknown as ProxyProvisionRequest;
            if (obj && obj.v === 1 && obj.api && obj.resultsFile) {
                let error = "";
                let result: any = undefined;
                try {
                    switch (obj.api) {
                        case "startProxyServer": {
                            const policy = obj.args?.[0] as ProxyLaunchPolicy;
                            if (policy) {
                                if (!obj.authority) {
                                    error = "Missing authority for startProxyServer";
                                    break;
                                }
                                this.validateAuthority(obj.authority).then((isAuthorized) => {
                                    if (isAuthorized) {
                                        startProxyServerWrapper(policy).then((result) => {
                                            this.depositProvision(obj, "", result);
                                        }).catch((err) => {
                                            this.depositProvision(obj, `Failed to start proxy server: ${err.message}`, undefined);
                                        });
                                    } else {
                                        this.depositProvision(obj, "Probe host declined permission", undefined);
                                    }
                                });
                                return; // async, will call depositProvision later
                            } else {
                                error = "Missing or invalid policy argument for startProxyServer";
                            }
                            break;
                        }
                        case "startReverseTunnel": {
                            const sshHost = obj.args?.[0] as string;
                            const localProxyPort = obj.args?.[1] as number;
                            if (sshHost && localProxyPort) {
                                if (!obj.authority) {
                                    error = "Missing authority for startProxyServer";
                                    break;
                                }
                                this.validateAuthority(obj.authority).then((isAuthorized) => {
                                    if (isAuthorized) {
                                        startSshReverseTunnel(sshHost, localProxyPort).then((remotePort) => {
                                            this.depositProvision(obj, "", remotePort);
                                        }).catch((err) => {
                                            this.depositProvision(obj, `Failed to start reverse tunnel: ${err.message}`, undefined);
                                        });
                                    } else {
                                        this.depositProvision(obj, "Probe host declined permission", undefined);
                                    }
                                });
                                return; // async, will call depositProvision later
                            } else {
                                error = "Missing or invalid arguments for startReverseTunnel";
                            }
                            break;
                        }
                        case "getRemoteSshHost": {
                            result = getRemoteShhHost();
                            break;
                        }
                        case "getWslHostIp": {
                            result = getWslHostIp();
                            break;
                        }
                        default:
                            error = `Unknown API command: ${obj.api}`;
                    }
                } catch (err: any) {
                    error = `Error processing API command ${obj.api}: ${err.message}`;
                }
                this.depositProvision(obj, error, result);
            }
        }
    }

    private depositProvision(obj: ProxyProvisionRequest, error: string, result: any) {
        const results: ProvisioningResults = {
            resultsFile: obj.resultsFile,
            error: error,
            result: result,
        };
        vscode.commands.executeCommand("mcu-debug.depositProvision", results);
    }

    public validateAuthority(authority: string): Promise<boolean> {
        return new Promise<boolean>(async (resolve) => {
            let resolved = false;
            let permissions = this.context.globalState.get<string[]>("mcu-debug-proxy.authorizedAuthorities", []);
            if (permissions.includes(authority)) {
                return resolve(true);
            }
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    return resolve(false);
                }
            }, 30_000); // 30 seconds timeout for user to respond
            const choices = ["Deny", "Allow", "Always Allow"];
            const result = await vscode.window.showWarningMessage(
                `The authority "${authority}" is requesting access to the MCU Debug Proxy. Do you want to allow it?`,
                { modal: true },
                ...choices
            );

            if (result === choices[1] || result === choices[2]) {
                if (result === choices[2]) {
                    permissions.push(authority);
                    this.context.globalState.update("mcu-debug-proxy.authorizedAuthorities", permissions);
                }
                if (!resolved) {
                    clearTimeout(timer);
                    resolved = true;
                    return resolve(true);
                }
            }
            if (!resolved) {
                clearTimeout(timer);
                resolved = true;
                return resolve(false);
            }
        });
    }
}

function getRemoteShhHost() {
    const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "";
    const host = authority.replace(/^ssh-remote\+/, "");
    return host || null;
}

function getWslHostIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        if (/vEthernet.*WSL/i.test(name)) {
            const entry = nets[name]?.find((n) => n.family === "IPv4" && !n.internal);
            if (entry) {
                return entry.address;
            }
        }
    }
    return null;
}

export function deactivate() {
    // The shared singleton proxy is intentionally NOT killed here — other windows
    // and the CLI may be using it, and it self-reaps via idle-timeout once no
    // sessions remain. We only tear down our own SSH reverse tunnel.
    killSshReverseTunnel();
}
