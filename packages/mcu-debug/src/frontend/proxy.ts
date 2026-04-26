
import { ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { spawn } from "child_process";
import { computeProxyLaunchPolicy, ProxyHostType, ProxyLaunchPolicy, ProxyLaunchResults, ProxyNetworkMode, resolveProxyNetworkMode } from "@mcu-debug/shared";
import { MCUDebugChannel } from "../dbgmsgs";
import { HostConfig, awaitWithTimeout, getAnyFreePort, getHelperExecutable } from "../adapter/servers/common";
import { time } from "console";

let localProxyProcess: ChildProcess | null = null;

interface SshTunnelConfig {
    sshHost: string;
    sshPort: number;
    localPort: number;
    args: string[];
    fingerprint: string; // key over all config fields that affect what tunnel/agent is running
}
/** Attempt a TCP connection to host:port within timeoutMs. Returns true if the connection
 *  succeeds (socket connected), false on any error or timeout. Used to pre-flight the
 *  WSL NAT proxy path while we still have access to the VS Code UI. */
function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, timeoutMs);
        socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

// Stable string over every config field that determines whether an existing SSH tunnel+agent can be reused.
// Any change to these fields → cache miss → full restart.
function sshCacheFingerprint(hc: HostConfig): string {
    return JSON.stringify({
        sshHost: hc.sshHost ?? null,
        sshProxyPort: hc.sshProxyPort ?? null, // null vs undefined → stable comparison
        token: hc.token ?? null,
        sshProxyServerPath: hc.sshProxyServerPath ?? null,
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
const SSH_RUN_TIMEOUT_MS = 15000;
const SSH_DEPLOY_TIMEOUT_MS = 60000;
const SSH_AGENT_LAUNCH_TIMEOUT_MS = 30000;
const REMOTE_HELPER_PATH = "~/.mcu-debug/bin/mcu-debug-helper";

let _extensionPath = "";

// Runs a command on the remote host via SSH. Returns trimmed stdout on success,
// rejects with a descriptive error on non-zero exit or timeout.
async function sshRunHelper(hostConfig: HostConfig, command: string, timeoutMs = SSH_RUN_TIMEOUT_MS): Promise<string> {
    const sshHost = hostConfig.sshHost!;
    return new Promise<string>((resolve, reject) => {
        MCUDebugChannel.debugMessage(`Running SSH command on ${sshHost}: ${command}`);
        const proc = spawn("ssh", [sshHost, command]);
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
                MCUDebugChannel.debugMessage(`SSH command succeeded on ${sshHost}: ${command}\n${stdout.trim()}`);
                resolve(stdout.trim());
            } else {
                MCUDebugChannel.debugMessage(`SSH command failed (exit ${code}) on ${sshHost}: ${command}\n${stderr.trim()}`);
                reject(new Error(`SSH command failed (exit ${code}) on ${sshHost}: ${command}\n${stderr.trim()}`));
            }
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            MCUDebugChannel.debugMessage(`SSH process error on ${sshHost}: ${err.message}`);
            reject(new Error(`SSH process error on ${sshHost}: ${err.message}`));
        });
    });
}

// Deploys the mcu-debug-helper binary to REMOTE_HELPER_PATH on the remote host.
// Detects remote OS/arch via `uname -sm`, selects the matching local binary, and
// streams it over SSH stdin — no scp required, so it works on all platforms.
async function sshCopyHelper(hostConfig: HostConfig): Promise<void> {
    const sshHost = hostConfig.sshHost!;

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

    const localBinary = path.join(_extensionPath, "bin", archDir, "mcu-debug-helper");
    if (!fs.existsSync(localBinary)) {
        throw new Error(`Local helper binary not found for ${archDir}: ${localBinary}`);
    }

    await new Promise<void>((resolve, reject) => {
        const args = [sshHost, `mkdir -p ~/.mcu-debug/bin && rm -f ${REMOTE_HELPER_PATH} && cat > ${REMOTE_HELPER_PATH} && chmod +x ${REMOTE_HELPER_PATH}`];
        MCUDebugChannel.debugMessage(`Deploying helper binary ${localBinary} to ${sshHost}: ssh ${args.join(" ")}`);
        const proc = spawn("ssh", args);

        let stderr = "";
        proc.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
        });

        const timer = setTimeout(() => {
            proc.kill();
            MCUDebugChannel.debugMessage(`Binary deploy to ${sshHost} timed out after ${SSH_DEPLOY_TIMEOUT_MS / 1000}s`);
            reject(new Error(`Binary deploy to ${sshHost} timed out after ${SSH_DEPLOY_TIMEOUT_MS / 1000}s`));
        }, SSH_DEPLOY_TIMEOUT_MS);

        proc.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                MCUDebugChannel.debugMessage(`Binary deploy to ${sshHost} succeeded`);
                resolve();
            } else {
                MCUDebugChannel.debugMessage(`Binary deploy to ${sshHost} failed (exit ${code}): ${stderr.trim()}`);
                reject(new Error(`Binary deploy to ${sshHost} failed (exit ${code}): ${stderr.trim()}`));
            }
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            MCUDebugChannel.debugMessage(`SSH deploy process error on ${sshHost}: ${err.message}`);
            reject(new Error(`SSH deploy process error on ${sshHost}: ${err.message}`));
        });

        const readStream = fs.createReadStream(localBinary);
        readStream.on("error", (err) => {
            clearTimeout(timer);
            proc.kill();
            MCUDebugChannel.debugMessage(`Failed to read local binary ${localBinary} on ${sshHost}: ${err.message}`);
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
}
// Starts the proxy server on the remote host via SSH by running the deployed helper binary with appropriate arguments.
// The token is generated here and passed as --token; the binary echoes it back in the Discovery JSON so we can verify
// the right process responded. The SSH process stays alive (running the proxy) after emitting the single JSON line.
async function startSshProxyServer(hostConfig: HostConfig): Promise<ProxyLaunchResults> {
    const sshHost = hostConfig.sshHost!;

    // Kill any stale agent from a previous session
    killSshAgent();

    // Generate token before spawn — we pass it in, we don't trust the channel to invent it
    const token = crypto.randomBytes(16).toString("hex");
    const remoteHelperPath = hostConfig.sshProxyServerPath || REMOTE_HELPER_PATH;
    const remoteCmd = `${remoteHelperPath} proxy --port 0 --token ${token}`;

    return new Promise<ProxyLaunchResults>((resolve, reject) => {
        MCUDebugChannel.debugMessage(`Starting SSH proxy server on ${sshHost} with command: ssh ${sshHost} ${remoteCmd}`);
        const proc = spawn("ssh", [sshHost, remoteCmd]);
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

        proc.stderr?.on("data", (d: Buffer) => {
            const line = d.toString().trim();
            MCUDebugChannel.debugMessage(`SSH proxy agent stderr on ${sshHost}: ${line}`);
        });

        proc.stdout?.on("data", (d: Buffer) => {
            stdoutBuf += d.toString();
            MCUDebugChannel.debugMessage(`SSH proxy agent stdout on ${sshHost}: ${d.toString().trim()}`);
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

            if (!parsed.port || parsed.port <= 0) {
                fail(`SSH proxy agent on ${sshHost} reported invalid port: ${parsed.port}`);
                return;
            }

            // Verify the token echoed back matches what we sent — catches wires-crossed / stale-process scenarios
            if (parsed.token && parsed.token !== token) {
                fail(`SSH proxy agent on ${sshHost} echoed unexpected token — possible process mismatch`);
                return;
            }

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
            });
        });

        proc.on("exit", (code) => {
            if (!settled) {
                fail(`SSH proxy agent on ${sshHost} exited prematurely (code ${code}). Check host, credentials, and that the binary is deployed`);
            } else {
                sshAgentProcess = null;
                if (code !== 0 && code !== null) {
                    vscode.window.showErrorMessage(`SSH proxy agent on ${sshHost} exited unexpectedly with code ${code}`);
                }
            }
        });

        proc.on("error", (err) => {
            fail(`SSH proxy agent process error on ${sshHost}: ${err.message}`);
        });
    });
}

async function startSshTunnel(hostConfig: HostConfig): Promise<void> {
    if (!hostConfig?.enabled || hostConfig?.pvtNetworkMode !== "ssh") {
        return;
    }
    const sshHost = hostConfig.sshHost || hostConfig.pvtProxyHost;
    if (!sshHost) {
        throw new Error("SSH host not defined for SSH tunnel");
    }
    let sshPort = hostConfig.sshProxyPort || hostConfig.pvtProxyPort;
    if (!sshPort) {
        // Clear any existing token if port is not defined, to avoid confusion with stale tunnels. If we are going to be starting a
        // tunnel, any existing token would be invalid anyway, so better to require a clean slate.
        hostConfig.token = undefined;
    }
    const fingerprint = sshCacheFingerprint(hostConfig);
    if (sshTunnelProcess) {
        const isDaemonMode = !!hostConfig.sshProxyPort;
        const fingerprintMatch = sshTunnelConfig?.fingerprint === fingerprint;
        const agentAlive = isDaemonMode || !!sshAgentProcess; // daemon has no extension-managed agent process
        if (fingerprintMatch && agentAlive) {
            hostConfig.pvtProxyToken = (proxyLaunchResults!.token as string) || hostConfig.token;
            hostConfig.pvtProxyPort = sshTunnelConfig!.localPort;
            hostConfig.pvtProxyHost = "127.0.0.1";
            return; // reuse existing tunnel
        }
        const reason = !fingerprintMatch ? `launch config changed (${sshTunnelConfig?.sshHost} → ${sshHost})` : `per-session agent process exited unexpectedly`;
        MCUDebugChannel.debugMessage(`Existing SSH tunnel invalidated: ${reason}. Restarting from scratch.`);
        vscode.window.showWarningMessage(`SSH tunnel restarting: ${reason}.`);
        killSshAgent();
        killSshTunnel();
    }

    if (sshHost && !sshPort) {
        if (!hostConfig.sshProxyServerPath) {
            try {
                await sshCopyHelper(hostConfig);
            } catch (error) {
                MCUDebugChannel.debugMessage(`Failed to deploy SSH helper binary to ${sshHost}: ${error}`);
                vscode.window.showErrorMessage(`Failed to deploy helper binary for SSH proxy: ${error}. Cannot start SSH tunnel.`);
                return Promise.reject(error);
            }
        }
        try {
            const result = await startSshProxyServer(hostConfig);
            proxyLaunchResults = result;
            MCUDebugChannel.debugMessage(`SSH proxy server started on ${sshHost} with port ${result.serverPort}`);
            sshPort = result && result.serverPort ? result.serverPort : undefined;
        } catch (error) {
            MCUDebugChannel.debugMessage(`Failed to start SSH proxy server on ${sshHost}: ${error}`);
            vscode.window.showErrorMessage(`Failed to start SSH proxy server: ${error}. Cannot start SSH tunnel.`);
            return Promise.reject(error);
        }
    }

    if (!sshHost || !sshPort) {
        throw new Error("SSH host or port not defined for SSH tunnel");
    }

    const localPort = await getAnyFreePort(56978);
    const args = ["-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${sshPort}`, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", sshHost];
    const cmdString = `ssh ${args.join(" ")}`;

    return new Promise<void>((resolve, reject) => {
        MCUDebugChannel.debugMessage(`Starting SSH tunnel with command: ${cmdString}`);
        const proc = spawn("ssh", args);
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let pollHandle: ReturnType<typeof setTimeout> | undefined;

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
            MCUDebugChannel.debugMessage(`SSH tunnel failed to start for ${sshHost}: ${msg}`);
            vscode.window.showErrorMessage(`Failed to start SSH tunnel: ${msg}`);
            reject(new Error(msg));
        };

        const succeed = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            sshTunnelProcess = proc;
            sshTunnelConfig = { sshHost, sshPort, localPort, args, fingerprint };
            vscode.window.showInformationMessage(`SSH tunnel started: ${cmdString}`);
            MCUDebugChannel.debugMessage(`SSH tunnel started for ${sshHost} on local port ${localPort}`);
            resolve();
        };

        // If SSH exits before we've confirmed the tunnel is up, it failed
        proc.on("exit", (code) => {
            if (!settled) {
                fail(`SSH process exited prematurely (code ${code}). Check host and credentials: ${sshHost}`);
            } else {
                if (code !== 0 && code !== null) {
                    MCUDebugChannel.debugMessage(`SSH tunnel process for ${sshHost} exited with code ${code}`);
                    vscode.window.showErrorMessage(`SSH tunnel to ${sshHost} exited with code ${code}`);
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

let currentPolicy: ProxyLaunchPolicy | null = null;
let proxyLaunchResults: ProxyLaunchResults | null = null;
let currentHostConfig: HostConfig | null = null;
export async function launchProxyServerFromExtension(policy: ProxyLaunchPolicy): Promise<ProxyLaunchResults | null> {
    try {
        const command = "mcu-debug-proxy.startProxyServer";
        const value = await vscode.commands.executeCommand<ProxyLaunchResults | null>(command, policy);
        proxyLaunchResults = value;
        currentPolicy = policy;
        return value;
    } catch (error) {
        proxyLaunchResults = null;
        currentPolicy = null;
        vscode.window.showErrorMessage(`Failed to launch proxy server: ${error}, mcu-debug-proxy extension not activated? Please try again. Report this problem if it continues to happen`);
        return null;
    }
}

export async function getCurrentProxyLaunchResults(policy: ProxyLaunchPolicy): Promise<ProxyLaunchResults | null> {
    const command = "mcu-debug-proxy.getProxyResults";
    try {
        const value = await vscode.commands.executeCommand<ProxyLaunchResults | null>(command);
        if (!value || !value.serverPort || value.serverPort <= 0) {
            proxyLaunchResults = null;
            return null;
        }
        if (value.serverPort !== proxyLaunchResults?.serverPort || value.token !== proxyLaunchResults?.token || value.policy.bindHost !== proxyLaunchResults?.policy.bindHost) {
            proxyLaunchResults = null;
            return null;
        }
        return value;
    } catch {
        vscode.window.showErrorMessage(`Failed to get current proxy launch results. mcu-debug-proxy extension not activated? Please try again. Report this problem if it continues to happen`);
        return null;
    }
}

function resolveNetworkMode(hostConfig: HostConfig): ProxyNetworkMode | undefined {
    const hostType = hostConfig?.type as ProxyHostType | undefined;
    if (!hostType) {
        return undefined;
    }
    return resolveProxyNetworkMode(hostType, vscode.env.remoteName);
}


async function resolveWslGatewayHost(): Promise<string | undefined> {
    // Primary: ask the UI extension (mcu-debug-proxy) which runs on the Windows host.
    // It reads os.networkInterfaces() directly and returns the IPv4 address of the
    // WSL virtual ethernet adapter — authoritative, not subject to DNS relay quirks.
    try {
        const fromProxy = await vscode.commands.executeCommand<string | null>("mcu-debug-proxy.getWslHostIp");
        if (fromProxy) {
            return fromProxy;
        }
    } catch {
        // mcu-debug-proxy not available or command failed — fall through to local fallback.
    }
    // Fallback: parse the nameserver from /etc/resolv.conf on the WSL guest side.
    // Less reliable: on some configurations the nameserver is a Hyper-V DNS relay
    // (168.63.x.x) rather than the WSL gateway IP. Kept as a safety net.
    try {
        const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
        const match = resolv.match(/^nameserver\s+(\S+)$/m);
        if (match && match[1]) {
            return match[1].trim();
        }
    } catch {
        // Ignore errors and fall back to loopback.
    }
    return undefined;
}

async function handleLocalHostConfig(hostConfig: HostConfig): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
        // We need to spawn the proxy server on the local machine, but the DA will connect to it via the loopback interface,
        // so no network setup is needed. We can set the mode and return immediately.
        const extPath = _extensionPath;
        const helperPath = getHelperExecutable(extPath);
        hostConfig.pvtNetworkMode = "local";
        hostConfig.pvtProxyHost = "127.0.0.1";
        const token = crypto.randomBytes(16).toString("hex");
        hostConfig.pvtProxyToken = token;
        let settled = false;
        let timeout: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            settled = true;
            if (localProxyProcess) {
                localProxyProcess.kill();
                localProxyProcess = null;
            }
        }
        getAnyFreePort(66778).then((port) => {
            localProxyProcess = spawn(helperPath, ["proxy", "--port", port.toString(), "--token", token]);
            localProxyProcess.stdout?.on("data", (data: Buffer) => {
                const line = data.toString().trim();
                MCUDebugChannel.debugMessage(`Local proxy stdout: ${line}`);
            });
            localProxyProcess.stderr?.on("data", (data: Buffer) => {
                const line = data.toString().trim();
                MCUDebugChannel.debugMessage(`Local proxy stderr: ${line}`);
            });
            localProxyProcess.on("exit", (code) => {
                cleanup();
                MCUDebugChannel.debugMessage(`Local proxy process exited with code ${code}`);
                if (code !== 0 && code !== null) {
                    vscode.window.showErrorMessage(`Local proxy process exited with code ${code}`);
                }
            });
            localProxyProcess.on("error", (err) => {
                cleanup();
                MCUDebugChannel.debugMessage(`Local proxy process error: ${err.message}`);
                vscode.window.showErrorMessage(`Local proxy process error: ${err.message}`);
            });
            localProxyProcess.on("spawn", () => {
                MCUDebugChannel.debugMessage(`Local proxy process started on port ${port}`);
                hostConfig.pvtProxyPort = port;
                settled = true;
                resolve();
            });
            timeout = setTimeout(() => {
                if (!settled) {
                    reject(new Error("Local proxy process failed to start within timeout"));
                }
                timeout = undefined;
                cleanup();
            }, 2000);
        }).catch((err) => {
            reject(new Error(`Failed to get free port for local proxy: ${err.message}`));
        });
    });
}

export async function handleHostConfig(hostConfig: HostConfig | undefined, delConfig: () => void): Promise<void> {
    if (hostConfig && hostConfig.enabled) {
        if (!hostConfig.type || typeof hostConfig.type !== "string" || !["local", "ssh", "auto"].includes(hostConfig.type)) {
            vscode.window.showWarningMessage(
                'hostConfig.type is required when hostConfig.enabled is true. Proxy server will not be used. Please set hostConfig.type to "local", "ssh", or "auto" (recommended).',
            );
            delConfig();
            return;
        }
        const resolvedMode = resolveNetworkMode(hostConfig);
        hostConfig.pvtNetworkMode = resolvedMode;
        if (resolvedMode === "ssh") {
            // Topology B — LAB: probe on a separate physical machine. We deploy the helper binary,
            // launch the Probe Agent on the remote host, and establish an SSH -L tunnel so the DA
            // can reach the agent via 127.0.0.1:<localPort>.
            try {
                await startSshTunnel(hostConfig);
                hostConfig.pvtProxyBindHost = "127.0.0.1";
                hostConfig.pvtProxyPort = sshTunnelConfig?.localPort as number;
                hostConfig.pvtProxyToken = proxyLaunchResults!.token as string;
                currentHostConfig = { ...hostConfig };
            } catch (error) {
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
            // Fall back to hostConfig.sshHost if the user provides it explicitly.
            const hostFromProxy = await vscode.commands.executeCommand<string | null>("mcu-debug-proxy.getRemoteSshHost");
            const sshHostForReverse = hostConfig.sshHost || hostFromProxy || undefined;
            if (!sshHostForReverse) {
                const msg = "auto-ssh-remote: could not determine SSH host from mcu-debug-proxy. Please specify hostConfig.sshHost explicitly.";
                vscode.window.showErrorMessage(msg);
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
            let current = await awaitWithTimeout(getCurrentProxyLaunchResults(policy), 10000);
            if (!current || !currentPolicy || currentPolicy.bindHost !== policy.bindHost) {
                current = await awaitWithTimeout(launchProxyServerFromExtension(policy), 10000);
                if (!current) {
                    throw new Error("Proxy server did not launch in a timely manner or had an error. mcu-debug-proxy extension not activated? Please try again.");
                }
            }
            if (proxyLaunchResults?.serverPort == null || proxyLaunchResults.serverPort <= 0) {
                vscode.window.showErrorMessage("mcu-debug-proxy did not return a valid port");
                throw new Error("mcu-debug-proxy did not return a valid port");
            }
            if (!proxyLaunchResults.reverseTunnelPort || proxyLaunchResults.reverseTunnelPort <= 0) {
                const msg = `SSH reverse tunnel to ${sshHostForReverse} did not return a valid remote port`;
                vscode.window.showErrorMessage(msg);
                throw new Error(msg);
            }

            hostConfig.pvtProxyHost = "127.0.0.1"; // DA connects to its loopback on the remote host
            hostConfig.pvtProxyPort = proxyLaunchResults.reverseTunnelPort;
            hostConfig.pvtProxyToken = proxyLaunchResults.token as string;
            currentHostConfig = { ...hostConfig };
        } else if (resolvedMode) {
            const policy = computeProxyLaunchPolicy(resolvedMode);
            let resolvedProxyHost = policy.proxyHostForDA;

            if (resolvedMode === "auto-wsl" && resolvedProxyHost === "<wsl-gateway-ip>") {
                resolvedProxyHost = (await resolveWslGatewayHost()) || "127.0.0.1";
            }

            const isWslNatMode = resolvedMode === "auto-wsl" && resolvedProxyHost !== "127.0.0.1";
            if (isWslNatMode) {
                // NAT mode: the Proxy Agent binds on 0.0.0.0. Windows Firewall will block
                // OS-assigned ports UNLESS there is an application-level inbound rule for the
                // helper executable (Windows prompts automatically on first run — clicking
                // "Allow access" creates this rule). In that case any port works and
                // wslProxyPort is not needed. It is only required on machines where the
                // prompt was dismissed or group policy manages rules by port only.
                if (hostConfig.wslProxyPort && hostConfig.wslProxyPort > 0) {
                    policy.fixedPort = hostConfig.wslProxyPort;
                }
            }

            if (!hostConfig.pvtProxyBindHost) {
                hostConfig.pvtProxyBindHost = policy.bindHost;
            }

            if (!hostConfig.pvtProxyHost) {
                hostConfig.pvtProxyHost = resolvedProxyHost;
            }
            let current = await awaitWithTimeout(getCurrentProxyLaunchResults(policy), 10000);
            if (!current || !currentPolicy || currentPolicy.bindHost !== policy.bindHost || currentPolicy.fixedPort !== policy.fixedPort) {
                current = await awaitWithTimeout(launchProxyServerFromExtension(policy), 10000);
                if (!current) {
                    throw new Error(
                        "Proxy server did not launch in a timely manner or had an error. mcu-debug-proxy extension not activated?. Please try again. Report this problem if it continues to happen",
                    );
                }
            }
            if (proxyLaunchResults?.serverPort == null || proxyLaunchResults.serverPort <= 0) {
                vscode.window.showErrorMessage("mcu-debug-proxy did not return a valid port");
                throw new Error("mcu-debug-proxy did not return a valid port");
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
                let reachable = await tcpReachable(resolvedProxyHost, proxyLaunchResults.serverPort, 2000);
                if (!reachable) {
                    const choice = await vscode.window.showErrorMessage(
                        `WSL NAT: cannot reach Proxy Agent at ${resolvedProxyHost}:${proxyLaunchResults.serverPort}. ` +
                        "A Windows Security Alert may have appeared — switch to Windows, click \"Allow access\", " +
                        "then click Retry.",
                        { modal: true },
                        "Retry",
                    );
                    if (choice !== "Retry") {
                        throw new Error(`WSL NAT: cannot reach Proxy Agent at ${resolvedProxyHost}:${proxyLaunchResults.serverPort}. Cancelled.`);
                    }
                    reachable = await tcpReachable(resolvedProxyHost, proxyLaunchResults.serverPort, 2000);
                    if (!reachable) {
                        const msg =
                            `WSL NAT: cannot reach Proxy Agent at ${resolvedProxyHost}:${proxyLaunchResults.serverPort}. ` +
                            "Windows Firewall is still blocking the connection. " +
                            "Set hostConfig.wslProxyPort to a port you have opened in Windows Firewall.";
                        vscode.window.showErrorMessage(msg);
                        throw new Error(msg);
                    }
                }
            }
            hostConfig.pvtProxyPort = proxyLaunchResults!.serverPort as number;
            hostConfig.pvtProxyToken = proxyLaunchResults!.token as string;
            currentHostConfig = { ...hostConfig };
        } else if (resolvedMode === "local") {
            // This is allowed only in two circumstances:
            // 1) the user explicitly sets type: "local" -- and this is meant for testing. Not production
            // 2) for serial ports that are locallly accessible and there is no existing hostConfig alread existing
            try {
                await handleLocalHostConfig(hostConfig);
                currentHostConfig = { ...hostConfig };
            } catch (error) {
                MCUDebugChannel.debugMessage(`Failed to start local proxy server: ${error}`);
                vscode.window.showErrorMessage(`Failed to start local proxy server: ${error}. Cannot use local proxy configuration.`);
                throw error;
            }
        } else {
            vscode.window.showWarningMessage(
                `Unknown hostConfig.type "${hostConfig.type}". Proxy server will not be used. Please set hostConfig.type to "local", "ssh", or "auto" (recommended).`,
            );
            delConfig;
        }
    } else {
        delConfig;
    }
}

/**
 * 
 * @param hostConfig - used when no previous result exists
 * @returns Either a cached and resolved HostConfig or a newly resolved one
 * 
 * Note: Do not cached this result at a higher level. Things can change underneath us (e.g. the user can change the
 * config via launch.json, or the SSH tunnel can drop) and we want to be resilient to that. The proxyLaunchResults are
 * cached and will be validated for staleness on each call, so we can rely on that for correctness.
 */
export async function getProxyForSerialPorts(hostConfig: HostConfig | undefined): Promise<HostConfig | null> {
    if (!proxyLaunchResults) {
        try {
            if (!hostConfig) {
                hostConfig = {
                    type: vscode.env.remoteName ? "auto" : "local",
                    enabled: true,
                }
            }
            await handleHostConfig(hostConfig, () => { });
        } catch (error) {
            return null;
        }
    }
    return currentHostConfig;
}
