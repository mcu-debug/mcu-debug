import * as path from 'path';
import * as fs from 'fs';
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { HostConfig, ChainedConfig, ConfigurationArguments } from "../adapter/servers/common";
import { SymbolInformation } from "../adapter/symbols";
import { IDebugSession, IHostAdapter, IOutputChannel, ISerialPortView, ISWORTTView } from "../common/host-adapter";
import { logger } from "../common/logger";
import { GraphConfiguration } from "../common/swo/common";

// Detect the equivalent of vscode.env.remoteName from OS-level signals.
// Return values match VS Code's remoteName strings so resolveProxyNetworkMode() works unchanged.
// Detection order:
//   1. WSL          — WSL_DISTRO_NAME env var (set by WSL, always present)
//   2. Kubernetes   — KUBERNETES_SERVICE_HOST env var; host is explicit config → return undefined
//   3. Docker       — /.dockerenv exists (primary)
//                     /proc/1/cgroup contains "docker" or "containerd" (secondary)
//   4. SSH server   — SSH_CLIENT env var (process was started via SSH)
//   5. Local        — none of the above → return undefined
function calculateRemoteName(): string | undefined {
    // WSL: WSL_DISTRO_NAME is always injected by the WSL runtime
    if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME !== undefined) {
        return 'wsl';
    }

    // Kubernetes: host address must come from explicit launch.json config; skip auto-detection
    if (process.env.KUBERNETES_SERVICE_HOST !== undefined) {
        return undefined;
    }

    // Docker: /.dockerenv (primary) or /proc/1/cgroup containing "docker"/"containerd" (secondary)
    if (process.platform === 'linux') {
        if (fs.existsSync('/.dockerenv')) {
            return 'dev-container';
        }
        try {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
            if (cgroup.includes('docker') || cgroup.includes('containerd')) {
                return 'dev-container';
            }
        } catch {
            // /proc/1/cgroup unavailable — not a container
        }
    }

    // SSH: SSH_CLIENT is set when the process was launched over an SSH connection
    if (process.env.SSH_CLIENT !== undefined) {
        return 'ssh-remote';
    }

    return undefined;
}

export class CliAdapter implements IHostAdapter {
    private readonly remoteName: string | undefined;
    private settings: { [key: string]: any } = {};
    constructor(private cliArgs: { json: string; config: string; settings?: string; }) {
        logger.info("CLI adapter initialized with args: " + JSON.stringify(cliArgs));
        this.remoteName = calculateRemoteName();
        this.initSettings();
    }
    showError(msg: string): void {
        logger.error(msg);
    }
    showWarning(msg: string): void {
        logger.warn(msg);
    }
    showInfo(msg: string): void {
        logger.info(msg);
    }
    getSetting<T>(section: string, key: string, defaultValue: T): T;
    getSetting<T>(section: string, key: string): T | undefined;
    getSetting(section: unknown, key: unknown, defaultValue?: unknown): unknown {
        return defaultValue;
    }
    getExtensionPath(): string {
        // The CLI bundle is emitted to dist/cli.js; __dirname is <extensionRoot>/dist at runtime.
        return path.resolve(__dirname, '..').replace(/\\/g, '/');
    }
    getGdbServerConsolePort(): number {
        return 5000;
    }
    getUsedPorts(): number[] {
        return [];
    }
    stopDebugging(session: IDebugSession): void {
        // No-op in CLI
    }
    handleHostConfig(hostConfig: HostConfig | undefined, onDelete: () => void): Promise<void> {
        return Promise.resolve();
    }
    getWorkspaceFilePath(): string | undefined {
        return undefined;
    }
    findChainedSession(name: string): { parent: { config: any; }; config: ChainedConfig; } | undefined {
        return undefined;
    }
    debugMessage(msg: string): void {
        logger.debug(msg);
    }
    getRemoteName(): string | undefined {
        return this.remoteName;
    }
    showErrorWithChoice(msg: string, modal: boolean, ...choices: string[]): Promise<string | undefined> {
        logger.error(msg);
        return Promise.resolve(undefined);
    }
    executeProxyCommand<T>(command: string, ...args: unknown[]): Promise<T | null> {
        logger.debug(`Proxy command: ${command}`);
        return Promise.resolve(null);
    }
    createSWORTTWebView(extensionPath: string, graphs: GraphConfiguration[]): ISWORTTView {
        throw new Error("SWO RTT WebView not supported in CLI mode.");
    }
    loadFunctionSymbols(session: any): SymbolInformation[] {
        return [];
    }
    createSerialPortView(device: string, serialConfig: SerialParams, isNew: boolean, tcpPort: number): ISerialPortView {
        throw new Error("Serial port view not supported in CLI mode.");
    }
    showQuickPick(items: { label: string; description?: string; detail?: string; }[], opts?: { title?: string; placeHolder?: string; }): Promise<string | undefined> {
        return Promise.resolve(undefined);
    }
    createOutputChannel(name: string): IOutputChannel {
        return new CliOutputChannel(name);
    }

    private initSettings() {
        const settingsFile = this.cliArgs.settings;
        if (settingsFile && fs.existsSync(settingsFile)) {
            try {
                const content = fs.readFileSync(settingsFile, "utf8");
                this.settings = JSON.parse(content) as { [key: string]: any };
            } catch (error) {
                logger.error("Failed to load configuration from settings file: " + (error instanceof Error ? error.message : String(error)));
                process.exit(1);
            }
        } else if (settingsFile) {
            logger.warn(`Settings file ${settingsFile} does not exist.`);
        }
    }

    public getSettings(): { [key: string]: any } {
        return this.settings;
    }
}

export class CliOutputChannel implements IOutputChannel {
    public readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    append(value: string): void {
        logger.info(`[${this.name}] ${value}`);
    }
    appendLine(value: string): void {
        logger.info(`[${this.name}] ${value}`);
    }
    replace(value: string): void {
        logger.info(`[${this.name}] ${value}`);
    }
    clear(): void {
        // No-op, we can't really clear the console
    }
    show(preserveFocus?: boolean): void {
        // No-op, the console is always visible in CLI
    }
    hide(): void {
        // No-op, we can't hide the console in CLI
    }
    dispose(): void {
        // No-op, nothing to dispose in CLI
    }
}

let hostAdapterInstance: IHostAdapter | null = null;
export function getHostAdapter(): IHostAdapter {
    if (!hostAdapterInstance) {
        throw new Error("Host adapter not set. This should never happen, as the CLI entry point should set it before any other code runs.");
    }
    return hostAdapterInstance;
}

export function setHostAdapter(adapter: IHostAdapter): void {
    hostAdapterInstance = adapter;
}
