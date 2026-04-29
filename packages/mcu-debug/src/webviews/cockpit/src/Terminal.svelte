<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import { Terminal } from "@xterm/xterm";
    import { FitAddon } from "@xterm/addon-fit";
    import { WebLinksAddon } from "@xterm/addon-web-links";
    import type { ToUi } from "@mcu-debug/shared";
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
    let resizeObserver: ResizeObserver;
    let dataListener: { dispose(): void } | undefined;
    let terminalTextarea: HTMLTextAreaElement | undefined;

    const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

    function readCssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
        return styles.getPropertyValue(name).trim() || fallback;
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
            theme: {
                background: readCssVar(cs, "--vscode-terminal-background", "#1e1e1e"),
                foreground: readCssVar(cs, "--vscode-terminal-foreground", "#cccccc"),
                cursor: readCssVar(cs, "--vscode-terminalCursor-foreground", "#aeafad"),
                cursorAccent: readCssVar(cs, "--vscode-terminal-background", "#1e1e1e"),
                black: readCssVar(cs, "--vscode-terminal-ansiBlack", "#000000"),
                red: readCssVar(cs, "--vscode-terminal-ansiRed", "#cd3131"),
                green: readCssVar(cs, "--vscode-terminal-ansiGreen", "#0dbc79"),
                yellow: readCssVar(cs, "--vscode-terminal-ansiYellow", "#e5e510"),
                blue: readCssVar(cs, "--vscode-terminal-ansiBlue", "#2472c8"),
                magenta: readCssVar(cs, "--vscode-terminal-ansiMagenta", "#bc3fbc"),
                cyan: readCssVar(cs, "--vscode-terminal-ansiCyan", "#11a8cd"),
                white: readCssVar(cs, "--vscode-terminal-ansiWhite", "#e5e5e5"),
                brightBlack: readCssVar(cs, "--vscode-terminal-ansiBrightBlack", "#666666"),
                brightRed: readCssVar(cs, "--vscode-terminal-ansiBrightRed", "#f14c4c"),
                brightGreen: readCssVar(cs, "--vscode-terminal-ansiBrightGreen", "#23d18b"),
                brightYellow: readCssVar(cs, "--vscode-terminal-ansiBrightYellow", "#f5f543"),
                brightBlue: readCssVar(cs, "--vscode-terminal-ansiBrightBlue", "#3b8eea"),
                brightMagenta: readCssVar(cs, "--vscode-terminal-ansiBrightMagenta", "#d670d6"),
                brightCyan: readCssVar(cs, "--vscode-terminal-ansiBrightCyan", "#29b8db"),
                brightWhite: readCssVar(cs, "--vscode-terminal-ansiBrightWhite", "#e5e5e5"),
            },
            fontFamily,
            fontSize,
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        term.open(container);
        term.attachCustomKeyEventHandler(handleTerminalKeyEvent);
        if (allowKeyboardInput) {
            dataListener = term.onData((text) => submitUserInput(text));
        }

        terminalTextarea = term.textarea ?? undefined;
        terminalTextarea?.addEventListener("copy", handleClipboardCopy);
        terminalTextarea?.addEventListener("cut", handleClipboardCut);
        terminalTextarea?.addEventListener("paste", handleClipboardPaste);

        requestAnimationFrame(fitTerminal);
        resizeObserver = new ResizeObserver(fitTerminal);
        resizeObserver.observe(container);

        // Flush data that arrived before xterm.js was ready
        if (earlyBuffer) {
            term.write(earlyBuffer);
            earlyBuffer = "";
        }

        // Signal to the extension that this terminal is ready to receive stream data.
        postToExtension({ type: "terminal-ready", tabId });

        return () => {
            flush();
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
        resizeObserver?.disconnect();
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
