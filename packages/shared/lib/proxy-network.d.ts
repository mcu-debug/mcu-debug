export type ProxyHostType = "auto" | "ssh" | "local";
export type ProxyNetworkMode = "local" | "ssh" | "auto-local" | "auto-wsl" | "auto-dev-container" | "auto-ssh-remote" | `auto-${string}`;
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
    token: string | null;
    serverPort: number | null;
    /** Set when ProxyLaunchPolicy.reverseTunnelSshHost was provided.
     *  The port on the remote SSH host's loopback that forwards back to serverPort here. */
    reverseTunnelPort?: number;
}
export declare function resolveProxyNetworkMode(hostType?: ProxyHostType, remoteName?: string): ProxyNetworkMode;
export declare function computeProxyLaunchPolicy(mode: ProxyNetworkMode): ProxyLaunchPolicy;
