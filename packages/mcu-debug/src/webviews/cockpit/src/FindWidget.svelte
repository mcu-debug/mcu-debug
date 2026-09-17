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

<!--
    Find bar for a tab's terminal, modelled on the one in VS Code's integrated terminal.

    It is positioned inside the terminal region, so it never covers the panel's tab bar —
    unlike VS Code's terminal, our terminals live under a tab strip that must stay usable
    while a search is open.

    All search state lives in Terminal.svelte, which owns the xterm SearchAddon. This
    component is presentation plus keyboard handling for its own input.
-->

<script lang="ts">
    const {
        query,
        caseSensitive,
        wholeWord,
        regex,
        resultIndex,
        resultCount,
        invalidRegex = false,
        onQueryChange,
        onToggle,
        onNext,
        onPrevious,
        onClose,
    }: {
        query: string;
        caseSensitive: boolean;
        wholeWord: boolean;
        regex: boolean;
        /** Zero-based index of the active match, or -1 when there is none. */
        resultIndex: number;
        resultCount: number;
        invalidRegex?: boolean;
        onQueryChange: (text: string) => void;
        onToggle: (which: "caseSensitive" | "wholeWord" | "regex") => void;
        onNext: () => void;
        onPrevious: () => void;
        onClose: () => void;
    } = $props();

    let inputEl: HTMLInputElement | undefined;
    let focused = $state(false);

    /** Called by Terminal.svelte when the find shortcut is pressed. */
    export function focusInput(selectAll = true): void {
        inputEl?.focus();
        if (selectAll) {
            inputEl?.select();
        }
    }

    /** True when the search box itself has keyboard focus. */
    export function ownsFocus(): boolean {
        return !!inputEl && document.activeElement === inputEl;
    }

    const statusText = $derived.by(() => {
        if (!query) {
            return "";
        }
        if (invalidRegex) {
            return "Invalid regex";
        }
        if (resultCount === 0) {
            return "No results";
        }
        // The addon reports -1 once its highlight limit is passed; it stops counting there.
        if (resultIndex < 0) {
            return `${resultCount.toLocaleString()}+ results`;
        }
        return `${resultIndex + 1} of ${resultCount.toLocaleString()}`;
    });

    const canNavigate = $derived(!!query && !invalidRegex && resultCount > 0);

    function handleInput(event: Event) {
        onQueryChange((event.currentTarget as HTMLInputElement).value);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) {
                onPrevious();
            } else {
                onNext();
            }
        }
    }
</script>

<div class="find-widget" role="search">
    <div class="find-input-box" class:focused class:invalid={invalidRegex}>
        <!-- prettier-ignore -->
        <input
            type="text"
            value={query}
            bind:this={inputEl}
            oninput={handleInput}
            onkeydown={handleKeydown}
            onfocus={() => (focused = true)}
            onblur={() => (focused = false)}
            placeholder="Find"
            aria-label="Find in terminal"
            spellcheck={false}
            autocomplete="off"
        />
        <button
            class="toggle"
            class:on={caseSensitive}
            type="button"
            title="Match Case"
            aria-label="Match Case"
            aria-pressed={caseSensitive}
            onclick={() => onToggle("caseSensitive")}
        >Aa</button>
        <button
            class="toggle"
            class:on={wholeWord}
            type="button"
            title="Match Whole Word"
            aria-label="Match Whole Word"
            aria-pressed={wholeWord}
            onclick={() => onToggle("wholeWord")}
        ><span class="whole-word">ab</span></button>
        <button
            class="toggle"
            class:on={regex}
            type="button"
            title="Use Regular Expression"
            aria-label="Use Regular Expression"
            aria-pressed={regex}
            onclick={() => onToggle("regex")}
        >.*</button>
    </div>

    <div class="status" class:no-results={!!query && !invalidRegex && resultCount === 0} aria-live="polite">
        {statusText}
    </div>

    <button
        class="nav"
        type="button"
        title="Previous Match (Shift+Enter)"
        aria-label="Previous Match"
        disabled={!canNavigate}
        onclick={onPrevious}
    >↑</button>
    <button
        class="nav"
        type="button"
        title="Next Match (Enter)"
        aria-label="Next Match"
        disabled={!canNavigate}
        onclick={onNext}
    >↓</button>
    <button class="nav" type="button" title="Close (Escape)" aria-label="Close find" onclick={onClose}>✕</button>
</div>

<style>
    .find-widget {
        position: absolute;
        top: 0;
        right: 14px;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 4px;
        max-width: calc(100% - 28px);
        padding: 4px 6px;
        background: var(--vscode-editorWidget-background, #252526);
        color: var(--vscode-editorWidget-foreground, #cccccc);
        border: 1px solid var(--vscode-widget-border, #454545);
        border-top: none;
        border-radius: 0 0 4px 4px;
        box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
        font-family: var(--vscode-font-family, sans-serif);
        font-size: 12px;
    }

    .find-input-box {
        display: flex;
        align-items: center;
        gap: 2px;
        min-width: 0;
        padding: 0 2px;
        background: var(--vscode-input-background, #3c3c3c);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
    }

    .find-input-box.focused {
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    .find-input-box.invalid {
        border-color: var(--vscode-inputValidation-errorBorder, #be1100);
    }

    input {
        flex: 1;
        min-width: 0;
        width: 170px;
        padding: 3px 4px;
        background: transparent;
        border: none;
        outline: none;
        color: var(--vscode-input-foreground, #cccccc);
        font-family: inherit;
        font-size: 12px;
    }

    input::placeholder {
        color: var(--vscode-input-placeholderForeground, #888);
    }

    .toggle,
    .nav {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-icon-foreground, #cccccc);
        font-family: inherit;
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
    }

    .nav {
        font-size: 13px;
    }

    .toggle:hover:not(.on),
    .nav:hover:not(:disabled) {
        background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    }

    .toggle.on {
        background: var(--vscode-inputOption-activeBackground, rgba(0, 122, 204, 0.4));
        color: var(--vscode-inputOption-activeForeground, #ffffff);
        border-color: var(--vscode-inputOption-activeBorder, transparent);
    }

    .whole-word {
        border-bottom: 1px solid currentColor;
        line-height: 1;
    }

    .nav:disabled {
        opacity: 0.4;
        cursor: default;
    }

    .status {
        flex-shrink: 0;
        min-width: 72px;
        text-align: center;
        white-space: nowrap;
        color: var(--vscode-descriptionForeground, #9d9d9d);
    }

    .status.no-results {
        color: var(--vscode-errorForeground, #f14c4c);
    }
</style>
