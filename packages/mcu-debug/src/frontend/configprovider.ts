import * as vscode from "vscode";
import { ConfigurationArguments } from "../adapter/servers/common";
import { McuDebugConfigurationProviderBase } from "../common/config-provider";
import { VscodeAdapter } from "./vscode-adapter";

export class McuDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private readonly base: McuDebugConfigurationProviderBase;

    constructor(context: vscode.ExtensionContext) {
        this.base = new McuDebugConfigurationProviderBase(new VscodeAdapter(context));
    }

    public provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return this.base.provideDebugConfigurations() as vscode.DebugConfiguration[];
    }

    public async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        return this.base.resolveDebugConfiguration(folder?.uri.fsPath, config as unknown as ConfigurationArguments & { [key: string]: any }) as Promise<vscode.DebugConfiguration | undefined>;
    }

    public resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        return this.base.resolveDebugConfigurationWithSubstitutedVariables(folder?.uri.fsPath, config as unknown as ConfigurationArguments & { [key: string]: any }) as vscode.DebugConfiguration | undefined;
    }
}
