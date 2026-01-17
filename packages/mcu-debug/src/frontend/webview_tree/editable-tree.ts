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
        // In a real implementation, you would load these from separate files
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "webview-tree.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "webview-tree.css"));

        // Inline simple impl for scaffolding
        const scriptContent = `
            const vscode = acquireVsCodeApi();
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'setChildren':
                        renderChildren(message.element, message.children);
                        break;
                    case 'newItem':
                        startAdd();
                        break;
                    case 'refresh':
                        requestChildren(); 
                        break;
                }
            });

            function requestChildren(element) {
                vscode.postMessage({ type: 'getChildren', element });
            }

            function renderChildren(parent, children) {
                const container = parent ? document.getElementById('children-' + parent.id) : document.getElementById('tree-root');
                if (!container) return;
                
                container.innerHTML = '';
                const ul = document.createElement('ul');
                children.forEach(item => {
                    const li = document.createElement('li');
                    li.className = 'tree-item';
                    
                    const content = document.createElement('div');
                    content.className = 'tree-content';
                    content.innerHTML = \`
                        <span class="codicon codicon-chevron-right \${item.hasChildren ? '' : 'hidden'}"></span>
                        <span class="label" ondblclick="startEdit(this, '\${item.id}', 'label')">\${item.label}</span>
                        <span class="value" ondblclick="startEdit(this, '\${item.id}', 'value')">\${item.value || ''}</span>
                    \`;
                    
                    li.appendChild(content);
                    if (item.hasChildren) {
                        const childContainer = document.createElement('div');
                        childContainer.id = 'children-' + item.id;
                        li.appendChild(childContainer);
                    }
                    ul.appendChild(li);
                });
                container.appendChild(ul);
            }

            // Primitive Edit Logic
            window.startEdit = (element, id, field) => {
                const currentVal = element.innerText;
                const input = document.createElement('input');
                input.type = 'text';
                input.value = currentVal;
                input.onblur = () => {
                    if (input.value !== currentVal) {
                        vscode.postMessage({ type: 'edit', item: { id }, value: input.value });
                    }
                    element.innerText = input.value; // Optimistic update
                };
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') input.blur();
                };
                element.innerHTML = '';
                element.appendChild(input);
                input.focus();
            };

            function startAdd() {
                const container = document.getElementById('tree-root');
                let ul = container.querySelector('ul');
                if (!ul) {
                    ul = document.createElement('ul');
                    container.appendChild(ul);
                }
                
                const li = document.createElement('li');
                li.className = 'tree-item';
                const content = document.createElement('div');
                content.className = 'tree-content';
                
                const input = document.createElement('input');
                input.type = 'text';
                input.placeholder = 'Expression';
                
                content.appendChild(input);
                li.appendChild(content);
                ul.appendChild(li);
                
                input.focus();
                
                const commit = () => {
                   if (input.value) {
                       vscode.postMessage({ type: 'add', value: input.value });
                   }
                   // The refresh will kill this node anyway
                };
                
                input.onblur = commit;
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') {
                        input.blur();
                    } else if (e.key === 'Escape') {
                        li.remove();
                    }
                };
            }

            // Initial load
            requestChildren();
        `;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { padding: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
                ul { list-style: none; padding-left: 20px; margin: 0; }
                #tree-root { padding-left: 0; }
                .tree-item { cursor: pointer; }
                .tree-content { display: flex; align-items: center; padding: 2px 0; }
                .tree-content:hover { background: var(--vscode-list-hoverBackground); }
                .hidden { visibility: hidden; }
                input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
                .label { margin-right: 10px; font-weight: bold; }
                .value { color: var(--vscode-debugTokenExpression-value); }
            </style>
        </head>
        <body>
            <div id="tree-root"></div>
            <script>
                ${scriptContent}
            </script>
        </body>
        </html>`;
    }
}
