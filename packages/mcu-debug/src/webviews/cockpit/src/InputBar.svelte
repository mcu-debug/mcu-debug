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
    import { untrack } from "svelte";
    import type { TabInputMode } from "@mcu-debug/shared";
    import { loadHistory, saveHistory } from "./history-store";

    const {
        tabId,
        onSubmit,
        onSpecialKey,
        placeholderText,
        inputMode = "cooked",
    }: {
        tabId: string;
        onSubmit: (text: string) => void;
        onSpecialKey?: (key: string) => void;
        placeholderText: string;
        inputMode?: TabInputMode;
    } = $props();

    let value = $state("");

    /**
     * Submitted lines, oldest first. The rules mirror the Rust TUI (cockpit/tui.rs) so
     * that the same keys behave the same way in the panel, the TUI and the CLI: the
     * half-typed line is kept while you browse, and consecutive duplicates are dropped
     * (bash's HISTCONTROL=ignoredups).
     */
    // Read once, deliberately: there is one InputBar per tab and a tab's id never
    // changes, so this is the history belonging to this bar for its whole life.
    // untrack() says so, rather than leaving Svelte to warn about a prop read that
    // looks like it was meant to stay in step with the prop.
    let history: string[] = untrack(() => loadHistory(tabId));
    /** Index being viewed, or null while composing a new line. */
    let historyPos: number | null = null;
    /** What was being typed before browsing started. */
    let historyDraft = "";

    // Enough for a long session; the cap only exists to bound what is written back
    // into the webview's state.
    const MAX_HISTORY = 1000;

    function historyPush(line: string) {
        if (history[history.length - 1] !== line) {
            history.push(line);
            if (history.length > MAX_HISTORY) {
                history = history.slice(history.length - MAX_HISTORY);
            }
            saveHistory(tabId, history);
        }
        historyPos = null;
        historyDraft = "";
    }

    function historyUp() {
        if (history.length === 0) {
            return;
        }
        if (historyPos === null) {
            historyDraft = value;
            historyPos = history.length - 1;
        } else if (historyPos === 0) {
            return; // already at the oldest entry
        } else {
            historyPos -= 1;
        }
        value = history[historyPos];
    }

    function historyDown() {
        if (historyPos === null) {
            return; // already composing a new line
        }
        if (historyPos + 1 >= history.length) {
            // Past the newest entry — put the draft back.
            historyPos = null;
            value = historyDraft;
            historyDraft = "";
            return;
        }
        historyPos += 1;
        value = history[historyPos];
    }

    function handleKeydown(e: KeyboardEvent) {
        if (inputMode === "cooked") {
            // Raw mode deliberately has no history: every keystroke there belongs to
            // the device, arrow keys included.
            if (e.key === "ArrowUp") {
                e.preventDefault();
                historyUp();
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                historyDown();
                return;
            }
            if (e.key === "Enter") {
                const line = value;
                onSubmit(line);
                // A bare Enter is meaningful (gdb repeats the last command) but is not
                // worth recalling, so it is submitted without being recorded.
                if (line.trim()) {
                    historyPush(line);
                }
                value = "";
            }
            return;
        }

        if (e.metaKey || e.altKey) {
            return;
        }

        if (e.ctrlKey) {
            if (e.key === " ") {
                e.preventDefault();
                onSubmit("\x00");
                value = "";
                return;
            }
            if (/^[a-z]$/i.test(e.key)) {
                e.preventDefault();
                onSubmit(String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64));
                value = "";
            }
            return;
        }

        if (e.key === "Enter") {
            e.preventDefault();
            onSubmit("\r");
            value = "";
            return;
        }
        if (e.key === "Backspace") {
            e.preventDefault();
            onSubmit("\b");
            value = "";
            return;
        }
        if (e.key === "Delete") {
            e.preventDefault();
            onSubmit("\x7f");
            value = "";
            return;
        }
        if (e.key === "Tab") {
            e.preventDefault();
            onSubmit("\t");
            value = "";
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            onSubmit("\x1b");
            value = "";
            return;
        }
        if (e.key.length === 1) {
            e.preventDefault();
            onSubmit(e.key);
            value = "";
        }
    }

    function handleInput() {
        if (inputMode === "raw" && value.length > 0) {
            value = "";
        }
    }

    function handlePaste(e: ClipboardEvent) {
        if (inputMode !== "raw") {
            return;
        }
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (!text) {
            return;
        }
        e.preventDefault();
        onSubmit(text);
        value = "";
    }
</script>

<div class="input-bar">
    <span class="prompt">&gt;&nbsp;</span>
    <!-- prettier-ignore -->
    <input
        type="text"
        bind:value
        onkeydown={handleKeydown}
        oninput={handleInput}
        onpaste={handlePaste}
        placeholder={placeholderText}
        spellcheck={false}
        autocomplete="off"
    />
</div>

<style>
    .input-bar {
        display: flex;
        align-items: center;
        padding: 6px 10px;
        background: var(--vscode-panel-background, #1e1e1e);
        border-top: 1px solid var(--vscode-panel-border, #444);
        flex-shrink: 0;
    }

    .prompt {
        color: var(--vscode-terminal-ansiGreen, #89d185);
        font-family: monospace;
        font-size: 13px;
        flex-shrink: 0;
    }

    input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: var(--vscode-editor-foreground, #d4d4d4);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 13px;
        caret-color: var(--vscode-editorCursor-foreground, #aeafad);
    }

    input::placeholder {
        color: var(--vscode-input-placeholderForeground, #666);
    }
</style>
