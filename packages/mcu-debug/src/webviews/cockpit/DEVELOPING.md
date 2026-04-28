# Cockpit Webview — Developer Guide

Svelte 5 + Vite project. Produces a single `resources/cockpit/index.html` for the VS Code WebviewPanel.

## Prerequisites

```sh
cd packages/mcu-debug/src/webviews/cockpit
npm install
```

> **Note:** If you change `packages/shared/src/cockpit-protocol.ts`, rebuild the shared
> library before type-checking or compiling the extension:
> ```sh
> cd packages/shared && npm run compile
> ```

## Run in browser (mock mode)

```sh
npm run dev
```

Open <http://localhost:5173>. The fake orchestrator (`dev-mock.ts`) starts automatically and exercises the full tab lifecycle — no hardware, no VS Code needed.

**What the mock does over time:**

| Time  | Event |
|-------|-------|
| 0s    | 4 tabs created: ttyUSB0 (UART), COM3 (UART), RTT#0, Glass Cockpit |
| 0s+   | Each tab receives its own independent data stream |
| 5s    | AI-REQUEST appears in Glass Cockpit tab |
| 8s    | COM3 goes orange — simulates cable disconnect |
| 12s   | AI-REQUEST clears |
| 15s   | COM3 reconnects |
| 20s   | RTT#0 and Glass Cockpit dim — simulates debug session end |

Edit any `.svelte` file and the browser updates instantly (HMR). The browser console logs outbound messages (`[cockpit→ext]`) whenever you submit input.

## Type-check

```sh
npm run typecheck
```

## Build for VS Code

```sh
npm run build
```

Output: `packages/mcu-debug/resources/cockpit/index.html` — a single self-contained file (JS and CSS inlined). The extension host loads this file into the WebviewPanel.

The main extension's `tsconfig.json` excludes `src/webviews/` — the cockpit is built by Vite, not tsc.

## Project layout

```
src/
  main.ts            Entry point. Starts dev-mock in DEV mode only.
  vscode.ts          Thin shim: acquireVsCodeApi() in production, silent mock in dev.
  dev-mock.ts        Fake orchestrator — browser-only, tree-shaken from prod build.
  App.svelte         Tab container. Owns tab list state, routes all ToUi messages.
  TabBar.svelte      Tab bar UI. UART tabs show × always; session tabs show × on hover.
  GlassCockpit.svelte  Three-region cockpit layout (terminal / AI-REQUEST / input).
  SourceTab.svelte   Single-source layout for UART, RTT, SWO. Input bar gated by direction prop.
  Terminal.svelte    xterm.js wrapper. Filters stream messages by tabId. 500ms/32KB throttle.
  AiRequest.svelte   Sticky AI-REQUEST section (cockpit tab only).
  InputBar.svelte    Single input line → user-input message.
```

## Protocol

Messages between the extension host and this webview are defined in:

```
packages/shared/src/cockpit-protocol.ts
```

`ToUi` — extension → webview (tab lifecycle, stream data, AI-REQUEST).
`FromUi` — webview → extension (user input, tab-close).

Every content message carries a `tabId`. The webview treats `tabId` as an opaque token.
Tab removal is always user-initiated (`tab-close`); the extension never removes tabs.
