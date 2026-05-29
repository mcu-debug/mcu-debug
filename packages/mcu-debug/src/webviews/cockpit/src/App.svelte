<!--
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
-->
<script lang="ts">
    import { onMount } from "svelte";
    import TabBar from "./TabBar.svelte";
    import GlassCockpit from "./GlassCockpit.svelte";
    import SourceTab from "./SourceTab.svelte";
    import type { CockpitUiState, ToUi, TabDescriptor, TabState } from "@mcu-debug/shared";
    import { postToExtension } from "./vscode";

    // -------------------------------------------------------------------------
    // Tab state
    // -------------------------------------------------------------------------

    interface TabEntry extends TabDescriptor {
        aiRequestText: string;
        bufferLines: number;
        cockpitUi: CockpitUiState;
    }

    const defaultCockpitUi: CockpitUiState = {
        availableConfigs: [],
        selectedConfig: null,
        statusText: "not-started",
        buttonEnabled: {
            continue: false,
            pause: false,
            "step-over": false,
            "step-into": false,
            "step-out": false,
            restart: false,
            reset: false,
            stop: false,
        },
    };

    let tabs = $state<TabEntry[]>([]);
    let activeTabId = $state<string | null>(null);
    let panelEl: HTMLDivElement | undefined;

    function findTab(tabId: string): TabEntry | undefined {
        return tabs.find((t) => t.tabId === tabId);
    }

    function dispatchSpecialKey(key: string) {
        if (!activeTabId) {
            return;
        }
        postToExtension({ type: "special-key", tabId: activeTabId, key });
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
                const entry: TabEntry = { ...msg.tab, aiRequestText: "", bufferLines: 0, cockpitUi: { ...defaultCockpitUi } };
                tabs.push(entry);
                // Auto-select if nothing is active
                if (!activeTabId) activeTabId = msg.tab.tabId;
                break;
            }
            case "tab-activate": {
                if (findTab(msg.tabId)) {
                    activeTabId = msg.tabId;
                }
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
            case "tab-update": {
                const tab = findTab(msg.tabId);
                if (tab) Object.assign(tab, msg.patch);
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
            case "cockpit-ui-state": {
                const tab = findTab(msg.tabId);
                if (tab) tab.cockpitUi = msg.state;
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
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key !== "F1") {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            dispatchSpecialKey("F1");
        };
        window.addEventListener("message", handler);
        window.addEventListener("keydown", keyHandler, { capture: true });
        // Signal to the extension that the webview JS is loaded and ready.
        // The extension holds all tab-add messages until this arrives.
        postToExtension({ type: "ready" });
        return () => {
            window.removeEventListener("message", handler);
            window.removeEventListener("keydown", keyHandler, { capture: true });
        };
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

    function focusPanelOnPointerDown(event: PointerEvent) {
        const target = event.target as HTMLElement | null;
        if (!panelEl || !target) {
            return;
        }
        if (target.closest("button, input, select, textarea")) {
            return;
        }
        panelEl.focus();
    }

    // Keep activeTabId valid when tabs list changes
    $effect(() => {
        activateFirst();
    });
</script>

<div class="panel" bind:this={panelEl} tabindex="-1" role="presentation" onpointerdown={focusPanelOnPointerDown}>
    <TabBar {tabs} {activeTabId} onSelect={selectTab} onClose={closeTab} />

    <div class="content">
        {#if tabs.length > 0}
            {#each tabs as tab (tab.tabId)}
                <div class="tab-pane" class:active={tab.tabId === activeTabId}>
                    {#if tab.kind === "cockpit"}
                        <GlassCockpit
                            tabId={tab.tabId}
                            aiRequestText={tab.aiRequestText}
                            bufferLines={tab.bufferLines}
                            active={tab.tabId === activeTabId}
                            placeholderText={tab.placeholderText}
                            inputMode={tab.inputMode ?? "cooked"}
                            cockpitUi={tab.cockpitUi}
                        />
                    {:else}
                        <SourceTab
                            tabId={tab.tabId}
                            direction={tab.direction ?? "rx"}
                            bufferLines={tab.bufferLines}
                            active={tab.tabId === activeTabId}
                            placeholderText={tab.placeholderText}
                            inputMode={tab.inputMode ?? "cooked"}
                        />
                    {/if}
                </div>
            {/each}
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
        outline: none;
    }

    .content {
        position: relative;
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }

    .tab-pane {
        display: none;
        width: 100%;
        height: 100%;
    }

    .tab-pane.active {
        display: block;
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
