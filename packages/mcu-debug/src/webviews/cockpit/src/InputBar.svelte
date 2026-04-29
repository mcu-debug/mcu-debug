<script lang="ts">
    import type { TabInputMode } from "@mcu-debug/shared";

    const {
        onSubmit,
        placeholderText,
        inputMode = "cooked",
    }: {
        onSubmit: (text: string) => void;
        placeholderText: string;
        inputMode?: TabInputMode;
    } = $props();

    let value = $state("");

    function handleKeydown(e: KeyboardEvent) {
        if (inputMode === "cooked") {
            if (e.key === "Enter") {
                onSubmit(value);
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
