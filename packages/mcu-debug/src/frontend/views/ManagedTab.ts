import type { TabDescriptor, TabInputMode, TabKind, TabState, ToUi, FromUi } from "@mcu-debug/shared";

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

    // For tabs that buffer data before the webview is ready. This is still needed for the
    // first terminal mount and when VS Code deallocates the entire cockpit webview.
    private _backingStore = "";
    // Max number of characters to retain for terminal restore. This caps memory usage while
    // keeping the buffer logic cheap and preserves newline boundaries when trimming.
    private readonly _maxBufferChars = 1024 * 1024;

    // Stream data is held here until the mounted xterm.js instance confirms that
    // its message listener and terminal object are ready.
    private _terminalReady = false;

    constructor(
        readonly tabId: string,
        label: string,
        placeholderText: string,
        inputMode: TabInputMode = "cooked",
    ) {
        this._label = label;
        this._placeholderText = placeholderText;
        this._inputMode = inputMode;
    }

    private _placeholderText: string;
    private _inputMode: TabInputMode;

    get label(): string { return this._label; }
    get state(): TabState { return this._state; }
    get placeholderText(): string { return this._placeholderText; }
    get inputMode(): TabInputMode { return this._inputMode; }

    get descriptor(): TabDescriptor {
        return {
            tabId: this.tabId,
            kind: this.kind,
            label: this._label,
            direction: this.direction,
            state: this._state,
            placeholderText: this.placeholderText,
            inputMode: this.inputMode,
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
            const text = this._backingStore;
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
    protected send(text: string): void {
        if (text.length === 0) {
            return;
        }
        this._appendToBackingStore(text);
        if (this._canPostLiveData()) {
            this._post({ type: "stream", tabId: this.tabId, text });
        }
    }

    private _appendToBackingStore(text: string): void {
        this._backingStore += text;
        if (this._backingStore.length <= this._maxBufferChars) {
            return;
        }

        const overflow = this._backingStore.length - this._maxBufferChars;
        const trimAtNewline = this._backingStore.indexOf("\n", overflow);
        const trimIndex = trimAtNewline >= 0 ? trimAtNewline + 1 : overflow;
        this._backingStore = this._backingStore.slice(trimIndex);
    }

    /** Clear the tab's terminal. */
    protected clear(): void {
        this._backingStore = "";
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

    protected setPlaceholderText(placeholderText: string): void {
        this._placeholderText = placeholderText;
        this._post({ type: "tab-update", tabId: this.tabId, patch: { placeholderText } });
    }

    protected setInputMode(inputMode: TabInputMode): void {
        this._inputMode = inputMode;
        this._post({ type: "tab-update", tabId: this.tabId, patch: { inputMode } });
    }

    protected echoInput(text: string): void {
        this.send(text);
    }

    private _post(msg: ToUi): void {
        this._panel?.postToWebview(msg);
    }

    private _canPostLiveData(): boolean {
        return this._terminalReady
            && (this._panel?.isParentPanelVisible() ?? false);
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
