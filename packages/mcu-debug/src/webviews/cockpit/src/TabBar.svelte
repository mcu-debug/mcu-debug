<script lang="ts">
    import type { TabDescriptor, TabState } from '@mcu-debug/shared';

    const { tabs, activeTabId, onSelect, onClose }: {
        tabs: TabDescriptor[];
        activeTabId: string | null;
        onSelect: (tabId: string) => void;
        onClose: (tabId: string) => void;
    } = $props();

    function stateClass(state: TabState): string {
        switch (state.kind) {
            case 'inactive':     return 'state-inactive';
            case 'disconnected': return 'state-disconnected';
            case 'error':        return 'state-error';
            default:             return '';
        }
    }

    function stateIcon(state: TabState): string {
        switch (state.kind) {
            case 'inactive':     return '○';
            case 'disconnected': return '⚡';
            case 'error':        return '✕';
            default:             return '';
        }
    }

    function stateTitle(state: TabState): string {
        switch (state.kind) {
            case 'inactive':     return 'Session ended';
            case 'disconnected': return state.message;
            case 'error':        return state.message;
            default:             return '';
        }
    }

    function kindIcon(kind: TabDescriptor['kind']): string {
        switch (kind) {
            case 'uart':    return '⇄';
            case 'rtt':     return '⟳';
            case 'swo':     return '◈';
            case 'cockpit': return '◉';
        }
    }

    /** UARTs always show ×; session-scoped tabs only show × when the user hovers. */
    function isCloseable(tab: TabDescriptor): boolean {
        return tab.kind === 'uart';
    }
</script>

<div class="tab-bar" role="tablist">
    {#each tabs as tab (tab.tabId)}
        {@const active = tab.tabId === activeTabId}
        {@const sc = stateClass(tab.state)}
        {@const icon = stateIcon(tab.state)}
        {@const title = stateTitle(tab.state)}
        <button
            class="tab {sc}"
            class:active
            role="tab"
            aria-selected={active}
            title={title || tab.label}
            onclick={() => onSelect(tab.tabId)}
        >
            <span class="kind-icon" aria-hidden="true">{kindIcon(tab.kind)}</span>
            <span class="label">{tab.label}</span>
            {#if icon}
                <span class="state-icon" aria-hidden="true">{icon}</span>
            {/if}
            {#if isCloseable(tab)}
                <!-- always visible for UARTs -->
                <span
                    class="close"
                    role="button"
                    tabindex={0}
                    aria-label="Close {tab.label}"
                    onclick={(e) => { e.stopPropagation(); onClose(tab.tabId); }}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClose(tab.tabId); } }}
                >×</span>
            {:else}
                <!-- hover-only × for session-scoped tabs -->
                <span
                    class="close close-hover"
                    role="button"
                    tabindex={0}
                    aria-label="Close {tab.label}"
                    onclick={(e) => { e.stopPropagation(); onClose(tab.tabId); }}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClose(tab.tabId); } }}
                >×</span>
            {/if}
        </button>
    {/each}
</div>

<style>
    .tab-bar {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        overflow-x: auto;
        overflow-y: hidden;
        background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        flex-shrink: 0;
        scrollbar-width: none;
    }
    .tab-bar::-webkit-scrollbar { display: none; }

    .tab {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 10px;
        height: 35px;
        border: none;
        border-right: 1px solid var(--vscode-panel-border, #3c3c3c);
        background: transparent;
        color: var(--vscode-tab-inactiveForeground, #969696);
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        position: relative;
    }

    .tab:hover {
        background: var(--vscode-tab-hoverBackground, #2a2d2e);
        color: var(--vscode-tab-hoverForeground, #d4d4d4);
    }

    .tab.active {
        background: var(--vscode-tab-activeBackground, #1e1e1e);
        color: var(--vscode-tab-activeForeground, #ffffff);
        border-bottom: 1px solid var(--vscode-tab-activeBorderTop, #007acc);
    }

    .tab.state-inactive {
        opacity: 0.55;
    }

    .tab.state-disconnected .label {
        color: var(--vscode-charts-orange, #e8a000);
    }

    .tab.state-error .label {
        color: var(--vscode-errorForeground, #f14c4c);
    }

    .kind-icon {
        font-size: 11px;
        opacity: 0.7;
    }

    .state-icon {
        font-size: 10px;
        margin-left: 2px;
    }

    .tab.state-error .state-icon   { color: var(--vscode-errorForeground, #f14c4c); }
    .tab.state-disconnected .state-icon { color: var(--vscode-charts-orange, #e8a000); }

    .close {
        margin-left: 4px;
        padding: 0 2px;
        border-radius: 3px;
        font-size: 14px;
        line-height: 1;
        opacity: 0.6;
        cursor: pointer;
        background: none;
        border: none;
        color: inherit;
    }
    .close:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, #5a5d5e); }

    /* hover-only close: hidden by default, shown on tab hover */
    .close-hover { visibility: hidden; }
    .tab:hover .close-hover { visibility: visible; }
</style>
