import { spawnSync } from "child_process";
import * as dns from "dns";
import * as fs from "fs";
import * as os from "os";
import * as net from "net";

/// Definitions for proxy agent and related types

enum ProxyEndpointType {
    GDB_SERVER = 0,
    ADAPTER,
}

export class Funnel {
    hostNameOrAddress: string;
    tcpPort: number;
    proxyType: ProxyEndpointType;
    constructor(hostNameOrAddress: string, tcpPort: number, proxyType: ProxyEndpointType) {
        this.hostNameOrAddress = hostNameOrAddress;
        this.tcpPort = tcpPort;
        this.proxyType = proxyType;
    }
}

export class ProxyAdapterSide {
    funnel: Funnel | null = null;
    portMap: Map<string, number>;
    constructor() {
        this.portMap = new Map<string, number>();
    }

    initialize(otherHost: string | undefined, port: number): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this.funnel = new Funnel("127.0.0.1", port, ProxyEndpointType.ADAPTER);
            resolve(true);
        });
    }

    allocatePorts(numPorts: number, consecutive: boolean = false): Promise<number[]> {
        return new Promise<number[]>((resolve, reject) => {
            resolve([]);
        });
    }
}

export enum NetEnvironment {
    PureLinux = "linux",
    WSL2Nat = "wsl2nat",
    WSL2Mirrored = "wsl2mirrored",
    Docker = "docker",
    Windows = "windows",
    MacOS = "macos",
    Unknown = "unknown",
}

export function detectEnvironment(): NetEnvironment {
    const platform = os.platform();

    if (platform === "win32") return NetEnvironment.Windows;
    if (platform === "darwin") return NetEnvironment.MacOS;

    if (platform === "linux") {
        // 1. Check for WSL2 (Look for "microsoft" or "WSL" in kernel version)
        try {
            const version = fs.readFileSync("/proc/version", "utf8").toLowerCase();
            if (version.includes("microsoft") || version.includes("wsl")) {
                return wsl2NetworkingMode();
            }
        } catch (e) {
            /* ignore */
        }

        // 2. Check for Docker (Presence of /.dockerenv is the standard "dirty" check)
        if (fs.existsSync("/.dockerenv")) {
            return NetEnvironment.Docker;
        }

        // 3. Fallback check for Docker (cgroups)
        try {
            const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
            if (cgroup.includes("docker") || cgroup.includes("kubepods")) {
                return NetEnvironment.Docker;
            }
        } catch (e) {
            /* ignore */
        }

        return NetEnvironment.PureLinux;
    }

    return NetEnvironment.Unknown;
}

function wsl2NetworkingMode(): NetEnvironment {
    try {
        const result = spawnSync("wslinfo", ["--networking-mode"], {
            encoding: "utf8",
            stdio: "pipe",
            timeout: 2000,
        });
        if (result.status === 0) {
            const output = result.stdout.trim().toLowerCase();
            if (output !== "nat") {
                return NetEnvironment.WSL2Mirrored;
            }
        }
    } catch (e) {
        // ignore
        console.log("Failed to determine WSL2 networking mode, defaulting to NAT");
    }
    return NetEnvironment.WSL2Nat;
}

// For WSL specifically
async function getWSLHostIP(): Promise<string> {
    // Method 1: /etc/resolv.conf (fastest, most reliable)
    try {
        const resolv = fs.readFileSync("/etc/resolv.conf", "utf-8");
        const match = resolv.match(/nameserver\s+(\S+)/);
        if (match) return match[1];
    } catch {}

    // Method 2: ip route (always works)
    const ipRouteHost = getHostFromIPRoute();
    if (ipRouteHost) return ipRouteHost;

    throw new Error("Cannot detect Windows host from WSL");
}

function getHostFromIPRoute() {
    try {
        // const { stdout } = await execAsync("ip route show default");
        const result = spawnSync("ip", ["route", "show", "default"], {
            encoding: "utf8",
            stdio: "pipe",
            timeout: 2000,
        });
        if (result.status === 0) {
            const output = result.stdout.trim().toLowerCase();
            const match = output.match(/default via (\S+)/);
            if (match) return match[1];
        }
    } catch {}
    return null;
}

// For Docker (any host OS)
async function getDockerHostIP(): Promise<string> {
    // Try Docker Desktop magic hostname first
    try {
        const { address } = await dns.promises.lookup("host.docker.internal");
        return address;
    } catch {}

    // Linux Docker: gateway IP
    const ipRouteHost = getHostFromIPRoute();
    if (ipRouteHost) return ipRouteHost;

    throw new Error("Cannot detect host from Docker container");
}

/*
async function resolveProxyAddress(config: LaunchConfig): Promise<string> {
    // 1. Check launch.json
    if (config.proxyHost) {
        return `${config.proxyHost}:${config.proxyPort ?? 3333}`;
    }

    // 2. Check workspace settings
    const wsConfig = vscode.workspace.getConfiguration("mcu-debug.proxy");
    const settingsHost = wsConfig.get<string>("host");
    if (settingsHost) {
        const settingsPort = wsConfig.get<number>("port") ?? 3333;
        return `${settingsHost}:${settingsPort}`;
    }

    // 3. Try extension API (if proxy extension is running locally)
    try {
        const proxyExt = vscode.extensions.getExtension("your.mcu-debug-proxy");
        if (proxyExt) {
            const api = await proxyExt.activate();
            const addr = api.getServerAddress();
            if (addr) return addr;
        }
    } catch {
        // Extension not installed or not responding
    }

    // 4. Auto-detect
    const detected = await detectConnection(config);
    return `${detected.host}:${detected.port}`;
}
*/

interface PortReservation {
    ports: number[];
    release: () => void;
}

async function reserveConsecutivePorts(count: number, preferredStart?: number): Promise<PortReservation> {
    // Try preferred port first if specified
    if (preferredStart) {
        const result = await tryReserveRange(preferredStart, count);
        if (result) return result;
    }

    // Try common ranges
    const commonStarts = [3333, 4000, 5000, 6000, 7000, 8000, 9000];
    for (const start of commonStarts) {
        const result = await tryReserveRange(start, count);
        if (result) return result;
    }

    // Search systematically
    for (let base = 10000; base < 60000; base += 100) {
        const result = await tryReserveRange(base, count);
        if (result) return result;
    }

    throw new Error(`Could not find ${count} consecutive free ports`);
}

async function tryReserveRange(start: number, count: number): Promise<PortReservation | null> {
    const servers: net.Server[] = [];

    try {
        for (let i = 0; i < count; i++) {
            const port = start + i;
            const server = net.createServer();

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Timeout binding port ${port}`));
                }, 1000);

                server.once("error", (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });

                server.listen(port, "127.0.0.1", () => {
                    clearTimeout(timeout);
                    server.removeListener("error", reject);
                    resolve();
                });
            });

            servers.push(server);
        }

        // Success - all ports reserved
        const ports = servers.map((s) => (s.address() as net.AddressInfo).port);

        return {
            ports,
            release: () => {
                for (const server of servers) {
                    try {
                        server.close();
                    } catch {
                        // Ignore errors during cleanup
                    }
                }
            },
        };
    } catch {
        // Failed - clean up what we got
        for (const server of servers) {
            try {
                server.close();
            } catch {}
        }
        return null;
    }
}
