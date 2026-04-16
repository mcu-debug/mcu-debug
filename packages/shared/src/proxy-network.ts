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

export type ProxyHostType = "auto" | "ssh" | "local";

export type ProxyNetworkMode = "local" | "ssh" | "auto-local" | "auto-wsl" | "auto-dev-container" | "auto-ssh-remote" | `auto-${string}`;

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
    if (remoteName === "dev-container") {
        return "auto-dev-container";
    }
    if (remoteName === "ssh-remote") {
        return "auto-ssh-remote";
    }
    return `auto-${remoteName}`;
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

    if (mode === "auto-wsl") {
        return {
            mode,
            bindHost: "0.0.0.0",
            proxyHostForDA: "<wsl-gateway-ip>",
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
