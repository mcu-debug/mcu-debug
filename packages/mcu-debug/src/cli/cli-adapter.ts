import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { getHostAdapter } from '../common/host-adapter';
import { EventEmitter } from 'events';
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { HostConfig, ChainedConfig, ConfigurationArguments, processVarSubstitution, getAnyFreePort } from "../adapter/servers/common";
import { SymbolInformation } from "../adapter/symbols";
import { IDebugSession, IHostAdapter, IOutputChannel, ISerialPortView, ISWORTTView } from "../common/host-adapter";
import { logger } from "../common/cli-logger";
import { GraphConfiguration } from "../common/swo/common";
import JSONC from 'jsonc-simple-parser';
import { TabState } from '@mcu-debug/shared/cockpit-protocol';
import { LineBuffer, trimBrackets } from '../common/utils';

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
        if (settingsFile && fs.existsSync(settingsFile)) {
            let content: string;
            try {
                content = fs.readFileSync(settingsFile, "utf8");
                this.settings = JSONC.parse(content) as { [key: string]: any };
            } catch (error) {
                logger.error("Failed to load configuration from settings file: " + (error instanceof Error ? error.message : String(error)));
                process.exit(1);
            }
            const substitutedContent = processVarSubstitution(content, this.settings as any, 'config:', (msg) => {
                logger.warn(`In config: variable substitution for ${settingsFile}: ${msg}`);
            });
            if (substitutedContent !== content) {
                try {
                    this.settings = JSONC.parse(substitutedContent) as { [key: string]: any };
                } catch (error) {
                    logger.error("Failed to parse configuration after variable substitution: " + (error instanceof Error ? error.message : String(error)));
                    // process.exit(1);
                }
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
export class CLISerialPortView implements ISerialPortView {
    public readonly emitter = new EventEmitter();
    private socket: net.Socket | null = null;
    private logFileStream: fs.WriteStream | null = null;
    private txtPrefix: string;
    private lineBuffer: LineBuffer;
    private static existingPrefixes = new Set<string>();

    constructor(private device: string, public serialConfig: SerialParams, doClear: boolean = false, private tcpPort: number = 0) {
        let label = serialConfig.label ? trimBrackets(serialConfig.label) : path.basename(device);
        let counter = 1;
        const baseLabel = label;
        while (CLISerialPortView.existingPrefixes.has(label)) {
            label = `${baseLabel}-${counter}`;
            counter++;
        }
        CLISerialPortView.existingPrefixes.add(label);
        this.txtPrefix = `[${label}]`;
        if (this.tcpPort) {
            this.restartSocket();
        }
        if (this.serialConfig.log_file) {
            this.setLogFile(this.serialConfig.log_file);
        }
        this.lineBuffer = new LineBuffer(this.txtPrefix, (source, line) => {
            line = line.trimEnd();
            const str = `${source} ${line}`;
            if (this.logFileStream) {
                this.logFileStream.write(str + "\n");
            }
            logger.info(str, { source: "serial", isConsole: true });
        });
    }

    public getStatus(): "connected" | "not-connected" {
        return this.socket && !this.socket.destroyed ? "connected" : "not-connected";
    }

    public getPrefix(): string {
        return this.txtPrefix;
    }

    send(text: string): void {
        this.lineBuffer.push(text);
    }
    sendDA(text: string): void {
        logger.info(text, { source: "DA", isConsole: true });
    }

    setState(state: TabState): void {
        // No-op in CLI mode, but could be used to track connection state if desired
    }
    setLabel(label: string): void {
        // No-op in CLI mode, but could be used to prefix log messages if desired
    }
    setPlaceholderText(placeholderText: string): void {
        // No-op in CLI mode
    }

    onUserInput(text: string) {
        const outgoing = `${text}\r\n`;
        if (!outgoing) {
            return;
        }
        if (this.socket) {
            this.socket.write(outgoing);
        }
        if (this.logFileStream) {
            this.logFileStream.write(outgoing);
        }
    }

    onUserClose(): void {
        // This should not happen but we will have it here in case we create a way to close from CLI
        this.destroySocket();
        this.sendDA(`\r\n\x1b[33m${this.txtPrefix} !!closed\x1b[0m\r\n`);
    }

    public notifyConnected(reason: string) {
        this.sendDA(`\r\n\x1b[32m${this.txtPrefix} !!connected] ${reason}\x1b[0m\r\n`);
        this.setState({ kind: "active" });
    }

    public notifyDisconnected(reason: string) {
        this.destroySocket();
        this.sendDA(`\r\n\x1b[33m${this.txtPrefix} !!disconnected: ${reason} — retrying...\x1b[0m\r\n`);
        this.setState({ kind: "inactive" });
    }

    public notifyReconnected() {
        this.sendDA(`\r\n\x1b[32m${this.txtPrefix} !!reconnected\x1b[0m\r\n`);
        this.setState({ kind: "active" });
    }

    setTcpPort(port: number) {
        if (this.tcpPort === port && this.socket && !this.socket.destroyed) {
            return;
        }
        this.tcpPort = port;
        this.restartSocket();
    }

    private destroySocket() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    private destroyLogFile() {
        if (this.serialConfig.log_file) {
            this.logFileStream?.end(() => {
                getHostAdapter().debugMessage(`Closed log file stream for ${this.serialConfig.log_file}`);
            });
            this.logFileStream = null;
        }
    }

    public setLogFile(log_file: string | undefined) {
        if (this.serialConfig.log_file === log_file) {
            return;
        }
        this.serialConfig.log_file = log_file || "";
        this.destroyLogFile();
        if (log_file) {
            this.logFileStream = fs.createWriteStream(log_file, { flags: "a" });
            if (!this.logFileStream) {
                getHostAdapter().debugMessage(`Failed to create log file stream for ${log_file}`);
                getHostAdapter().showError(`Failed to create log file stream for ${log_file}`);
            }
        }
    }

    public setInputMode(input_mode: string | undefined) {
    }

    restartSocket() {
        this.destroySocket();
        // The helper will create a TCP server for this serial port and report the port number back to us. Once we have the port number, we can connect to it.
        const socket = new net.Socket();
        socket.connect(this.tcpPort, "127.0.0.1");
        socket.on("connect", () => {
            getHostAdapter().debugMessage(`Connected to serial port ${this.device} at 127.0.0.1:${this.tcpPort}`);
            this.socket = socket;
        });
        socket.on("data", (data) => {
            this.send(data.toString());
        });
        socket.on("error", (err) => {
            getHostAdapter().debugMessage(`Error on serial port ${this.device} connection: ${err.message}`);
            this.destroySocket();
            this.notifyDisconnected(err.message);
        });
        socket.on("close", () => {
            getHostAdapter().debugMessage(`Connection to serial port ${this.device} closed`);
            this.destroySocket();
            this.notifyDisconnected("Connection closed");
        });
    }
}
