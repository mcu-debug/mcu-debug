<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import { Terminal } from "@xterm/xterm";
    import { FitAddon } from "@xterm/addon-fit";
    import { WebLinksAddon } from "@xterm/addon-web-links";
    import type { ToUi } from "@mcu-debug/shared";
    import { postToExtension } from "./vscode";
    import "@xterm/xterm/css/xterm.css";

    const { tabId, bufferLines, active }: { tabId: string; bufferLines: number; active: boolean } = $props();

    const FLUSH_INTERVAL_MS = 500;
    const MAX_BUFFER_BYTES = 32_000;

    let container: HTMLDivElement;
    let term: Terminal | undefined;
    let fitAddon: FitAddon;
    let buffer = ""; // xterm.js write buffer (throttled)
    let earlyBuffer = ""; // pre-mount stream buffer (before xterm.js exists)
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver;

    function fitTerminal() {
        if (!fitAddon) return;
        if (container.clientWidth > 0 && container.clientHeight > 0) {
            fitAddon.fit();
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
        const fontFamily =
            cs.getPropertyValue("--vscode-terminal-font-family").trim() || cs.getPropertyValue("--vscode-editor-font-family").trim() || "Menlo, Monaco, Consolas, 'Courier New', monospace";
        const fontSizeRaw = cs.getPropertyValue("--vscode-terminal-font-size").trim() || cs.getPropertyValue("--vscode-editor-font-size").trim();
        const fontSize = fontSizeRaw ? parseFloat(fontSizeRaw) : 13;

        term = new Terminal({
            scrollback: 10_000,
            convertEol: true,
            theme: {
                background: cs.getPropertyValue("--vscode-terminal-background").trim() || "#1e1e1e",
                foreground: cs.getPropertyValue("--vscode-terminal-foreground").trim() || "#cccccc",
                cursor: cs.getPropertyValue("--vscode-terminalCursor-foreground").trim() || "#aeafad",
            },
            fontFamily,
            fontSize,
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        term.open(container);

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
