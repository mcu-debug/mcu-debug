<script lang="ts">
    const { text }: { text: string } = $props();
</script>

<div class="ai-request">
    <span class="icon">⚑</span>
    <span class="label">AI REQUEST</span>
    <span class="message">{text}</span>
</div>

<style>
    .ai-request {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 12px;
        border-top: 2px solid var(--vscode-charts-orange, #e8a000);
        border-bottom: 2px solid var(--vscode-charts-orange, #e8a000);
        background: var(--vscode-inputValidation-warningBackground, #3a2f00);
        font-size: 13px;
        flex-shrink: 0;
    }

    .icon {
        color: var(--vscode-charts-orange, #e8a000);
        flex-shrink: 0;
        line-height: 1.4;
    }

    .label {
        color: var(--vscode-charts-orange, #e8a000);
        font-weight: bold;
        flex-shrink: 0;
        line-height: 1.4;
    }

    .message {
        color: var(--vscode-editor-foreground, #d4d4d4);
        line-height: 1.4;
        white-space: pre-wrap;
    }
</style>
