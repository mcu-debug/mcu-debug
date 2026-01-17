import * as vscode from "vscode";
import { TreeItem, TreeItemCollapsibleState, DebugSession, ProviderResult, Event, EventEmitter, Disposable } from "vscode";
import { TreeViewProviderDelegate, TreeItem as WebviewTreeItem } from "../webview_tree/editable-tree";
import {
    LiveUpdateEvent,
    RegisterClientRequest,
    RegisterClientResponse,
    DeleteLiveGdbVariables,
    LiveConnectedEvent,
    EvaluateRequestLiveArguments,
    EvaluateLiveResponse,
    VariablesRequestLiveArguments,
    LatestLiveSessionVersion,
} from "../../adapter/custom-requests";
import { VarUpdateRecord } from "../../adapter/gdb-mi/mi-types";

// Configuration interfaces
interface LiveWatchConfig {
    enabled: boolean;
    samplesPerSecond: number;
}

interface SaveVarState {
    expanded: boolean;
    value: string;
    children: LiveVariableNode[] | undefined;
}

interface SaveVarStateMap {
    [name: string]: SaveVarState;
}

interface GdbMapUpdater {
    addToMap: (gdbName: string, node: LiveVariableNode) => void;
    getFromMap: (gdbName: string) => LiveVariableNode | undefined;
    removeFromMap: (gdbName: string) => void;
    getLiveSessionId: () => string | undefined;
}

export class LiveVariableNode {
    public parent: LiveVariableNode | undefined;
    public expanded: boolean = false;
    public children: LiveVariableNode[] = [];
    public variablesReference: number = 0;
    public gdbVarName: string = "";
    public session: vscode.DebugSession | undefined;
    public childrenLoaded: boolean = false;
    protected prevValue: string = "";

    // Added for webview compat
    public readonly id: string;

    constructor(
        private mapUpdater: GdbMapUpdater,
        parent: LiveVariableNode | undefined,
        protected name: string,
        protected expr: string, // Any string for top level ars but lower level ones are actual children's simple names
        protected value = "", // Current value
        protected type = "", // C/C++ Type if any
        variablesReference = 0,
        gdbVarName = "",
    ) {
        // Variable reference returned by the debugger (only valid per-session)
        this.parent = parent;
        this.variablesReference = variablesReference;
        this.gdbVarName = gdbVarName;
        this.mapUpdater?.addToMap(gdbVarName, this);

        // Generate a unique ID for the webview tree
        // Root children use expr, others use gdbVarName or combined path
        if (!parent) {
            this.id = "root";
        } else if (this.isRootChild()) {
            this.id = "expr-" + Buffer.from(this.expr).toString("base64");
        } else {
            this.id = "var-" + (this.gdbVarName || Math.random().toString(36).substring(2));
        }
    }

    public isDummyNode(): boolean {
        return false;
    }

    public getParent(): LiveVariableNode | undefined {
        return this.parent;
    }

    public getExpr(): string {
        return this.expr;
    }

    public getChildren(): LiveVariableNode[] {
        if (!this.parent && (!this.children || !this.children.length)) {
            return [];
        }

        const ret = [...(this.children ?? [])];
        return ret;
    }

    public isRootChild(): boolean {
        const node = this.parent;
        return node && node.getParent() === undefined;
    }

    public rename(nm: string) {
        if (this.isRootChild()) {
            this.name = nm;
            this.expr = nm;
            this.value = "";
            this.type = "";
            this.variablesReference = 0;
            if (this.gdbVarName) {
                this.mapUpdater?.removeFromMap(this.gdbVarName);
            }
            this.gdbVarName = "";
            this.clearChildren();
        }
    }

    public getName() {
        return this.name;
    }

    public findName(str: string): LiveVariableNode | undefined {
        for (const child of this.children || []) {
            if (child.name === str) {
                return child;
            }
        }
        return undefined;
    }

    public getDgbVarNames(): string[] {
        const names: string[] = [];
        if (this.gdbVarName) {
            names.push(this.gdbVarName);
        }
        for (const child of this.children || []) {
            names.push(...child.getDgbVarNames());
        }
        return names;
    }

    private clearChildren() {
        // this.variablesReference = 0; Keep it, we could use it later, if we get children again
        this.expanded = false;
        for (const child of this.children || []) {
            child.clearChildren();
            if (child.gdbVarName) {
                this.mapUpdater?.removeFromMap(child.gdbVarName);
            }
        }
        this.children = undefined;
        this.childrenLoaded = false;
    }

    updateFromGdb(update: VarUpdateRecord): Promise<void> {
        return new Promise<void>((resolve) => {
            if (update.in_scope === "false") {
                this.value = "<out of scope>";
                // We should probably delete the children?
            } else if (update.in_scope === "invalid") {
                this.value = "<invalid>";
            }
            this.value = update.value;
            this.type = update.type_changed === "true" && update.new_type ? update.new_type : this.type;
            if (update.new_num_children !== undefined) {
                const num = parseInt(update.new_num_children);
                if (num === 0) {
                    this.clearChildren();
                } else if (this.children && this.children.length > 0) {
                    // We have children, but the number changed. We need to re-fetch?
                    // For now, just clear
                    this.clearChildren();
                }
            }
            resolve();
        });
    }

    // Convert to Webview Tree Item
    public toWebviewTreeItem(): WebviewTreeItem {
        const parts = this.name.startsWith("'") && this.isRootChild() ? this.name.split("'::") : [this.name];
        const name = parts.pop() || "";

        return {
            id: this.id,
            label: name,
            value: this.value || "not available",
            hasChildren: this.variablesReference > 0 || (this.children && this.children.length > 0),
            expanded: this.expanded,
        };
    }

    public getCopyValue(): string {
        throw new Error("Method not implemented.");
    }

    public addChild(name: string, expr: string = "", value = "", type = "", reference = 0): LiveVariableNode {
        if (!this.children) {
            this.children = [];
        }
        const child = new LiveVariableNode(this.mapUpdater, this, name, expr || name, value, type, reference);
        this.children.push(child);
        return child;
    }

    public removeChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) {
            return false;
        }
        let ix = 0;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                this.children!.splice(ix, 1);
                node.clearChildren();
                if (node.gdbVarName) {
                    this.mapUpdater.removeFromMap(node.gdbVarName);
                }
                return true;
            }
            ix++;
        }
        return false;
    }

    public moveUpChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) {
            return false;
        }
        let ix = 0;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                if (ix > 0) {
                    this.children!.splice(ix, 1);
                    this.children!.splice(ix - 1, 0, child);
                    return true;
                }
                break;
            }
            ix++;
        }
        return false;
    }

    public moveDownChild(node: LiveVariableNode): boolean {
        if (!node || !node.isRootChild()) {
            return false;
        }
        let ix = 0;
        const last = this.children ? this.children.length - 1 : -1;
        for (const child of this.children || []) {
            if (child.name === node.name) {
                if (ix !== last) {
                    this.children!.splice(ix, 1);
                    this.children!.splice(ix + 1, 0, child);
                } else {
                    // Wrap around
                    this.children!.splice(ix, 1);
                    this.children!.unshift(child);
                }
                return true;
            }
            ix++;
        }
        return false;
    }

    public reset(valuesToo: boolean) {
        this.session = undefined;
        if (valuesToo) {
            this.value = this.type = this.prevValue = "";
        }
        for (const child of this.children || []) {
            child.reset(valuesToo);
        }
    }

    private namedVariables: number = 0;
    private indexedVariables: number = 0;
    private refreshChildren(resolve: () => void) {
        if (!LiveWatchTreeProvider.session || this.session !== LiveWatchTreeProvider.session || !this.mapUpdater.getLiveSessionId()) {
            resolve();
        } else if (this.expanded && (this.variablesReference > 0 || this.gdbVarName)) {
            const recurseChildren = () => {
                const promises = [];
                for (const child of this.children ?? []) {
                    if (child.expanded) {
                        promises.push(child.expandChildren());
                    }
                }
                Promise.allSettled(promises).finally(() => {
                    resolve();
                });
            };
            if (!this.childrenLoaded) {
                const oldStateMap: SaveVarStateMap = {};
                for (const child of this.children ?? []) {
                    oldStateMap[child.getName()] = {
                        expanded: child.expanded,
                        value: "",
                        children: undefined,
                    };
                }
                // TODO: Implement limits on number of children in adapter and then here
                // const start = this.children?.length ?? 0;
                const varg: VariablesRequestLiveArguments = {
                    command: "variablesLive",
                    sessionId: this.mapUpdater.getLiveSessionId() || "",
                    variablesReference: this.variablesReference,
                    gdbVarName: this.gdbVarName,
                    // start: start,
                    // count: 100 // Hardcoded for now
                };
                this.session.customRequest(varg.command, varg).then(
                    (result_) => {
                        if (!result_?.variables?.length) {
                            // No children
                        } else {
                            const vars = result_.variables;
                            this.children = [];
                            for (const v of vars) {
                                const child = new LiveVariableNode(this.mapUpdater, this, v.name, v.evaluateName, v.value, v.type, v.variablesReference, v.gdbVarName);
                                const old = oldStateMap[v.name];
                                if (old) {
                                    child.expanded = old.expanded;
                                }
                                this.children.push(child);
                            }
                            this.childrenLoaded = true;
                        }
                        recurseChildren();
                    },
                    (e) => {
                        resolve();
                    },
                );
            } else if (this.children && this.children.length > 0) {
                recurseChildren();
            } else {
                resolve();
            }
        } else {
            resolve();
        }
    }

    public expandChildren(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.expanded = true;
            // If we still have a current session, try to get the children or
            // wait for the next timer
            this.refreshChildren(resolve);
        });
    }

    public refresh(session: vscode.DebugSession): Promise<void> {
        if (this.isDummyNode() || !this.mapUpdater.getLiveSessionId()) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.session = session;
            if (session !== LiveWatchTreeProvider.session) {
                resolve();
                return;
            }
            if (!this.gdbVarName && this.expr) {
                const arg: EvaluateRequestLiveArguments = {
                    command: "evaluateLive",
                    sessionId: this.mapUpdater.getLiveSessionId() || "",
                    expression: this.expr,
                    context: "watch",
                };
                session.customRequest(arg.command, arg).then(
                    (result_) => {
                        const result = result_ as EvaluateLiveResponse["body"];
                        if (result && result.variableObject !== undefined) {
                            const obj = result.variableObject;
                            if (result.gdbName) {
                                obj.gdbVarName = result.gdbName; // Should already be in the variableObject
                            }
                            this.value = obj.value;
                            this.type = obj.type;
                            this.variablesReference = obj.variablesReference ?? 0;
                            this.namedVariables = obj.namedVariables ?? 0;
                            this.indexedVariables = obj.indexedVariables ?? 0;
                            this.gdbVarName = obj.gdbVarName;
                            this.children = this.variablesReference ? [] : undefined;
                            this.mapUpdater?.addToMap(this.gdbVarName, this);
                            this.refreshChildren(resolve);
                        } else {
                            this.value = `<Failed to evaluate ${this.expr}>`;
                            this.children = undefined;
                            this.mapUpdater?.removeFromMap(this.gdbVarName);
                            resolve();
                        }
                    },
                    () => {
                        resolve();
                    },
                );
            } else if (this.children && !this.parent) {
                // This is the root node
                const promises = [];
                for (const child of this.children) {
                    promises.push(child.refresh(session));
                }
                Promise.allSettled(promises).finally(() => {
                    resolve();
                });
            } else {
                this.refreshChildren(resolve);
            }
        });
    }

    public addNewExpr(expr: string): boolean {
        if (this.parent) {
            // You can't add new expressions unless at the root
            return false;
        }
        for (const child of this.children || []) {
            if (expr === child.expr) {
                return false;
            }
        }
        this.addChild(expr, expr);
        return true;
    }

    private pvtSerialize(state: NodeState | undefined): NodeState {
        const item: NodeState = {
            name: this.name,
            expr: this.expr,
            expanded: this.expanded || !this.parent,
            children: [],
        };
        if (!state) {
            state = item;
        } else {
            state.children.push(item);
        }
        for (const child of this.children ?? []) {
            child.pvtSerialize(item);
        }
        return item;
    }

    public serialize(): NodeState {
        return this.pvtSerialize(undefined);
    }

    public deSerialize(state: NodeState): void {
        for (const child of state.children) {
            if (!this.children) {
                this.children = [];
            }
            const item = new LiveVariableNode(this.mapUpdater, this, child.name, child.expr);
            item.expanded = child.expanded;
            this.children.push(item);
            item.deSerialize(child);
        }
    }
}

class LiveVariableNodeMsg extends LiveVariableNode {
    constructor(
        mapUpdater: GdbMapUpdater | undefined,
        parent: LiveVariableNode,
        private empty = true,
    ) {
        super(undefined, parent, "dummy", "dummy");
    }

    public isDummyNode(): boolean {
        return true;
    }

    public toWebviewTreeItem(): WebviewTreeItem {
        const tmp = 'Hint: Use & Enable "liveWatch" in your launch.json to enable this panel';
        return {
            id: "dummy-msg",
            label: tmp + (this.empty ? ", and use the '+' button above to add new expressions" : ""),
            value: "",
            hasChildren: false,
            expanded: false,
        };
    }

    public getChildren(): LiveVariableNode[] {
        return [];
    }
}

interface NodeState {
    name: string;
    expr: string;
    expanded: boolean;
    children: NodeState[];
}

const VERSION_ID = "livewatch.version";
const WATCH_LIST_STATE = "livewatch.watchTree";

export class LiveWatchTreeProvider implements TreeViewProviderDelegate, GdbMapUpdater {
    // tslint:disable-next-line:variable-name
    public _onDidChangeTreeData: EventEmitter<LiveVariableNode | undefined> = new EventEmitter<LiveVariableNode | undefined>();
    public readonly onDidChangeTreeData: Event<LiveVariableNode | undefined> = this._onDidChangeTreeData.event;

    private static stateVersion = 2;
    public gdbVarNameToNodeMap: Map<string, LiveVariableNode> = new Map<string, LiveVariableNode>();
    private rootNode: LiveVariableNode;
    public static session: vscode.DebugSession | undefined;
    public state: vscode.TreeItemCollapsibleState;
    private toBeDeleted: Set<string> = new Set<string>();
    private isStopped = true;
    private readonly clientId = "mcu-debug-live-watch-tree-provider";
    private liveSessionVersion = LatestLiveSessionVersion;
    private liveSessionId: string | undefined;
    private refreshCallback?: () => void;

    protected oldState = new Map<string, vscode.TreeItemCollapsibleState>();
    constructor(private context: vscode.ExtensionContext) {
        this.rootNode = new LiveVariableNode(this, undefined, "", "");
        this.setRefreshRate();
        this.restoreState();
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this)));
    }

    // --- WebView Delegate Implementation ---

    public setRefreshCallback(callback: () => void) {
        this.refreshCallback = callback;
    }

    async getChildren(element?: WebviewTreeItem): Promise<WebviewTreeItem[]> {
        const node = element ? this.findNodeById(this.rootNode, element.id) : this.rootNode;
        if (!node) return [];

        if (node instanceof LiveVariableNode && element) {
            // Need to expand if not already loaded
            if (!node.childrenLoaded) {
                await node.expandChildren();
            }
        }

        const children = node.getChildren();
        if (node === this.rootNode && children.length === 0) {
            return [new LiveVariableNodeMsg(undefined, this.rootNode, true).toWebviewTreeItem()];
        }

        return children.map((c) => c.toWebviewTreeItem());
    }

    async onEdit(item: WebviewTreeItem, newValue: string): Promise<void> {
        const node = this.findNodeById(this.rootNode, item.id);
        if (node && node.isRootChild()) {
            if (node.getName() !== newValue) {
                if (this.rootNode.findName(newValue)) {
                    vscode.window.showInformationMessage(`Live Watch: Expression ${newValue} is already being watched`);
                } else {
                    node.rename(newValue);
                    this.saveState();
                    this.refresh(LiveWatchTreeProvider.session);
                }
            }
        }
    }

    async onDelete(item: WebviewTreeItem): Promise<void> {
        const node = this.findNodeById(this.rootNode, item.id);
        if (node) {
            this.removeWatchExpr(node);
        }
    }

    async onAdd(value: string): Promise<void> {
        if (!value) return;
        // Strip whitespace
        value = value.trim();
        if (!value) return;

        if (this.rootNode.findName(value)) {
            vscode.window.showInformationMessage(`Live Watch: Expression ${value} is already being watched`);
        } else {
            // We can use the existing helper
            this.addWatchExpr(value, LiveWatchTreeProvider.session);
        }
    }

    private findNodeById(node: LiveVariableNode, id: string): LiveVariableNode | undefined {
        if (node.id === id) return node;
        for (const child of node.getChildren()) {
            const found = this.findNodeById(child, id);
            if (found) return found;
        }
        return undefined;
    }

    // --- End WebView Delegate ---

    addToMap(gdbName: string, node: LiveVariableNode): void {
        if (gdbName) {
            this.gdbVarNameToNodeMap.set(gdbName, node);
        }
    }
    getFromMap(gdbName: string): LiveVariableNode | undefined {
        if (gdbName) {
            return this.gdbVarNameToNodeMap.get(gdbName);
        }
        return undefined;
    }
    removeFromMap(gdbName: string): void {
        if (gdbName) {
            this.toBeDeleted.add(gdbName);
            this.gdbVarNameToNodeMap.delete(gdbName);
        }
    }
    getLiveSessionId(): string | undefined {
        return this.liveSessionId;
    }

    private restoreState() {
        try {
            const state = this.context.workspaceState;
            const ver = state.get(VERSION_ID) ?? LiveWatchTreeProvider.stateVersion;
            if (ver === LiveWatchTreeProvider.stateVersion) {
                const data = state.get(WATCH_LIST_STATE);
                const saved = data as NodeState;
                if (saved) {
                    this.rootNode.deSerialize(saved);
                }
            }
        } catch (error) {
            console.error("live-watch.restoreState", error);
        }
    }

    private static defaultRefreshRate = 300;
    private currentRefreshRate = LiveWatchTreeProvider.defaultRefreshRate;
    private settingsChanged(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration("mcu-debug.liveWatchRefreshRate")) {
            this.setRefreshRate();
        }
    }
    private static minRefreshRate = 200; // Seems to be the magic number
    private static maxRefreshRate = 1000;
    private setRefreshRate() {
        const config = vscode.workspace.getConfiguration("mcu-debug", null);
        let rate = config.get("liveWatchRefreshRate", LiveWatchTreeProvider.defaultRefreshRate);
        rate = Math.max(rate, LiveWatchTreeProvider.minRefreshRate);
        rate = Math.min(rate, LiveWatchTreeProvider.maxRefreshRate);
        this.currentRefreshRate = rate;
    }

    public saveState() {
        const state = this.context.workspaceState;
        const data = this.rootNode.serialize();
        state.update(VERSION_ID, LiveWatchTreeProvider.stateVersion);
        state.update(WATCH_LIST_STATE, data);
    }

    private isSameSession(session: vscode.DebugSession): boolean {
        if (session && LiveWatchTreeProvider.session && session.id === LiveWatchTreeProvider.session.id) {
            return true;
        }
        return false;
    }

    async receivedVariableUpdates(e_: vscode.DebugSessionCustomEvent) {
        try {
            const e = e_ as any as LiveUpdateEvent;
            const session = e_.session;
            if (!this.isSameSession(session)) {
                return;
            }
            const promises = [];
            let changed = false;
            for (const update of e.body?.updates || []) {
                const node = this.gdbVarNameToNodeMap.get(update.name);
                if (node) {
                    changed = true;
                    promises.push(node.updateFromGdb(update));
                }
            }
            await Promise.allSettled(promises);
            if (changed) {
                this.refresh(session).then(() => {
                    this.fire();
                });
            }
            await this.deleteGdbVars(session);
        } catch (error) {
            console.error("live-watch.receivedVariableUpdates", error);
        }
    }

    private async deleteGdbVars(session: vscode.DebugSession) {
        const save = this.toBeDeleted;
        if (save.size === 0 || !this.getLiveSessionId()) {
            return;
        }
        try {
            this.toBeDeleted = new Set<string>();
            const arg: DeleteLiveGdbVariables = {
                command: "deleteLiveGdbVariables",
                sessionId: this.liveSessionId || "",
                deleteGdbVars: Array.from(save),
            };
            // The following will update all the variables in the backend cache in bulk
            await session.customRequest(arg.command, arg);
        } catch (e) {
            for (const item of save) {
                this.toBeDeleted.add(item);
            }
        }
    }

    public debugSessionTerminated(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = true;
            LiveWatchTreeProvider.session = undefined;
            this.fire();
            this.saveState();
            this.getLiveSessionId = undefined;
            setTimeout(() => {
                // We hold the current values as they are until we start another debug session and
                // another fire() is called
                this.rootNode.reset(true);
                this.clearGdbVarNameMap();
            }, 100);
        }
    }

    clearGdbVarNameMap() {
        for (const [key, value] of this.gdbVarNameToNodeMap) {
            value.gdbVarName = "";
        }
        this.gdbVarNameToNodeMap.clear();
    }

    public async refresh(session: vscode.DebugSession, restartTimer = false): Promise<void> {
        let promises = [];
        for (const child of this.rootNode.getChildren()) {
            if (child.isDummyNode() || child.gdbVarName) {
                continue;
            }
            promises.push(child.refresh(session));
        }
        if (promises.length > 0) {
            await Promise.allSettled(promises);
            this.fire();
        }
    }

    liveWatchConnected(e_: vscode.DebugSessionCustomEvent) {
        const session = e_.session;
        if (!this.isSameSession(session)) {
            return;
        }
        const e = e_ as any as LiveConnectedEvent;
        const req: RegisterClientRequest = {
            command: "registerClient",
            clientId: this.clientId,
            version: this.liveSessionVersion,
            sessionId: "",
        };
        session.customRequest(req.command, req).then(
            (result_) => {
                const result = result_ as RegisterClientResponse["body"];
                this.liveSessionId = result.sessionId;
                this.refresh(session).then(() => {
                    this.fire();
                });
            },
            (e) => {
                vscode.window.showErrorMessage("Unable to register Live Watch client with debug adapter. Live Watch will be disabled. $(e)");
            },
        );
    }

    public debugSessionStarted(session: vscode.DebugSession) {
        const liveWatch = session.configuration.liveWatch as LiveWatchConfig;
        if (!liveWatch?.enabled) {
            if (!LiveWatchTreeProvider.session) {
                // Force a child node to be created to provide a Hint
                this.fire();
            }
            return;
        }
        if (LiveWatchTreeProvider.session) {
            vscode.window.showErrorMessage("Error: You can have live-watch enabled to only one debug session at a time. Live Watch is already enabled for " + LiveWatchTreeProvider.session.name);
            return;
        }
        LiveWatchTreeProvider.session = session;
        this.isStopped = true;
        this.rootNode.reset(true);
        this.clearGdbVarNameMap();
    }

    public debugStopped(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = true;
        }
    }

    public debugContinued(session: vscode.DebugSession) {
        if (this.isSameSession(session)) {
            this.isStopped = false;
        }
    }

    public addWatchExpr(expr: string, session: vscode.DebugSession) {
        expr = expr.trim();
        if (expr && this.rootNode.addNewExpr(expr)) {
            this.saveState();
            this.refresh(LiveWatchTreeProvider.session);
        }
    }

    public removeWatchExpr(node: LiveVariableNode) {
        try {
            if (this.rootNode.removeChild(node)) {
                this.saveState();
                this.fire();
            }
        } catch (e) {
            console.error("Failed to remove node. Invalid node?", node);
        }
    }

    public async editNode(node: LiveVariableNode) {
        if (!node || !node.isRootChild()) {
            return;
        }
        const val = await vscode.window.showInputBox({
            placeHolder: "Enter a valid C/gdb expression. Must be a global variable expression",
            ignoreFocusOut: true,
            value: node.getName(),
        });
        if (val) {
            if (val !== node.getName()) {
                if (this.rootNode.findName(val)) {
                    vscode.window.showInformationMessage(`Live Watch: Expression ${val} is already being watched`);
                } else {
                    node.rename(val);
                    this.saveState();
                    this.refresh(LiveWatchTreeProvider.session);
                }
            }
        }
    }

    // Legacy method for non-in-place edit/move (can be kept or removed if moved entirely to webview)
    public moveUpNode(node: LiveVariableNode) {
        const parent = node?.getParent() as LiveVariableNode;
        if (parent && parent.moveUpChild(node)) {
            this.fire();
        }
    }

    public moveDownNode(node: LiveVariableNode) {
        const parent = node?.getParent() as LiveVariableNode;
        if (parent && parent.moveDownChild(node)) {
            this.fire();
        }
    }

    private inFire = false;
    public fire() {
        if (!this.inFire) {
            this.inFire = true;
            setTimeout(() => {
                this.inFire = false;
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
            }, this.currentRefreshRate);
        }
    }
}
