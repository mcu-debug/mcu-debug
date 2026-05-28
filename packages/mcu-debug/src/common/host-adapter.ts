import { ChainedConfig, HostConfig } from "../adapter/servers/common";
import { SymbolInformation } from "../adapter/symbols";
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";
import { SWORTTAdvancedProcessor } from "./swo/decoders/advanced";
import { SWORTTGraphProcessor } from "./swo/decoders/graph";
import { GraphConfiguration, GrapherMessage } from "./swo/common";
import { EventEmitter } from "stream";

export const CLI_SESSION_TYPES = ["not-started", "starting", "initialized", "running", "paused", "terminated"] as const;
export type CLISessionType = typeof CLI_SESSION_TYPES[number];
// export type CLISessionType = "not-started" | "starting" | "initialized" | "running" | "paused" | "terminated";

/**
 * Platform-agnostic debug configuration — mirrors vscode.DebugConfiguration.
 * Both ConfigurationArguments and vscode.DebugConfiguration are structurally
 * compatible with this interface.
 */
export interface IDebugConfiguration {
    name: string;
    request: string;
    [key: string]: any;
}

/**
 * Platform-agnostic debug session — mirrors vscode.DebugSession.
 * vscode.DebugSession is structurally assignable to this interface.
 * The CLI adapter will supply its own implementation.
 */
export interface IDebugSession {
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly parentSession?: IDebugSession;
    readonly configuration: IDebugConfiguration;
    customRequest(command: string, args?: any): Thenable<any>;
}

export interface ISerialPortView {
    readonly emitter: EventEmitter;
    setTcpPort(port: number): void;
    setLogFile(log_file: string | undefined): void;
    setInputMode(input_mode: string | undefined): void;
    notifyConnected(reason: string): void;
    notifyReconnected(): void;
    notifyDisconnected(reason: string): void;
}

export interface ISWORTTView {
    sendMessage(message: GrapherMessage): void;
    clearProcessors(): void;
    registerProcessors(processor: SWORTTGraphProcessor | SWORTTAdvancedProcessor): void;
}

export interface IOutputChannel {

    /**
     * The human-readable name of this output channel.
     */
    readonly name: string;

    /**
     * Append the given value to the channel.
     *
     * @param value A string, falsy values will not be printed.
     */
    append(value: string): void;

    /**
     * Append the given value and a line feed character
     * to the channel.
     *
     * @param value A string, falsy values will be printed.
     */
    appendLine(value: string): void;

    /**
     * Replaces all output from the channel with the given value.
     *
     * @param value A string, falsy values will not be printed.
     */
    replace(value: string): void;

    /**
     * Removes all output from the channel.
     */
    clear(): void;

    /**
     * Reveal this channel in the UI.
     *
     * @param preserveFocus When `true` the channel will not take focus.
     */
    show(preserveFocus?: boolean): void;

    /**
     * Hide this channel from the UI.
     */
    hide(): void;

    /**
     * Dispose and free associated resources.
     */
    dispose(): void;
}

/**
 * Abstraction layer over the host environment (VS Code extension or CLI).
 *
 * `common/` code uses only this interface — no `import from 'vscode'` is permitted there.
 * `frontend/` supplies `VscodeAdapter`; `cli/` will supply `CliAdapter`.
 */
export interface IHostAdapter {
    // ── User-facing diagnostics ──────────────────────────────────────────────
    showError(msg: string): void;
    showWarning(msg: string): void;
    showInfo(msg: string): void;

    // ── Settings bridge ──────────────────────────────────────────────────────
    // VS Code: vscode.workspace.getConfiguration(section).get(key[, defaultValue])
    // CLI:     .vscode/mcu-debug-settings.json → ~/.mcu-debug/settings.json
    getSetting<T>(section: string, key: string, defaultValue: T): T;
    getSetting<T>(section: string, key: string): T | undefined;

    // ── Extension / context info ─────────────────────────────────────────────
    /** Absolute path to the extension installation directory. */
    getExtensionPath(): string;

    // ── Session management (port allocation) ─────────────────────────────────
    /** TCP port the GDB server console backend is listening on. ≤0 means not ready. */
    getGdbServerConsolePort(): Promise<number>;
    /** Set of TCP ports already in use by active debug sessions. */
    getUsedPorts(): number[];
    /**
     * Stop a debug session.
     * VS Code: vscode.debug.stopDebugging(session).
     * CLI: terminate the associated debug process.
     */
    stopDebugging(session: IDebugSession): void;

    // ── Host config / proxy setup ─────────────────────────────────────────────
    /**
     * Handle the probe-host config (SSH tunnel, auto-proxy, etc.).
     * Calls `onDelete()` when hostConfig has been processed and must be removed
     * from the launch configuration before it is sent to the DA.
     */
    handleHostConfig(hostConfig: HostConfig | undefined, onDelete: () => void): Promise<void>;

    // ── Workspace info ────────────────────────────────────────────────────────
    /** Equivalent to vscode.workspace.workspaceFile?.fsPath */
    getWorkspaceFilePath(): string | undefined;

    // ── Chained-session state ─────────────────────────────────────────────────
    /**
     * Look up a chained debug-session by launch-config name.
     * Returns the parent config and the child's ChainedConfig if found.
     */
    findChainedSession(name: string): { parent: { config: any }; config: ChainedConfig } | undefined;

    // ── Debug / telemetry ────────────────────────────────────────────────────
    /** Write a message to the debug output channel (VS Code) or stderr (CLI). */
    debugMessage(msg: string): void;

    /** The VS Code remote name (e.g. "wsl", "ssh-remote+host") or undefined when local. */
    getRemoteName(): string | undefined;

    /**
     * Show an error with optional action buttons and return the chosen label.
     * `modal` — if true the dialog blocks the UI until the user dismisses it.
     * CLI adapter should log the error and return undefined.
     */
    showErrorWithChoice(msg: string, modal: boolean, ...choices: string[]): Promise<string | undefined>;

    /**
     * Invoke a VS Code command by name (for extension-to-extension IPC).
     * The VS Code adapter delegates to `vscode.commands.executeCommand`.
     * The CLI adapter always throws — these code paths are never reached in CLI mode.
     */
    executeProxyCommand<T>(command: string, ...args: unknown[]): Promise<T | null>;

    /**
     * createSWORTTWebView is used by SWORTTAdvancedProcessor to create the webview for graphing. It is passed as a callback to the decoder class and called from there. The reason for this indirection is that the decoder class is created before the webview is created, but the decoder needs to be able to send messages to the webview. So instead of passing the webview directly to the decoder, we pass a function that creates the webview when called.
     */
    createSWORTTWebView(extensionPath: string, graphs: GraphConfiguration[]): ISWORTTView;

    /**
     * createOutputChannel is used by advanced processor where users can direct their output
     */
    createOutputChannel(name: string): IOutputChannel;

    /**
     * loadFunctionSymbols is used to find the PC address with SWO
     */
    loadFunctionSymbols(session: any): SymbolInformation[];

    /**
     * Create (or reuse) a serial port view for the given device.
     * The VS Code adapter returns a ManagedTab-backed SerialPortView.
     * A CLI adapter may return a stdout/readline-based implementation.
     */
    createSerialPortView(device: string, serialConfig: SerialParams, isNew: boolean, tcpPort: number): ISerialPortView;

    /**
     * Show a quick-pick list of labeled items and return the selected label,
     * or undefined if the user dismissed. CLI adapter may print the list and
     * return undefined.
     */
    showQuickPick(
        items: { label: string; description?: string; detail?: string }[],
        opts?: { title?: string; placeHolder?: string }
    ): Promise<string | undefined>;
}

// ── Global singleton ─────────────────────────────────────────────────────────
// Each entry point (extension activate, CLI main) calls setHostAdapter() once
// before any debug session starts.  All common/ code then calls getHostAdapter()
// inside functions/methods — never at module scope.

let _hostAdapter: IHostAdapter | undefined;

export function setHostAdapter(adapter: IHostAdapter): void {
    _hostAdapter = adapter;
}

export function getHostAdapter(): IHostAdapter {
    if (!_hostAdapter) {
        throw new Error("IHostAdapter not initialized — setHostAdapter() must be called at startup");
    }
    return _hostAdapter;
}
