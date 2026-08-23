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
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { spawn } from "child_process";
import { DefaultPortBase, SSH_BATCH_OPTS, computeProxyLaunchPolicy, ProxyHostType, ProxyLaunchPolicy, ProxyLaunchResults, ProxyNetworkMode, resolveProxyNetworkMode, startOrReuseProxyServerOnWslHost, startProxyServerWithPolicy, fmtBindErrors, formatThrown, generateNonce } from "@mcu-debug/shared";
import { HostConfig, awaitWithTimeout, getAnyFreePort, getHelperExecutable } from "../adapter/servers/common";
import { getHostAdapter } from "./host-adapter";
import { pkgJsonVersion } from "../commit-hash";
import { tcpReachable } from "./utils";

interface SshTunnelConfig {
    sshHost: string;
    sshPort: number;
    localPort: number;
    args: string[];
    fingerprint: string; // key over all config fields that affect what tunnel/agent is running
    /** Token of the Probe Agent this tunnel reaches.
     *
     *  Lives here rather than in a module-wide slot because it is a property of *this*
     *  tunnel: `killSshTunnel()` clears this object, which invalidates the token at
     *  exactly the moment it stops being valid. */
    token: string;
}

// Stable string over every config field that determines whether an existing SSH tunnel+agent can be reused.
// Any change to these fields → cache miss → full restart.
function sshCacheFingerprint(hc: HostConfig): string {
    return JSON.stringify({
        sshHost: hc.ssh?.host ?? null,
        sshProxyPort: hc.ssh?.proxyPort ?? null, // null vs undefined → stable comparison
        token: hc.ssh?.token ?? null,
        sshProxyServerPath: hc.ssh?.serverPath ?? null,
    });
}

let sshTunnelProcess: ChildProcess | null = null;
let sshTunnelConfig: SshTunnelConfig | null = null;
function killSshTunnel() {
    if (sshTunnelProcess) {
        sshTunnelProcess.kill();
        sshTunnelProcess = null;
    }
    sshTunnelConfig = null;
}

let sshAgentProcess: ChildProcess | null = null;
function killSshAgent() {
    if (sshAgentProcess) {
        sshAgentProcess.kill();
        sshAgentProcess = null;
    }
}

const SSH_TUNNEL_TIMEOUT_MS = 15000;
const SSH_TUNNEL_POLL_MS = 250;
// Deliberately short. This runs on the reuse path of every launch and every cached serial
// request, and the round trip is at most one ssh hop to an agent that is either answering
// promptly or not answering at all — there is no slow-but-healthy case to accommodate.
// Waiting longer only delays the rebuild that is going to happen anyway.
const PROXY_PROBE_TIMEOUT_MS = 2000;
const SSH_RUN_TIMEOUT_MS = 15000;
const SSH_DEPLOY_TIMEOUT_MS = 60000;
const SSH_AGENT_LAUNCH_TIMEOUT_MS = 30000;
const REMOTE_HELPER_PATH = "~/.mcu-debug/bin/mdbg"; // The ~ will be expanded by the remote shell.

// Appends ssh's own stderr to an error message. Because we run with BatchMode=yes
// (SSH_BATCH_OPTS), an unusable login fails instantly and says exactly why here —
// "Permission denied (publickey)", "Host key verification failed", "Could not resolve
// hostname". Without this the user only sees our generic wrapper text.
function fmtSshStderr(stderr: string): string {
    const trimmed = stderr.trim();
    return trimmed ? `\nssh: ${trimmed}` : "";
}

// Runs a command on the remote host via SSH. Returns trimmed stdout on success,
// rejects with a descriptive error on non-zero exit or timeout.
async function sshRunHelper(hostConfig: HostConfig, command: string, timeoutMs = SSH_RUN_TIMEOUT_MS): Promise<string> {
    const sshHost = hostConfig.ssh!.host;
    return new Promise<string>((resolve, reject) => {
        getHostAdapter().debugMessage(`Running SSH command on ${sshHost}: ${command}`);
        const proc = spawn("ssh", [...SSH_BATCH_OPTS, sshHost, command], { windowsHide: true });
        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (d: Buffer) => {
            stdout += d.toString();
        });
        proc.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
        });

        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`SSH command timed out after ${timeoutMs / 1000}s on ${sshHost}: ${command}`));
        }, timeoutMs);

        proc.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                getHostAdapter().debugMessage(`SSH command succeeded on ${sshHost}: ${command}\n${stdout.trim()}`);
                resolve(stdout.trim());
            } else {
                getHostAdapter().debugMessage(`SSH command failed (exit ${code}) on ${sshHost}: ${command}\n${stderr.trim()}`);
                reject(new Error(`SSH command failed (exit ${code}) on ${sshHost}: ${command}\n${stderr.trim()}`));
            }
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            getHostAdapter().debugMessage(`SSH process error on ${sshHost}: ${err.message}`);
            reject(new Error(`SSH process error on ${sshHost}: ${err.message}`));
        });
    });
}

/**
 * Quote a remote executable path for the shell on the far side of `ssh`.
 *
 * Double quotes rather than single, because this string may be interpreted by a POSIX shell
 * *or* by cmd.exe, and double quotes are the only form both honour — cmd.exe does not treat
 * `'` as quoting at all and would pass it through as part of the filename. That matters as
 * soon as `ssh.serverPath` is used, which is the configuration that lets a Windows host work:
 * `C:\Program Files\...` is an ordinary path there, and unquoted it splits at the space.
 *
 * A leading `~/` is left outside the quotes. Tilde expansion happens only on an unquoted
 * tilde, so quoting the whole path would turn our own default into a literal filename
 * starting with a tilde character.
 */
export function quoteRemotePath(p: string): string {
    return p.startsWith("~/") ? `~/"${p.slice(2)}"` : `"${p}"`;
}

// Deploys the mcu-debug binary to REMOTE_HELPER_PATH on the remote host.
// Detects remote OS/arch via `uname -sm`, selects the matching local binary, and
// streams it over SSH stdin — no scp required, so it works on all platforms.
async function sshCopyHelper(hostConfig: HostConfig): Promise<void> {
    const sshHost = hostConfig.ssh!.host;

    // Detect remote OS + arch in one round trip. e.g. "Linux x86_64", "Linux aarch64"
    const unameOut = await sshRunHelper(hostConfig, "uname -sm");
    const archMap: Record<string, string> = {
        "Linux x86_64": "linux-x64",
        "Linux aarch64": "linux-arm64",
        "Linux arm64": "linux-arm64",
        "Darwin x86_64": "darwin-x64",
        "Darwin arm64": "darwin-arm64",
    };
    const archDir = archMap[unameOut];
    if (!archDir) {
        throw new Error(`Unsupported remote OS/arch: "${unameOut}"`);
    }

    const binName = "mdbg";
    const localBinary = path.join(getHostAdapter().getExtensionPath(), "bin", archDir, binName);
    if (!fs.existsSync(localBinary)) {
        throw new Error(`Local helper binary not found for ${archDir}: ${localBinary}`);
    }

    await new Promise<void>((resolve, reject) => {
        const args = [...SSH_BATCH_OPTS, sshHost, `mkdir -p ~/.mcu-debug/bin && rm -f ${REMOTE_HELPER_PATH} && cat > ${REMOTE_HELPER_PATH} && chmod +x ${REMOTE_HELPER_PATH}`];
        getHostAdapter().debugMessage(`Deploying helper binary ${localBinary} to ${sshHost}: ssh ${args.join(" ")}`);
        const proc = spawn("ssh", args, { windowsHide: true });

        let stderr = "";
        proc.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
        });

        const timer = setTimeout(() => {
            proc.kill();
            getHostAdapter().debugMessage(`Binary deploy to ${sshHost} timed out after ${SSH_DEPLOY_TIMEOUT_MS / 1000}s`);
            reject(new Error(`Binary deploy to ${sshHost} timed out after ${SSH_DEPLOY_TIMEOUT_MS / 1000}s`));
        }, SSH_DEPLOY_TIMEOUT_MS);

        proc.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                getHostAdapter().debugMessage(`Binary deploy to ${sshHost} succeeded`);
                resolve();
            } else {
                getHostAdapter().debugMessage(`Binary deploy to ${sshHost} failed (exit ${code}): ${stderr.trim()}`);
                reject(new Error(`Binary deploy to ${sshHost} failed (exit ${code}): ${stderr.trim()}`));
            }
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            getHostAdapter().debugMessage(`SSH deploy process error on ${sshHost}: ${err.message}`);
            reject(new Error(`SSH deploy process error on ${sshHost}: ${err.message}`));
        });

        const readStream = fs.createReadStream(localBinary);
        readStream.on("error", (err) => {
            clearTimeout(timer);
            proc.kill();
            getHostAdapter().debugMessage(`Failed to read local binary ${localBinary} on ${sshHost}: ${err.message}`);
            reject(new Error(`Failed to read local binary ${localBinary} on ${sshHost}: ${err.message}`));
        });
        readStream.pipe(proc.stdin!);
    });
}

interface RemoteProxyOutput {
    status: string;
    port: number;
    pid: number;
    token: string;
    /** Version of the agent now listening on `port`. Optional: agents older than this field
     *  omit it, and an SSH host is exactly where such an agent turns up, since the user may
     *  have installed it themselves. */
    version?: string;
    bind_errors?: string[];
}

/**
 * Reject a version mismatch here, where the numbers are still in hand.
 *
 * The agent enforces this itself at `initialize`, but that is several steps later — after we
 * have deployed or launched a binary and built an SSH tunnel to it — and the failure arrives as
 * a protocol error a long way from the cause. The discovery line carries the agent's version, so
 * the cheap check is the early one.
 *
 * A blank or absent version means an agent predating the field. That is not a mismatch we can
 * assert, so it is passed through and left to `initialize`, which has always checked.
 */
function checkAgentVersion(agentVersion: string | undefined, where: string): void {
    if (!agentVersion) {
        getHostAdapter().debugMessage(
            `Proxy Agent on ${where} did not report a version — it predates that field. ` +
            "Compatibility will be decided at initialize.",
        );
        return;
    }
    if (agentVersion === pkgJsonVersion) {
        return;
    }
    throw new Error(
        `Proxy Agent version mismatch on ${where}: the agent is ${agentVersion}, this extension is ${pkgJsonVersion}. ` +
        "They must match exactly — neither side accepts an older or newer peer. " +
        `Replace the agent with the mdbg shipped inside the matching extension (see the "Getting the mdbg binary" ` +
        "section of the SSH documentation).",
    );
}
// Starts the proxy server on the remote host via SSH by running the deployed helper binary with appropriate arguments.
// The token is generated here and passed as --token; the binary echoes it back in the Discovery JSON so we can verify
// the right process responded. The SSH process stays alive (running the proxy) after emitting the single JSON line.
async function startSshProxyServer(hostConfig: HostConfig): Promise<ProxyLaunchResults> {
    const sshHost = hostConfig.ssh!.host;

    // Kill any stale agent from a previous session
    killSshAgent();

    // Generate token before spawn — we pass it in, we don't trust the channel to invent it
    let token = generateNonce(16);
    const remoteHelperPath = hostConfig.ssh?.serverPath || REMOTE_HELPER_PATH;
    const remoteCmd = `${quoteRemotePath(remoteHelperPath)} proxy --port 0 --token ${token}`;

    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        getHostAdapter().debugMessage(`Starting SSH proxy server on ${sshHost} with command: ssh ${sshHost} ${remoteCmd}`);
        const proc = spawn("ssh", [...SSH_BATCH_OPTS, sshHost, remoteCmd], { windowsHide: true });
        let settled = false;
        let stdoutBuf = "";

        const fail = (msg: string) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            proc.kill();
            sshAgentProcess = null;
            reject(new Error(msg));
        };

        const timer = setTimeout(() => {
            fail(`SSH proxy agent on ${sshHost} did not emit Discovery JSON within ${SSH_AGENT_LAUNCH_TIMEOUT_MS / 1000}s`);
        }, SSH_AGENT_LAUNCH_TIMEOUT_MS);

        // Kept, not just logged: with BatchMode=yes an auth or host-key failure exits
        // immediately and the only explanation is here ("Permission denied (publickey)",
        // "Host key verification failed"). The exit handler puts it in the error.
        let stderrBuf = "";
        proc.stderr?.on("data", (d: Buffer) => {
            const line = d.toString().trim();
            stderrBuf += d.toString();
            getHostAdapter().debugMessage(`SSH proxy agent stderr on ${sshHost}: ${line}`);
        });

        proc.stdout?.on("data", (d: Buffer) => {
            stdoutBuf += d.toString();
            getHostAdapter().debugMessage(`SSH proxy agent stdout on ${sshHost}: ${d.toString().trim()}`);
            // Wait for a complete newline-terminated line
            const nl = stdoutBuf.indexOf("\n");
            if (nl === -1) {
                return;
            }
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);

            let parsed: RemoteProxyOutput;
            try {
                parsed = JSON.parse(line);
            } catch {
                fail(`SSH proxy agent on ${sshHost} emitted non-JSON on stdout: ${line}`);
                return;
            }

            const bindErrors = fmtBindErrors(parsed);
            if (bindErrors && bindErrors.length > 0) {
                const str = bindErrors.join("\t\n");
                getHostAdapter().debugMessage(`SSH proxy agent on ${sshHost} reported bind errors: ${str}`);
                return;
            }

            if (!parsed.port || parsed.port <= 0) {
                fail(`SSH proxy agent on ${sshHost} reported invalid port: ${parsed.port}`);
                return;
            }

            // Before the tunnel, not after. This is the SSH path, where the agent may be one the
            // user installed and updated on their own schedule, so it is the likeliest place for
            // the versions to drift apart.
            try {
                checkAgentVersion(parsed.version, sshHost);
            } catch (e: any) {
                fail(e.message);
                return;
            }

            // The token can be different from what we passed in if the agent was already running and reused its existing token.
            // The fingerpring could have mismatched but there may already be a running agent with a valid token, so we accept
            // whatever the agent actually uses.
            if (!(parsed.token as string) || parsed.token.length < 16) {
                fail(`SSH proxy agent on ${sshHost} echoed no token — cannot trust it`);
                return;
            }
            token = parsed.token as string; // update to whatever the agent actually uses

            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            sshAgentProcess = proc; // proc stays alive; store for lifecycle management

            const policy = computeProxyLaunchPolicy("ssh");
            resolve({
                policy,
                consoleMessages: [],
                consoleErrors: [],
                token,
                serverPort: parsed.port,
                hosts: [],
                bindErrors: null,
            });
        });

        proc.on("exit", (code) => {
            if (!settled) {
                fail(`SSH proxy agent on ${sshHost} exited prematurely (code ${code}). Check host, credentials, and that the binary is deployed.${fmtSshStderr(stderrBuf)}`);
            } else {
                sshAgentProcess = null;
                if (code !== 0 && code !== null) {
                    getHostAdapter().showError(`SSH proxy agent on ${sshHost} exited unexpectedly with code ${code}`);
                }
            }
        });

        proc.on("error", (err) => {
            fail(`SSH proxy agent process error on ${sshHost}: ${err.message}`);
        });
    });
}

/**
 * Is a Proxy Agent still answering at `host:port`?
 *
 * Used before reusing anything we resolved earlier — an SSH tunnel, or a cached endpoint from
 * a previous request. The need is sharpest for SSH but the question is the same everywhere:
 * we are about to hand a caller an address we have not checked since we learned it.
 *
 * A TCP connect is not evidence. For `ssh -L` in particular it proves nothing at all: ssh
 * binds the local port at startup and keeps it bound for its whole life, so `connect()`
 * succeeds even when the agent on the far side is long gone — the same reason `pollPort()`
 * below can only tell us ssh is up, not that anything is listening on the other end. Reusing
 * on that evidence is how a dead agent turns into a session that hangs with no explanation.
 *
 * So we speak one word of the protocol. `heartbeat` is the right word: the agent answers it
 * unconditionally — no `initialize`, no token, no session state touched — so a probe cannot
 * disturb an agent that *is* healthy. (`initialize` would be actively wrong here: it does a
 * `remove_dir_all` on the session directory.)
 *
 * The reply is parsed rather than merely counted, because "something accepted the connection"
 * is not the claim we need. If the agent died and its port was recycled by an unrelated
 * process, that process may well send a banner; matching `seq` and `success` says the thing on
 * the other end is our agent and is processing messages.
 *
 * Never rejects — an unreachable agent is the expected answer, not an error.
 */
export function probeProxyAlive(host: string, port: number, timeoutMs = PROXY_PROBE_TIMEOUT_MS): Promise<boolean> {
    const PROBE_SEQ = 1; // seq 0 is reserved for unsolicited server events
    return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        let rx = Buffer.alloc(0);

        const done = (alive: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(alive);
        };

        // A wedged agent that accepts but never answers looks the same as a dead one from
        // here, and for our purposes it is one: we cannot run a session through it either.
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref();

        socket.once("connect", () => {
            const payload = Buffer.from(JSON.stringify({ seq: PROBE_SEQ, method: "heartbeat" }), "utf-8");
            const header = Buffer.alloc(5);
            header.writeUInt8(0, 0); // stream_id 0 — the control channel
            header.writeUInt32LE(payload.length, 1);
            socket.write(Buffer.concat([header, payload]));
        });

        socket.on("data", (chunk: Buffer) => {
            rx = Buffer.concat([rx, chunk]);
            if (rx.length < 5) {
                return; // header not complete yet
            }
            const streamId = rx.readUInt8(0);
            const length = rx.readUInt32LE(1);
            if (rx.length < 5 + length) {
                return; // payload not complete yet
            }
            if (streamId !== 0) {
                done(false); // not the control channel — not our agent's answer
                return;
            }
            try {
                const msg = JSON.parse(rx.subarray(5, 5 + length).toString("utf-8"));
                done(msg?.seq === PROBE_SEQ && msg?.success === true);
            } catch {
                done(false);
            }
        });

        // Both are ordinary outcomes when the agent is gone: ssh answers the channel-open
        // failure by closing the connection it just accepted from us.
        socket.once("error", () => done(false));
        socket.once("close", () => done(false));

        socket.connect(port, host);
    });
}

// Sets `hostConfig.pvtProxy{Host,Port,Token}` on success — all three, on both the
// reuse and fresh-launch paths, so no caller has to reach for the agent's token from
// somewhere else.
async function startSshTunnel(hostConfig: HostConfig): Promise<void> {
    if (!hostConfig?.enabled || hostConfig?.pvtNetworkMode !== "ssh") {
        return;
    }
    const sshHost = hostConfig.ssh?.host || hostConfig.pvtProxyHost;
    if (!sshHost) {
        throw new Error("SSH host not defined for SSH tunnel");
    }
    let sshPort = hostConfig.ssh?.proxyPort || hostConfig.pvtProxyPort;
    // Daemon mode supplies the token in launch.json; otherwise the agent we start below
    // mints one and reports it in its discovery line.
    let agentToken = (hostConfig.ssh?.token as string) || "";
    if (!sshPort) {
        // Clear any existing token if port is not defined, to avoid confusion with stale tunnels. If we are going to be starting a
        // tunnel, any existing token would be invalid anyway, so better to require a clean slate.
        if (hostConfig.ssh) { hostConfig.ssh.token = undefined; }
    }
    const fingerprint = sshCacheFingerprint(hostConfig);
    if (sshTunnelProcess) {
        const fingerprintMatch = sshTunnelConfig?.fingerprint === fingerprint;
        // Matching config is necessary but not sufficient: the tunnel also has to still
        // reach a live agent. Probed on every reuse because nothing here observes the far
        // side otherwise — the agent runs on another machine, and since the proxy became a
        // singleton it may be shared with, and outlive or be outlived by, sessions we know
        // nothing about.
        const tunnelAlive = fingerprintMatch && (await probeProxyAlive("127.0.0.1", sshTunnelConfig!.localPort));
        if (fingerprintMatch && tunnelAlive) {
            hostConfig.pvtProxyToken = sshTunnelConfig!.token || (hostConfig.ssh?.token as string);
            hostConfig.pvtProxyPort = sshTunnelConfig!.localPort;
            hostConfig.pvtProxyHost = "127.0.0.1";
            return; // reuse existing tunnel
        } else if (!fingerprintMatch) {
            getHostAdapter().debugMessage(`SSH tunnel fingerprint mismatch: ${sshTunnelConfig?.fingerprint} vs ${fingerprint}`);
        }
        const reason = !fingerprintMatch
            ? `launch config changed (${sshTunnelConfig?.sshHost} → ${sshHost})`
            : `no Proxy Agent answered through the existing tunnel to ${sshTunnelConfig?.sshHost} within ${PROXY_PROBE_TIMEOUT_MS / 1000}s`;
        getHostAdapter().debugMessage(`Existing SSH tunnel invalidated: ${reason}. Restarting from scratch.`);
        getHostAdapter().showWarning(`SSH tunnel restarting: ${reason}.`);
        killSshAgent();
        killSshTunnel();
    }

    if (sshHost && !sshPort) {
        if (!hostConfig.ssh?.serverPath) {
            try {
                await sshCopyHelper(hostConfig);
            } catch (error) {
                getHostAdapter().debugMessage(`Failed to deploy SSH helper binary to ${sshHost}: ${error}`);
                getHostAdapter().showError(`Failed to deploy helper binary for SSH proxy: ${error}. Cannot start SSH tunnel.`);
                return Promise.reject(error);
            }
        }
        try {
            const result = await startSshProxyServer(hostConfig);
            agentToken = (result.token as string) || agentToken;
            getHostAdapter().debugMessage(`SSH proxy server started on ${sshHost} with port ${result.serverPort}`);
            sshPort = result && result.serverPort ? result.serverPort : undefined;
        } catch (error) {
            getHostAdapter().debugMessage(`Failed to start SSH proxy server on ${sshHost}: ${error}`);
            getHostAdapter().showError(`Failed to start SSH proxy server: ${error}. Cannot start SSH tunnel.`);
            return Promise.reject(error);
        }
    }

    if (!sshHost || !sshPort) {
        throw new Error("SSH host or port not defined for SSH tunnel");
    }

    const localPort = await getAnyFreePort(DefaultPortBase.sshTunnel);
    const args = ["-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${sshPort}`, ...SSH_BATCH_OPTS, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", sshHost];
    const cmdString = `ssh ${args.join(" ")}`;

    return new Promise<void>((resolve, reject) => {
        getHostAdapter().debugMessage(`Starting SSH tunnel with command: ${cmdString}`);
        const proc = spawn("ssh", args, { windowsHide: true });
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let pollHandle: ReturnType<typeof setTimeout> | undefined;
        // See startSshProxyServer: with BatchMode=yes this is where the reason for a
        // fast failure appears, so it has to reach the error message.
        let stderrBuf = "";
        proc.stderr?.on("data", (d: Buffer) => {
            stderrBuf += d.toString();
        });

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            clearTimeout(pollHandle);
        };

        const fail = (msg: string) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            proc.kill();
            sshTunnelProcess = null;
            getHostAdapter().debugMessage(`SSH tunnel failed to start for ${sshHost}: ${msg}`);
            getHostAdapter().showError(`Failed to start SSH tunnel: ${msg}`);
            reject(new Error(msg));
        };

        const succeed = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            sshTunnelProcess = proc;
            sshTunnelConfig = { sshHost, sshPort, localPort, args, fingerprint, token: agentToken };
            hostConfig.pvtProxyToken = agentToken;
            getHostAdapter().showInfo(`SSH tunnel started: ${cmdString}`);
            getHostAdapter().debugMessage(`SSH tunnel started for ${sshHost} on local port ${localPort}`);
            resolve();
        };

        // If SSH exits before we've confirmed the tunnel is up, it failed
        proc.on("exit", async (code) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (!settled) {
                fail(`SSH process exited prematurely (code ${code}). Check host and credentials: ${sshHost}.${fmtSshStderr(stderrBuf)}`);
            } else {
                if (code !== 0 && code !== null) {
                    getHostAdapter().debugMessage(`SSH tunnel process for ${sshHost} exited with code ${code}`);
                    getHostAdapter().showError(`SSH tunnel to ${sshHost} exited with code ${code}`);
                }
                sshTunnelProcess = null;
            }
        });

        proc.on("error", (err) => {
            fail(`SSH tunnel process error (${cmdString}): ${err.message}`);
        });

        // Abort if the tunnel takes too long to come up
        timeoutHandle = setTimeout(() => {
            fail(`SSH tunnel timed out after ${SSH_TUNNEL_TIMEOUT_MS / 1000}s connecting to ${sshHost}`);
        }, SSH_TUNNEL_TIMEOUT_MS);

        // Poll by attempting a TCP connection to the local forwarded port.
        // ECONNREFUSED means SSH hasn't bound the port yet (nothing held open — no interference).
        // A successful connect means SSH is listening and the tunnel is up; close immediately.
        // Note: if the remote proxy is not running, SSH still binds the local port, so this
        // check passes regardless. Remote-not-running is detected later at protocol level.
        const pollPort = () => {
            const socket = new net.Socket();
            socket.once("connect", () => {
                socket.destroy();
                succeed();
            });
            socket.once("error", () => {
                // ECONNREFUSED: SSH hasn't bound the local port yet. On loopback this
                // returns instantly — no real network path involved, so no hang risk.
                socket.destroy();
                if (!settled) {
                    pollHandle = setTimeout(pollPort, SSH_TUNNEL_POLL_MS);
                }
            });
            socket.connect(localPort, "127.0.0.1");
        };
        pollHandle = setTimeout(pollPort, SSH_TUNNEL_POLL_MS);
    });
}


// Resolved hostConfigs cached per proxy request, keyed by the fields that
// determine WHICH proxy a request resolves to (type, ssh host/port/token,
// proxy override, remote name). This replaces the single `currentHostConfig`
// global whose one slot short-circuited *every* getProxyForSerialPorts call to
// whatever was resolved first — the bug that made local + remote serial ports
// impossible at the same time. A changed request produces a different key →
// cache miss → re-resolve, so launch.json edits invalidate automatically.
const resolvedHostConfigs = new Map<string, HostConfig>();

/**
 * Drop everything a previous resolution wrote, leaving only what the user asked for.
 *
 * The `pvt*` fields are outputs, but several are read back as inputs on the next pass to
 * mean "an agent is already running here". That is only true when they came from a
 * resolution that is still current, so a config being re-resolved has to shed them first.
 * Deliberately exhaustive over the `pvt*` fields of HostConfig: a field missed here is a
 * stale value silently trusted later.
 */
function clearResolvedProxyFields(hc: HostConfig): void {
    hc.pvtProxyHost = undefined;
    hc.pvtProxyBindHost = undefined;
    hc.pvtProxyPort = undefined;
    hc.pvtProxyToken = undefined;
    hc.pvtSshTunnelLocalPort = undefined;
    hc.pvtNetworkMode = undefined;
    hc.pvtResolved = undefined;
}

function proxyRequestFingerprint(hc: HostConfig): string {
    return JSON.stringify({
        type: hc.type ?? null,
        sshHost: hc.ssh?.host ?? null,
        sshProxyPort: hc.ssh?.proxyPort ?? null,
        token: hc.ssh?.token ?? null,
        sshProxyServerPath: hc.ssh?.serverPath ?? null,
        proxy: hc.proxy ?? null,
        remoteName: getHostAdapter().getRemoteName() ?? null,
    });
}
export async function launchProxyServerFromExtension(policy: ProxyLaunchPolicy): Promise<ProxyLaunchResults | null> {
    if (policy.mode.includes("wsl") || policy.mode === "local") {
        try {
            const result = await startOrReuseProxyServerOnWslHost(policy);
            const bindErrors = fmtBindErrors(result);
            if (bindErrors && bindErrors.length > 0) {
                getHostAdapter().showError(`Proxy server reported bind errors: ${bindErrors.join("\t\n")}`);
                return null
            }
            return result;
        } catch (error) {
            // We could remove this in the future
            getHostAdapter().showError(`Failed to quick-start proxy server on WSL host: ${error}. Trying another way`);
        }
    }
    try {
        const command = "mcu-debug-proxy.startProxyServer";
        const value = await getHostAdapter().executeProxyCommand<ProxyLaunchResults | null>(command, policy);
        const bindErrors = fmtBindErrors(value);
        if (bindErrors && bindErrors.length > 0) {
            getHostAdapter().showError(`Proxy server reported bind errors: ${bindErrors.join("\t\n")}`);
            return null
        }
        return value;
    } catch (error) {
        getHostAdapter().showError(`Failed to launch proxy server: ${error}, mcu-debug-proxy extension not activated? Please try again. Report this problem if it continues to happen`);
        return null;
    }
}

function resolveNetworkMode(hostConfig: HostConfig): ProxyNetworkMode | undefined {
    const hostType = hostConfig?.type as ProxyHostType | undefined;
    if (!hostType) {
        return undefined;
    }
    return resolveProxyNetworkMode(hostType, getHostAdapter().getRemoteName());
}


async function handleLocalHostConfig(hostConfig: HostConfig): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
        // We need to spawn the proxy server on the local machine, but the DA will connect to it via the loopback interface,
        // so no network setup is needed. We can set the mode and return immediately.
        const helperPath = getHelperExecutable(getHostAdapter().getExtensionPath());
        const policy = computeProxyLaunchPolicy("local");
        startProxyServerWithPolicy(policy, helperPath, 10000).then((launchResults) => {
            hostConfig.pvtNetworkMode = "local";
            hostConfig.pvtProxyHost = "127.0.0.1";
            hostConfig.pvtProxyPort = launchResults.serverPort!;
            hostConfig.pvtProxyToken = launchResults.token;
            resolve();
        }).catch((err) => {
            reject(err);
        });
    });
    return promise;
}

/** Name of the environment variable both ends read for the shared token. */
export const PROXY_TOKEN_ENV = "MDBG_PROXY_TOKEN";

/**
 * Expand a `${env:NAME}` reference. VS Code does this for launch.json before the DA
 * ever sees it, but the CLI has no such preprocessing — so the same config text has to
 * work in both, and this makes it so.
 */
function expandEnvRef(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
    const m = value?.match(/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
    return m ? env[m[1]] : value;
}

/**
 * Validate and resolve `hostConfig.proxy` into a concrete endpoint.
 *
 * Pure and exported so the rules can be tested without a host adapter or a live proxy.
 * Returns null when no override is configured. Throws when one is present but cannot be
 * completed — a partial endpoint has nothing to fall back on, and every way of guessing
 * fails late and obscurely (a connection timeout, or an auth rejection from the agent)
 * rather than here, where the mistake actually is.
 *
 * The token may come from the config or from `MDBG_PROXY_TOKEN`. The environment is not
 * a guess: the operator set it deliberately, and the agent reads the same variable — so
 * one export configures both ends and keeps the secret out of source control. What is
 * never assumed is the agent's *built-in* default token.
 */
export function resolveProxyOverride(
    override: { host?: string; port?: number; token?: string } | undefined,
    env: NodeJS.ProcessEnv = process.env,
): { host: string; port: number; token: string } | null {
    if (!override) {
        return null;
    }
    const host = override.host?.trim();
    const port = override.port;
    const token = expandEnvRef(override.token, env)?.trim() || env[PROXY_TOKEN_ENV]?.trim();

    const missing: string[] = [];
    if (!host) {
        missing.push("host");
    }
    if (port === undefined || port === null || !Number.isInteger(port) || port <= 0 || port > 65535) {
        missing.push("port");
    }
    if (!token) {
        missing.push(`token (or set ${PROXY_TOKEN_ENV})`);
    }
    if (missing.length > 0) {
        throw new Error(
            `hostConfig.proxy is incomplete: missing ${missing.join(", ")}. ` +
            "All of host, port and token are required — they describe a Probe Agent you started yourself, " +
            "so there is nothing to fall back on. Run `mcu-debug proxy --status` on the machine with the probe " +
            "to read its port and its bound addresses.",
        );
    }
    return { host: host as string, port: port as number, token: token as string };
}

/**
 * Apply `hostConfig.proxy` to the `pvtProxy*` fields, short-circuiting all detection.
 * Returns false when no override is configured.
 * 
 * Prints error message besides throwing if the override is present but invalid, so the caller doesn't have to worry about it.
 */
function applyProxyOverride(hostConfig: HostConfig): boolean {
    let endpoint;
    try {
        endpoint = resolveProxyOverride(hostConfig.proxy);
    } catch (e: any) {
        getHostAdapter().showError(e.message);
        throw e;
    }
    if (!endpoint) {
        return false;
    }
    hostConfig.pvtNetworkMode = "override";
    hostConfig.pvtProxyHost = endpoint.host;
    hostConfig.pvtProxyPort = endpoint.port;
    hostConfig.pvtProxyToken = endpoint.token;
    hostConfig.pvtResolved = true;
    getHostAdapter().debugMessage(`Using hostConfig.proxy override: ${endpoint.host}:${endpoint.port} (no detection, no launch)`);
    return true;
}

/**
 * This function MUST print an error message before throwing, so the caller doesn't have to worry about it.
 */
export async function handleHostConfig(hostConfig: HostConfig | undefined, delConfig: () => void): Promise<void> {
    if (hostConfig && hostConfig.enabled) {
        // Checked before `type`: the override says "I manage the agent", which makes the
        // topology irrelevant. Requiring a meaningful `type` alongside it would be asking
        // for information we have just been told not to use.
        if (applyProxyOverride(hostConfig)) {
            return;
        }
        if (!hostConfig.type || typeof hostConfig.type !== "string" || !["local", "ssh", "auto"].includes(hostConfig.type)) {
            getHostAdapter().showWarning(
                'hostConfig.type is required when hostConfig.enabled is true. Proxy server will not be used. Please set hostConfig.type to "local", "ssh", or "auto" (recommended).',
            );
            delConfig();
            return;
        }
        const resolvedMode = resolveNetworkMode(hostConfig);
        if (resolvedMode === "auto-local") {
            // There is no remote name and no ssh was specified. So, nothing for us to do, run it as if it were 
            // totall local.
            hostConfig.enabled = false;
            delConfig();
            return;
        }
        hostConfig.pvtNetworkMode = resolvedMode;
        if (resolvedMode === "ssh") {
            // Topology B — LAB: probe on a separate physical machine. We deploy the helper binary,
            // launch the Probe Agent on the remote host, and establish an SSH -L tunnel so the DA
            // can reach the agent via 127.0.0.1:<localPort>.
            try {
                // startSshTunnel sets pvtProxyHost/Port/Token for both the fresh and
                // reused-tunnel paths.
                await startSshTunnel(hostConfig);
                hostConfig.pvtProxyBindHost = "127.0.0.1";
                hostConfig.pvtProxyPort = sshTunnelConfig?.localPort as number;
            } catch (error) {
                const msg = `Failed to start SSH tunnel: ${formatThrown(error)}. Please check hostConfig.ssh.host, hostConfig.ssh.proxyPort, and hostConfig.ssh.token.`;
                getHostAdapter().showError(msg);
                throw error;
            }
        } else if (resolvedMode === "auto-ssh-remote") {
            // Topology A — VS Code Remote SSH: the workspace extension (and DA) run on the remote SSH
            // host, but the probe is on the Engineer Machine where the UI extension runs. The Proxy
            // Agent is spawned locally by mcu-debug-proxy (same as other auto-* modes).
            //
            // The DA is on the remote side and cannot reach 127.0.0.1:<proxyPort> on the Engineer
            // Machine directly. We solve this with an SSH reverse tunnel (-R):
            //   ssh -R localhost:0:127.0.0.1:<localProxyPort> -N <sshHost>
            // This asks the SSH server to bind a random port on its loopback; connections to that
            // port are forwarded back to localhost:<localProxyPort> on the Engineer Machine.
            // mcu-debug-proxy (UI extension) establishes the tunnel and returns the allocated remote
            // port. The DA then connects to 127.0.0.1:<remotePort> on the remote host.
            //
            // Ask the UI extension (mcu-debug-proxy) for the SSH host alias. It runs on
            // the Engineer Machine and reads the workspace folder URI authority
            // ("ssh-remote+HOSTNAME") — stable public API, no proposed API required.
            // Fall back to hostConfig.ssh?.host if the user provides it explicitly.
            const hostFromProxy = await getHostAdapter().executeProxyCommand<string | null>("mcu-debug-proxy.getRemoteSshHost");
            const sshHostForReverse = hostConfig.ssh?.host || hostFromProxy || undefined;
            if (!sshHostForReverse) {
                const msg = "auto-ssh-remote: could not determine SSH host from mcu-debug-proxy. Please specify hostConfig.ssh?.host explicitly.";
                getHostAdapter().showError(msg);
                throw new Error(msg);
            }

            const policy = computeProxyLaunchPolicy(resolvedMode);
            // Tell the proxy extension to start the reverse tunnel as part of startProxyServer.
            // It already knows the local port the moment the proxy is ready, so there is no
            // need for a separate round-trip through the workspace extension.
            policy.reverseTunnelSshHost = sshHostForReverse;
            if (!hostConfig.pvtProxyBindHost) {
                hostConfig.pvtProxyBindHost = policy.bindHost;
            }

            // Ensure the proxy is running on the Engineer Machine (and the reverse tunnel is up)
            const current = await awaitWithTimeout(launchProxyServerFromExtension(policy), 10000);
            if (!current) {
                throw new Error("Proxy server did not launch in a timely manner or had an error. mcu-debug-proxy extension not activated? Please try again.");
            }
            if (current.serverPort == null || current.serverPort <= 0) {
                const msg = `mcu-debug-proxy did not return a valid port ${JSON.stringify(current)}`;
                getHostAdapter().showError(msg);
                throw new Error(msg);
            }
            if (!current.reverseTunnelPort || current.reverseTunnelPort <= 0) {
                const msg = `SSH reverse tunnel to ${sshHostForReverse} did not return a valid remote port`;
                getHostAdapter().showError(msg);
                throw new Error(msg);
            }

            hostConfig.pvtProxyHost = "127.0.0.1"; // DA connects to its loopback on the remote host
            hostConfig.pvtProxyPort = current.reverseTunnelPort;
            hostConfig.pvtProxyToken = current.token as string;
        } else if (resolvedMode === "local") {
            // This is allowed only in two circumstances:
            // 1) the user explicitly sets type: "local" -- and this is meant for testing. Not production
            // 2) for serial ports that are locallly accessible and there is no existing hostConfig alread existing
            try {
                await handleLocalHostConfig(hostConfig);
            } catch (error) {
                getHostAdapter().debugMessage(`Failed to start local proxy server: ${error}`);
                getHostAdapter().showError(`Failed to start local proxy server: ${error}. Cannot use local proxy configuration.`);
                throw error;
            }
        } else if (resolvedMode) {
            const policy = computeProxyLaunchPolicy(resolvedMode);
            // Already a concrete address: computeProxyLaunchPolicy resolves the WSL
            // gateway itself now. It used to return the literal string
            // "<wsl-gateway-ip>" for every caller to substitute, which meant any caller
            // that trusted the field handed a bogus hostname to connect().
            const resolvedProxyHost = policy.proxyHostForDA;

            // Loopback here means either mirrored networking or a gateway lookup that
            // failed — in both cases there is nothing to open a firewall port for.
            // NAT mode: the Proxy Agent binds the WSL gateway address, which is not
            // loopback, so Windows Firewall blocks it until there is an inbound rule for
            // the executable. Windows prompts on first run and "Allow access" creates an
            // application-level rule that permits any port, so the OS-assigned port is
            // fine. A fixed port is only useful where rules are managed by port instead —
            // and that case is served by starting the agent yourself and pointing
            // `hostConfig.proxy` at it, rather than by a launch option here.
            const isWslNatMode = resolvedMode === "auto-wsl" && resolvedProxyHost !== "127.0.0.1";

            if (!hostConfig.pvtProxyBindHost) {
                hostConfig.pvtProxyBindHost = policy.bindHost;
            }

            if (!hostConfig.pvtProxyHost) {
                hostConfig.pvtProxyHost = resolvedProxyHost;
            }
            const current = await awaitWithTimeout(launchProxyServerFromExtension(policy), 10000);
            if (!current) {
                const msg = "Proxy server did not launch in a timely manner or had an error. mcu-debug-proxy extension not activated?. Please try again. Report this problem if it continues to happen";
                getHostAdapter().showError(msg);
                throw new Error(msg);
            }
            if (current.serverPort == null || current.serverPort <= 0) {
                const msg = `mcu-debug-proxy did not return a valid port ${JSON.stringify(current)}`;
                getHostAdapter().showError(msg);
                throw new Error(msg);
            }
            if (isWslNatMode) {
                // Probe reachability now, while we still have access to the VS Code UI.
                // The DA runs without UI and would silently time out on the same failure.
                //
                // On first run, Windows Firewall shows a Security Alert the moment the
                // first inbound connection arrives from WSL. That probe fails immediately
                // (the packet is blocked). We show a modal so the user can alt-tab to
                // Windows, click "Allow access", alt-tab back, and click Retry — all
                // without restarting the debug session. On subsequent runs the first probe
                // succeeds and this modal is never shown.
                let reachable = await tcpReachable(resolvedProxyHost, current.serverPort, 2000);
                if (!reachable) {
                    const choice = await getHostAdapter().showErrorWithChoice(
                        `WSL NAT: cannot reach Proxy Agent at ${resolvedProxyHost}:${current.serverPort}. ` +
                        "A Windows Security Alert may have appeared — switch to Windows, click \"Allow access\", " +
                        "then click Retry.",
                        true,
                        "Retry",
                    );
                    if (choice !== "Retry") {
                        throw new Error(`WSL NAT: cannot reach Proxy Agent at ${resolvedProxyHost}:${current.serverPort}. Cancelled.`);
                    }
                    reachable = await tcpReachable(resolvedProxyHost, current.serverPort, 2000);
                    if (!reachable) {
                        const msg =
                            `WSL NAT: cannot reach Proxy Agent at ${resolvedProxyHost}:${current.serverPort}. ` +
                            "Windows Firewall is still blocking the connection. " +
                            "Allow the mdbg executable through the firewall, or start the Probe Agent yourself " +
                            "on a port you have opened and point hostConfig.proxy at it.";
                        getHostAdapter().showError(msg);
                        throw new Error(msg);
                    }
                }
            }
            hostConfig.pvtProxyPort = current.serverPort as number;
            hostConfig.pvtProxyToken = current.token as string;
        } else {
            getHostAdapter().showWarning(
                `Unknown hostConfig.type "${hostConfig.type}". Proxy server will not be used. Please set hostConfig.type to "local", "ssh", or "auto" (recommended).`,
            );
            delConfig;
        }
    } else {
        delConfig;
    }
}

/**
 * Resolve the proxy a set of serial ports should use, caching the result per
 * request so distinct requests (e.g. a local request and an ssh request) each
 * resolve independently instead of clobbering one shared slot.
 *
 * @param hostConfig - the desired host configuration; when omitted, defaults to
 *   "auto" on a remote workspace and "local" otherwise.
 * @returns the resolved HostConfig (with pvtProxy* fields populated), or null if
 *   the request does not resolve to a usable proxy.
 *
 * Do not cache the return value at a higher level: the SSH tunnel can drop or
 * the proxy can restart under the same identity. The cache here is keyed by the
 * request fingerprint, so a launch.json edit changes the key and forces a fresh
 * resolution, and a hit is only returned after the endpoint answers a heartbeat —
 * neither of which protects a copy someone else is holding on to. Failures past
 * that point still surface via ProxyConnection.connect().
 */
export async function getProxyForSerialPorts(hostConfig: HostConfig | undefined): Promise<HostConfig | null> {
    if (!hostConfig) {
        hostConfig = {
            type: getHostAdapter().getRemoteName() ? "auto" : "local",
            enabled: true,
        };
    }
    const key = proxyRequestFingerprint(hostConfig);
    const cached = resolvedHostConfigs.get(key);
    if (cached) {
        // A cache hit is a claim about a remote process, and processes exit. The entry
        // records where a Proxy Agent answered *once*; the agent may since have died, or
        // the SSH tunnel behind it may have been torn down and rebuilt on a different
        // local port by a debug launch. Handing that address back produces a connect that
        // hangs or refuses, far from here and with nothing pointing at the stale entry —
        // so the endpoint is re-checked rather than assumed.
        if (await probeProxyAlive(cached.pvtProxyHost || "127.0.0.1", cached.pvtProxyPort as number)) {
            return cached;
        }
        getHostAdapter().debugMessage(
            `Cached proxy ${cached.pvtProxyHost}:${cached.pvtProxyPort} no longer answers — discarding and re-resolving.`,
        );
        resolvedHostConfigs.delete(key);
    }
    // Start from a clean slate. handleHostConfig and startSshTunnel both read pvtProxyPort
    // as an *input* when deciding whether an agent already exists, so a config carrying
    // values from a dead session would have them mistaken for a live endpoint — for the
    // host-only SSH variant, an old tunnel's local port read as the remote agent's port.
    clearResolvedProxyFields(hostConfig);
    try {
        // handleHostConfig resolves the proxy (reusing an already-running tunnel
        // / proxy where it can) and mutates hostConfig in place with pvtProxy*.
        await handleHostConfig(hostConfig, () => { });
    } catch (error) {
        return null;
    }
    if (!hostConfig.pvtProxyPort) {
        // Did not resolve to a proxy (e.g. auto-local: purely local, nothing to
        // launch). Don't cache — a later, better-specified request can retry.
        return null;
    }
    const resolved = { ...hostConfig };
    resolvedHostConfigs.set(key, resolved);
    return resolved;
}
