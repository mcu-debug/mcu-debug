# CLI Architecture — `mcu-debug`

Design document for the standalone `mcu-debug` CLI. Covers the binary rename rationale, the DAP-client architecture, three UI modes, subcommand structure, remote probe support, and topology auto-detection.

Related: [cli-config.md](cli-config.md) (launch.json resolution), [uart-management.md](uart-management.md) (UART/serial), [AI-Angle.md](AI-Angle.md) (AI integration, deployment modes), [Proxy-Plan.md](Proxy-Plan.md) (Funnel Protocol, remote topologies).

---

## 1. Binary Rename: `mcu-debug-helper` → `mcu-debug`

The original name reflected the binary's original role: a helper subprocess to the TypeScript Debug Adapter. It parsed ELF files and handled disassembly on behalf of the TS side.

That role has expanded beyond recognition:

- Probe Agent (`proxy` subcommand) — manages gdb-server lifecycle, Funnel Protocol server, serial ports, ring buffers
- DA helper (`da-helper` subcommand) — ELF/symbol/disassembly, still called by TS DA
- **CLI debugger** (`debug` subcommand, new) — direct GDB, TUI, mux stream, session attach

"Helper" undersells it. `mcu-debug` *is* the debugger. The VS Code extension is the face; `mcu-debug` is the muscle — and now it gets to work standalone.

### Rename mechanics

- `Cargo.toml`: `[[bin]] name = "mcu-debug"` — one line
- Package directory `packages/mcu-debug-helper/` — keep as-is (internal, not user-facing)
- Pre-built binaries: `packages/mcu-debug/bin/mcu-debug`, `packages/mcu-debug-proxy/bin/mcu-debug` — no collision; the extension *contains* the binary
- TS DA invocation: `mcu-debug da-helper ...` instead of `mcu-debug-helper da-helper ...`
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

| Adapter | Used by | Behaviour |
|---|---|---|
| `VscodeAdapter` | VS Code entry point (existing) | Calls `vscode.window.*`, `vscode.workspace.*` — identical to today |
| `CliAdapter` | CLI Driver entry point (new) | Writes errors/info to the mux stream; config arrives pre-resolved in the launch request — no lookup needed |

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

| Mode | When | What runs |
|---|---|---|
| **VS Code Cockpit** | Running inside VS Code (extension handles this path) | WebviewPanel + xterm.js Glass Cockpit — see AI-Angle.md §6 |
| **Rust TUI** | `stdout` is a TTY, running standalone in a terminal | `ratatui` — three-region layout: live mux output / AI-REQUEST / input line |
| **Dummy / headless** | `stdout` is not a TTY (AI subprocess, CI/CD, pipe) | No terminal manipulation; mux stream written raw to stdout |

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

`mcu-debug debug` is new. Resolves the launch config (cli-config.md), spawns the TS DA as a subprocess, acts as its DAP client, detects TTY/headless, starts the appropriate UI, and manages the session socket for potential attachers.

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

| Factor | Assessment |
|---|---|
| TS Funnel client is DAP-shaped | Code is intertwined with TS DA session lifecycle; extracting cleanly is more surgery than rewrite |
| No Node.js on lab servers / CI agents | Single binary with zero runtime deps is a hard requirement for those environments |
| Server side already Rust | Having both sides of the Funnel in the same language is natural |
| Protocol is simple | The framing is 50 lines. The state machine is ~200. Not a research project |
| TS DA keeps its own client | VS Code path is unaffected — TS client stays, continues to work, no regressions |

---

## 6. Topology Auto-Detection

In the VS Code extension, `vscode.env.remoteName` was the single API call that revealed the entire topology:

| `remoteName` value | Meaning | Probe location | Transport |
|---|---|---|---|
| `undefined` | Running locally | Same machine | No proxy, or local proxy |
| `"wsl"` | Running in WSL | Windows host | Proxy on Windows host |
| `"dev-container"` / `"attached-container"` | Docker container | Docker host | Proxy on host |
| `"ssh-remote"` | VS Code Remote SSH | Local machine (user's laptop) | Funnel via SSH tunnel |

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

| Detected topology | `remoteConfig: auto` behaviour |
|---|---|
| `Local` | No proxy; GDB connects directly to gdb-server ports |
| `Wsl { mirrored }` | Probe Agent expected on Windows host at `127.0.0.1`; auto-start via `wsl.exe` interop or require pre-running |
| `Wsl { nat }` | Same but use gateway IP instead of 127.0.0.1 |
| `Docker` | Probe Agent expected on Docker host at `host.docker.internal` or gateway IP |
| `SshServer` | Probe is locally attached to this machine; no proxy needed; `Local` behaviour |

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
- The TS DA's existing `mcu-debug-helper` subprocess model extends naturally — same binary, new subcommand

The interface is the same discovery-JSON-on-stdout pattern already used in the proxy launch flow (ARCHITECTURE.md). The heartbeat is stdin-based, matching the existing proxy heartbeat in `proxy_helper/run.rs`.

This is not a v1 concern — the TS Funnel client works and is tested across all topologies. But once the Rust client is proven via the CLI, the consolidation is low-risk and the direction is clear.

---

## 8. Packaging and Distribution

> **Status: TBD / pending verification.** Strategy is directionally agreed; exact packaging mechanism needs validation before implementation.

### Node.js prerequisite

The CLI controller (DAP client) is a Node.js program. Node.js is a documented prerequisite.

**Why this is acceptable for v1:**
- GitHub Copilot CLI requires Node.js already — confirmed
- Claude CLI Node.js requirement — *TBD, needs verification*
- The primary v1 use case is as an AI skill/tool (Copilot CLI, Claude CLI); both audiences are developers with Node.js likely already present
- Trivial to document: "install Node.js 20+ from nodejs.org"

### Invocation model

```sh
# Preferred — always-latest, no pre-install required
npx mcu-debug debug

# Or installed globally
npm install -g mcu-debug
mcu-debug debug
```

`npx` is the natural fit for AI skill definitions. The SKILL.md or tool manifest references `npx mcu-debug` and the AI executes it directly. npx handles download and caching; the AI does not need to manage installation.

### npm package structure

The npm package is not pure JS — it also needs the platform-specific Rust binary (`mcu-debug` — proxy, da-helper, TUI). This is a solved pattern in the ecosystem (esbuild, biome, Rollup all do this):

```
mcu-debug (npm)                  ← JS CLI controller + package.json bin entry
  optionalDependencies:
    mcu-debug-linux-x64          ← contains pre-built Rust binary for linux/x64
    mcu-debug-darwin-arm64       ← contains pre-built Rust binary for mac/arm64
    mcu-debug-win32-x64          ← contains pre-built Rust binary for win/x64
    ...
```

npm installs only the optional dep matching the current platform. The JS wrapper locates the binary at a well-known relative path inside the installed optional package. The pre-built binaries already exist (currently checked in under `packages/mcu-debug/bin/`) — this is a repackaging of what already ships in the VS Code extension.

### Rust binary discovery (fallback chain)

When the CLI controller needs to invoke the Rust binary, it searches in order:

1. **npm optional dep** — `node_modules/mcu-debug-<platform>/bin/mcu-debug` (standard npm install path)
2. **`~/.mcu-debug/bin/`** — explicit user install, or placed there by the VS Code extension
3. **`PATH`** — if user has installed manually
4. **VS Code extension install** — `~/.vscode/extensions/mcu-debug.mcu-debug-*/bin/mcu-debug` (glob on version) — *wonky but useful as a last resort for users who have the extension but installed the CLI separately*
5. → Error with clear message: "mcu-debug binary not found — run `npm install -g mcu-debug` or install the VS Code extension"

The VS Code extension path (step 4) is intentionally last. The path format is unstable (version-stamped, platform-specific locations vary between VS Code and VS Code Insiders and Cursor), but it is a genuine escape hatch for users who have the extension installed and are trying out the CLI without a full npm install.

### What the VS Code extension does

No changes needed for the extension's own operation — it continues to use its own bundled binary from `packages/mcu-debug/bin/`. The npm packaging is a parallel distribution channel, not a replacement.

The extension could optionally write the binary to `~/.mcu-debug/bin/` on activation, making it available to the CLI fallback chain (step 2 above) without any npm install. Simple, reliable, no path-guessing needed.

---

## 9. What the CLI Does Not Have

| Missing vs VS Code | Reason / mitigation |
|---|---|
| VS Code as DAP client | Replaced by `mcu-debug debug` acting as DAP client (§2) |
| `vscode.env.remoteName` | Replaced by OS-level detection (§6) |
| VS Code settings store | Replaced by `mcu-debug-settings.json` + `envFile` (see cli-config.md) |
| Workspace state (Memento) | UART config and session state from `launch.json` + `~/.mcu-debug/` |
| Auto-start Probe Agent on probe host | v1: require pre-running for WSL/Docker; SSH auto-deploy for LAB |
| Webview / xterm.js Cockpit | Replaced by ratatui TUI (Mode 2) or headless stream (Mode 1) |
| Zero-install single binary | Node.js prerequisite; npx covers most cases (see §8) |
| Extension marketplace updates | Distributed as a standalone binary; updated independently |
