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

import type { FromUi } from '@mcu-debug/shared';

interface VsCodeApi {
    postMessage(message: FromUi): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function makeMockApi(): VsCodeApi {
    return {
        postMessage: (msg) => {
            console.log('[cockpit→ext]', msg);
        },
        getState: () => null,
        setState: () => undefined,
    };
}

let _api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
    if (!_api) {
        _api = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : makeMockApi();
    }
    return _api;
}

export function postToExtension(msg: FromUi): void {
    getVsCodeApi().postMessage(msg);
}
