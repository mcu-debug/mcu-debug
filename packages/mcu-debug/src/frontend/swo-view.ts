
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GraphConfiguration, GrapherMessage } from "../common/swo/common";
import { SWORTTGraphProcessor } from "../common/swo/decoders/graph";
import { SWORTTAdvancedProcessor } from "../common/swo/decoders/advanced";
import { getNonce } from "../adapter/servers/common";
import { ISWORTTView } from "../common/host-adapter";

export class SWOWebview implements ISWORTTView {
    private viewPanel: vscode.WebviewPanel;
    private currentStatus: "stopped" | "terminated" | "continued" = "stopped";
    private now: Date;

    constructor(
        private extensionPath: string,
        public graphs: GraphConfiguration[],
    ) {
        this.now = new Date();
        const time = this.now.toTimeString();

        const showOptions = { preserveFocus: true, viewColumn: vscode.ViewColumn.Beside };
        const viewOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
            retainContextWhenHidden: true,
            enableFindWidget: false,
            enableCommandUris: false,
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(extensionPath, "dist"))],
        };

        const title = `SWO/RTT Graphs [${time}]`;
        this.viewPanel = vscode.window.createWebviewPanel("mcu-debug.grapher", title, showOptions, viewOptions);
        this.viewPanel.webview.onDidReceiveMessage((msg) => {
            this.onMessage(msg);
        });
        this.viewPanel.webview.html = this.getHTML();
    }

    private getHTML() {
        const onDiskPath = vscode.Uri.file(path.join(this.extensionPath, "dist", "grapher.bundle.js"));
        const scriptUri = this.viewPanel.webview.asWebviewUri(onDiskPath);

        const nonce = getNonce();

        let html = fs.readFileSync(path.join(this.extensionPath, "resources", "grapher.html"), { encoding: "utf8", flag: "r" });
        html = html.replace(/\$\{nonce\}/g, nonce).replace(/\$\{scriptUri\}/g, scriptUri.toString());

        return html;
    }

    private processors: (SWORTTGraphProcessor | SWORTTAdvancedProcessor)[] = [];
    public registerProcessors(processor: SWORTTGraphProcessor | SWORTTAdvancedProcessor): void {
        processor.on("message", this.sendMessage.bind(this));
        this.processors.push(processor);
    }

    public clearProcessors(): void {
        this.processors = [];
    }

    public sendMessage(message: GrapherMessage): void {
        message.timestamp = new Date().getTime();
        this.viewPanel.webview.postMessage(message);
    }

    private onMessage(message: GrapherMessage) {
        if (message.type === "init") {
            const message = { type: "configure", graphs: this.graphs, status: this.currentStatus };
            this.viewPanel.webview.postMessage(message);
        }
    }
}
