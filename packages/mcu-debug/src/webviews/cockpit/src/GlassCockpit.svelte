<script lang="ts">
    import Terminal from './Terminal.svelte';
    import AiRequest from './AiRequest.svelte';
    import InputBar from './InputBar.svelte';
    import { postToExtension } from './vscode';

    const { tabId, aiRequestText, bufferLines }: {
        tabId: string;
        aiRequestText: string;
        bufferLines: number;
    } = $props();

    function handleUserInput(text: string) {
        postToExtension({ type: 'user-input', tabId, text });
    }
</script>

<div class="cockpit">
    <div class="terminal-region">
        <Terminal {tabId} {bufferLines} />
    </div>

    {#if aiRequestText}
        <AiRequest text={aiRequestText} />
    {/if}

    <InputBar onSubmit={handleUserInput} />
</div>

<style>
    .cockpit {
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
