// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// SPDX-License-Identifier: Apache-2.0

const EventEmitter = require('events');

import type { TabDescriptor, TabInputMode, TabKind, TabState, ToUi, FromUi } from "@mcu-debug/shared";
import { CockpitPanel } from "./CockpitPanel";

const allUUids = new Set<string>();
export function getUUid(baseName: string): string {
    let uuid = "";
    do {
        uuid = `${baseName}-${Math.random().toString(16).substring(2, 10)}`;
    } while (allUUids.has(uuid));
    allUUids.add(uuid);
    return uuid;
}

const termalsMap = new Map<string, ManagedTab | ManagedTabConsole>();
export function createTerminalUniqueName<T>(want: string, ctor: (name: string) => T): [string, T, boolean] {
    let ret = want;
    let count = 1;
    while (true) {
        let found = false;
        for (const term of termalsMap.values()) {
            const isActive = term?.state.kind === "active";
            if (term.label.startsWith(want)) {
                // Semi exact match, only reuse if inactive and exact label match. This allows multiple "SWO:foo" terminals to coexist
                // without clashing, but still reuses the terminal if we are recreating the same one after a reload.
                if (!isActive && term.label === ret) {
                    // Reuse this terminal, exact match
                    return [ret, term as unknown as T, false];
                }
                found = true;
            }
        }
        if (!found) {
            const term = ctor(ret);
            CockpitPanel.instance?.addTab(term as unknown as ManagedTab);
            return [ret, term, true];
        }
        ret = `${want}-${count}`;
        count = count + 1;
    }
}

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
    private _savedInputMode: TabInputMode | null = null;
    private _closeHandlers: (() => void)[] = [];

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
        termalsMap.set(label, this as unknown as ManagedTab);
    }

    private _placeholderText: string;
    private _inputMode: TabInputMode;
    private _savedPlaceholderText: string | null = null;

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
    public send(text: string): void {
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
    public clear(): void {
        this._backingStore = "";
        this._post({ type: "clear", tabId: this.tabId });
    }

    /** Update the tab's visual state. Extension always drives this; webview never self-transitions. */
    public setState(state: TabState): void {
        this._state = state;
        this._post({ type: "tab-set-state", tabId: this.tabId, state });
    }

    /** Rename the tab's display label. */
    public setLabel(label: string): void {
        this._label = label;
        this._post({ type: "tab-set-label", tabId: this.tabId, label });
    }

    public setPlaceholderText(placeholderText: string): void {
        this._placeholderText = placeholderText;
        this._post({ type: "tab-update", tabId: this.tabId, patch: { placeholderText } });
    }

    public setInputMode(inputMode: TabInputMode): void {
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
    onUserInput(_text: string): void {
        // Default no-op. Subclasses override if they have user input.
        if (this.inputMode === "cooked") {
            this.echoInput(_text + "\r\n");
        } else {
            this.echoInput(_text.replace(/\r(?!\n)/g, "\r\n"));
        }
    }

    /**
     * Called when the user clicks × on the tab.
     * Subclass should tear down its data source here.
     * After calling super.onUserClose(), the tab is detached from the panel.
     */
    onUserClose(): void {
        termalsMap.delete(this._label);
        this.callCloseHandlers();
        this._panel = null;
    }

    /**
     * Freeze user input
     */
    disableInput(): void {
        if (this.inputMode === "none") {
            return;
        }
        this._savedInputMode = this.inputMode;
        this._savedPlaceholderText = this._placeholderText;
        this.setPlaceholderText("Input disabled until connection is ready...");
        this.setInputMode("none");
    }

    /**
     * Unfreeze user input with the given mode
     */
    enableInput(): void {
        if (this._savedInputMode === null) {
            return;
        }
        this.setInputMode(this._savedInputMode);
        this.setPlaceholderText(this._savedPlaceholderText ?? "Enter input");
        this._savedPlaceholderText = null;
        this._savedInputMode = null;
    }

    addCloseHandler(handler: () => void): void {
        this._closeHandlers.push(handler);
    }

    protected callCloseHandlers(): void {
        for (const handler of this._closeHandlers) {
            handler();
        }
    }

    // -------------------------------------------------------------------------
    // Other public methods
}

export class ManagedTabConsole extends ManagedTab {
    protected emitter = new EventEmitter();

    constructor(
        tabId: string,
        label: string,
        readonly kind: TabKind,
        readonly direction: TabDescriptor["direction"] = "both",
        placeholderText = "Enter input for console",
        readonly mode: "raw" | "cooked" = "cooked"
    ) {
        super(tabId, label, placeholderText, mode);
    }

    onUserClose(): void {
        this.emitter.emit("close");
        super.onUserClose();
        this.removeAllListeners();
    }

    onUserInput(text: string): void {
        this.emitter.emit("data", text);
        super.onUserInput(text);
    }

    on(event: "data", listener: (data: string) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: string, listener: (...args: any[]) => void): void {
        this.emitter.on(event, listener);
    }

    removeAllListeners(): void {
        this.emitter.removeAllListeners();
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
