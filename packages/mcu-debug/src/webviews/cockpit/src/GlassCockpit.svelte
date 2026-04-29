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
    import Terminal from "./Terminal.svelte";
    import AiRequest from "./AiRequest.svelte";
    import InputBar from "./InputBar.svelte";
    import { postToExtension } from "./vscode";
    import type { TabInputMode } from "@mcu-debug/shared";

    const {
        tabId,
        aiRequestText,
        bufferLines,
        active,
        placeholderText,
        inputMode = "cooked",
    }: {
        tabId: string;
        aiRequestText: string;
        bufferLines: number;
        active: boolean;
        placeholderText: string;
        inputMode?: TabInputMode;
    } = $props();

    function handleUserInput(text: string) {
        postToExtension({ type: "user-input", tabId, text });
    }
</script>

<div class="cockpit">
    <div class="terminal-region">
        <Terminal {tabId} {bufferLines} {active} allowKeyboardInput={false} />
    </div>

    {#if aiRequestText}
        <AiRequest text={aiRequestText} />
    {/if}

    <InputBar onSubmit={handleUserInput} {placeholderText} {inputMode} />
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
