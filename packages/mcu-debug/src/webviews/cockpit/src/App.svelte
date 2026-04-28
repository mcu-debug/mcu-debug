<script lang="ts">
    import { onMount } from "svelte";
    import TabBar from "./TabBar.svelte";
    import GlassCockpit from "./GlassCockpit.svelte";
    import SourceTab from "./SourceTab.svelte";
    import type { ToUi, TabDescriptor, TabState } from "@mcu-debug/shared";
    import { postToExtension } from "./vscode";

    // -------------------------------------------------------------------------
    // Tab state
    // -------------------------------------------------------------------------

    interface TabEntry extends TabDescriptor {
        aiRequestText: string;
        bufferLines: number;
    }

    let tabs = $state<TabEntry[]>([]);
    let activeTabId = $state<string | null>(null);

    function findTab(tabId: string): TabEntry | undefined {
        return tabs.find((t) => t.tabId === tabId);
    }

    function activateFirst() {
        if (tabs.length > 0 && !tabs.find((t) => t.tabId === activeTabId)) {
            activeTabId = tabs[0].tabId;
        }
    }

    // -------------------------------------------------------------------------
    // Message dispatch
    // -------------------------------------------------------------------------

    function handleToUi(msg: ToUi) {
        switch (msg.type) {
            case "tab-add": {
                // Prevent duplicates (idempotent)
                if (findTab(msg.tab.tabId)) break;
                const entry: TabEntry = { ...msg.tab, aiRequestText: "", bufferLines: 0 };
                tabs.push(entry);
                // Auto-select if nothing is active
                if (!activeTabId) activeTabId = msg.tab.tabId;
                break;
            }
            case "tab-set-state": {
                const tab = findTab(msg.tabId);
                if (tab) tab.state = msg.state;
                break;
            }
            case "tab-set-label": {
                const tab = findTab(msg.tabId);
                if (tab) tab.label = msg.label;
                break;
            }
            case "clear": {
                // Terminal.svelte listens to window 'message' directly per tabId —
                // we re-dispatch as-is; terminals filter by their own tabId.
                break;
            }
            case "restore": {
                // Terminal.svelte listens to window 'message' directly per tabId —
                // we re-dispatch as-is; terminals filter by their own tabId.
                break;
            }
            case "stream": {
                // Terminal.svelte listens to window 'message' directly per tabId —
                // we re-dispatch as-is; terminals filter by their own tabId.
                break;
            }
            case "ai-request": {
                const tab = findTab(msg.tabId);
                if (tab) tab.aiRequestText = msg.text;
                break;
            }
            case "ai-request-clear": {
                const tab = findTab(msg.tabId);
                if (tab) tab.aiRequestText = "";
                break;
            }
            case "buffer-status": {
                const tab = findTab(msg.tabId);
                if (tab) tab.bufferLines = msg.lines;
                break;
            }
        }
    }

    onMount(() => {
        const handler = (e: MessageEvent) => handleToUi(e.data as ToUi);
        window.addEventListener("message", handler);
        // Signal to the extension that the webview JS is loaded and ready.
        // The extension holds all tab-add messages until this arrives.
        postToExtension({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    });

    $effect(() => {
        postToExtension({ type: "active-tab-changed", tabId: activeTabId });
    });

    // -------------------------------------------------------------------------
    // User actions
    // -------------------------------------------------------------------------

    function selectTab(tabId: string) {
        activeTabId = tabId;
    }

    function closeTab(tabId: string) {
        postToExtension({ type: "tab-close", tabId });
        const idx = tabs.findIndex((t) => t.tabId === tabId);
        if (idx === -1) return;
        tabs.splice(idx, 1);
        // If we closed the active tab, activate its neighbour
        if (activeTabId === tabId) {
            activeTabId = tabs[Math.max(0, idx - 1)]?.tabId ?? null;
        }
    }

    // -------------------------------------------------------------------------
    // Derived active tab
    // -------------------------------------------------------------------------

    const activeTab = $derived(tabs.find((t) => t.tabId === activeTabId) ?? null);

    // Keep activeTabId valid when tabs list changes
    $effect(() => {
        activateFirst();
    });
</script>

<div class="panel">
    <TabBar {tabs} {activeTabId} onSelect={selectTab} onClose={closeTab} />

    <div class="content">
        {#if activeTab}
            {#if activeTab.kind === "cockpit"}
                <GlassCockpit tabId={activeTab.tabId} aiRequestText={activeTab.aiRequestText} bufferLines={activeTab.bufferLines} />
            {:else}
                <SourceTab tabId={activeTab.tabId} direction={activeTab.direction ?? "rx"} bufferLines={activeTab.bufferLines} />
            {/if}
        {:else}
            <div class="empty">No tabs open. Add a UART with + or start a debug session.</div>
        {/if}
    </div>
</div>

<style>
    :global(body) {
        margin: 0;
        padding: 0;
        background: var(--vscode-panel-background, #1e1e1e);
        color: var(--vscode-editor-foreground, #d4d4d4);
        font-family: var(--vscode-font-family, monospace);
        height: 100vh;
        overflow: hidden;
    }

    .panel {
        display: flex;
        flex-direction: column;
        height: 100vh;
    }

    .content {
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }

    .empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--vscode-descriptionForeground, #717171);
        font-size: 13px;
    }
</style>
