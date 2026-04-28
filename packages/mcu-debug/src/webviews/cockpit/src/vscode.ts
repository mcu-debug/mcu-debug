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
