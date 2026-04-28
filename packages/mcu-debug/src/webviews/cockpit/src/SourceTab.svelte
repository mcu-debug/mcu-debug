<script lang="ts">
    import Terminal from './Terminal.svelte';
    import InputBar from './InputBar.svelte';
    import { postToExtension } from './vscode';

    const { tabId, direction = 'rx', bufferLines }: {
        tabId: string;
        direction?: 'rx' | 'tx' | 'both';
        bufferLines: number;
    } = $props();

    const showInput = $derived(direction === 'tx' || direction === 'both');

    function handleUserInput(text: string) {
        postToExtension({ type: 'user-input', tabId, text });
    }
</script>

<div class="source-tab">
    <div class="terminal-region">
        <Terminal {tabId} {bufferLines} />
    </div>

    {#if showInput}
        <InputBar onSubmit={handleUserInput} />
    {/if}
</div>

<style>
    .source-tab {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .terminal-region {
        flex: 1;
        overflow: hidden;
        min-height: 0;
    }
</style>
