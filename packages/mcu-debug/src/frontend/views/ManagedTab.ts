import type { TabDescriptor, TabKind, TabState, ToUi, FromUi } from "@mcu-debug/shared";

/**
 * Base class for a tab hosted in the MCU DEBUG panel (CockpitPanel).
 *
 * Mirrors what SerialPortView did with PtyTerminal, but instead of writing
 * to a vscode.Terminal, it posts protocol messages to the webview.
 *
 * Subclasses own the data source (TCP socket, RTT channel, etc.) and call:
 *   send(text)      — stream a chunk to the tab's xterm.js instance
 *   setState(state) — update tab visual state (active / disconnected / error / inactive)
 *   setLabel(label) — rename the tab
 *
 * CockpitPanel calls back into onUserInput / onUserClose when the webview sends FromUi messages.
 */
export abstract class ManagedTab {
    abstract readonly kind: TabKind;
    abstract readonly direction: TabDescriptor["direction"];

    private _panel: CockpitPanelSink | null = null;
    private _state: TabState = { kind: "active" };
    private _label: string;

    // For tabs that buffer data before the webview is ready. This is needed as VSCode will clear the terminal
    // when not visible/removed from the Panel. We need to restore everythig when we become visible again.
    private _backingStore: string[] = [];
    // Max number of lines to keep in the backing store. This is a safety valve to prevent unbounded memory growth
    // if the webview is never ready or falls behind. The webview should be consuming data at a reasonable rate, so
    // this should not be hit in normal use.
    private readonly _maxBufferSize = 10_000;

    // Stream data is held here until the mounted xterm.js instance confirms that
    // its message listener and terminal object are ready.
    private _terminalReady = false;

    constructor(
        readonly tabId: string,
        label: string,
    ) {
        this._label = label;
    }

    get label(): string { return this._label; }
    get state(): TabState { return this._state; }

    get descriptor(): TabDescriptor {
        return {
            tabId: this.tabId,
            kind: this.kind,
            label: this._label,
            direction: this.direction,
            state: this._state,
        };
    }

    // -------------------------------------------------------------------------
    // Called by CockpitPanel — do not call directly
    // -------------------------------------------------------------------------

    /** Attached when the tab is added to the panel. */
    _attach(panel: CockpitPanelSink): void {
        this._panel = panel;
    }

    /**
     * Called by CockpitPanel when the mounted xterm.js instance for this tab sends terminal-ready.
     * Replays the backing store into the fresh terminal before live streaming resumes.
     */
    _onTerminalReady(): void {
        this._terminalReady = true;
        if (this._canPostLiveData()) {
            const text = this._backingStore.join("");
            if (text.length > 0) {
                this._post({ type: "restore", tabId: this.tabId, text });
            }
        }
    }

    /**
     * Called by CockpitPanel when this tab's xterm.js instance may have mounted
     * or unmounted. Marks the terminal as not ready once it is no longer mounted.
     */
    _onTerminalMountStateChanged(mounted: boolean): void {
        if (!mounted) {
            this._terminalReady = false;
        } else if (this._panel?.isTabActive(this.tabId) ?? false) {
            this._onTerminalReady();
        }
    }

    /**
     * Called by CockpitPanel when the webview reloads (new 'ready' received).
     * Resets the handshake so it runs again for the fresh xterm.js instance.
     * Queued data is discarded only if the terminal was previously live — a tab
     * that was never ready still holds its initial connection messages in the queue
     * and those must survive the reload so they appear when xterm.js mounts.
     */
    _resetTerminalReady(): void {
        this._terminalReady = false;
    }

    // -------------------------------------------------------------------------
    // For subclasses — push data to the webview
    // -------------------------------------------------------------------------

    /** Write a text chunk to the tab's xterm.js terminal. */
    private _lastLineEndedWithNewline = true;
    protected send(text: string): void {
        if (text.length === 0) {
            return;
        }
        this.addToBackingStore(text);
        if (this._canPostLiveData()) {
            this._post({ type: "stream", tabId: this.tabId, text });
        }
    }

    private addToBackingStore(text: string) {
        const lines = text.split("\n");
        const endsWithNewline = text.endsWith("\n");
        if (!this._lastLineEndedWithNewline) {
            // The previous chunk ended mid-line, so the first line of this chunk is a continuation. Don't add a new line to the backing store for it.
            lines[0] = (this._backingStore.pop() ?? "") + lines[0];
        }
        if (endsWithNewline && lines[lines.length - 1] === "") {
            // If the text ends with a newline, split() adds an extra empty string at the end of the array. Remove it to avoid adding an extra blank line to the backing store.
            lines.pop();
        }
        for (let i = 0; i < lines.length - 1; i++) {
            this._backingStore.push(lines[i] + "\n");
        }
        if (endsWithNewline) {
            this._backingStore.push(lines[lines.length - 1] + "\n");
        } else {
            this._backingStore.push(lines[lines.length - 1]);
        }
        this._lastLineEndedWithNewline = endsWithNewline;
        // Trim the backing store if it exceeds the max buffer size. This ensures we don't keep unbounded history if the webview is never ready or falls behind. The webview should be consuming data at a reasonable rate, so this should not be hit in normal use.
        if (this._backingStore.length > this._maxBufferSize) {
            this._backingStore.splice(0, this._backingStore.length - this._maxBufferSize);
        }
    }

    /** Clear the tab's terminal. */
    protected clear(): void {
        this._backingStore = [];
        this._lastLineEndedWithNewline = true;
        this._post({ type: "clear", tabId: this.tabId });
    }

    /** Update the tab's visual state. Extension always drives this; webview never self-transitions. */
    protected setState(state: TabState): void {
        this._state = state;
        this._post({ type: "tab-set-state", tabId: this.tabId, state });
    }

    /** Rename the tab's display label. */
    protected setLabel(label: string): void {
        this._label = label;
        this._post({ type: "tab-set-label", tabId: this.tabId, label });
    }

    private _post(msg: ToUi): void {
        this._panel?.postToWebview(msg);
    }

    private _canPostLiveData(): boolean {
        return this._terminalReady
            && (this._panel?.isParentPanelVisible() ?? false)
            && (this._panel?.isTabActive(this.tabId) ?? false);
    }

    // -------------------------------------------------------------------------
    // Callbacks from CockpitPanel — subclasses override as needed
    // -------------------------------------------------------------------------

    /** Called when the engineer submits a line in the tab's input bar. */
    onUserInput(_text: string): void { /* override in subclass */ }

    /**
     * Called when the user clicks × on the tab.
     * Subclass should tear down its data source here.
     * After calling super.onUserClose(), the tab is detached from the panel.
     */
    onUserClose(): void {
        this._panel = null;
    }
}

/** Minimal interface CockpitPanel exposes back to ManagedTab. Avoids circular import. */
export interface CockpitPanelSink {
    postToWebview(msg: ToUi): void;
    isParentPanelVisible(): boolean;
    isTabActive(tabId: string): boolean;
}

// Re-export FromUi so callers don't need a second import
export type { FromUi };
