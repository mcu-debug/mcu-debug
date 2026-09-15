import * as vscode from "vscode";
import { ConfigurationArguments } from "../adapter/servers/common";
import { McuDebugConfigurationProviderBase } from "../common/config-provider";
import { VscodeAdapter } from "./vscode-adapter";
import { ensureProxyForLaunch, needsProxyExtension } from "./activate-proxy";
import { SerialPortManager } from "../common/serial-manager";
import { logger } from "../common/logger";

export class McuDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private readonly base: McuDebugConfigurationProviderBase;

    private readonly ourVersion: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly serialPortManager: SerialPortManager,
    ) {
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
        const resolved = await this.base.resolveDebugConfigurationWithSubstitutedVariables(folder?.uri.fsPath, config as unknown as ConfigurationArguments & { [key: string]: any });
        if (resolved) {
            this.openSerialPorts(resolved as ConfigurationArguments);
        }
        return resolved as vscode.DebugConfiguration | undefined;
    }

    /**
     * Open this launch's serial ports now, before the adapter has even started.
     *
     * Nothing has touched the target yet, so the ports attach before the firmware prints its first
     * byte. This used to wait for the adapter's `uart-configure` event, sent only after GDB had
     * connected; the open then raced the firmware, which was often past `main` before the port was
     * attached.
     *
     * Deliberately not awaited. A slow port must not hold up the launch — programming a KitProg3's
     * line settings has measured 3.37 s — and a port that fails to open must not fail it.
     * `SerialPortManager` reports its own errors; the catch only keeps a rejection from going unhandled.
     *
     * Given a JSON copy rather than `config` itself: `createSerialPorts` edits its argument
     * synchronously (it deletes a disabled or empty `serialConfig`), which would otherwise land in the
     * launch configuration before VS Code sends it to the adapter. The copy is exactly the data the
     * adapter used to echo back in `uart-configure`.
     */
    private openSerialPorts(config: ConfigurationArguments) {
        const copy = JSON.parse(JSON.stringify(config)) as ConfigurationArguments;
        this.serialPortManager.createSerialPorts(copy).catch((e) => {
            logger.error(`Failed to open serial ports: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
}
