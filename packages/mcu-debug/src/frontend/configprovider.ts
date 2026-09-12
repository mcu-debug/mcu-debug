import * as vscode from "vscode";
import { ConfigurationArguments } from "../adapter/servers/common";
import { McuDebugConfigurationProviderBase } from "../common/config-provider";
import { VscodeAdapter } from "./vscode-adapter";
import { ensureProxyForLaunch, needsProxyExtension } from "./activate-proxy";

export class McuDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private readonly base: McuDebugConfigurationProviderBase;

    private readonly ourVersion: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.base = new McuDebugConfigurationProviderBase(new VscodeAdapter(context));
        this.ourVersion = context.extension.packageJSON.version as string;
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

    public async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        // Only the remote-probe modes route through the proxy extension, and only a remote
        // window needs it -- a local window starts its own probe agent. Cancel the launch if it
        // is needed and unavailable: the user has been told why and offered the install.
        if (
            vscode.env.remoteName !== undefined &&
            needsProxyExtension(config.hostConfig) &&
            !(await ensureProxyForLaunch(this.ourVersion))
        ) {
            return undefined;
        }
        return this.base.resolveDebugConfigurationWithSubstitutedVariables(folder?.uri.fsPath, config as unknown as ConfigurationArguments & { [key: string]: any }) as Promise<vscode.DebugConfiguration | undefined>;
    }
}
