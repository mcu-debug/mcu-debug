import * as vscode from "vscode";
import * as path from "path";
import { getNonce } from "../../adapter/servers/common";
import type { FromUi } from "@mcu-debug/shared";
import { ManagedTab, type CockpitPanelSink } from "./ManagedTab";

/**
 * WebviewViewProvider for the MCU DEBUG bottom panel.
 *
 * Hosts the Svelte cockpit webview (resources/cockpit/) and manages the
 * collection of ManagedTab instances. Each ManagedTab owns its data source
 * (socket, RTT channel, etc.) and calls back into this panel to post messages.
 *
 * VS Code owns the singleton lifecycle. resolveWebviewView may be called more
 * than once (e.g. after a full panel collapse). On each call we replay all
 * existing tabs so the webview rebuilds its state correctly.
 */
export class CockpitPanel implements vscode.WebviewViewProvider, CockpitPanelSink {
    public static instance: CockpitPanel | undefined;
    public static readonly viewId = "mcu-debug.cockpit";

    private _view: vscode.WebviewView | undefined;
    private _webviewReady = false;
    private _activeTabId: string | null = null;
    private readonly _tabs = new Map<string, ManagedTab>();

    constructor(private readonly _extensionUri: vscode.Uri) {
        CockpitPanel.instance = this;
    }

    // -------------------------------------------------------------------------
    // vscode.WebviewViewProvider
    // -------------------------------------------------------------------------

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;
        this._webviewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "resources", "cockpit")],
        };

        webviewView.webview.html = this._buildHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: FromUi) => this._handleFromUi(msg));

        // When the view is hidden (user switches panel tabs), VS Code destroys the webview.
        // Mark mounted terminals as unavailable immediately so send() queues data instead of
        // posting to a dead webview. Data is replayed when the active tab's terminal remounts.
        webviewView.onDidChangeVisibility(() => {
            for (const tab of this._tabs.values()) {
                tab._onTerminalMountStateChanged(webviewView.visible);
            }
        });
        webviewView.onDidDispose(() => {
            this._view = undefined;
            this._webviewReady = false;
            for (const tab of this._tabs.values()) {
                tab._onTerminalMountStateChanged(false);
            }
        });

        // Tabs are replayed when the webview sends { type: 'ready' } — see _handleFromUi.
    }

    // -------------------------------------------------------------------------
    // CockpitPanelSink — called by ManagedTab instances
    // -------------------------------------------------------------------------

    postToWebview(msg: object): void {
        this._view?.webview.postMessage(msg);
    }

    isParentPanelVisible(): boolean {
        return this._view?.visible ?? false;
    }

    isTabActive(tabId: string): boolean {
        return this._activeTabId === tabId;
    }

    // -------------------------------------------------------------------------
    // Public API — used by the rest of the extension
    // -------------------------------------------------------------------------

    /**
     * Register a new tab and tell the webview to display it.
     * Idempotent: calling again with the same tabId is a no-op.
     */
    addTab(tab: ManagedTab): void {
        if (this._tabs.has(tab.tabId)) {
            return;
        }
        this._tabs.set(tab.tabId, tab);
        tab._attach(this);
        if (this._webviewReady) {
            this.postToWebview({ type: "tab-add", tab: tab.descriptor });
        }
        // else: tab is in _tabs and will be sent when the webview fires 'ready'
    }

    /**
     * Remove a tab from the internal registry without telling the webview.
     * Used when the extension tears down a tab that the user already closed
     * (the webview already removed it from its own state via tab-close).
     */
    removeTab(tabId: string): void {
        this._tabs.delete(tabId);
        if (this._activeTabId === tabId) {
            this._activeTabId = null;
        }
    }

    findTabByLabel(label: string): ManagedTab | undefined {
        for (const tab of this._tabs.values()) {
            if (tab.label === label) {
                return tab;
            }
        }
        return undefined;
    }

    get tabCount(): number {
        return this._tabs.size;
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    private _handleFromUi(msg: FromUi): void {
        if (msg.type === "ready") {
            this._webviewReady = true;
            for (const tab of this._tabs.values()) {
                tab._resetTerminalReady();
                this._view?.webview.postMessage({ type: "tab-add", tab: tab.descriptor });
            }
            return;
        }
        if (msg.type === "active-tab-changed") {
            this._activeTabId = msg.tabId;
            for (const tab of this._tabs.values()) {
                tab._onTerminalMountStateChanged(this.isParentPanelVisible() && this._activeTabId === tab.tabId);
            }
            return;
        }
        if (msg.type === "terminal-ready") {
            this._tabs.get(msg.tabId)?._onTerminalReady();
            return;
        }
        const tab = this._tabs.get(msg.tabId);
        if (!tab) {
            return;
        }
        switch (msg.type) {
            case "user-input":
                tab.onUserInput(msg.text);
                break;
            case "tab-close":
                tab.onUserClose();
                this._tabs.delete(msg.tabId);
                break;
        }
    }

    private _buildHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "resources", "cockpit", "cockpit.js"),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "resources", "cockpit", "cockpit.css"),
        );
        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';
                 style-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" nonce="${nonce}" href="${styleUri}">
</head>
<body>
    <div id="app"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
