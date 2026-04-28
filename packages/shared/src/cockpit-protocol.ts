/**
 * Wire protocol between the Glass Cockpit orchestrator and the MCU DEBUG panel webview.
 *
 * All content messages are routed by tabId. The webview treats tabId as an opaque
 * token — it never interprets or derives meaning from it. The extension assigns tabIds
 * at creation and is the only source of truth for tab identity.
 *
 * Removal is always user-driven (tab-close from UI). The extension never removes tabs.
 */

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------

export type TabKind = 'uart' | 'rtt' | 'swo' | 'cockpit';

/**
 * Visual/operational state of a tab. The extension drives all transitions.
 * The webview reflects state but never self-transitions.
 */
export type TabState =
    | { kind: 'active' }                       // normal operation
    | { kind: 'inactive' }                     // session ended; tab stays, dimmed (RTT/SWO/Cockpit)
    | { kind: 'disconnected'; message: string } // UART physically gone; waiting for reconnect, tab persists
    | { kind: 'error'; message: string };       // unrecoverable error; tab persists, user decides

/** Sent once when a tab is first created. tabId is the stable opaque identity. */
export interface TabDescriptor {
    tabId: string;
    kind: TabKind;
    label: string;
    /** For uart/rtt: whether the input bar is shown. Absent for swo/cockpit (cockpit always has input). */
    direction?: 'rx' | 'tx' | 'both';
    state: TabState;
}

// ---------------------------------------------------------------------------
// Orchestrator → UI
// ---------------------------------------------------------------------------

export type ToUi =
    // --- Tab lifecycle (extension-driven) ---
    | { type: 'tab-add'; tab: TabDescriptor }
    | { type: 'tab-set-state'; tabId: string; state: TabState }
    | { type: 'tab-set-label'; tabId: string; label: string }

    // --- Content: streamed mux output, routed to a specific tab's terminal ---
    | { type: 'stream'; tabId: string; text: string }

    // --- Content: Glass Cockpit tab only ---
    | { type: 'ai-request'; tabId: string; text: string }
    | { type: 'ai-request-clear'; tabId: string }

    // --- Display throttle lag indicator on a tab's terminal ---
    | { type: 'buffer-status'; tabId: string; lines: number };

// ---------------------------------------------------------------------------
// UI → Orchestrator
// ---------------------------------------------------------------------------

export type FromUi =
    /** Engineer typed a line in any tab's input bar. */
    | { type: 'user-input'; tabId: string; text: string }
    /** User clicked × on a tab. Extension handles actual teardown. */
    | { type: 'tab-close'; tabId: string };
