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

    // -------------------------------------------------------------------------
    // For subclasses — push data to the webview
    // -------------------------------------------------------------------------

    /** Write a text chunk to the tab's xterm.js terminal. */
    protected send(text: string): void {
        this._post({ type: "stream", tabId: this.tabId, text });
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
}

// Re-export FromUi so callers don't need a second import
export type { FromUi };
