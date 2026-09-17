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

/**
 * Per-tab input history, kept in the webview's own state so it survives VS Code
 * throwing the webview away when the panel is hidden and rebuilding it later.
 *
 * Webview state is one object shared by the whole panel, so every write is a
 * read-modify-write under a single key: replacing the object wholesale would
 * discard anything another component had stored.
 *
 * History is keyed by tabId, which the extension assigns and keeps stable across
 * a reload, so a rebuilt tab finds the history it had before.
 */

import { getVsCodeApi } from "./vscode";

const STATE_KEY = "inputHistory";

type HistoryState = Record<string, string[]>;

function readAll(): HistoryState {
    const state = getVsCodeApi().getState();
    if (!state || typeof state !== "object") {
        return {};
    }
    const all = (state as Record<string, unknown>)[STATE_KEY];
    if (!all || typeof all !== "object") {
        return {};
    }
    return { ...(all as HistoryState) };
}

/** Lines previously submitted in this tab, oldest first. Empty if there are none. */
export function loadHistory(tabId: string): string[] {
    const entry = readAll()[tabId];
    if (!Array.isArray(entry)) {
        return [];
    }
    return entry.filter((line): line is string => typeof line === "string");
}

/** Replace this tab's history, leaving every other key in the webview state alone. */
export function saveHistory(tabId: string, lines: string[]): void {
    const api = getVsCodeApi();
    const state = api.getState();
    const base = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
    const all = readAll();
    all[tabId] = lines;
    api.setState({ ...base, [STATE_KEY]: all });
}
