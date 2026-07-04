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

export type ProxyHostType = "auto" | "ssh" | "local";

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
    /** If set, the Proxy Agent is started with --port <fixedPort> instead of --port 0 (OS-assigned).
     *  Required for WSL NAT mode where the user must pre-open a Windows Firewall port.
     *  The extension passes this value from hostConfig.wslProxyPort. */
    fixedPort?: number;
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
    token: string | null;
    serverPort: number | null;
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

export function getWSLNetworkingMode() {
    try {
        // This command is available in WSL 2.2.4+ 
        const mode = child_process.execSync('wslinfo --networking-mode').toString().trim();
        return mode; // Returns 'nat' or 'mirrored'
    } catch (error) {
        // Fallback for older WSL versions where wslinfo isn't available
        return 'nat'; // Default mode in older versions
    }
}

export function computeProxyLaunchPolicy(mode: ProxyNetworkMode): ProxyLaunchPolicy {
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
        const wslNetworkingMode = getWSLNetworkingMode();
        return {
            mode,
            bindHost: wslNetworkingMode === "nat" ? "0.0.0.0" : "127.0.0.1",
            proxyHostForDA: wslNetworkingMode === "nat" ? "<wsl-gateway-ip>" : "127.0.0.1",
            reason: "WSL mode may require host bind outside loopback for NAT",
        };
    }

    return {
        mode,
        bindHost: "127.0.0.1",
        proxyHostForDA: "127.0.0.1",
        reason: "Fallback policy",
    };
}
