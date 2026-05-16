
// VscodeAdapter implements IHostAdapter using VS Code extension APIs.
import * as vscode from "vscode";
import * as fs from "fs";
import { HostConfig, ChainedConfig } from "../adapter/servers/common";
import { IHostAdapter, ISWORTTView, IOutputChannel } from "../common/host-adapter";
import { handleHostConfig } from "../common/proxy";
import { GraphConfiguration } from "../common/swo/common";
import { MCUDebugChannel } from "../dbgmsgs";
import { CDebugSession, CDebugChainedSessionItem } from "./mcu-debug-session";
import { GDBServerConsole } from "./server-console";
import { SWOWebview } from "./swo/swo-view";
import { SymbolInformation } from "../adapter/symbols";

// It lives here (frontend/) so that common/ stays free of vscode imports.
export class VscodeAdapter implements IHostAdapter {
    constructor(private readonly context: vscode.ExtensionContext) { }

    showError(msg: string): void {
        vscode.window.showErrorMessage(msg);
    }

    showWarning(msg: string): void {
        vscode.window.showWarningMessage(msg);
    }

    showInfo(msg: string): void {
        vscode.window.showInformationMessage(msg);
    }

    getSetting<T>(section: string, key: string, defaultValue?: T): T | undefined {
        const cfg = vscode.workspace.getConfiguration(section);
        return defaultValue !== undefined ? cfg.get<T>(key, defaultValue) : cfg.get<T>(key);
    }

    getExtensionPath(): string {
        return this.context.extensionPath;
    }

    getGdbServerConsolePort(): number {
        return GDBServerConsole.BackendPort;
    }

    getUsedPorts(): number[] {
        return CDebugSession.getAllUsedPorts();
    }

    async handleHostConfig(hostConfig: HostConfig | undefined, onDelete: () => void): Promise<void> {
        return handleHostConfig(hostConfig, onDelete);
    }

    getWorkspaceFilePath(): string | undefined {
        return vscode.workspace.workspaceFile?.fsPath;
    }

    findChainedSession(name: string): { parent: { config: any }; config: ChainedConfig } | undefined {
        return CDebugChainedSessionItem.FindByName(name);
    }

    debugMessage(msg: string): void {
        MCUDebugChannel.debugMessage(msg);
    }

    getRemoteName(): string | undefined {
        return vscode.env.remoteName;
    }

    async showErrorWithChoice(msg: string, modal: boolean, ...choices: string[]): Promise<string | undefined> {
        return vscode.window.showErrorMessage(msg, { modal }, ...choices);
    }

    async executeProxyCommand<T>(command: string, ...args: unknown[]): Promise<T | null> {
        return vscode.commands.executeCommand<T | null>(command, ...args);
    }

    createSWORTTWebView(extensionPath: string, graphs: GraphConfiguration[]): ISWORTTView {
        return new SWOWebview(extensionPath, graphs);
    }

    createOutputChannel(name: string): IOutputChannel {
        return new VSCodeOutputChannel(name);
    }

    loadFunctionSymbols(session: any): SymbolInformation[] {
        let symbols: SymbolInformation[] = [];
        session.customRequest("load-function-symbols").then(
            async (result: any) => {
                try {
                    const filePath = result.file as string;
                    const fileContent = await fs.promises.readFile(filePath, "utf8");
                    const parsed = JSON.parse(fileContent, (key, value) => {
                        return key === "address" || key === "addressOrig" ? BigInt(value) : value;
                    });
                    symbols.push(...parsed.functionSymbols);
                    await fs.promises.unlink(filePath);
                } catch (e) {
                    MCUDebugChannel.debugMessage(`Error loading function symbols: ${e instanceof Error ? e.message : String(e)}`);
                    symbols = [];
                }
            },
            (error: any) => {
                MCUDebugChannel.debugMessage(`Error loading function symbols: ${error instanceof Error ? error.message : String(error)}`);
                symbols = [];
            },
        );

        return symbols;
    }
}

export class VSCodeOutputChannel implements IOutputChannel {
    private output: vscode.OutputChannel;
    constructor(name: string) {
        this.output = vscode.window.createOutputChannel(name);
    }

    get name(): string {
        return this.output.name;
    }

    append(value: string): void {
        this.output.append(value);
    }

    appendLine(value: string): void {
        this.output.appendLine(value);
    }

    clear(): void {
        this.output.clear();
    }

    show(preserveFocus?: boolean): void {
        this.output.show(preserveFocus);
    }

    hide(): void {
        this.output.hide();
    }

    replace(value: string): void {
        this.output.clear();
        this.output.append(value);
    }

    dispose(): void {
        this.output.dispose();
    }
}
