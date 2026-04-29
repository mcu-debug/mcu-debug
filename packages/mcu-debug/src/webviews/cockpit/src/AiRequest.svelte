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
