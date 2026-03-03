export type ProxyHostType = "auto" | "ssh" | "local";
export type ProxyNetworkMode = "local" | "ssh" | "auto-local" | "auto-wsl" | "auto-dev-container" | "auto-ssh-remote" | `auto-${string}`;
export interface ProxyLaunchPolicy {
    mode: ProxyNetworkMode;
    bindHost: string;
    proxyHostForDA: string;
    reason: string;
}
export interface ProxyLaunchResults {
    policy: ProxyLaunchPolicy;
    consoleMessages: string[];
    consoleErrors: string[];
    token: string | null;
    serverPort: number | null;
}
export declare function resolveProxyNetworkMode(hostType?: ProxyHostType, remoteName?: string): ProxyNetworkMode;
export declare function computeProxyLaunchPolicy(mode: ProxyNetworkMode): ProxyLaunchPolicy;
