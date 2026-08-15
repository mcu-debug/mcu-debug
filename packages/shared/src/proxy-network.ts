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

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";

export type ProxyHostType = "auto" | "ssh" | "local";

/**
 * Options shared by every `ssh` process we spawn, in either SSH topology.
 *
 * We always spawn ssh with piped stdio and no controlling terminal, so a password or
 * key-passphrase prompt can never be answered — ssh would sit there until whichever
 * caller-side timeout fires, and the user gets a misleading "timed out waiting for ..."
 * instead of the truth, which is that authentication never had a chance. BatchMode=yes
 * makes that case exit immediately with a real error on stderr.
 *
 * It also turns an unknown/changed host key into an immediate failure instead of a
 * silent wait on an unanswerable confirmation prompt.
 *
 * Nothing here weakens auth: key-based auth via ssh-agent, an already-open ControlMaster,
 * or a passphrase-less key all work exactly as before. The requirement this makes explicit
 * is one we already had — these connections must be non-interactive.
 */
export const SSH_BATCH_OPTS = ["-o", "BatchMode=yes"];

// Known remoteName values from VS Code's remote extension:
//   "wsl"            — WSL 1/2 classic (shared-kernel or mirrored)
//   "wsl-container"  — WSL Container (VM-isolated OCI container under WSL) — TENTATIVE, watch
//                      https://github.com/microsoft/vscode-remote-release for the confirmed string
//   "dev-container"  — Docker Dev Containers, Apple Container (OCI-compatible)
//   "ssh-remote"     — SSH remote
//   "codespaces"     — GitHub Codespaces (falls through to auto-${remoteName})
export type ProxyNetworkMode = "local" | "ssh" | "auto-local" | "auto-wsl" | "auto-wsl-container" | "auto-dev-container" | "auto-ssh-remote" | `auto-${string}`;

export interface ProxyLaunchPolicy {
    mode: ProxyNetworkMode;
    bindHost: string;
    proxyHostForDA: string;
    reason: string;
    /** If set, startProxyServer will also establish an SSH reverse tunnel to this host
     *  after the proxy is ready, and return the allocated remote port in ProxyLaunchResults.
     *  Used for auto-ssh-remote (Topology A) so the DA on the remote host can reach the
     *  Proxy Agent on the Engineer Machine. */
    reverseTunnelSshHost?: string;
}
export interface ProxyLaunchResults {
    policy: ProxyLaunchPolicy;
    consoleMessages: string[];
    consoleErrors: string[];
    token: string;
    serverPort: number;
    hosts: string[];
    bindErrors: string[] | null;
    /** Set when ProxyLaunchPolicy.reverseTunnelSshHost was provided.
     *  The port on the remote SSH host's loopback that forwards back to serverPort here. */
    reverseTunnelPort?: number;
}

export function resolveProxyNetworkMode(hostType: ProxyHostType = "auto", remoteName?: string): ProxyNetworkMode {
    if (hostType === "local") {
        return "local";
    }
    if (hostType === "ssh") {
        return "ssh";
    }

    if (!remoteName) {
        return "auto-local";
    }
    if (remoteName === "wsl") {
        return "auto-wsl";
    }
    // WSL Container: VM-isolated OCI container launched under WSL.
    // "wsl-container" is the expected VS Code remoteName — confirm once VS Code ships support.
    if (remoteName === "wsl-container") {
        return "auto-wsl-container";
    }
    if (remoteName === "dev-container") {
        return "auto-dev-container";
    }
    if (remoteName === "ssh-remote") {
        return "auto-ssh-remote";
    }
    return `auto-${remoteName}`;
}

/** True when this process is running inside a WSL guest (as opposed to on the
 *  Windows host). The WSL probes below need it because the same question is asked
 *  with a different command on each side. */
export function isInsideWslGuest(): boolean {
    return process.platform === "linux" && !!process.env.WSL_DISTRO_NAME;
}

export function getWSLNetworkingMode(): string {
    try {
        // `wslinfo` lives inside the distro (WSL 2.2.4+), so from the Windows host the
        // question has to be relayed through the default distro. Without this the host
        // always hit the catch below and *assumed* NAT.
        const cmd = isInsideWslGuest() ? "wslinfo --networking-mode" : "wsl.exe -- wslinfo --networking-mode";
        // stderr is ignored rather than inherited: on a machine with no WSL this
        // command is expected to fail, and the noise would look like a real error.
        return child_process.execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        // Older WSL without `wslinfo`, or no WSL at all. NAT was the only mode back then.
        return "nat";
    }
}

/** The Windows host's own IPv4 address on the WSL virtual ethernet adapter
 *  ("vEthernet (WSL)", or "vEthernet (WSL (Hyper-V firewall))" when the Hyper-V
 *  firewall is in play), or null if there is no such adapter.
 *
 *  Only meaningful when called ON the Windows host — from inside a guest,
 *  `os.networkInterfaces()` reports the guest's interfaces, not the host's. */
export function getWslHostAdapterIp(): string | null {
    return findWslAdapterIp(os.networkInterfaces());
}

/** The adapter-matching half of [[getWslHostAdapterIp]], split out so the adapter
 *  name patterns can be tested from any platform. */
export function findWslAdapterIp(nets: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
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

/** Pull the default gateway out of `ip route` output.
 *
 *  Split out from the command that produces it so the parsing is testable without a
 *  WSL install. Anchored per-line so a route named "default-something" elsewhere in
 *  the table cannot match. */
export function parseDefaultGateway(ipRouteOutput: string): string | null {
    const m = ipRouteOutput.match(/^\s*default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})\b/m);
    return m ? m[1] : null;
}

/** Probes the WSL branch of the policy depends on.
 *
 *  Injectable so `computeProxyLaunchPolicy` can be tested on a machine with no WSL,
 *  and so a test can pin the NAT/mirrored fork rather than inheriting the host's. */
export interface WslProbes {
    networkingMode: () => string;
    gatewayIp: () => string | null;
}

const defaultWslProbes: WslProbes = {
    networkingMode: getWSLNetworkingMode,
    gatewayIp: getWslGatewayIp,
};

export function computeProxyLaunchPolicy(mode: ProxyNetworkMode, probes: WslProbes = defaultWslProbes): ProxyLaunchPolicy {
    if (mode === "local" || mode === "auto-local" || mode === "ssh" || mode === "auto-ssh-remote") {
        return {
            mode,
            bindHost: "127.0.0.1",
            proxyHostForDA: "127.0.0.1",
            reason: "Loopback-only mode",
        };
    }

    if (mode === "auto-dev-container") {
        return {
            mode,
            bindHost: "127.0.0.1",
            proxyHostForDA: "host.docker.internal",
            reason: "Container reaches host through host.docker.internal",
        };
    }

    // WSL Container: OCI container running inside WSL's VM (not the Windows host directly).
    // Networking is not yet documented. Two hops: container → WSL VM → Windows host.
    // "host.docker.internal" may not be injected here (that's a Docker Desktop feature).
    // VS Code port-forwarding tunnel is likely the reliable path; proxy binds loopback only.
    // TODO: verify once WSL Container ships in VS Code stable — may need a custom gateway IP
    //       similar to the WSL NAT path, or may need a wslinfo-style query for container mode.
    if (mode === "auto-wsl-container") {
        return {
            mode,
            bindHost: "127.0.0.1",
            proxyHostForDA: "127.0.0.1",
            reason: "WSL Container: relying on VS Code port-forwarding tunnel (networking TBD)",
        };
    }

    if (mode === "auto-wsl") {
        // Mirrored networking hands the guest the host's own interfaces, so loopback
        // already reaches the proxy and there is nothing to widen.
        if (probes.networkingMode() !== "nat") {
            return {
                mode,
                bindHost: "127.0.0.1",
                proxyHostForDA: "127.0.0.1",
                reason: "WSL mirrored networking: the guest reaches the host over loopback",
            };
        }

        // NAT: bind the gateway address itself, never `0.0.0.0`.
        //
        // In NAT mode the guest's default gateway *is* the Windows host's
        // "vEthernet (WSL)" address, so one number answers both questions — which
        // address the host binds, and which address the guest dials. It is also the
        // narrowest thing that works: that adapter is host-local by construction,
        // whereas `0.0.0.0` would expose the proxy on every interface including hotel
        // wifi. And a *specific* address is the only kind that can be added alongside
        // the existing loopback listener on all three platforms — see
        // `proxy_helper/listeners.rs`.
        const gateway = probes.gatewayIp();
        if (!gateway) {
            return {
                mode,
                bindHost: "127.0.0.1",
                proxyHostForDA: "127.0.0.1",
                reason: "WSL NAT: could not resolve the WSL gateway address; staying on loopback, which the guest cannot reach",
            };
        }
        return {
            mode,
            bindHost: gateway,
            proxyHostForDA: gateway,
            reason: `WSL NAT: host binds its WSL gateway address ${gateway}`,
        };
    }

    return {
        mode,
        bindHost: "127.0.0.1",
        proxyHostForDA: "127.0.0.1",
        reason: "Fallback policy",
    };
}

/** The Windows host's address on the WSL NAT network, or null if it cannot be found.
 *
 *  Returns null rather than throwing. The previous version threw from inside its own
 *  catch, which escaped every `getWslGatewayIp() || "127.0.0.1"` fallback at the call
 *  sites and failed the whole launch instead of degrading to loopback. */
export function getWslGatewayIp(): string | null {
    try {
        if (isInsideWslGuest()) {
            // Ask the kernel we are already running on. The previous version shelled
            // out to `wsl.exe -d Ubuntu -- ip route` from *inside* the guest: a round
            // trip out to Windows and back that also hardcoded a distro name, so it
            // answered for the wrong distro (or not at all) for anyone not on Ubuntu.
            return parseDefaultGateway(child_process.execSync("ip route", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
        }
        if (process.platform === "win32") {
            // On the host, read the adapter directly instead of shelling out to the
            // guest. This is authoritative — the host knows its own adapter IPs — and
            // it needs no running distro, no subprocess, and no assumption about which
            // distro is default.
            return getWslHostAdapterIp();
        }
    } catch {
        // No WSL, no default distro, or the command is missing.
    }
    return null;
}

export function openRemoteUri(targetUri: string) {
    // const isWsl = process.platform === 'linux' && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    const isWsl = !!process.env.WSL_DISTRO_NAME;
    const isDocker = fs.existsSync('/.dockerenv');

    // 1. Handle WSL (Direct host interop via cmd.exe)
    if (isWsl) {
        exec(`cmd.exe /c start "" "${targetUri}"`, (err) => {
            if (err) throw new Error(`WSL cmd.exe launch failed: ${err.message}`);
        });
    }
    // 2. Handle Docker Containers (Use terminal browser hook)
    else if (isDocker) {
        if (process.env.BROWSER) {
            exec(`"${process.env.BROWSER}" "${targetUri}"`, (err) => {
                if (err) throw new Error(`Docker browser forwarder failed: ${err.message}`);
            });
        } else {
            throw new Error("Error: Docker container must run inside a VS Code Integrated Terminal to forward URLs.");
        }
    }
    // 3. Handle Native Environments (Non-remote Mac/Windows/Linux)
    else {
        if (process.platform === 'win32') {
            exec(`start "" "${targetUri}"`);
        } else if (process.platform === 'darwin') {
            exec(`open "${targetUri}"`);
        } else {
            exec(`xdg-open "${targetUri}"`);
        }
    }
}
