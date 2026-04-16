import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { computeProxyLaunchPolicy, findAvailablePortRange, ProxyHostType, ProxyLaunchPolicy, ProxyLaunchResults, ProxyNetworkMode, resolveProxyNetworkMode } from "@mcu-debug/shared";
import * as net from "net";
import * as crypto from "crypto";
import { STLinkServerController } from "../adapter/servers/stlink";
import { GDBServerConsole } from "./server_console";
import { parseAddress } from "./utils";
import {
    ChainedConfigurations,
    ChainedEvents,
    MCUDebugKeys,
    validateELFHeader,
    SymbolFile,
    defSymbolFile,
    ConfigurationArguments,
    SWOConfiguration,
    awaitWithTimeout,
    getAnyFreePort,
} from "../adapter/servers/common";
import { CDebugChainedSessionItem, CDebugSession } from "./cortex_debug_session";
import * as path from "path";
import { ChildProcess, spawn } from "child_process";
import { MCUDebugChannel } from "../dbgmsgs";

interface SshTunnelConfig {
    sshHost: string;
    sshPort: number;
    localPort: number;
    args: string[];
    fingerprint: string; // key over all config fields that affect what tunnel/agent is running
}

// Stable string over every config field that determines whether an existing SSH tunnel+agent can be reused.
// Any change to these fields → cache miss → full restart.
function sshCacheFingerprint(config: ConfigOptions): string {
    const hc = config.hostConfig!;
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
async function sshRunHelper(config: ConfigOptions, command: string, timeoutMs = SSH_RUN_TIMEOUT_MS): Promise<string> {
    const sshHost = config.hostConfig!.sshHost!;
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
async function sshCopyHelper(config: ConfigOptions): Promise<void> {
    const sshHost = config.hostConfig!.sshHost!;

    // Detect remote OS + arch in one round trip. e.g. "Linux x86_64", "Linux aarch64"
    const unameOut = await sshRunHelper(config, "uname -sm");
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
async function startSshProxyServer(config: ConfigOptions): Promise<ProxyLaunchResults> {
    const sshHost = config.hostConfig!.sshHost!;

    // Kill any stale agent from a previous session
    killSshAgent();

    // Generate token before spawn — we pass it in, we don't trust the channel to invent it
    const token = crypto.randomBytes(16).toString("hex");
    const remoteHelperPath = config.hostConfig!.sshProxyServerPath || REMOTE_HELPER_PATH;
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

async function startSshTunnel(config: ConfigOptions): Promise<void> {
    if (!config.hostConfig?.enabled || config.hostConfig?.pvtNetworkMode !== "ssh") {
        return;
    }
    const sshHost = config.hostConfig.sshHost || config.hostConfig.pvtProxyHost;
    if (!sshHost) {
        throw new Error("SSH host not defined for SSH tunnel");
    }
    let sshPort = config.hostConfig.sshProxyPort || config.hostConfig.pvtProxyPort;
    if (!sshPort) {
        // Clear any existing token if port is not defined, to avoid confusion with stale tunnels. If we are going to be starting a
        // tunnel, any existing token would be invalid anyway, so better to require a clean slate.
        config.hostConfig.token = undefined;
    }
    const fingerprint = sshCacheFingerprint(config);
    if (sshTunnelProcess) {
        const isDaemonMode = !!config.hostConfig.sshProxyPort;
        const fingerprintMatch = sshTunnelConfig?.fingerprint === fingerprint;
        const agentAlive = isDaemonMode || !!sshAgentProcess; // daemon has no extension-managed agent process
        if (fingerprintMatch && agentAlive) {
            config.hostConfig.pvtProxyToken = (proxyLaunchResults!.token as string) || config.hostConfig.token;
            config.hostConfig.pvtProxyPort = sshTunnelConfig!.localPort;
            config.hostConfig.pvtProxyHost = "127.0.0.1";
            return; // reuse existing tunnel
        }
        const reason = !fingerprintMatch ? `launch config changed (${sshTunnelConfig?.sshHost} → ${sshHost})` : `per-session agent process exited unexpectedly`;
        MCUDebugChannel.debugMessage(`Existing SSH tunnel invalidated: ${reason}. Restarting from scratch.`);
        vscode.window.showWarningMessage(`SSH tunnel restarting: ${reason}.`);
        killSshAgent();
        killSshTunnel();
    }

    if (sshHost && !sshPort) {
        if (!config.hostConfig!.sshProxyServerPath) {
            try {
                await sshCopyHelper(config);
            } catch (error) {
                MCUDebugChannel.debugMessage(`Failed to deploy SSH helper binary to ${sshHost}: ${error}`);
                vscode.window.showErrorMessage(`Failed to deploy helper binary for SSH proxy: ${error}. Cannot start SSH tunnel.`);
                return Promise.reject(error);
            }
        }
        try {
            const result = await startSshProxyServer(config);
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

type ConfigOptions = vscode.DebugConfiguration & ConfigurationArguments;

// Please confirm these names with OpenOCD source code. Their docs are incorrect as to case
const OPENOCD_VALID_RTOS: string[] = [
    "auto",
    "FreeRTOS",
    "ThreadX",
    "chibios",
    "Chromium-EC",
    "eCos",
    "embKernel",
    // 'hwthread',
    "linux",
    "mqx",
    "nuttx",
    "RIOT",
    "uCOS-III",
    "Zephyr",
];
const JLINK_VALID_RTOS: string[] = ["Azure", "ChibiOS", "embOS", "FreeRTOS", "NuttX", "Zephyr"];

export class CortexDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(private context: vscode.ExtensionContext) {
        _extensionPath = context.extensionPath;
    }

    private async resolveWslGatewayHost(): Promise<string | undefined> {
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

    private resolveNetworkMode(config: ConfigOptions): ProxyNetworkMode | undefined {
        const hostType = config.hostConfig?.type as ProxyHostType | undefined;
        if (!hostType) {
            return undefined;
        }
        return resolveProxyNetworkMode(hostType, vscode.env.remoteName);
    }

    public provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                name: "MCU Debug: Launch",
                cwd: "${workspaceFolder}",
                executable: "./bin/executable.elf",
                request: "launch",
                type: "mcu-debug",
                runToEntryPoint: "main",
                servertype: "jlink",
            },
        ];
    }

    public async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
        if (GDBServerConsole.BackendPort <= 0) {
            vscode.window.showErrorMessage("GDB server console not yet ready. Please try again. Report this problem");
            return undefined;
        }
        config.gdbServerConsolePort = GDBServerConsole.BackendPort;
        config.pvtAvoidPorts = CDebugSession.getAllUsedPorts();

        try {
            await this.handleHostConfig(config);
        } catch (error) {
            // All errors should already be surfaced in handleHostConfig, so we just return here to avoid cascading failures. The user can fix the issue and try again.
            return undefined; // Errors already surfaced in handleHostConfig
        }

        // Flatten the platform specific stuff as it is not done by VSCode at this point.
        switch (os.platform()) {
            case "darwin":
                Object.assign(config, config.osx);
                break;
            case "win32":
                Object.assign(config, config.windows);
                break;
            case "linux":
                Object.assign(config, config.linux);
                break;
            default:
                console.log(`Unknown platform ${os.platform()}`);
                break;
        }
        // Delete all OS props instead just the current one. See Issue#1114
        delete config.osx;
        delete config.windows;
        delete config.linux;

        this.sanitizeChainedConfigs(config);
        if ((config as any).debugger_args && !config.debuggerArgs) {
            config.debuggerArgs = (config as any).debugger_args;
        }
        if (!config.debuggerArgs) {
            config.debuggerArgs = [];
        }

        const type = config.servertype;

        let validationResponse: string | null = null;

        if (!config.swoConfig) {
            config.swoConfig = { enabled: false, decoders: [], cpuFrequency: 0, swoFrequency: 0, source: "probe" };
        } else if (config.swoConfig.enabled) {
            if (!config.swoConfig.cpuFrequency) {
                config.swoConfig.cpuFrequency = 1 * 1e6;
                vscode.window.showWarningMessage(`launch.json: Missing/Invalid swoConfig.cpuFrequency. setting to ${config.swoConfig.cpuFrequency} Hz`);
            }
            if (!config.swoConfig.swoFrequency) {
                config.swoConfig.swoFrequency = config.swoConfig.cpuFrequency / 2;
                vscode.window.showWarningMessage(`launch.json: Missing/Invalid swoConfig.swoFrequency. setting to ${config.swoConfig.swoFrequency} Hz`);
            }
            if (!config.swoConfig.swoEncoding) {
                config.swoConfig.swoEncoding = "uart";
            }
            if (!config.swoConfig.source) {
                config.swoConfig.source = "probe";
            }
            if (!config.swoConfig.decoders) {
                config.swoConfig.decoders = [];
            }
            for (const d of config.swoConfig.decoders) {
                if (d.type === "advanced") {
                    if (d.ports === undefined && d.port !== undefined) {
                        d.ports = [d.port];
                    }
                } else {
                    if (d.port === undefined && (d as any).number !== undefined) {
                        d.port = (d as any).number;
                    }
                }
            }
        }
        if (!config.rttConfig) {
            config.rttConfig = { enabled: false, decoders: [] };
        } else if (!config.rttConfig.decoders) {
            config.rttConfig.decoders = [];
        }

        if (!config.graphConfig) {
            config.graphConfig = [];
        }
        if (!config.preLaunchCommands) {
            config.preLaunchCommands = [];
        }
        if (!config.postLaunchCommands) {
            config.postLaunchCommands = [];
        }
        if (!config.preAttachCommands) {
            config.preAttachCommands = [];
        }
        if (!config.postAttachCommands) {
            config.postAttachCommands = [];
        }
        if (!config.preResetCommands) {
            config.preResetCommands = (config as any).preRestartCommands || [];
        }
        if (!config.postResetCommands) {
            config.postResetCommands = (config as any).postRestartCommands || [];
        }
        if (config.overridePreEndSessionCommands === undefined) {
            config.overridePreEndSessionCommands = null;
        }
        if (!config.postResetSessionCommands) {
            config.postResetSessionCommands = (config as any).postRestartSessionCommands || null;
        }
        if (config.runToEntryPoint) {
            config.runToEntryPoint = config.runToEntryPoint.trim();
        } else if (config.runToMain) {
            config.runToEntryPoint = "main";
            vscode.window.showWarningMessage('launch.json: "runToMain" has been deprecated and will not work in future versions of mcu-debug. Please use "runToEntryPoint" instead');
        }

        switch (type) {
            case "jlink":
                validationResponse = this.verifyJLinkConfiguration(folder, config);
                break;
            case "openocd":
                validationResponse = this.verifyOpenOCDConfiguration(folder, config);
                break;
            case "stutil":
                validationResponse = this.verifySTUtilConfiguration(folder, config);
                break;
            case "stlink":
                validationResponse = this.verifySTLinkConfiguration(folder, config);
                break;
            case "probe-rs":
                validationResponse = this.verifyProbeRSConfiguration(folder, config);
                break;
            case "pyocd":
                validationResponse = this.verifyPyOCDConfiguration(folder, config);
                break;
            case "bmp":
                validationResponse = this.verifyBMPConfiguration(folder, config);
                break;
            case "pe":
                validationResponse = this.verifyPEConfiguration(folder, config);
                break;
            case "external":
                validationResponse = this.verifyExternalConfiguration(folder, config);
                break;
            case "qemu":
                validationResponse = this.verifyQEMUConfiguration(folder, config);
                break;
            default: {
                const validValues = ["jlink", "openocd", "stutil", "stlink", "pyocd", "bmp", "pe", "external", "qemu"].map((s) => `"${s}"`).join(", ");
                validationResponse = "Invalid servertype parameters. The following values are supported: " + validValues;
                break;
            }
        }

        if (config.armToolchainPath) {
            config.toolchainPath = config.armToolchainPath;
        }
        this.setOsSpecficConfigSetting(config, "toolchainPath", "armToolchainPath");

        if (!config.toolchainPath) {
            if (!config.armToolchainPath && config.servertype === "stlink") {
                // Special case to auto-resolve GCC toolchain for STM32CubeIDE users. Doesn't quite work
                // if you are using WSL or remote debug. It will be re-calcutate later anyways in the debug adapter
                const stController = new STLinkServerController();
                config.armToolchainPath = stController.getArmToolchainPath();
                config.toolchainPath = config.armToolchainPath;
            }
        }

        const configuration = vscode.workspace.getConfiguration("mcu-debug");
        if (!config.toolchainPrefix) {
            config.toolchainPrefix = configuration.armToolchainPrefix || "arm-none-eabi";
        }

        this.setOsSpecficConfigSetting(config, "gdbPath");
        this.setOsSpecficConfigSetting(config, "objdumpPath");
        config.extensionPath = this.context.extensionPath;
        if (os.platform() === "win32") {
            config.extensionPath = config.extensionPath.replace(/\\/g, "/"); // GDB doesn't interpret the path correctly with backslashes.
        }

        config.registerUseNaturalFormat = configuration.get(MCUDebugKeys.REGISTER_DISPLAY_MODE, true);
        config.variableUseNaturalFormat = configuration.get(MCUDebugKeys.VARIABLE_DISPLAY_MODE, true);

        if (validationResponse) {
            vscode.window.showErrorMessage(validationResponse);
            return undefined;
        }

        return config;
    }

    private async handleHostConfig(config: ConfigOptions) {
        if (config.hostConfig && config.hostConfig.enabled) {
            if (!config.hostConfig.type || typeof config.hostConfig.type !== "string" || !["local", "ssh", "auto"].includes(config.hostConfig.type)) {
                vscode.window.showWarningMessage(
                    'hostConfig.type is required when hostConfig.enabled is true. Proxy server will not be used. Please set hostConfig.type to "local", "ssh", or "auto" (recommended).',
                );
                delete config.hostConfig;
                return;
            }
            const resolvedMode = this.resolveNetworkMode(config);
            config.hostConfig.pvtNetworkMode = resolvedMode;
            if (resolvedMode === "ssh") {
                // Topology B — LAB: probe on a separate physical machine. We deploy the helper binary,
                // launch the Probe Agent on the remote host, and establish an SSH -L tunnel so the DA
                // can reach the agent via 127.0.0.1:<localPort>.
                try {
                    await startSshTunnel(config);
                    config.hostConfig.pvtProxyBindHost = "127.0.0.1";
                    config.hostConfig.pvtProxyPort = sshTunnelConfig?.localPort as number;
                    config.hostConfig.pvtProxyToken = proxyLaunchResults!.token as string;
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
                const sshHostForReverse = config.hostConfig.sshHost || hostFromProxy || undefined;
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
                if (!config.hostConfig.pvtProxyBindHost) {
                    config.hostConfig.pvtProxyBindHost = policy.bindHost;
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

                config.hostConfig.pvtProxyHost = "127.0.0.1"; // DA connects to its loopback on the remote host
                config.hostConfig.pvtProxyPort = proxyLaunchResults.reverseTunnelPort;
                config.hostConfig.pvtProxyToken = proxyLaunchResults.token as string;
            } else if (resolvedMode) {
                const policy = computeProxyLaunchPolicy(resolvedMode);
                let resolvedProxyHost = policy.proxyHostForDA;

                if (resolvedMode === "auto-wsl" && resolvedProxyHost === "<wsl-gateway-ip>") {
                    resolvedProxyHost = (await this.resolveWslGatewayHost()) || "127.0.0.1";
                }

                if (resolvedMode === "auto-wsl" && resolvedProxyHost !== "127.0.0.1") {
                    // NAT mode: the Proxy Agent binds on 0.0.0.0 and Windows Firewall blocks
                    // OS-assigned ports, so a fixed pre-opened port is mandatory. Mirrored mode
                    // resolves to 127.0.0.1 above and does not need a firewall rule.
                    if (!config.hostConfig.wslProxyPort || config.hostConfig.wslProxyPort <= 0) {
                        const msg =
                            "WSL NAT mode requires hostConfig.wslProxyPort to be set to a port you have opened in Windows Firewall. " +
                            "Alternatively, enable WSL Mirrored networking in %USERPROFILE%\\.wslconfig to avoid the firewall requirement.";
                        vscode.window.showErrorMessage(msg);
                        throw new Error(msg);
                    }
                    policy.fixedPort = config.hostConfig.wslProxyPort;
                }

                if (!config.hostConfig.pvtProxyBindHost) {
                    config.hostConfig.pvtProxyBindHost = policy.bindHost;
                }

                if (!config.hostConfig.pvtProxyHost) {
                    config.hostConfig.pvtProxyHost = resolvedProxyHost;
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
                config.hostConfig.pvtProxyPort = proxyLaunchResults!.serverPort as number;
                config.hostConfig.pvtProxyToken = proxyLaunchResults!.token as string;
            } else {
                vscode.window.showWarningMessage(
                    `Unknown hostConfig.type "${config.hostConfig.type}". Proxy server will not be used. Please set hostConfig.type to "local", "ssh", or "auto" (recommended).`,
                );
                delete config.hostConfig;
            }
        } else {
            delete config.hostConfig;
        }
    }

    public resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: ConfigOptions,
        token?: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        const wsFile = vscode.workspace.workspaceFile?.fsPath;
        let cwd = config.cwd || folder?.uri.fsPath || (wsFile ? path.dirname(wsFile) : ".");
        const isAbsCwd = path.isAbsolute(cwd);
        if (!isAbsCwd && folder) {
            cwd = path.join(folder.uri.fsPath, cwd);
        } else if (!isAbsCwd) {
            cwd = path.resolve(cwd);
        }
        config.cwd = cwd;
        if (!cwd || !fs.existsSync(cwd)) {
            vscode.window.showWarningMessage(`Invalid "cwd": "${cwd}". Many operations can fail. Trying to continue`);
        }
        this.validateLoadAndSymbolFiles(config, cwd);

        if (config.liveWatch?.enabled) {
            const supportedList = ["openocd", "jlink", "stlink"];
            if (supportedList.indexOf(config.servertype) < 0) {
                const str = supportedList.join(", ");
                vscode.window.showInformationMessage(
                    `Live watch is not officially supported for servertype '${config.servertype}'. ` +
                        `Only ${str} are supported and tested. ` +
                        `Report back to us if it works with your servertype '${config.servertype}'.\n \n` +
                        'If you are using an "external" servertype and it is working for you, then you can safely ignore this message. ',
                );
            }
        }

        let validationResponse: string | null = null;
        switch (config.servertype) {
            case "jlink":
                validationResponse = this.verifyJLinkConfigurationAfterSubstitution(folder, config);
                break;
            default:
                /* config.servertype was already checked in resolveDebugConfiguration */
                validationResponse = null;
                break;
        }
        if (validationResponse) {
            vscode.window.showErrorMessage(validationResponse);
            return undefined;
        }

        return config;
    }

    private static adjustStrIntProp(obj: any, prop: string, where: string) {
        if (!(prop in obj)) {
            return;
        }
        let val: any = obj[prop];
        if (val) {
            let isIntString = false;
            if (typeof val === "string") {
                val = val.trim();
                isIntString = val.match(/^0[x][0-9a-f]+/i) || val.match(/^[0-9]+/);
            }
            if (isIntString) {
                obj[prop] = parseAddress(val);
            } else if (typeof obj[prop] !== "number") {
                vscode.window.showErrorMessage(`Invalid "${prop}" value ${val} for ${where}. Must be a number or a string." +
                    " Use a string starting with "0x" for a hexadecimal number`);
                delete obj[prop];
            }
        }
    }

    private validateLoadAndSymbolFiles(config: ConfigOptions, cwd: string) {
        // Right now, we don't consider a bad executable as fatal. Technically, you don't need an executable but
        // users will get a horrible debug experience ... so many things don't work.
        if (config.executable) {
            let exe = config.executable;
            exe = path.isAbsolute(exe) ? exe : path.join(cwd || ".", exe);
            config.executable = path.normalize(exe).replace(/\\/g, "/");
        }
        const def = defSymbolFile(config.executable);
        const symFiles: SymbolFile[] = config.symbolFiles?.map((v) => (typeof v === "string" ? defSymbolFile(v) : (v as SymbolFile))) || [def];
        if (!symFiles || symFiles.length === 0) {
            vscode.window.showWarningMessage('No "executable" or "symbolFiles" specified. We will try to run program without symbols');
        } else {
            for (const symF of symFiles) {
                let exe = symF.file;
                exe = path.isAbsolute(exe) ? exe : path.join(cwd, exe);
                exe = path.normalize(exe).replace(/\\/g, "/");
                if (!config.symbolFiles) {
                    config.executable = exe;
                } else {
                    symF.file = exe;
                }
                CortexDebugConfigurationProvider.adjustStrIntProp(symF, "offset", `file ${exe}`);
                CortexDebugConfigurationProvider.adjustStrIntProp(symF, "textaddress", `file ${exe}`);
                symF.sectionMap = {};
                symF.sections = symF.sections || [];
                for (const section of symF.sections) {
                    CortexDebugConfigurationProvider.adjustStrIntProp(section, "address", `section ${section.name} of file ${exe}`);
                    symF.sectionMap[section.name] = section;
                }
                validateELFHeader(exe, (str: string, fatal: boolean) => {
                    if (fatal) {
                        vscode.window.showErrorMessage(str);
                    } else {
                        // vscode.window.showWarningMessage(str);
                    }
                });
            }
            if (config.symbolFiles) {
                config.symbolFiles = symFiles;
            }
        }

        if (config.loadFiles) {
            for (let ix = 0; ix < config.loadFiles.length; ix++) {
                let fName = config.loadFiles[ix];
                fName = path.isAbsolute(fName) ? fName : path.join(cwd, fName);
                fName = path.normalize(fName).replace(/\\/g, "/");
                config.loadFiles[ix] = fName;
            }
        } else if (config.executable && config.symbolFiles) {
            // This is a special case when you have symbol files, we don't pass anything to gdb on the command line
            // and a target load will fail. Create a loadFiles from the executable if it exists.
            config.loadFiles = [config.executable];
        }
    }

    private handleChainedInherits(config: ConfigOptions, parent: any, props: string[]) {
        if (!props) {
            return;
        }
        const blackList: string[] = ["type", "name", "request", "chainedConfigurations"];

        for (const propName of props) {
            if (blackList.includes(propName) || propName.startsWith("pvt")) {
                vscode.window.showWarningMessage(`Cannot inherit property '${propName}' for configuration '${config.name}' ` + `because it is reserved`);
                continue;
            }
            const val = parent[propName];
            if (val !== undefined) {
                config[propName] = val;
            } else {
                vscode.window.showWarningMessage(`Cannot inherit property '${propName}' for configuration '${config.name}' ` + `because it does not exist in parent configuration`);
            }
        }
    }

    private handleChainedOverrides(config: ConfigOptions, props: any) {
        if (!props) {
            return;
        }
        const blackList: string[] = ["type", "name", "request"];

        for (const propName of Object.keys(props)) {
            if (blackList.includes(propName) || propName.startsWith("pvt")) {
                continue;
            }
            const val = props[propName];
            if (val === null) {
                delete config[propName];
            } else {
                config[propName] = val;
            }
        }
    }

    private sanitizeChainedConfigs(config: ConfigOptions) {
        // First are we chained ... as in do we have a parent?
        const isChained = CDebugChainedSessionItem.FindByName(config.name);
        if (isChained) {
            (config as any).pvtParent = isChained.parent.config;
            (config as any).pvtMyConfigFromParent = isChained.config;
            this.handleChainedInherits(config, (config as any).pvtParent, isChained.config.inherits);
            this.handleChainedOverrides(config, isChained.config.overrides);
        }

        // See if we gave children and sanitize them
        const chained = config.chainedConfigurations;
        if (!chained || !chained.enabled || !chained.launches || chained.launches.length === 0) {
            config.chainedConfigurations = { enabled: false } as ChainedConfigurations;
            return;
        }
        if (!chained.delayMs) {
            chained.delayMs = 0;
        }
        if (!chained.waitOnEvent || !Object.values(ChainedEvents).includes(chained.waitOnEvent)) {
            chained.waitOnEvent = ChainedEvents.POSTINIT;
        }
        if (chained.detached === undefined || chained.detached === null) {
            chained.detached = config.servertype === "jlink" ? true : false;
        }
        if (chained.lifecycleManagedByParent === undefined || chained.lifecycleManagedByParent === null) {
            chained.lifecycleManagedByParent = true;
        }
        const overrides = chained.overrides || {};
        for (const launch of chained.launches) {
            if (launch.enabled === undefined || launch.enabled === null) {
                launch.enabled = true;
            }
            if (launch.delayMs === undefined) {
                launch.delayMs = chained.delayMs;
            }
            if (launch.detached === undefined || launch.detached === null) {
                launch.detached = chained.detached;
            }
            if (launch.waitOnEvent === undefined || !Object.values(ChainedEvents).includes(launch.waitOnEvent)) {
                launch.waitOnEvent = chained.waitOnEvent;
            }
            if (launch.lifecycleManagedByParent === undefined || launch.lifecycleManagedByParent === null) {
                launch.lifecycleManagedByParent = chained.lifecycleManagedByParent;
            }
            const inherits = (launch.inherits || []).concat(chained.inherits || []);
            if (inherits.length > 0) {
                launch.inherits = inherits;
            } else {
                delete (launch as any).inherits;
            }

            const tmp = launch.overrides || {};
            if (Object.keys(overrides).length > 0 || Object.keys(tmp).length > 0) {
                launch.overrides = Object.assign(overrides, tmp);
            } else {
                delete (launch as any).overrides;
            }
        }
    }

    private setOsSpecficConfigSetting(config: ConfigOptions, dstName: string, propName: string = "") {
        if (!config[dstName]) {
            propName = propName || dstName;
            for (const configName of ["mcu-debug", "cortex-debug"]) {
                const settings = vscode.workspace.getConfiguration(configName);
                const obj = settings[propName];
                if (obj !== undefined && obj !== null) {
                    if (typeof obj === "object") {
                        const osName = os.platform();
                        const osOverride = osName === "win32" ? "windows" : osName === "darwin" ? "osx" : "linux";
                        const val = obj[osOverride];
                        if (val !== undefined) {
                            config[dstName] = obj[osOverride];
                            return;
                        }
                    } else {
                        config[dstName] = obj;
                        return;
                    }
                }
            }
        }
    }

    private verifyQEMUConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        this.setOsSpecficConfigSetting(config, "serverpath", "qemupath");
        // if (config.qemupath && !config.serverpath) { config.serverpath = config.qemupath; }

        if (!config.cpu) {
            config.cpu = "mcu-m3";
        }
        if (!config.machine) {
            config.machine = "lm3s6965evb";
        }

        if (config.swoConfig.enabled) {
            vscode.window.showWarningMessage("SWO support is not available when using QEMU.");
            config.swoConfig = { enabled: false, decoders: [], cpuFrequency: 0, swoFrequency: 0 };
            config.graphConfig = [];
        }

        if (config.rtos) {
            return "RTOS support is not available when using QEMU";
        }

        return "";
    }

    private verifyJLinkConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.jlinkpath && !config.serverpath) {
            config.serverpath = config.jlinkpath;
        } // Obsolete
        if (!config.interface && config.jlinkInterface) {
            config.interface = config.jlinkInterface;
        }
        if (!config.interface) {
            config.interface = "swd";
        }

        this.setOsSpecficConfigSetting(config, "serverpath", "JLinkGDBServerPath");

        if (!config.device) {
            return "Device Identifier is required for J-Link configurations. " + "Please see https://www.segger.com/downloads/supported-devices.php for supported devices";
        }

        if ((config.interface === "jtag" || config.interface === "cjtag") && config.swoConfig.enabled && config.swoConfig.source === "probe") {
            return "SWO Decoding cannot be performed through the J-Link Probe in JTAG mode.";
        }

        if (config.rttConfig && config.rttConfig.enabled && config.rttConfig.decoders && config.rttConfig.decoders.length !== 0) {
            let chosenPort;
            for (const dec of config.rttConfig.decoders) {
                if (dec.port === undefined) {
                    dec.port = 0;
                } else if (dec.port < 0 || dec.port > 15) {
                    return `Invalid port/channel '${dec.port}'.  JLink RTT port/channel must be between 0 and 15.`;
                }

                if (chosenPort !== undefined && chosenPort !== dec.port) {
                    return `Port/channel ${dec.port} selected but another decoder is using port ${chosenPort}. ` + "JLink RTT only allows a single RTT port/channel per debugging session.";
                } else {
                    chosenPort = dec.port;
                }
            }
        }

        return "";
    }

    private verifyJLinkConfigurationAfterSubstitution(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        function defaultExt() {
            switch (os.platform()) {
                case "darwin":
                    return ".dylib";
                case "linux":
                    return ".so";
                case "win32":
                    return ".dll";
                default:
                    console.log(`Unknown platform ${os.platform()}`);
                    return "";
            }
        }

        if (config.rtos) {
            if (JLINK_VALID_RTOS.indexOf(config.rtos) === -1) {
                /* When we do not have a file extension use the default OS one for file check, as J-Link allows the
                 * parameter to be used without one.
                 */
                if ("" === path.extname(config.rtos)) {
                    config.rtos = config.rtos + defaultExt();
                }

                if (!fs.existsSync(config.rtos)) {
                    return (
                        `JLink RTOS plugin file "${config.rtos}" not found.\n` +
                        `The following RTOS values are supported by J-Link: ${JLINK_VALID_RTOS.join(", ")}.` +
                        " A custom plugin can be used by supplying a complete path to a J-Link GDB Server Plugin."
                    );
                }
            } else {
                config.rtos = `GDBServer/RTOSPlugin_${config.rtos}` + defaultExt();
            }
        }

        return "";
    }

    private verifyOpenOCDConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.openOCDPath && !config.serverpath) {
            config.serverpath = config.openOCDPath;
        } // Obsolete
        this.setOsSpecficConfigSetting(config, "serverpath", "openocdPath");

        if (config.rtos && OPENOCD_VALID_RTOS.indexOf(config.rtos) === -1) {
            return `The following RTOS values are supported by OpenOCD: ${OPENOCD_VALID_RTOS.join(" ")}.` + 'You can always use "auto" and OpenOCD generally does the right thing';
        }

        if (!CDebugChainedSessionItem.FindByName(config.name)) {
            // Not chained so configFiles, searchDir matter
            if (!config.configFiles || config.configFiles.length === 0) {
                return "At least one OpenOCD Configuration File must be specified.";
            }

            if (!config.searchDir || config.searchDir.length === 0) {
                config.searchDir = [];
            }
        }

        return "";
    }

    private verifySTUtilConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.stutilpath && !config.serverpath) {
            config.serverpath = config.stutilpath;
        } // obsolete
        this.setOsSpecficConfigSetting(config, "serverpath", "stutilPath");

        if (config.rtos) {
            return "The st-util GDB Server does not have support for the rtos option.";
        }

        if (config.swoConfig.enabled && config.swoConfig.source === "probe") {
            vscode.window.showWarningMessage("SWO support is not available from the probe when using the ST-Util GDB server. Disabling SWO.");
            config.swoConfig = { enabled: false, decoders: [], cpuFrequency: 0, swoFrequency: 0 };
            config.graphConfig = [];
        }

        return "";
    }

    private verifySTLinkConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.stlinkPath && !config.serverpath) {
            config.serverpath = config.stlinkPath;
        } // Obsolete
        this.setOsSpecficConfigSetting(config, "serverpath", "stlinkPath");
        this.setOsSpecficConfigSetting(config, "stm32cubeprogrammer");

        if (config.rtos) {
            return "The ST-Link GDB Server does not have support for the rtos option.";
        }

        return "";
    }

    private verifyProbeRSConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.probeRSPath && !config.serverpath) {
            config.serverpath = config.probeRSPath;
        }
        this.setOsSpecficConfigSetting(config, "serverpath", "probeRSPath");

        if (config.rtos) {
            return "The probe-rs GDB Server does not have support for the rtos option.";
        }

        return "";
    }

    private verifyPyOCDConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.pyocdPath && !config.serverpath) {
            config.serverpath = config.pyocdPath;
        } // Obsolete
        this.setOsSpecficConfigSetting(config, "serverpath", "pyocdPath");

        if (config.rtos) {
            return "The PyOCD GDB Server does not have support for the rtos option.";
        }

        if (config.board && !config.boardId) {
            config.boardId = config.board;
        }
        if (config.target && !config.targetId) {
            config.targetId = config.target;
        }

        return "";
    }

    private verifyBMPConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (!config.BMPGDBSerialPort) {
            return "A Serial Port for the Black Magic Probe GDB server is required.";
        }
        if (!config.powerOverBMP) {
            config.powerOverBMP = "lastState";
        }
        if (!config.interface) {
            config.interface = "swd";
        }
        if (!config.targetId) {
            config.targetId = 1;
        }

        if (config.rtos) {
            return "The Black Magic Probe GDB Server does not have support for the rtos option.";
        }

        return "";
    }

    private verifyPEConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        this.setOsSpecficConfigSetting(config, "serverpath", "PEGDBServerPath");

        if (config.configFiles && config.configFiles.length > 1) {
            return "Only one pegdbserver Configuration File is allowed.";
        }

        if (!config.device) {
            return "Device Identifier is required for PE configurations. Please run `pegdbserver_console.exe -devicelist` for supported devices";
        }

        if (config.swoConfig.enabled && config.swoConfig.source !== "socket") {
            return "The PE GDB Server Only supports socket type SWO";
        }

        return "";
    }

    private verifyExternalConfiguration(folder: vscode.WorkspaceFolder | undefined, config: ConfigOptions): string {
        if (config.swoConfig.enabled) {
            if (config.swoConfig.source === "socket" && !config.swoConfig.swoPort) {
                vscode.window.showWarningMessage('SWO source type "socket" requires a "swoPort". Disabling SWO support.');
                config.swoConfig = { enabled: false, decoders: [], cpuFrequency: 0, swoFrequency: 0 };
                config.graphConfig = [];
            } else if (config.swoConfig.source !== "socket" && !config.swoConfig.swoPath) {
                vscode.window.showWarningMessage(`SWO source type "${config.swoConfig.source}" requires a "swoPath". Disabling SWO support.`);
                config.swoConfig = { enabled: false, decoders: [], cpuFrequency: 0, swoFrequency: 0 };
                config.graphConfig = [];
            }
        }

        if (!config.gdbTarget) {
            return 'External GDB server type must specify the GDB target. This should either be a "hostname:port" combination or a serial port.';
        }

        return "";
    }
}
