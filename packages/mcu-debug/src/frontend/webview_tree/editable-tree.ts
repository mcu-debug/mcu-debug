import * as vscode from "vscode";

export interface TreeItem {
    id: string;
    label: string;
    value?: string;
    hasChildren?: boolean;
    expanded?: boolean;
    contextValue?: string;
}

export interface TreeViewProviderDelegate {
    getChildren(element?: TreeItem): Promise<TreeItem[]>;
    onEdit(item: TreeItem, newValue: string): Promise<void>;
    onDelete?(item: TreeItem): Promise<void>;
    onAdd?(value: string): Promise<void>;
}

export class EditableTreeViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _delegate: TreeViewProviderDelegate,
    ) {}

    public add() {
        this._view?.webview.postMessage({ type: "newItem" });
    }

    public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "getChildren":
                    const children = await this._delegate.getChildren(data.element);
                    this._view?.webview.postMessage({ type: "setChildren", element: data.element, children });
                    break;
                case "edit":
                    await this._delegate.onEdit(data.item, data.value);
                    this.refresh();
                    break;
                case "add":
                    if (this._delegate.onAdd) {
                        await this._delegate.onAdd(data.value);
                        this.refresh();
                    }
                    break;
                case "delete":
                    if (this._delegate.onDelete) {
                        await this._delegate.onDelete(data.item);
                        this.refresh();
                    }
                    break;
            }
        });
    }

    public refresh() {
        if (this._view) {
            this._view.webview.postMessage({ type: "refresh" });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "webview-tree.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "webview-tree.css"));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "node_modules", "@vscode/codicons", "dist", "codicon.css"));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${styleUri}" rel="stylesheet" />
            <link href="${codiconsUri}" rel="stylesheet" />
        </head>
        <body>
            <div id="tree-root"></div>
            <script src="${scriptUri}"></script>
        </body>
        </html>`;
    }
}
