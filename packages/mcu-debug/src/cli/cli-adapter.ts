import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { HostConfig, ChainedConfig, ConfigurationArguments, processVarSubstitution, getAnyFreePort } from "../adapter/servers/common";
import { SymbolInformation } from "../adapter/symbols";
import { IDebugSession, IHostAdapter, IOutputChannel, ISerialPortView, ISWORTTView } from "../common/host-adapter";
import { logger } from "../common/cli-logger";
import { GraphConfiguration } from "../common/swo/common";
import JSONC from 'jsonc-simple-parser';
import { CLISerialPortView } from './cli-serial';

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
    private serialPortViews: CLISerialPortView[] = [];
    private consolePort: number = 0;
    constructor(private cliArgs: { json: string; config: string; settings?: string; }) {
        logger.debug("CLI adapter initialized with args: " + JSON.stringify(cliArgs));
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
    getSetting<T>(section: string, key: string, defaultValue?: T): T | undefined {
        const fullKey = section ? `${section}.${key}` : key;
        const value = this.settings?.[fullKey];
        return value !== undefined ? value : defaultValue;
    }
    getExtensionPath(): string {
        // The CLI bundle is emitted to dist/cli.js; __dirname is <extensionRoot>/dist at runtime.
        return path.resolve(__dirname, '..').replace(/\\/g, '/');
    }
    getGdbServerConsolePort(): Promise<number> {
        if (this.consolePort === 0) {
            return getAnyFreePort(50500).then(port => {
                this.consolePort = port;
                return port;
            });
        }
        return Promise.resolve(this.consolePort);
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
        const port = new CLISerialPortView(device, serialConfig, false, tcpPort);
        this.serialPortViews.push(port);
        return port;
    }
    getSerialPortViews(): CLISerialPortView[] {
        return this.serialPortViews;
    }

    showQuickPick(items: { label: string; description?: string; detail?: string; }[], opts?: { title?: string; placeHolder?: string; }): Promise<string | undefined> {
        return Promise.resolve(undefined);
    }
    createOutputChannel(name: string): IOutputChannel {
        return new CliOutputChannel(name);
    }

    private initSettings() {
        const settingsFile = this.cliArgs.settings;
        const settingsFiles = [os.homedir() + '/.mcu-debug/settings.json', settingsFile].filter(f => f !== undefined) as string[];
        for (const file of settingsFiles) {
            if (fs.existsSync(file)) {
                let content: string;
                try {
                    content = fs.readFileSync(file, "utf8");
                    this.settings = JSONC.parse(content) as { [key: string]: any };
                } catch (error) {
                    logger.error("Failed to load configuration from settings file: " + (error instanceof Error ? error.message : String(error)));
                    process.exit(1);
                }
                const substitutedContent = processVarSubstitution(content, this.settings as any, 'config:', (msg) => {
                    logger.warn(`In config: variable substitution for ${file}: ${msg}`);
                });
                if (substitutedContent !== content) {
                    try {
                        this.settings = JSONC.parse(substitutedContent) as { [key: string]: any };
                    } catch (error) {
                        logger.error("Failed to parse configuration after variable substitution: " + (error instanceof Error ? error.message : String(error)));
                        // process.exit(1);
                    }
                }
            } else if (file !== settingsFiles[0]) { // Don't warn about the default settings file if it doesn't exist
                logger.warn(`Settings file ${file} does not exist.`);
            }
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
