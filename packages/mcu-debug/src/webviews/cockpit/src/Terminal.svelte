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
    import { onMount, onDestroy } from "svelte";
    import { Terminal } from "@xterm/xterm";
    import { FitAddon } from "@xterm/addon-fit";
    import { WebLinksAddon } from "@xterm/addon-web-links";
    import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
    import type { ToUi } from "@mcu-debug/shared";
    import FindWidget from "./FindWidget.svelte";
    import { postToExtension } from "./vscode";
    import "@xterm/xterm/css/xterm.css";

    const {
        tabId,
        bufferLines,
        active,
        allowKeyboardInput = true,
    }: {
        tabId: string;
        bufferLines: number;
        active: boolean;
        allowKeyboardInput?: boolean;
    } = $props();

    const FLUSH_INTERVAL_MS = 500;
    const MAX_BUFFER_BYTES = 32_000;

    let container: HTMLDivElement;
    let term: Terminal | undefined;
    let fitAddon: FitAddon;
    let buffer = ""; // xterm.js write buffer (throttled)
    let earlyBuffer = ""; // pre-mount stream buffer (before xterm.js exists)
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let themeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver;
    let themeObserver: MutationObserver;
    let dataListener: { dispose(): void } | undefined;
    let terminalTextarea: HTMLTextAreaElement | undefined;

    // Find state. The addon does the searching; everything the bar displays lives here.
    let searchAddon: SearchAddon | undefined;
    let resultsListener: { dispose(): void } | undefined;
    let findWidget: { focusInput: (selectAll?: boolean) => void; ownsFocus: () => boolean } | undefined = $state(undefined);
    let findOpen = $state(false);
    let findQuery = $state("");
    let findCaseSensitive = $state(false);
    let findWholeWord = $state(false);
    let findRegex = $state(false);
    let findInvalidRegex = $state(false);
    let findResultIndex = $state(-1);
    let findResultCount = $state(0);

    const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

    function readCssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
        return styles.getPropertyValue(name).trim() || fallback;
    }

    /**
     * Build an xterm theme from VS Code's CSS custom properties.
     *
     * VS Code injects theme colors as CSS custom properties on <body>. If the
     * active theme doesn't define terminal-specific colors (terminal.background /
     * terminal.foreground), we fall back to editor colors and ultimately to
     * hard-coded defaults that match the current light/dark mode so the terminal
     * is always readable.
     */
    function buildXtermTheme(): object {
        // VS Code adds vscode-light / vscode-dark / vscode-high-contrast* classes
        // to <body> so we can pick appropriate fallback colors without guessing.
        // "vscode-light" matches both "vscode-light" and "vscode-high-contrast-light".
        const isLight = document.body.className.includes("vscode-light");

        // CSS custom properties cascade, so reading from body picks up vars
        // set anywhere in the tree (html, :root, or body itself).
        const cs = getComputedStyle(document.body);

        const fallbackBg = isLight ? "#ffffff" : "#1e1e1e";
        const fallbackFg = isLight ? "#333333" : "#cccccc";

        const bg =
            cs.getPropertyValue("--vscode-terminal-background").trim() ||
            cs.getPropertyValue("--vscode-editor-background").trim() ||
            fallbackBg;
        const fg =
            cs.getPropertyValue("--vscode-terminal-foreground").trim() ||
            cs.getPropertyValue("--vscode-editor-foreground").trim() ||
            fallbackFg;

        return {
            background: bg,
            foreground: fg,
            cursor: readCssVar(cs, "--vscode-terminalCursor-foreground", isLight ? "#333333" : "#aeafad"),
            cursorAccent: bg,
            black: readCssVar(cs, "--vscode-terminal-ansiBlack", isLight ? "#000000" : "#000000"),
            red: readCssVar(cs, "--vscode-terminal-ansiRed", "#cd3131"),
            green: readCssVar(cs, "--vscode-terminal-ansiGreen", "#0dbc79"),
            yellow: readCssVar(cs, "--vscode-terminal-ansiYellow", "#e5e510"),
            blue: readCssVar(cs, "--vscode-terminal-ansiBlue", "#2472c8"),
            magenta: readCssVar(cs, "--vscode-terminal-ansiMagenta", "#bc3fbc"),
            cyan: readCssVar(cs, "--vscode-terminal-ansiCyan", "#11a8cd"),
            white: readCssVar(cs, "--vscode-terminal-ansiWhite", isLight ? "#555555" : "#e5e5e5"),
            brightBlack: readCssVar(cs, "--vscode-terminal-ansiBrightBlack", "#666666"),
            brightRed: readCssVar(cs, "--vscode-terminal-ansiBrightRed", "#f14c4c"),
            brightGreen: readCssVar(cs, "--vscode-terminal-ansiBrightGreen", "#23d18b"),
            brightYellow: readCssVar(cs, "--vscode-terminal-ansiBrightYellow", "#f5f543"),
            brightBlue: readCssVar(cs, "--vscode-terminal-ansiBrightBlue", "#3b8eea"),
            brightMagenta: readCssVar(cs, "--vscode-terminal-ansiBrightMagenta", "#d670d6"),
            brightCyan: readCssVar(cs, "--vscode-terminal-ansiBrightCyan", "#29b8db"),
            brightWhite: readCssVar(cs, "--vscode-terminal-ansiBrightWhite", isLight ? "#000000" : "#e5e5e5"),
            selectionBackground: readCssVar(
                cs,
                "--vscode-terminal-selectionBackground",
                isLight ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.3)",
            ),
            selectionForeground: cs.getPropertyValue("--vscode-terminal-selectionForeground").trim() || undefined,
            selectionInactiveBackground: readCssVar(
                cs,
                "--vscode-terminal-inactiveSelectionBackground",
                isLight ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.15)",
            ),
            // The overview ruler draws its border whether or not anything is marked,
            // and left undefined it comes out white — a hairline down the right edge.
            overviewRulerBorder:
                cs.getPropertyValue("--vscode-terminalOverviewRuler-border").trim() ||
                cs.getPropertyValue("--vscode-editorOverviewRuler-border").trim() ||
                cs.getPropertyValue("--vscode-panel-border").trim() ||
                (isLight ? "#d4d4d4" : "#3c3c3c"),
        };
    }

    function fitTerminal() {
        if (!fitAddon) return;
        if (container.clientWidth > 0 && container.clientHeight > 0) {
            fitAddon.fit();
        }
    }

    function submitUserInput(text: string) {
        if (!text) return;
        postToExtension({ type: "user-input", tabId, text });
    }

    function isTerminalFocused(): boolean {
        return !!term && document.activeElement === term.textarea;
    }

    function hasSelection(): boolean {
        return (term?.getSelection() ?? "").length > 0;
    }

    async function writeSelectionToClipboard(clearSelection: boolean): Promise<boolean> {
        const text = term?.getSelection() ?? "";
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
            if (clearSelection) {
                term?.clearSelection();
            }
            return true;
        } catch {
            return false;
        }
    }

    async function pasteFromClipboard(): Promise<boolean> {
        if (!allowKeyboardInput) {
            return false;
        }
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                submitUserInput(text);
            }
            return true;
        } catch {
            return false;
        }
    }

    function handleClipboardCopy(event: ClipboardEvent) {
        if (!active || !hasSelection() || !event.clipboardData) return;
        event.clipboardData.setData("text/plain", term!.getSelection());
        event.preventDefault();
    }

    function handleClipboardCut(event: ClipboardEvent) {
        if (!active || !hasSelection() || !event.clipboardData) return;
        event.clipboardData.setData("text/plain", term!.getSelection());
        term?.clearSelection();
        event.preventDefault();
    }

    function handleClipboardPaste(event: ClipboardEvent) {
        if (!allowKeyboardInput || !active || !isTerminalFocused()) return;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text) return;
        event.preventDefault();
        submitUserInput(text);
    }

    function handleTerminalKeyEvent(event: KeyboardEvent): boolean {
        if (!active) return true;

        if (event.key === "F1") {
            event.preventDefault();
            postToExtension({ type: "special-key", tabId, key: "F1" });
            return false;
        }

        // Ctrl+C (bare, no shift/meta): copy if there is a selection, otherwise
        // send a pause/interrupt request up to the extension.  This matches the
        // pattern VS Code uses in its own integrated terminal so Windows users
        // get copy-when-selected and interrupt-when-not.
        if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
            if (hasSelection()) {
                event.preventDefault();
                void writeSelectionToClipboard(false);
            } else {
                event.preventDefault();
                postToExtension({ type: "special-key", tabId, key: "Ctrl+C" });
            }
            return false;
        }

        const lowerKey = event.key.toLowerCase();
        const primaryModifier = isMac ? event.metaKey : event.ctrlKey;
        const terminalCopyShortcut = !isMac && event.ctrlKey && event.shiftKey && lowerKey === "c";
        const terminalPasteShortcut = !isMac && event.ctrlKey && event.shiftKey && lowerKey === "v";

        if (primaryModifier && !event.altKey && !event.shiftKey && lowerKey === "a") {
            term?.selectAll();
            event.preventDefault();
            return false;
        }

        if ((primaryModifier && !event.altKey && !event.shiftKey && lowerKey === "c") || terminalCopyShortcut) {
            if (!hasSelection()) {
                return true;
            }
            event.preventDefault();
            void writeSelectionToClipboard(false);
            return false;
        }

        if (primaryModifier && !event.altKey && !event.shiftKey && lowerKey === "x") {
            if (!hasSelection()) {
                return true;
            }
            event.preventDefault();
            void writeSelectionToClipboard(true);
            return false;
        }

        if ((primaryModifier && !event.altKey && !event.shiftKey && lowerKey === "v") || terminalPasteShortcut) {
            if (!allowKeyboardInput) {
                return true;
            }
            event.preventDefault();
            void pasteFromClipboard();
            return false;
        }

        return true;
    }

    // -------------------------------------------------------------------------
    // Find
    // -------------------------------------------------------------------------

    /**
     * The search addon wants #RRGGBB for its highlight colours, but VS Code theme
     * variables are frequently rgba() or #RRGGBBAA. Convert what we can and fall
     * back to something readable in the current light/dark mode otherwise.
     */
    function toHexColor(value: string, fallback: string): string {
        const v = value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) return v;
        if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7);
        const parts = v
            .match(/^rgba?\(([^)]+)\)$/i)?.[1]
            .split(",")
            .map((p) => parseFloat(p));
        if (parts && parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
            return `#${parts
                .slice(0, 3)
                .map((n) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, "0"))
                .join("")}`;
        }
        return fallback;
    }

    function buildSearchDecorations() {
        const isLight = document.body.className.includes("vscode-light");
        const cs = getComputedStyle(document.body);
        const match = toHexColor(
            cs.getPropertyValue("--vscode-terminal-findMatchHighlightBackground") ||
                cs.getPropertyValue("--vscode-editor-findMatchHighlightBackground"),
            isLight ? "#f5c396" : "#623315",
        );
        const activeMatch = toHexColor(
            cs.getPropertyValue("--vscode-terminal-findMatchBackground") ||
                cs.getPropertyValue("--vscode-editor-findMatchBackground"),
            isLight ? "#a8ac94" : "#515c6a",
        );
        // The marks beside the scrollbar have theme colours of their own. They are
        // foreground marks on the ruler, not the translucent backgrounds painted behind
        // text in the terminal, and VS Code gives them separate settings. Reusing the
        // backgrounds here is what made our marks a blue-grey where the editor shows
        // its find colour.
        const rulerMatch = toHexColor(
            cs.getPropertyValue("--vscode-terminalOverviewRuler-findMatchHighlightForeground") ||
                cs.getPropertyValue("--vscode-terminalOverviewRuler-findMatchForeground") ||
                cs.getPropertyValue("--vscode-editorOverviewRuler-findMatchForeground"),
            "#d18616",
        );
        const rulerActiveMatch = toHexColor(
            cs.getPropertyValue("--vscode-terminalOverviewRuler-findMatchForeground") ||
                cs.getPropertyValue("--vscode-editorOverviewRuler-findMatchForeground"),
            "#d18616",
        );

        return {
            matchBackground: match,
            matchOverviewRuler: rulerMatch,
            activeMatchBackground: activeMatch,
            activeMatchColorOverviewRuler: rulerActiveMatch,
            activeMatchBorder: toHexColor(
                cs.getPropertyValue("--vscode-terminal-findMatchBorder"),
                isLight ? "#3b3b3b" : "#d4d4d4",
            ),
        };
    }

    function searchOptions(incremental: boolean): ISearchOptions {
        return {
            regex: findRegex,
            wholeWord: findWholeWord,
            caseSensitive: findCaseSensitive,
            incremental,
            decorations: buildSearchDecorations(),
        };
    }

    /** Drop the counter only. The addon keeps its highlights and its place in the buffer. */
    function resetResultDisplay() {
        findResultIndex = -1;
        findResultCount = 0;
    }

    /**
     * Drop the highlights too. Only for an empty or unusable query, or a closed bar:
     * clearDecorations() also forgets the addon's cached search term, and the addon
     * uses that to decide whether to carry on from the current match or start over.
     * Calling it before an ordinary search makes Enter find the same match forever.
     */
    function clearSearchResults() {
        searchAddon?.clearDecorations();
        resetResultDisplay();
    }

    function runSearch(direction: "next" | "previous", incremental = false) {
        if (!searchAddon) return;
        if (!findQuery) {
            findInvalidRegex = false;
            clearSearchResults();
            return;
        }
        if (findRegex) {
            try {
                new RegExp(findQuery);
            } catch {
                // Half-typed patterns are normal while the engineer is still typing.
                findInvalidRegex = true;
                clearSearchResults();
                return;
            }
        }
        findInvalidRegex = false;
        // Counts arrive through onDidChangeResults, fired synchronously inside the
        // call below. Reset first so a search that reports nothing cannot leave the
        // previous count sitting on screen.
        resetResultDisplay();
        const found =
            direction === "next"
                ? searchAddon.findNext(findQuery, searchOptions(incremental))
                : searchAddon.findPrevious(findQuery, searchOptions(false));
        if (!found) {
            // Believe the return value over the reported count. The addon reports the
            // number of highlights it is holding, which can outlive a search that
            // matched nothing, and an unmatched search has no active result either.
            resetResultDisplay();
        }
    }

    function openFind() {
        findOpen = true;
        // The bar is only in the DOM once findOpen has rendered.
        requestAnimationFrame(() => findWidget?.focusInput());
        if (findQuery) {
            runSearch("next");
        }
    }

    function closeFind() {
        if (!findOpen) return;
        findOpen = false;
        findInvalidRegex = false;
        clearSearchResults();
        term?.focus();
    }

    function handleFindQueryChange(text: string) {
        findQuery = text;
        runSearch("next", true);
    }

    function handleFindToggle(which: "caseSensitive" | "wholeWord" | "regex") {
        if (which === "caseSensitive") {
            findCaseSensitive = !findCaseSensitive;
        } else if (which === "wholeWord") {
            findWholeWord = !findWholeWord;
        } else {
            findRegex = !findRegex;
        }
        // addon 0.16 records the new options before deciding whether its highlights
        // need recomputing, so it cannot notice a toggle on its own and would keep
        // showing matches for the old settings. Dropping the decorations forces a
        // fresh pass. (0.15 compared the options before storing them.)
        searchAddon?.clearDecorations();
        runSearch("next");
    }

    /**
     * Find shortcuts are handled on window during capture so they work wherever focus
     * is within the tab — terminal, input bar, or the find box — and never reach
     * xterm.js as input. Only the active tab responds, so the shortcut always lands
     * on the terminal the engineer is looking at.
     */
    function handleWindowKeydown(event: KeyboardEvent) {
        if (!active) return;
        const primaryModifier = isMac ? event.metaKey : event.ctrlKey;
        const lowerKey = event.key.toLowerCase();

        if (primaryModifier && !event.altKey && !event.shiftKey && lowerKey === "f") {
            // A raw-mode input bar forwards Ctrl+<letter> to the device — leave it be.
            if (!isMac && event.target instanceof HTMLInputElement && !findWidget?.ownsFocus()) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (findOpen) {
                findWidget?.focusInput();
            } else {
                openFind();
            }
            return;
        }

        if (findOpen && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeFind();
            return;
        }

        // F3 everywhere; Cmd+G only on macOS, where Ctrl+G is not a device shortcut.
        const findAgain = event.key === "F3" || (isMac && primaryModifier && !event.altKey && lowerKey === "g");
        if (findAgain && findQuery) {
            event.preventDefault();
            event.stopPropagation();
            findOpen = true;
            runSearch(event.shiftKey ? "previous" : "next");
        }
    }

    function flush() {
        if (!term) return;
        if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        if (buffer) {
            term.write(buffer);
            buffer = "";
        }
    }

    function scheduleFlush() {
        if (flushTimer === null) {
            flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
        }
    }

    function handleStreamChunk(text: string) {
        buffer += text;
        if (buffer.length >= MAX_BUFFER_BYTES) {
            flush();
        } else {
            scheduleFlush();
        }
    }

    function handleRestore(text: string) {
        if (flushTimer !== null) {
            flush();
        }
        if (term) {
            term.write(text);
        } else {
            earlyBuffer += text;
        }
    }

    // Registered synchronously at component creation — before onMount and before xterm.js exists.
    // Stream data that arrives during that window is captured in earlyBuffer and flushed in onMount.
    const messageHandler = (event: MessageEvent) => {
        const msg = event.data as ToUi;
        switch (msg.type) {
            case "clear":
                if (msg.tabId !== tabId) return;
                earlyBuffer = "";
                buffer = "";
                term?.clear();
                break;
            case "restore":
                if (msg.tabId !== tabId) return;
                handleRestore(msg.text);
                break;
            case "stream":
                if (msg.tabId !== tabId) return;
                if (term) {
                    handleStreamChunk(msg.text);
                } else {
                    earlyBuffer += msg.text;
                }
                break;
            default:
                break;
        }
    };
    window.addEventListener("message", messageHandler);

    onMount(() => {
        const cs = getComputedStyle(document.body);
        const fontFamily = readCssVar(cs, "--vscode-terminal-font-family", "Menlo, Monaco, Consolas, 'Courier New', monospace");
        const fontSizeRaw = cs.getPropertyValue("--vscode-terminal-font-size").trim() || cs.getPropertyValue("--vscode-editor-font-size").trim();
        const fontSize = fontSizeRaw ? parseFloat(fontSizeRaw) : 13;

        term = new Terminal({
            scrollback: 10_000,
            convertEol: true,
            // The search addon highlights matches with terminal decorations, and
            // registerDecoration is proposed API — without this every search throws.
            allowProposedApi: true,
            // Give the overview ruler a width so search hits are marked beside the
            // scrollbar, the way the editor marks matches. Without a width the ruler
            // is never rendered, and the ruler colours we hand the search addon do
            // nothing at all.
            overviewRuler: { width: 14 },
            theme: buildXtermTheme(),
            fontFamily,
            fontSize,
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        resultsListener = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
            findResultIndex = resultIndex;
            findResultCount = resultCount;
        });
        term.open(container);
        term.attachCustomKeyEventHandler(handleTerminalKeyEvent);
        if (allowKeyboardInput) {
            dataListener = term.onData((text) => submitUserInput(text));
        }

        terminalTextarea = term.textarea ?? undefined;
        terminalTextarea?.addEventListener("copy", handleClipboardCopy);
        terminalTextarea?.addEventListener("cut", handleClipboardCut);
        terminalTextarea?.addEventListener("paste", handleClipboardPaste);

        // Re-read theme after first paint. VS Code may inject CSS custom
        // properties asynchronously (e.g. after the webview script has already
        // started), so a second read in the next animation frame catches that case.
        requestAnimationFrame(() => {
            if (term) {
                term.options.theme = buildXtermTheme();
            }
            fitTerminal();
        });
        resizeObserver = new ResizeObserver(fitTerminal);
        resizeObserver.observe(container);

        // Watch for VS Code theme changes and re-apply xterm theme.
        // VS Code updates body class when theme type changes (dark/light),
        // and replaces/modifies a style element in head when theme colors change.
        themeObserver = new MutationObserver(() => {
            if (themeUpdateTimer !== null) clearTimeout(themeUpdateTimer);
            themeUpdateTimer = setTimeout(() => {
                themeUpdateTimer = null;
                if (term) term.options.theme = buildXtermTheme();
            }, 50);
        });
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

        // Flush data that arrived before xterm.js was ready
        if (earlyBuffer) {
            term.write(earlyBuffer);
            earlyBuffer = "";
        }

        window.addEventListener("keydown", handleWindowKeydown, { capture: true });

        // Signal to the extension that this terminal is ready to receive stream data.
        postToExtension({ type: "terminal-ready", tabId });

        return () => {
            flush();
            window.removeEventListener("keydown", handleWindowKeydown, { capture: true });
            resultsListener?.dispose();
            resultsListener = undefined;
            searchAddon?.dispose();
            searchAddon = undefined;
            dataListener?.dispose();
            dataListener = undefined;
            terminalTextarea?.removeEventListener("copy", handleClipboardCopy);
            terminalTextarea?.removeEventListener("cut", handleClipboardCut);
            terminalTextarea?.removeEventListener("paste", handleClipboardPaste);
            terminalTextarea = undefined;
            term!.dispose();
            term = undefined;
        };
    });

    onDestroy(() => {
        if (flushTimer !== null) clearTimeout(flushTimer);
        if (themeUpdateTimer !== null) clearTimeout(themeUpdateTimer);
        resizeObserver?.disconnect();
        themeObserver?.disconnect();
        window.removeEventListener("message", messageHandler);
    });

    $effect(() => {
        if (active) {
            requestAnimationFrame(fitTerminal);
        }
    });
</script>

<div class="terminal-wrap">
    <div class="xterm-container" bind:this={container}></div>
    {#if findOpen}
        <FindWidget
            bind:this={findWidget}
            query={findQuery}
            caseSensitive={findCaseSensitive}
            wholeWord={findWholeWord}
            regex={findRegex}
            invalidRegex={findInvalidRegex}
            resultIndex={findResultIndex}
            resultCount={findResultCount}
            onQueryChange={handleFindQueryChange}
            onToggle={handleFindToggle}
            onNext={() => runSearch("next")}
            onPrevious={() => runSearch("previous")}
            onClose={closeFind}
        />
    {/if}
    {#if bufferLines > 0}
        <div class="buffer-badge">▼ +{bufferLines.toLocaleString()} lines buffered</div>
    {/if}
</div>

<style>
    .terminal-wrap {
        position: relative;
        width: 100%;
        height: 100%;
    }

    .xterm-container {
        width: 100%;
        height: 100%;
        font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
    }

    /*
     * xterm 6 draws VS Code's own scrollbar widget, but with its colours baked in —
     * the only theme variable it reads is --vscode-scrollbar-shadow. Map the slider
     * onto the theme so it matches every other scrollbar in the window.
     */
    .terminal-wrap :global(.xterm-scrollable-element > .scrollbar > .slider) {
        background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
    }

    .terminal-wrap :global(.xterm-scrollable-element > .scrollbar > .slider:hover) {
        background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
    }

    .terminal-wrap :global(.xterm-scrollable-element > .scrollbar > .slider.active) {
        background: var(--vscode-scrollbarSlider-activeBackground, rgba(191, 191, 191, 0.4));
    }

    /*
     * The old .xterm-viewport still carries overflow-y: scroll while the scrollable
     * element above does the actual scrolling. macOS overlay scrollbars keep that
     * hidden, but Windows and Linux would paint a second bar beside VS Code's.
     * Hiding a scrollbar does not stop the element scrolling.
     */
    .terminal-wrap :global(.xterm-viewport) {
        scrollbar-width: none;
    }

    .terminal-wrap :global(.xterm-viewport::-webkit-scrollbar) {
        display: none;
    }

    .buffer-badge {
        position: absolute;
        bottom: 6px;
        right: 10px;
        background: var(--vscode-badge-background, #4d4d4d);
        color: var(--vscode-badge-foreground, #ffffff);
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        pointer-events: none;
        opacity: 0.85;
    }
</style>
