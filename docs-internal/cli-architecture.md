# CLI Architecture — `mcu-debug`

Design document for the standalone `mcu-debug` CLI. Covers the binary rename rationale, the new-entry-point architecture, three UI modes, subcommand structure, remote probe support, topology auto-detection, and packaging.

Related: [cli-config.md](cli-config.md) (launch.json resolution), [uart-management.md](uart-management.md) (UART/serial), [AI-Angle.md](AI-Angle.md) (AI integration, deployment modes), [Proxy-Plan.md](Proxy-Plan.md) (Funnel Protocol, remote topologies).

---

## 1. Binary Rename: `mdbg` → `mcu-debug`

The original name reflected the binary's original role: a helper subprocess to the TypeScript Debug Adapter. It parsed ELF files and handled disassembly on behalf of the TS side.

That role has expanded beyond recognition:

- Probe Agent (`proxy` subcommand) — manages gdb-server lifecycle, Funnel Protocol server, serial ports, ring buffers
- DA helper (`da-helper` subcommand) — ELF/symbol/disassembly, still called by TS DA
- **CLI debugger** (`debug` subcommand, new) — direct GDB, TUI, mux stream, session attach

"Helper" undersells it. `mcu-debug` *is* the debugger. The VS Code extension is the face; `mcu-debug` is the muscle — and now it gets to work standalone.

### Rename mechanics

- `Cargo.toml`: `[[bin]] name = "mcu-debug"` — one line
- Package directory `packages/mdbg/` — keep as-is (internal, not user-facing)
- Pre-built binaries: `packages/mcu-debug/bin/mcu-debug`, `packages/mcu-debug-proxy/bin/mcu-debug` — no collision; the extension *contains* the binary
- TS DA invocation: `mcu-debug da-helper ...` instead of `mdbg da-helper ...`
- Update AGENTS.md, any other docs that reference the binary name

---

## 2. Architecture: New Entry Point, Not a Rewrite

### The key insight

The DA code is not being replaced — it is getting a **second entry point**. VS Code drives it today via DAP. The CLI drives it directly, in-process, through a new **Driver** that calls the same session logic without any protocol overhead.

```
VS Code today:
  VS Code ↔ [DAP/stdio] ↔ DA entry point (DAP server)
                               └─ session logic: GDB, gdb-servers, RTT/SWO/UART

CLI tomorrow (same Node.js process, new entry point):
  CLI Driver entry point
      └─ session logic: GDB, gdb-servers, RTT/SWO/UART   ← identical, untouched
```

No separate process. No DAP framing between a client and server. Direct in-process function calls. The session logic — every gdb-server controller, GDB MI handling, RTT/SWO/UART, session lifecycle — runs exactly as it does today, just driven by a different caller.

### The refactoring: adapter pattern for `vscode.*` calls

The DA currently calls `vscode.*` APIs directly for UI and config:

```typescript
vscode.window.showErrorMessage("GDB crashed");
vscode.workspace.getConfiguration("mcu-debug").get("armToolchainPath");
```

These get extracted behind an `IHostAdapter` interface:

```typescript
interface IHostAdapter {
    showError(msg: string): void;
    showInfo(msg: string): void;
    getConfig<T>(key: string): T | undefined;
    // ... similarly for other vscode.* calls in the DA
}
```

Two implementations:

| Adapter         | Used by                        | Behaviour                                                                                                  |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `VscodeAdapter` | VS Code entry point (existing) | Calls `vscode.window.*`, `vscode.workspace.*` — identical to today                                         |
| `CliAdapter`    | CLI Driver entry point (new)   | Writes errors/info to the mux stream; config arrives pre-resolved in the launch request — no lookup needed |

The `vscode.*` calls in the DA are mostly notification/UI calls. The session logic — GDB, gdb-server controllers, RTT/SWO/UART — does not touch VS Code APIs. The refactoring scope is bounded.

### The CLI Driver entry point

A new `src/cli-driver.ts` (or equivalent). Called by the Node.js process when launched by the Rust bootstrap in CLI mode. Responsibilities:

1. Receive the fully-resolved launch config (passed from Rust via the TCP channel — already variable-substituted per [cli-config.md](cli-config.md))
2. Instantiate the session with `CliAdapter`
3. Start the session: gdb-server, GDB, RTT/SWO/UART — same sequence as the DAP `launch` handler, called directly
4. Expose the mux stream over the TCP channel to the Rust process (TUI or headless relay)
5. Accept commands from Rust (GDB input, meta-commands) and forward to GDB
6. Create the session socket (`~/.mcu-debug/current.sock`) for late attachers

### Process model

```
mcu-debug debug  (Rust binary)
  │
  ├─ checks Node >= 22
  ├─ spawns: node cli-controller.js --port <tcp-port>   (bundled JS, sibling to binary)
  │    └─ CLI Driver starts session (in-process, direct calls)
  │         ├─ GDB, gdb-server, RTT/SWO/UART
  │         ├─ mux stream → TCP port → Rust
  │         └─ session socket: ~/.mcu-debug/current.sock
  │
  ├─ [if TTY]     starts ratatui TUI, connects to Node via TCP port
  └─ [if no TTY]  spawns Node with inherited stdio, waits, forwards exit code
                  AI reads the mux stream directly from Node's stdout
                  (Unix: can exec-replace for true process substitution;
                   Windows: spawn-and-wait is equivalent from outside)
```

In headless mode Rust spawns Node with inherited stdio and waits, forwarding the exit code. The AI subprocess sees a clean stream. No TCP port, no TUI code runs. On Unix, `exec` can replace the process entirely (true process substitution); on Windows, spawn-and-wait is the equivalent and behaves identically from the outside — a thin waiting Rust process in the tree costs nothing.

### The TCP channel (Rust TUI ↔ Node)

This is the same session socket protocol used for `mcu-debug attach` (AI-Angle.md §9 Mode 3). The Rust TUI is just the first attacher. The protocol:

- **Node → Rust:** tagged mux stream frames (same `[GDB]`, `[RTT#0]`, `[UART:ttyUSB0]` format)
- **Rust → Node:** user input from TUI (GDB commands, meta-commands like `!!SIGINT`)

One protocol, two consumers (TUI attacher, AI attacher). Defining it once unlocks both.

---

## 3. Three UI Modes

The same `mcu-debug debug` session engine supports three presentation modes. Mode is auto-detected from the environment; no flag needed in the common cases. See [AI-Angle.md §9](AI-Angle.md) for the full deployment mode descriptions.

| Mode                 | When                                                 | What runs                                                                  |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| **VS Code Cockpit**  | Running inside VS Code (extension handles this path) | WebviewPanel + xterm.js Glass Cockpit — see AI-Angle.md §6                 |
| **Rust TUI**         | `stdout` is a TTY, running standalone in a terminal  | `ratatui` — three-region layout: live mux output / AI-REQUEST / input line |
| **Dummy / headless** | `stdout` is not a TTY (AI subprocess, CI/CD, pipe)   | No terminal manipulation; mux stream written raw to stdout                 |

The dummy mode is **real and required**. When an AI (Claude, Copilot, etc.) spawns `mcu-debug debug` as a subprocess, stdout is not a TTY. The binary must detect this and run silently with zero terminal manipulation — no escape codes, no cursor movement, no ratatui. The AI's parent TUI is never disturbed. The mux stream on stdout is all the AI needs.

TTY detection:
```rust
let headless = !std::io::stdout().is_terminal();
```

The ratatui TUI and the dummy mode are both implemented in the Rust `mcu-debug` binary. The TS DA is the session engine in all three modes — it doesn't know or care which UI is consuming its output events.

---

## 4. Subcommand Structure

```
mcu-debug proxy        ← Probe Agent: gdb-server lifecycle, Funnel Protocol server, serial ports
mcu-debug da-helper    ← ELF/symbol/disassembly helper (called by TS DA — interface unchanged)
mcu-debug debug        ← DAP client: drives TS DA, presents TUI or headless mux stream
mcu-debug attach       ← Attach to a running session socket (~/.mcu-debug/current.sock)
mcu-debug dump-config  ← Resolve and print a launch.json config (see cli-config.md)
```

`mcu-debug proxy` and `mcu-debug da-helper` are existing functionality, binary rename only.

`mcu-debug debug` is new. Resolves the launch config (cli-config.md), spawns Node with `cli-controller.js` (the CLI Driver entry point), detects TTY/headless, starts the appropriate UI, and manages the session socket for potential attachers (§2).

`mcu-debug attach` joins an existing session — the human+AI hybrid path (AI-Angle.md §9 Mode 3).

---

## 5. Remote Probe Support — Funnel Protocol Client in Rust

The VS Code extension's TypeScript side contains the Funnel Protocol **client**: SSH tunnel management, proxy deploy-and-probe, stream multiplexing. That code is not reusable in a pure Rust CLI — it's tightly coupled to VS Code APIs and Node.js.

For the CLI, the Funnel Protocol client is **reimplemented in Rust**, as a new module in the same `mcu-debug` binary. The protocol is fully specified in [ARCHITECTURE.md](ARCHITECTURE.md) and [Proxy-Plan.md](Proxy-Plan.md):

- 5-byte binary framing: `[stream_id: u8][payload_len: u32_le][payload: bytes]`
- Stream 0: JSON-RPC control channel
- Streams 1+: raw binary (GDB RSP, RTT, SWO, serial)

The framing is simple. The complexity is in the **connection lifecycle** — probe, deploy, tunnel, heartbeat. That logic is well-documented and reimplementable. Estimated ~600 lines of Rust including tests.

### Why reimplement rather than reuse

| Factor                                | Assessment                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| TS Funnel client is DAP-shaped        | Code is intertwined with TS DA session lifecycle; extracting cleanly is more surgery than rewrite |
| No Node.js on lab servers / CI agents | Single binary with zero runtime deps is a hard requirement for those environments                 |
| Server side already Rust              | Having both sides of the Funnel in the same language is natural                                   |
| Protocol is simple                    | The framing is 50 lines. The state machine is ~200. Not a research project                        |
| TS DA keeps its own client            | VS Code path is unaffected — TS client stays, continues to work, no regressions                   |

---

## 6. Topology Auto-Detection

In the VS Code extension, `vscode.env.remoteName` was the single API call that revealed the entire topology:

| `remoteName` value                         | Meaning            | Probe location                | Transport                |
| ------------------------------------------ | ------------------ | ----------------------------- | ------------------------ |
| `undefined`                                | Running locally    | Same machine                  | No proxy, or local proxy |
| `"wsl"`                                    | Running in WSL     | Windows host                  | Proxy on Windows host    |
| `"dev-container"` / `"attached-container"` | Docker container   | Docker host                   | Proxy on host            |
| `"ssh-remote"`                             | VS Code Remote SSH | Local machine (user's laptop) | Funnel via SSH tunnel    |

From that one value, `remoteConfig: { type: "auto" }` in launch.json just worked — near-zero questions to the user.

The CLI has no `vscode.env.remoteName`. It must detect the same topologies from OS-level signals.

### Detection signals, by environment

#### WSL

```
Environment variable:   WSL_DISTRO_NAME          (set by WSL, always present)
Networking mode:        wslinfo --networking-mode → "mirrored" | "nat"
  Mirrored:   Windows host reachable via 127.0.0.1
  NAT:        Windows host IP from /proc/net/route (default gateway)
              or /etc/resolv.conf nameserver line
Fallback:     /proc/version contains "microsoft" or "WSL"
```

#### Docker container

```
Primary signal:   /.dockerenv file exists
Secondary:        /proc/1/cgroup contains "docker" or "containerd"
Host address:
  Docker Desktop (Mac/Win):  host.docker.internal resolves
  Linux Docker:              default gateway from `ip route show default`
                             or /proc/net/route
Kubernetes:       KUBERNETES_SERVICE_HOST env var (treat host as explicit config)
```

#### Native SSH session (into a remote machine, probe locally attached to that machine)

```
SSH_CLIENT env var:    set when the process was started via SSH
                       format: "<client_ip> <client_port> <server_port>"
Implication:          mcu-debug is running on the SSH server; probe may be there too
                      (LAB topology: probe physically attached to the lab server)
Note:                 if probe IS local to the SSH server, no proxy needed
                      if probe is somewhere else, it must be explicit in launch.json
```

#### Nothing matched → local

No WSL, no Docker, no SSH. Probe is assumed local. No Funnel needed. Proxy runs on localhost (or not at all if probe ports are directly accessible to GDB).

### Detection algorithm

```rust
pub enum DetectedTopology {
    Local,
    Wsl { networking_mode: WslNetworkingMode, host_ip: IpAddr },
    Docker { host_addr: HostAddr },   // HostAddr = Dns("host.docker.internal") | Ip(...)
    SshServer { client_ip: IpAddr },  // mcu-debug is running on the SSH server end
}

fn detect_topology() -> DetectedTopology {
    if let Some(_) = env::var_os("WSL_DISTRO_NAME") {
        return DetectedTopology::Wsl { ... };
    }
    if Path::new("/.dockerenv").exists() {
        return DetectedTopology::Docker { ... };
    }
    if let Some(_) = env::var_os("SSH_CLIENT") {
        return DetectedTopology::SshServer { ... };
    }
    DetectedTopology::Local
}
```

### Mapping topology → proxy strategy

| Detected topology  | `remoteConfig: auto` behaviour                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `Local`            | No proxy; GDB connects directly to gdb-server ports                                                          |
| `Wsl { mirrored }` | Probe Agent expected on Windows host at `127.0.0.1`; auto-start via `wsl.exe` interop or require pre-running |
| `Wsl { nat }`      | Same but use gateway IP instead of 127.0.0.1                                                                 |
| `Docker`           | Probe Agent expected on Docker host at `host.docker.internal` or gateway IP                                  |
| `SshServer`        | Probe is locally attached to this machine; no proxy needed; `Local` behaviour                                |

### The "auto-start" question

In VS Code, the UI extension (running on the probe host) could auto-spawn the Probe Agent — the extension had a privileged position on both sides of the split.

In the CLI, there is no UI extension on the host side. Options:

1. **Require pre-running proxy** (simplest): user runs `mcu-debug proxy` on the Windows host / Docker host once. systemd/launchd/Task Scheduler makes it persistent. The CLI finds it.
2. **Auto-start via interop** (WSL only): WSL can invoke Windows executables directly (`/mnt/c/...mcu-debug.exe proxy`). Feasible but fiddly.
3. **SSH auto-deploy** (LAB topology): CLI SSHes to the probe host, checks/deploys the binary, starts the proxy, sets up tunnel — exactly the flow in ARCHITECTURE.md §Phase 3. Works for any topology where SSH access to the probe host exists.

For v1: require pre-running proxy for WSL/Docker; SSH auto-deploy for LAB (explicit `remoteConfig.host` in launch.json). "Auto" means auto-detect the address and transport, not auto-start the remote process. Document clearly.

### `remoteConfig` in launch.json (CLI)

Mirrors the VS Code behaviour:

```jsonc
// Auto-detect everything (default if omitted for local, explicit for remote)
"remoteConfig": { "type": "auto" }

// Explicit LAB host — SSH auto-deploy flow
"remoteConfig": {
  "type": "ssh",
  "host": "lab-server",          // SSH alias from ~/.ssh/config
  "syncFiles": ["*.cfg"]         // workspace files to stage on host
}

// Explicit address — probe agent already running (WSL/Docker pre-started)
"remoteConfig": {
  "type": "direct",
  "address": "127.0.0.1",        // or host.docker.internal
  "port": 7777
}
```

`type: "auto"` runs the detection algorithm above and picks the right strategy. If detection is ambiguous (e.g. SSH_CLIENT is set but probe is local), `auto` falls back to `local` — the safe default.

---

## 7. Future: Eliminating the TS Proxy Client

Once the Rust Funnel client exists for the CLI, there is a natural path to removing the TypeScript Funnel client from the VS Code DA entirely.

The mechanism: `mcu-debug tunnel` subcommand (or a mode of `mcu-debug proxy-connect`). The TS DA spawns it as a subprocess, passes it the `remoteConfig` parameters, and the Rust binary handles everything — SSH tunnel, deploy-and-probe, Funnel framing, heartbeat. It prints a discovery JSON to stdout with the local TCP port mappings for each channel (GDB RSP, RTT, SWO, serial), then stays running.

```
TS DA spawns:  mcu-debug tunnel --host lab-server --gdb-port 0 --rtt-port 0 ...
Rust prints:   { "gdb": 54321, "rtt_0": 54322, "swo": 54323, ... }
TS DA reads:   connects to 127.0.0.1:54321 for GDB, etc.
```

From that point, the TS DA is **topology-agnostic** — it always sees `127.0.0.1:PORT`, whether the probe is local, WSL, Docker, or a lab server on the other side of the planet. The tunnel subprocess owns all the remote complexity.

Benefits:
- Funnel Protocol client lives in **one place** (Rust), not two (Rust + TS)
- TS proxy-client code deleted — meaningful reduction in TS DA surface area
- Bug fixes and topology improvements (new WSL modes, new Docker variants) benefit both CLI and VS Code in one change
- The TS DA's existing `mdbg` subprocess model extends naturally — same binary, new subcommand

The interface is the same discovery-JSON-on-stdout pattern already used in the proxy launch flow (ARCHITECTURE.md). The heartbeat is stdin-based, matching the existing proxy heartbeat in `proxy_helper/run.rs`.

This is not a v1 concern — the TS Funnel client works and is tested across all topologies. But once the Rust client is proven via the CLI, the consolidation is low-risk and the direction is clear.

---

## 8. Packaging and Distribution

### Design principle: single source of truth

All CLI assets — the Rust binary, `cli-controller.js`, SVD files, server scripts, every bundled resource — live in **one place**: the VS Code extension directory. The extension is already installed, already versioned, already updated by the marketplace. There is no second copy to drift out of sync.

The npm package (`mcu-debug` on npmjs.com) is a **thin locator wrapper only**. It contains no binaries, no JS bundles. Its entire job is to find the assets that the extension already put on disk and hand off to them.

### How the extension advertises itself

On every activation, the VS Code extension writes a small JSON file to a well-known stable location:

```
~/.mcu-debug/config.json
```

```jsonc
{
  "extensionPath": "/Users/hdm/.vscode/extensions/mcu-debug-1.4.2",
  "version": "1.4.2"
}
```

This file is the stable pointer. It is recreated every time VS Code activates the extension, so it always reflects the current installation. The path to the extension directory changes with every version update; `config.json` absorbs that churn invisibly.

### The npx wrapper

The npm package contains a single JS file — the wrapper entry point. No platform binaries, no large bundles. It installs in milliseconds with `npx mcu-debug` or `npm install -g mcu-debug`.

What it does:

```javascript
#!/usr/bin/env node
// packages/mcu-debug-npm/index.js  (~15 lines, the entire npm package)
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

const configPath = join(homedir(), ".mcu-debug", "config.json");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  console.error(
    "mcu-debug: VS Code extension not found.\n" +
    "Install the mcu-debug extension from the VS Code marketplace first:\n" +
    "  https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug\n" +
    "Then re-run this command."
  );
  process.exit(1);
}

const bin = join(config.extensionPath, "bin", "mcu-debug" + (process.platform === "win32" ? ".exe" : ""));
const result = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    MCU_DEBUG_NODE:   process.execPath,                                    // same Node binary for sub-spawns
    MCU_DEBUG_CLI_JS: join(config.extensionPath, "dist", "cli-controller.js"),
  },
});
process.exit(result.status ?? 1);
```

The two env vars it injects:

| Env var              | Value                                            | Purpose                                                                      |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `MCU_DEBUG_NODE`     | `process.execPath`                               | Rust bootstrap uses this path to spawn `cli-controller.js` — same Node binary, no PATH search |
| `MCU_DEBUG_CLI_JS`   | `<extensionPath>/dist/cli-controller.js`         | Rust bootstrap uses this path to locate the bundled Node controller          |

`process.execPath` is the key. It is the absolute path to the Node binary that is currently running the wrapper. The Rust bootstrap does not need to search PATH for `node`, deal with nvm shims, or worry about version. It uses exactly the same Node version that found the binary in the first place.

### What the Rust bootstrap does with these vars

In `mcu-debug debug`:

```rust
let node = env::var("MCU_DEBUG_NODE")
    .unwrap_or_else(|_| locate_node_on_path());   // fallback for direct invocations

let cli_js = env::var("MCU_DEBUG_CLI_JS")
    .unwrap_or_else(|_| {
        // direct invocation (extension spawning mcu-debug directly):
        // binary is at <extensionPath>/bin/mcu-debug
        // controller is at <extensionPath>/dist/cli-controller.js
        current_exe().parent().parent().join("dist/cli-controller.js")
    });
```

When invoked via the npx wrapper, both vars are set — no PATH searching, no guessing. When invoked directly by the VS Code extension (which has a known path), the fallback derives `cli-controller.js` relative to the binary location.

### Node.js prerequisite

The CLI controller (`cli-controller.js`) is a Node.js program. Node.js >= 22 is a documented prerequisite.

**Why this is acceptable:**
- The Rust bootstrap checks the version early and gives a clear error with a link to nodejs.org
- GitHub Copilot CLI requires Node.js >= 22 — confirmed
- Claude CLI recommends Node.js >= 22 — confirmed
- Primary v1 audience: developers running Copilot CLI or Claude CLI, who almost certainly have Node.js already
- `npx` itself requires Node.js — anyone who can run `npx mcu-debug` already satisfies the prerequisite

Version check in Rust bootstrap:
```rust
// Run `node --version`, parse vX.Y.Z, require X >= 22
// On failure: "Node.js 22+ is required. Download from https://nodejs.org"
```

### Distribution channels

| Channel                     | Audience                           | How they get `mcu-debug`                                     |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| **npx mcu-debug**           | AI skills (Copilot, Claude), CI/CD | `npx mcu-debug debug ...` — no install, no PATH changes      |
| **npm install -g mcu-debug**| Terminal users who want it in PATH | Standard npm global install; wrapper becomes `mcu-debug` cmd |
| **VS Code extension**       | VS Code users (existing path)      | Extension bundles the binary; no npm needed at all           |

The VS Code extension path is **completely unchanged** — it continues to invoke its own bundled binary from `packages/mcu-debug/bin/` exactly as it does today. The npm packaging is a parallel distribution channel, not a replacement.

### What lives in the extension, what lives in npm

| Asset                         | Location                                    | Found via                  |
| ----------------------------- | ------------------------------------------- | -------------------------- |
| Rust binary (`mcu-debug`)     | `<extensionPath>/bin/`                      | `config.json` → binary     |
| CLI controller (`cli-controller.js`) | `<extensionPath>/dist/`            | `MCU_DEBUG_CLI_JS` env var |
| SVD files                     | `<extensionPath>/svd/`                      | `config.json` → extensionPath |
| OpenOCD scripts, server data  | `<extensionPath>/resources/`                | `config.json` → extensionPath |
| `~/.mcu-debug/config.json`    | Written by extension on activation          | Well-known stable path     |
| npm package (`mcu-debug`)     | npmjs.com — wrapper only, no assets         | `npx` or `npm install -g`  |

The npm package version is kept in sync with the extension version. A version mismatch between the wrapper and the extension is harmless — the wrapper is stateless; only the extension assets matter.

---

## 9. What the CLI Does Not Have

| Missing vs VS Code                   | Reason / mitigation                                                   |
| ------------------------------------ | --------------------------------------------------------------------- |
| VS Code as DAP client                | Replaced by `mcu-debug debug` acting as DAP client (§2)               |
| `vscode.env.remoteName`              | Replaced by OS-level detection (§6)                                   |
| VS Code settings store               | Replaced by `mcu-debug-settings.json` + `envFile` (see cli-config.md) |
| Workspace state (Memento)            | UART config and session state from `launch.json` + `~/.mcu-debug/`    |
| Auto-start Probe Agent on probe host | v1: require pre-running for WSL/Docker; SSH auto-deploy for LAB       |
| Webview / xterm.js Cockpit           | Replaced by ratatui TUI (Mode 2) or headless stream (Mode 1)          |
| Zero-install single binary           | Node.js >= 22 prerequisite; `npx mcu-debug` covers most cases (see §8) |
| Extension marketplace updates        | Distributed as a standalone binary; updated independently             |
