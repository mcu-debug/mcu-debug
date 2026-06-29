# CLI Implementation Plan

See [CLI Architecture](./cli-architecture.md) and [CLI Config](./cli-config.md) for design rationale.

---

## Directory Structure

Current layout:
```
packages/mcu-debug/src/
  adapter/      ← DA session logic + DAP server entry point
  frontend/     ← VS Code extension (mixed: pure VS Code glue + reusable logic tangled together)
  webviews/
  analytics/
```

Target layout — adds `common/` and `cli/`, splits `frontend/` at the vscode-dependency boundary:

```
packages/mcu-debug/src/
  adapter/              ← DA session logic + DAP server entry point (mostly unchanged)
    main.ts             ← existing DAP server entry point
    gdb-session.ts
    server-session.ts
    servers/            ← gdb-server controllers (openocd, jlink, pyocd, stlink, ...)
    gdb-mi/
    proxy-client.ts
    rtt-builtin.ts
    breakpoints.ts, variables.ts, symbols.ts, memory.ts, ...

  cli/                  ← CLI-specific: new entry point + CLI-only concerns
    cli-driver.ts       ← new entry point; drives session in-process (see Phase 5)
    cli-adapter.ts      ← CliAdapter: implements IHostAdapter for CLI mode
    cli-config-loader.ts  ← thin glue: creates CliAdapter, calls common/ConfigProvider
    session-socket.ts   ← ~/.mcu-debug/current.sock server (mux broadcast + command receive)

  common/               ← shared by both frontend AND cli
                           RULE: no `import from 'vscode'` (extension API) — enforced by tsconfig/lint
                           NOTE: @vscode/debugprotocol and @vscode/debugadapter ARE allowed —
                                 they are plain npm packages with no extension-host dependency
    host-adapter.ts     ← IHostAdapter interface (used by ConfigProvider — see below)
    config-provider.ts  ← bulk of frontend/configprovider.ts logic; ctor takes IHostAdapter
    swo/                ← moved from frontend/swo/ (decoders + sources — no vscode deps)
    serial/             ← moved from frontend/serial.ts (serial stream client)
    mux/                ← mux stream tag formatting, parsing, routing
    ansi-helpers.ts     ← moved from frontend/ansi-helpers.ts
    utils.ts            ← non-vscode utilities extracted from frontend/utils.ts

  frontend/             ← pure VS Code extension code (vscode APIs welcome here)
    extension.ts        ← VS Code activation (see note below)
    configprovider.ts   ← thin wrapper: creates VscodeAdapter, delegates to common/ConfigProvider
                           hooks (resolveDebugConfiguration etc.) stay here — VS Code lifecycle
    vscode-adapter.ts   ← VscodeAdapter: implements IHostAdapter using vscode.*
    cortex_debug_session.ts
    proxy.ts            ← Rust proxy binary lifecycle (VS Code only; CLI bootstrap handles this in Rust)
    io-terminal.ts
    views/              ← CockpitPanel, ManagedTab, live-watch
    rtos/
    swo/                ← VS Code-specific SWO panel/view wrappers (imports common/swo for logic)
    ...

  webviews/             ← unchanged
  analytics/            ← unchanged
```

### The `common/` contract

`common/` is the seam. The rule is mechanical and checkable:

- `common/` may import from `adapter/` (session types, interfaces)
- `common/` may NOT import from `frontend/`, `cli/`, or `vscode`
- `frontend/` may import from `common/` and `adapter/`
- `cli/` may import from `common/` and `adapter/`
- `frontend/` and `cli/` may NOT import from each other

Enforce with a separate `tsconfig.common.json` that excludes `@types/vscode`.

### IHostAdapter — the key seam

`IHostAdapter` is the boundary for **config resolution only** — it is used by `common/ConfigProvider`,
not injected into the DA session. The DA session (GDBDebugSession) communicates exclusively through
DAP events (`OutputEvent`, `StoppedEvent`, etc.) — it never calls `vscode.window.*` or any host UI
directly. `OutputEvent.category` carries all the routing metadata the CLI needs.

```typescript
// common/host-adapter.ts
interface IHostAdapter {
    // Workspace context — where is the project root?
    getWorkspaceFolder(): string | undefined;

    // Settings bridge:
    //   VS Code:  vscode.workspace.getConfiguration("mcu-debug").get(key)
    //   CLI:      .vscode/mcu-debug-settings.json → ~/.mcu-debug/settings.json
    getSetting<T>(key: string): T | undefined;

    // User-facing diagnostics during config resolution
    showError(msg: string): void;
    showWarning(msg: string): void;
}

// frontend/vscode-adapter.ts  (imports vscode)
class VscodeAdapter implements IHostAdapter { ... }

// cli/cli-adapter.ts  (no vscode)
class CliAdapter implements IHostAdapter { ... }
```

The DA session uses `sendEvent()` / `sendResponse()` — never `IHostAdapter`. In CLI mode
the Driver overrides these to intercept events and route them to the mux stream:

```typescript
// Routing table for OutputEvent.category → mux channel
// 'console'   → [GDB] channel  (GDB console output, MI notifications)
// 'important' → highlighted / TUI status bar  (errors, warnings)
// 'stdout'    → target stdout mux channel
// 'stderr'    → target stderr mux channel
// Lifecycle events (StoppedEvent, ContinuedEvent, TerminatedEvent) → TUI state / session teardown
// Custom events (SWOConfigureEvent, UARTConfigureEvent) → configure mux channels
```

---

## `extension.ts` — the elephant in the room

`extension.ts` grew organically and is now a monolith. It handles VS Code activation,
multi-core session management, panel lifecycle, config providers, and more — all tangled together.

**Decision: do not attempt a full refactor of `extension.ts` for v1 CLI.**

Rationale:
- Multi-core session management alone makes a clean extraction risky
- The CLI does not need most of what `extension.ts` does (VS Code panel lifecycle,
  multi-session orchestration, RTOS views, etc.)
- A full refactor risks regressions in the VS Code path for marginal CLI benefit

**What extension.ts DOES need (minimum required changes):**

1. Update imports to use `common/` for things that moved there
   (`ansi-helpers`, `utils`, `swo/`, `serial/`) — mechanical, low risk
2. `configprovider.ts` becomes a thin wrapper: create `VscodeAdapter`, delegate to
   `common/ConfigProvider` — the VS Code lifecycle hooks (`resolveDebugConfiguration` etc.)
   stay in `frontend/configprovider.ts`, only the logic moves to `common/`
3. Multi-core: leave entirely alone for v1

**CLI reimplements what it needs independently** (`cli-driver.ts`) rather than inheriting
from `extension.ts`. Some duplication is acceptable in v1. Convergence can happen
after both paths are working and the shape is clear.

---

## Implementation checklist — execution order

Ordered by how execution flows at runtime, which is also the order to write and test the code.
Each phase can be tested independently before the next begins.

---

### Phase 1 — Node bootstrap (`npx mcu-debug debug` subcommand) invokes Rust bootstrap

Entry point. Everything starts here.

- [x] **Arg parsing**
  - [x] `--no-tui`            Force headless even on a TTY (useful for testing)
  - [x] **                    All others passed to node cli

- [x] **Node.js check**
  - [x] Locate `node` on PATH
  - [x] Check version >= 22; if not: clear error with nodejs.org URL, exit non-zero
  - [x] If not found: clear error distinguishing "not installed" from "wrong version"

- [x] **Locate bundled `mcu-debug-cli.js`**
  - [x] Resolve relative to own executable: `current_exe().parent().join("dist/mcu-debug-cli.js")`
  - [x] If not found: error — likely a broken installation

- [x] **TTY detection → choose mode**
  - [x] `stdout` is a TTY and no `-no-tui` → **TUI mode**: start node program with stdio piped
  - [x] `stdout` is not a TTY → **headless mode**: spawn Node with inherited stdio (Unix: `exec`-replace; Windows: spawn-and-wait), forward exit code

---

### Phase 2 — Config resolution (Node — `common/config-provider.ts` + `cli/config-loader.ts`)

The resolution logic lives in `common/ConfigProvider` (moved from `frontend/configprovider.ts`).
`cli/config-resolver.ts` is thin: it instantiates `CliAdapter` and calls `ConfigProvider`.
`frontend/configprovider.ts` does the same with `VscodeAdapter` — shared logic, two thin callers.

Runs first thing in the Node process before any session logic.

- [x] **Read and select config**
  - [x] Open `launch.json` (from arg or `./launch.json`)
  - [x] Select config by name (case-insensitive or glob or index match on `name` field)
  - [x] Error clearly if not found — list available names

- [x] **Load `envFile`(s)**
  - [x] Support single string or array in launch config
  - [x] Parse `name=value` format: skip blank lines, skip `#` comments, strip optional quotes
  - [x] In-file substitution: single pass top-to-bottom, `${VAR}` resolves from earlier lines then `process.env`
  - [x] Build `mergedEnv = { ...envFileVars, ...process.env }` — process.env wins, never mutate it

- [x] **Variable substitution pass** (our pass — before any VS Code pass)
  - [x] `${env:VAR}`        → `mergedEnv` lookup
  - [x] `${workspaceFolder}`→ directory containing `launch.json`
  - [x] `${userHome}`       → `os.homedir()`
  - [x] `${pathSeparator}`  → `path.sep`
  - [x] `${config:KEY}`     → `.vscode/mcu-debug-settings.json` then `~/.mcu-debug/settings.json`
  - [x] `${command:...}`    → always error: tell user to expand manually
  - [x] Collect ALL unresolved — report together, exit non-zero, never partial

- [x] **Properties requiring resolution** (complete this list as you go):
  - [x] `serverPath`, `armToolchainPath` / `gdbPath`
  - [x] STLink: `cubeProgrammerPath`
  - [x] `serverArgs`, `debuggerArgs`
  - [x] `type`: `launch` vs `attach`
  - [x] Pre/post/override launch and attach commands
  - [x] openOCD startup commands
  - [x] `rtt`, ~~`swo`~~, `uart` config blocks
  - [x] `envFile` itself (resolve `${workspaceFolder}` in the path before loading)

- [x] **`dump-config` subcommand** (free once resolver exists)
  - [x] Print fully-resolved config as JSON to stdout

---

### Phase 3 — Topology detection (Node — `cli/topology.ts`)

Determines where the probe is and what transport to use.
Runs after config resolution — `remoteConfig` field in resolved config may override.

- [x] Detect WSL: `WSL_DISTRO_NAME` env var
  - [x] Networking mode: `wslinfo --networking-mode` → `mirrored` | `nat`
  - [x] NAT: resolve Windows host IP from `/proc/net/route` default gateway
- [x] Detect Docker: `/.dockerenv` exists, or `/proc/1/cgroup` contains `docker`
  - [x] Host address: `host.docker.internal` (Docker Desktop) or default gateway (Linux Docker)
- [ ] Detect SSH server: `SSH_CLIENT` env var set → probe is local to this machine → treat as `Local`
- [x] Default: `Local` — no proxy, GDB connects directly
- [x] `hostConfig` in launch config overrides detection:
  - [ ] `{ type: "auto" }` — use detection above
  - [ ] `{ type: "ssh", host: "..." }` — explicit LAB host, SSH auto-deploy flow
  - [ ] `{ type: "direct", address: "...", port: N }` — proxy already running

---

### Phase 4 — Proxy / tunnel setup (Node — `cli/cli-driver.ts`)

Only needed if topology is not `Local`.

- [ ] **LAB / SSH** (`remoteConfig.type == "ssh"`):
  - [ ] SSH to host, check `~/.mcu-debug/bin/mcu-debug` version
  - [ ] Deploy binary via SCP if missing or outdated
  - [ ] Start `mcu-debug proxy` on host, capture port from discovery JSON on stdout
  - [ ] Establish SSH `-L` tunnel to proxy port
- [ ] **WSL / Docker** (`remoteConfig.type == "direct"` or auto-detected):
  - [ ] Proxy assumed pre-running; connect directly to resolved address:port
  - [ ] Clear error if connection refused: "Start `mcu-debug proxy` on the host first"
- [ ] Heartbeat: detect proxy death, surface to user, clean shutdown

---

### Phase 5 — Session startup (Node — `cli/session-driver.ts`)

Drives the session logic directly in-process. `GDBDebugSession` is NOT started via
`GDBDebugSession.run()` (which starts the stdio DAP server). Instead the CLI Driver calls
`dispatchRequest()` directly with synthetic DAP request objects — no DAP framing, no stdio
transport, direct in-process calls. `SeqDebugSession`'s serialized-execution queue works
unchanged; the CLI Driver just feeds it requests and awaits responses via the existing
Promise resolver in `sendResponse()`.

- [x] **Event interception** — override `sendEvent()` to route DAP events to the mux stream
      instead of a transport. No IHostAdapter needed at the session level.
  - [x] `OutputEvent{category:'console'}` → `[GDB]` mux channel
  - [x] `OutputEvent{category:'stdout'/'stderr'}` → target output mux channels
  - [x] `StoppedEvent` / `ContinuedEvent / etc.` → TUI/VSCode-panel status indicator, goes to stderr
  - [x] `TerminatedEvent` → session teardown sequence
  - [x] `SWOConfigureEvent`, `UARTConfigureEvent` (custom) → configure mux channels
- [ ] **No-op transport** — skip `super.sendEvent()` / `super.sendResponse()` calls so the
      uninitialized stdio transport is never touched
- [x] **Dispatch synthetic requests** via `dispatchRequest()` — the same sequence as the
      DAP `launch` handler flow, now driven directly:
  - [x] `initialize` request
  - [x] `launch` (or `attach`) request with fully-resolved config from Phase 2
  - [x] `configurationDone` request
- [x] Launch gdb-server (delegates to existing `servers/*.ts` controllers — untouched)
- [x] Wait for gdb-server ports to be ready
- [x] Launch GDB, connect to gdb-server (existing `gdb-session.ts` — untouched)
- [x] Run pre-launch / startup commands
- [x] RTT setup (existing `rtt-builtin.ts` or gdb-server TCP mode — untouched)
- [ ] SWO setup (existing sources — untouched after move to `common/`)
- [x] UART setup (existing serial client — untouched after move to `common/`)
- [x] Signal "session ready" to Rust bootstrap via TCP control channel

---

### Phase 6 — Session socket + mux stream (`cli/session-socket.ts`)

The live session. Rust TUI connects here; AI attachers connect here later.

- [x] Create `~/.mcu-debug/socket.json` (and `/tmp/mcu-debug-<pid>.sock` for explicit addressing)
- [x] On each new attacher connection:
  - [x] Send ring buffer snapshot (catch-up — same principle as serial ring buffer)
  - [x] Then stream live mux frames
- [x] Receive commands from any attacher, route to GDB input
- [x] Meta-command handling:
  - [x] `!!SIGINT` → send SIGINT to target
  - [x] `!!RESET` → reset via gdb-server monitor command
  - [x] `!!AI-REQUEST: <text>` → post to AI-REQUEST region (TUI) or tag on mux stream
  - [x] `!!AI-REQUEST-CLEAR` → post to (TUI) to clear the AI-REQUEST area
  - [x] `!!NOTE: <json-patch>` → patch session-notes sidecar file
- [x] Attacher disconnect: clean, does not kill session
- [x] Session teardown: gdb-server killed, GDB exited, socket removed, Rust bootstrap exits

---

### Phase 7 — `mcu-debug attach` subcommand (Rust)

Late-attacher path for AI (Mode 1 via subprocess) and hybrid mode (Mode 3).

- [ ] Auto-discover session: `.mcu-debug/socket.json` (well-known path)
- [ ] Explicit: `--socket /tmp/mcu-debug-<pid>.sock`
- [ ] List: `mcu-debug list` — enumerate active sessions
- [ ] Connect, receive snapshot, stream live — mux to stdout, commands from stdin
- [ ] Exit cleanly on disconnect without killing the session

---

### Phase 8 — Refactoring: extract `common/` (TypeScript)

The mechanical refactor that makes both VS Code and CLI share the same underlying code.
Can proceed in parallel with phases above once the `common/` structure is defined.

- [x] Create `src/common/` with `tsconfig.common.json` (excludes `@types/vscode` only —
      `@vscode/debugprotocol` and `@vscode/debugadapter` are plain npm packages and ARE allowed)
- [x] Define `IHostAdapter` interface in `common/host-adapter.ts`
      (`getWorkspaceFolder`, `getSetting`, `showError`, `showWarning` — config resolution only)
- [x] Extract bulk of `frontend/configprovider.ts` → `common/config-provider.ts`
      (envFile, variable substitution, validation, defaults — all pure logic, no vscode deps)
- [x] Implement `VscodeAdapter` in `frontend/vscode-adapter.ts`
- [x] Implement `CliAdapter` in `cli/cli-adapter.ts`
      (reads `mcu-debug-settings.json`, workspaceFolder = dir containing launch.json)
- [x] Thin down `frontend/configprovider.ts` to: create VscodeAdapter, delegate to
      common/ConfigProvider — VS Code lifecycle hooks stay, logic moves out
- [x] Move `frontend/swo/` → `common/swo/` (decoders + sources — no vscode deps)
- [x] Move `frontend/serial.ts` → `common/serial/`
- [x] Move `frontend/ansi-helpers.ts` → `common/`
- [x] Extract non-vscode utils from `frontend/utils.ts` → `common/utils.ts`
- [x] Update `frontend/` imports to use `common/` for moved files — mechanical, low risk
- [x] Update `extension.ts` imports for moved files — mechanical, minimum viable touch
- [ ] **Do not refactor `extension.ts` internals for v1** — multi-core and panel lifecycle
      stay as-is; convergence deferred until both paths are working. Refactor as you go

---

### Packaging

See [cli-architecture.md §8](./cli-architecture.md) for full design rationale and wrapper code.

- [x] `mcu-debug-cli.js` bundled via existing esbuild pipeline (single file, no node_modules)
- [ ] Extension activation writes `~/.mcu-debug/config.json` → `{ extensionPath, version }`
      (stable pointer — recreated on every activation, absorbs version-path churn)
- [ ] npm package (`mcu-debug` on npmjs.com) is a thin JS wrapper only — no binaries bundled
      Reads `config.json`, sets `MCU_DEBUG_NODE` + `MCU_DEBUG_CLI_JS`, spawns Rust binary
      Errors clearly with marketplace URL if extension not installed (Option 1 — no fallback)
- [x] Node.js >= 22 check in Rust bootstrap (GH Copilot CLI confirmed >= 22; Claude CLI >= 22)
- [ ] Distribution: `npx mcu-debug` for AI/CI use; `npm install -g` for terminal users;
      VS Code extension path unchanged — all assets in extension dir, config.json is the pointer
