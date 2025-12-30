import * as vscode from "vscode";
import * as net from "net";

function activate(context: vscode.ExtensionContext) {
    console.log("mcu-debug-proxy: Activating extension");

    //const server = new DebugProxyServer(context);
    //context.subscriptions.push(server);

    console.log("mcu-debug-proxy: Extension activated");
}

export function deactivate() {
    console.log("mcu-debug-proxy: Deactivating extension");
}
