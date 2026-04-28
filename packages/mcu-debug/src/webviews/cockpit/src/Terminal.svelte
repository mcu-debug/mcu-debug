<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { Terminal } from '@xterm/xterm';
    import { FitAddon } from '@xterm/addon-fit';
    import { WebLinksAddon } from '@xterm/addon-web-links';
    import type { ToUi } from '@mcu-debug/shared';
    import '@xterm/xterm/css/xterm.css';

    const { tabId, bufferLines }: { tabId: string; bufferLines: number } = $props();

    const FLUSH_INTERVAL_MS = 500;
    const MAX_BUFFER_BYTES = 32_000;

    let container: HTMLDivElement;
    let term: Terminal;
    let fitAddon: FitAddon;
    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver;
    let messageHandler: (e: MessageEvent) => void;

    function flush() {
        if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        if (buffer) {
            term.write(buffer);
            buffer = '';
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

    onMount(() => {
        term = new Terminal({
            scrollback: 10_000,
            convertEol: true,
            theme: {
                background: getComputedStyle(document.body)
                    .getPropertyValue('--vscode-terminal-background')
                    .trim() || '#1e1e1e',
                foreground: getComputedStyle(document.body)
                    .getPropertyValue('--vscode-terminal-foreground')
                    .trim() || '#cccccc',
                cursor: getComputedStyle(document.body)
                    .getPropertyValue('--vscode-terminalCursor-foreground')
                    .trim() || '#aeafad',
            },
            fontFamily: getComputedStyle(document.body)
                .getPropertyValue('--vscode-editor-font-family')
                .trim() || 'monospace',
            fontSize: 13,
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());
        term.open(container);
        fitAddon.fit();

        resizeObserver = new ResizeObserver(() => fitAddon.fit());
        resizeObserver.observe(container);

        messageHandler = (event: MessageEvent) => {
            const msg = event.data as ToUi;
            if (msg.type === 'stream' && msg.tabId === tabId) {
                handleStreamChunk(msg.text);
            }
        };
        window.addEventListener('message', messageHandler);

        return () => {
            flush();
            term.dispose();
        };
    });

    onDestroy(() => {
        if (flushTimer !== null) clearTimeout(flushTimer);
        resizeObserver?.disconnect();
        window.removeEventListener('message', messageHandler);
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
