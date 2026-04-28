<script lang="ts">
    const { onSubmit }: { onSubmit: (text: string) => void } = $props();

    let value = $state('');

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' && value.trim()) {
            onSubmit(value.trim());
            value = '';
        }
    }
</script>

<div class="input-bar">
    <span class="prompt">&gt;&nbsp;</span>
    <input
        type="text"
        bind:value
        onkeydown={handleKeydown}
        placeholder="Send observation or GDB command…"
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
