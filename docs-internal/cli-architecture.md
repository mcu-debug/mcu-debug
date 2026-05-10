# CLI Architecture — `mcu-debug`

Design document for the standalone Rust CLI debugger. Covers the binary rename rationale, the no-DAP direct-GDB model, subcommand structure, remote probe support, and topology auto-detection.

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

## 2. No DAP — Direct GDB

The VS Code Debug Adapter runs a DAP server (Debug Adapter Protocol) so VS Code can talk to it. This adds a full translation layer: every VS Code concept (breakpoint, stack frame, variable) gets translated to/from GDB commands, responses are reformatted, async events are marshalled through the protocol.

**The CLI has none of this.** There is no DAP client above it. The CLI talks directly to GDB.

```
VS Code path:   VS Code ↔ [DAP] ↔ TS DA ↔ GDB ↔ [Funnel] ↔ Probe Agent ↔ gdb-server ↔ probe
CLI path:       mcu-debug ↔ GDB ↔ [Funnel] ↔ Probe Agent ↔ gdb-server ↔ probe
```

Consequences:

- **Simpler, not just different.** The DAP translation layer is significant complexity. CLI skips it entirely.
- **Full GDB power.** No translation tax. GDB scripts, watchpoints, custom commands — all available directly.
- **GDB MI or text mode — CLI chooses.** The TS DA uses GDB/MI (`-interpreter=mi2`) because MI is machine-parseable. For the CLI, where an AI or human reads the output, text mode (`-interpreter=console`) plus selective MI for specific operations may be more appropriate. TBD per use case.
- **AI has raw GDB.** This is the "Sergeant Schultz" architecture — the orchestrator passes GDB commands through without interpreting them. The AI handles dialect differences (GDB vs LLDB-MI vs whatever) directly.

---

## 3. Subcommand Structure

```
mcu-debug proxy        ← Probe Agent: gdb-server lifecycle, Funnel Protocol server, serial ports
mcu-debug da-helper    ← ELF/symbol/disassembly helper (called by TS DA — interface unchanged)
mcu-debug debug        ← CLI debugger: direct GDB, TUI, mux stream, AI-ready
mcu-debug attach       ← Attach to a running mcu-debug session (~/.mcu-debug/current.sock)
mcu-debug dump-config  ← Resolve and print a launch.json config (see cli-config.md)
```

`mcu-debug proxy` and `mcu-debug da-helper` are existing functionality, binary rename only.

`mcu-debug debug` is new. Takes a `--config` name and a `launch.json` path (defaults to `./launch.json`), resolves variables (see [cli-config.md](cli-config.md)), and starts a debug session.

`mcu-debug attach` is the session-join path for the human+AI hybrid mode (see [AI-Angle.md §9](AI-Angle.md)).

---

## 4. Remote Probe Support — Funnel Protocol Client in Rust

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

## 5. Topology Auto-Detection

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

## 6. Future: Eliminating the TS Proxy Client

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

## 7. What the CLI Does Not Have

| Missing vs VS Code | Reason / mitigation |
|---|---|
| DAP server | Not needed — direct GDB is simpler and more powerful |
| `vscode.env.remoteName` | Replaced by OS-level detection (§5) |
| VS Code settings store | Replaced by `mcu-debug-settings.json` (see cli-config.md) |
| Workspace state (Memento) | UART config and session state from `launch.json` + `~/.mcu-debug/` |
| Auto-start Probe Agent on probe host | v1: require pre-running for WSL/Docker; SSH auto-deploy for LAB |
| Webview / xterm.js | Replaced by ratatui TUI (see AI-Angle.md §10) |
| Extension marketplace updates | Distributed as a standalone binary; updated independently |
