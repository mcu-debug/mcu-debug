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
import * as path from "path";
import { ChildProcess, spawn } from "node:child_process";
import { SSH_BATCH_OPTS, computeProxyLaunchPolicy, ProxyHostType, resolveProxyNetworkMode, ProxyLaunchPolicy, ProxyLaunchResults, ProvisioningResults, ProxyProvisionRequest, startProxyServerWithPolicy, setDevelopmentModeEnvVars } from "@mcu-debug/shared";

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

    const args = ["-N", "-R", `localhost:0:127.0.0.1:${localProxyPort}`, ...SSH_BATCH_OPTS, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", sshHost];
    const cmdString = `ssh ${args.join(" ")}`;

    return new Promise<number>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        // Filled by the stderr handler below. With BatchMode=yes a bad login exits at once
        // and the reason ("Permission denied (publickey)", "Host key verification failed")
        // is only here, so every failure path appends it.
        let stderrBuf = "";
        const sshSays = () => (stderrBuf.trim() ? `\nssh: ${stderrBuf.trim()}` : "");

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

        const proc = spawn("ssh", args, { windowsHide: true });

        proc.on("error", (err) => {
            fail(`SSH reverse tunnel process error (${cmdString}): ${err.message}`);
        });

        proc.on("exit", (code) => {
            if (!settled) {
                fail(`SSH reverse tunnel exited prematurely (code ${code}). Check host, credentials, and that AllowTcpForwarding is enabled on ${sshHost}.${sshSays()}`);
            } else {
                sshRevTunnelProcess = null;
                sshRevTunnelConfig = null;
            }
        });

        // OpenSSH prints "Allocated port XXXXX for remote forward to ..." to stderr
        // at INFO level (the default) — no -v required.
        proc.stderr?.on("data", (d: Buffer) => {
            stderrBuf += d.toString();
            const match = stderrBuf.match(/Allocated port (\d+) for remote forward/);
            if (match) {
                succeed(parseInt(match[1], 10));
            }
        });

        timeoutHandle = setTimeout(() => {
            fail(`SSH reverse tunnel timed out after ${SSH_REV_TUNNEL_TIMEOUT_MS / 1000}s waiting for port allocation from ${sshHost}.${sshSays()}`);
        }, SSH_REV_TUNNEL_TIMEOUT_MS);
    });
}

const STARTUP_TIMEOUT_MS = 10_000;

// ── Tracing ───────────────────────────────────────────────────────────────────
// A `LogOutputChannel` rather than an ordinary one: it timestamps, carries levels, and
// respects the user's log-level setting, so trace output costs nothing when nobody is
// looking. `console.log` only reaches the Extension Host log, which is not something we
// can ask a user to find.
//
// What this is for: launching the proxy means launching-or-reusing a SINGLETON, and the
// discovery line does not say which happened. A reused daemon may be an older release's,
// with an older feature set and possibly the wrong bind addresses, and until now nothing
// on either side of the extension pair could tell. `step` is a stable identifier -- grep
// for `startProxy.reused-stale` rather than reading sentences.
let logChannel: vscode.LogOutputChannel | undefined;
let extVersion = "unknown";

function trace(step: string, meta: Record<string, unknown> = {}) {
    const detail = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    logChannel?.info(`${step}${detail}`);
}

function traceWarn(step: string, meta: Record<string, unknown> = {}) {
    const detail = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    logChannel?.warn(`${step}${detail}`);
}

/**
 * Record what the singleton actually handed us, and whether that is what this build asked for.
 *
 * Two things can silently not happen, and they fail in opposite ways:
 *
 *  - **Version.** `mdbg proxy` only takes over from a *strictly older* daemon. An equal version
 *    reuses, which is correct for a second window but means a rebuild during development (same
 *    `CARGO_PKG_VERSION`, and dev mode sets `--idle-timeout 0` so the daemon never exits) keeps
 *    talking to a daemon built hours ago. A handover that was attempted and *failed* also falls
 *    back to reuse, and says so only in the daemon's own log file.
 *  - **Widen.** Asking for an address the running daemon does not serve goes through the `widen`
 *    admin path. That one does report failure (`bind_errors`), but a caller that never compares
 *    the requested host against `hosts` cannot see a widen that was refused outright.
 */
function traceLaunchOutcome(policy: ProxyLaunchPolicy, result: ProxyLaunchResults) {
    const daemon = result.version;
    trace("startProxy.ready", {
        port: result.serverPort,
        daemonPid: result.pid,
        daemonVersion: daemon ?? "unknown",
        extVersion,
        hosts: result.hosts,
        bindErrors: result.bindErrors ?? [],
    });

    if (!daemon) {
        traceWarn("startProxy.version-unknown", {
            note: "daemon did not report a version; it predates the discovery `version` field",
        });
    } else if (daemon !== extVersion) {
        // Not fatal, and not necessarily wrong -- a newer daemon is the downgrade guard doing
        // its job. Either way the user is not running the proxy this extension shipped.
        traceWarn("startProxy.version-mismatch", {
            daemonVersion: daemon,
            extVersion,
            reused: "an already-running singleton answered instead of the binary we launched",
            // --all, not the bare form: the daemon that answered may be on another instance
            // (dev runs use `dev`), and without it only `default` is drained.
            hint: "`mdbg proxy --shutdown --all` drains them; the next launch starts this build",
        });
    }

    const wanted = policy?.bindHost;
    if (wanted && !result.hosts.includes(wanted)) {
        traceWarn("startProxy.host-not-served", {
            requested: wanted,
            hosts: result.hosts,
            note: "widen did not take -- the DA may not be able to reach this proxy",
        });
    }
}

function resolveNetworkMode(hostType: ProxyHostType = "auto") {
    return resolveProxyNetworkMode(hostType, vscode.env.remoteName);
}

function computeLaunchPolicy(hostType: ProxyHostType = "auto"): ProxyLaunchPolicy {
    const mode = resolveNetworkMode(hostType);
    return computeProxyLaunchPolicy(mode);
}

// Launch (or reuse) the singleton proxy and read its discovery line. `mdbg proxy`
// self-daemonizes: the process we spawn is a short-lived foreground launcher that
// re-spawns a detached daemon, forwards its discovery line to stdout, and exits.
// The daemon (owner) survives on its own; we never own or manage it.
function startProxyServerWrapper(proxyPolicy: ProxyLaunchPolicy): Promise<ProxyLaunchResults> {
    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        trace("startProxy.request", { policy: proxyPolicy, proxyPath });
        startProxyServerWithPolicy(proxyPolicy!, proxyPath, STARTUP_TIMEOUT_MS)
            .then((result: ProxyLaunchResults) => {
                if (result.serverPort === -1) {
                    // The launch-failure sentinel. The reason is only in these arrays, which
                    // every caller discards, so this is the one place it can be recorded.
                    traceWarn("startProxy.failed", {
                        errors: result.consoleErrors,
                        messages: result.consoleMessages,
                    });
                } else {
                    traceLaunchOutcome(proxyPolicy, result);
                }
                if (proxyPolicy!.reverseTunnelSshHost) {
                    // Start the reverse tunnel here — we already know the local port (json.port)
                    // so there is no need for the workspace extension to make a second round-trip.
                    startSshReverseTunnel(proxyPolicy!.reverseTunnelSshHost, result.serverPort!)
                        .then((remotePort) => {
                            trace("revTunnel.up", { sshHost: proxyPolicy!.reverseTunnelSshHost, remotePort, localPort: result.serverPort });
                            resolve({ ...result, reverseTunnelPort: remotePort });
                        })
                        .catch((err) => {
                            traceWarn("revTunnel.failed", { sshHost: proxyPolicy!.reverseTunnelSshHost, error: `${err}` });
                            reject(err);
                        });
                } else {
                    resolve(result);
                }
            })
            .catch((err) => {
                traceWarn("startProxy.rejected", { error: `${err}` });
                reject(err);
            });
    });
}

const STATUS_TIMEOUT_MS = 5_000;

/**
 * Run `mdbg proxy --status` and return its JSON report.
 *
 * This has to live on this side of the extension pair. The agent runs on the machine with
 * the probe, which in a remote window is *this* host, not the workspace one — so the main
 * extension can neither see this binary (it is inside this extension's install directory,
 * over here) nor reach the agent's loopback admin port. Commands cross extension hosts;
 * file paths and sockets do not.
 *
 * `--status` is a client mode: it queries whatever is already running and exits without
 * ever starting an agent, so calling this is free of side effects. It is also
 * instance-agnostic — it surveys every instance, so no `--instance` is passed and the
 * report covers a `dev` agent alongside the default one.
 *
 * Resolves `{ count: 0, instances: [] }` when no agent is running, and rejects only when
 * the binary could not be run at all.
 */
function proxyStatus(): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
        trace("status.request", { proxyPath });
        const child = spawn(proxyPath, ["proxy", "--status"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (fn: () => void) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                fn();
            }
        };
        const timer = setTimeout(() => {
            finish(() => {
                child.kill();
                traceWarn("status.timeout", { ms: STATUS_TIMEOUT_MS, stdout, stderr });
                reject(new Error(`'mdbg proxy --status' did not answer within ${STATUS_TIMEOUT_MS / 1000}s`));
            });
        }, STATUS_TIMEOUT_MS);

        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) => finish(() => {
            traceWarn("status.spawn-failed", { error: `${err}` });
            reject(new Error(`could not run '${proxyPath} proxy --status': ${err}`));
        }));
        // Wait for exit rather than parsing the first chunk: unlike a launch, there is no
        // single discovery line to watch for — the report is one JSON document that may
        // arrive in pieces, and the process is short-lived by design.
        child.on("close", (code) => finish(() => {
            try {
                const report = JSON.parse(stdout);
                trace("status.ok", { count: (report as { count?: number })?.count, exit: code });
                resolve(report);
            } catch (e) {
                traceWarn("status.unparseable", { exit: code, stdout, stderr, error: `${e}` });
                reject(new Error(`'mdbg proxy --status' returned no JSON (exit ${code}): ${stderr || stdout}`));
            }
        }));
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
    logChannel = vscode.window.createOutputChannel("MCU-Debug Proxy", { log: true });
    context.subscriptions.push(logChannel);
    extVersion = context.extension.packageJSON.version as string;
    const isDev = context.extensionMode === vscode.ExtensionMode.Development;
    if (isDev) {
        console.log("[mcu-debug-proxy] Running in development mode");
        setDevelopmentModeEnvVars();
    }
    trace("activate", {
        extVersion,
        dev: isDev,
        remoteName: vscode.env.remoteName ?? "local",
        // The daemon's own log records which branch it took ("Reusing existing proxy" /
        // "Newer proxy ... requesting handover"). That decision is made inside the launcher
        // process, not here, so point at the log rather than guessing. Same default the proxy
        // computes from `std::env::temp_dir()`, and it inherits this process's environment.
        daemonLogDir: path.join(os.tmpdir(), "mcu-debug", "proxy-logs"),
        instance: process.env["MDBG_PROXY_INSTANCE"] ?? "default",
    });
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

    const disposables = [
        // Liveness probe for the mcu-debug extension.
        //
        // That extension is `workspace`-kind, so in a remote window it runs in a different
        // extension host from this one and `vscode.extensions.getExtension()` cannot see us —
        // extension registries are per-host, commands are not. Calling this is therefore the
        // only way it can find out whether we are installed, and the call activates us as a
        // side effect. The version lets it detect a mismatched pair, which matters because the
        // two extensions are published in lockstep.
        //
        // Keep this free of side effects and cheap: it is called on activation and before
        // every launch that needs a remote probe.
        vscode.commands.registerCommand("mcu-debug-proxy.ping", () => {
            return { version: context.extension.packageJSON.version as string };
        }),
        // The main command the mcu-debug extension calls to obtain the proxy. It
        // launches-or-reuses the singleton and returns its port + reported token.
        vscode.commands.registerCommand("mcu-debug-proxy.startProxyServer", (policy: ProxyLaunchPolicy) => {
            if (policy) {
                return startProxyServerWrapper(policy);
            }
            // Returning undefined reads to the caller as "the command is not there", which is a
            // very different problem from the one it has. Leave a record of which it was.
            traceWarn("startProxy.no-policy", { note: "command invoked without a ProxyLaunchPolicy" });
        }),
        // Report on the Probe Agent(s) running on this machine. Like `ping`, deliberately
        // NOT in `contributes.commands`: the palette entry users should find belongs on the
        // main extension, which is the one always installed and the one that can say "the
        // proxy extension is missing". Two similar entries would just invite picking the one
        // that does nothing in a remote window.
        vscode.commands.registerCommand("mcu-debug-proxy.proxyStatus", () => proxyStatus()),
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
    ];
    context.subscriptions.push(...disposables);
    return {
        resolveNetworkMode,
        computeLaunchPolicy,
        startProxyServer: startProxyServerWrapper,
    };
}

function getRemoteShhHost() {
    const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? "";
    const host = authority.replace(/^ssh-remote\+/, "");
    return host || null;
}

export function deactivate() {
    // The shared singleton proxy is intentionally NOT killed here — other windows
    // and the CLI may be using it, and it self-reaps via idle-timeout once no
    // sessions remain. We only tear down our own SSH reverse tunnel.
    killSshReverseTunnel();
}
