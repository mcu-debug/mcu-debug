# MCU Debug — AI Agent Context

This file captures architectural facts that are not obvious from reading the code alone. Read this before making changes to the debug adapter, proxy, or RTT subsystems.

---

## Key Reference Documents

| Document                                                       | What it covers                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [docs-internal/Proxy-Plan.md](docs-internal/Proxy-Plan.md)     | Definitive topology for remote probe support — two scenarios, terminology, Funnel Protocol                        |
| [docs-internal/ARCHITECTURE.md](docs-internal/ARCHITECTURE.md) | High-level architecture; may have drifted from current implementation in details, but the overall arch is correct |
| [docs/rtt.md](docs/rtt.md)                                     | RTT implementation — this project's approach is a superset of the standard gdb-server model                       |

---

## Critical: Terminology Inversion

**VS Code's "Local" / "Remote" terminology is inverted relative to the intuitive meaning in this project.**

- VS Code calls the machine with the USB probe **"Local"** (the UI side).
- VS Code calls the machine running the extension's workspace (WSL / container / SSH) **"Remote"**.
- The `mcu-debug` UI extension runs on the **VS Code Local** side (probe host).
- The Debug Adapter (DA) and GDB run on the **VS Code Remote** side (workspace / engineer's source).

When the Proxy-Plan.md says "Engineer Machine" and "Probe Host", use those terms — they are unambiguous. Do not use "local" or "remote" without qualifying which convention you mean.

---

## Debug Adapter is Three Components, Not One

The debug adapter is **not** a single TypeScript process. It has three cooperating parts:

1. **TypeScript DA** (`packages/mcu-debug/src/adapter/`) — The DAP server. Talks to VS Code, manages sessions, orchestrates GDB via stdio.

2. **`da_helper`** (Rust, `packages/mcu-debug-helper/src/da_helper/`) — A Rust binary invoked by the TS DA as a subprocess. Responsible for ELF parsing, symbol table lookup, and disassembly (via objdump + Capstone). The TS side does **not** parse ELF directly. Any feature that requires symbol information goes through this helper.

3. **Proxy client** (`packages/mcu-debug-helper/src/proxy_helper/`) — Also Rust. Implements the client side of the Funnel Protocol for reaching a Probe Agent on a remote/host machine. Used when the probe is not accessible directly from the DA process (WSL, Dev Container, or LAB topology).

The `mcu-debug-helper` binary is a single Rust binary with subcommands (`da-helper`, `proxy`, …). Do not assume these are separate binaries.

---

## Remote Probe Topologies

There are two distinct scenarios. See [Proxy-Plan.md](docs-internal/Proxy-Plan.md) for full detail.

**Topology A — VS Code Remote (WSL / Dev Container)**
- DA runs inside WSL or a container; probe is on the host machine.
- The `mcu-debug` **UI extension** (not the DA) runs on the host and spawns the Probe Agent.
- DA reaches the Probe Agent via `127.0.0.1` (WSL mirrored mode) or `host.docker.internal`.
- This is the `type: "auto"` case in config.

**Topology B — LAB (physically separate machine)**
- DA and all tooling run on the engineer's machine; probe is on a lab server.
- An SSH tunnel (`ssh -L`) is established by the UI extension.
- The DA sees "ghost ports" on `127.0.0.1` that tunnel through to the lab server's Probe Agent.
- No inbound firewall rules are needed on the lab server.

**Probe Agent** (`mcu-debug-helper proxy`) always runs on the machine physically attached to the probe. It manages gdb-server lifecycle and implements the Funnel Protocol.

---

## RTT: Two Modes

This project supports RTT in two ways. Most other debuggers only support the first.

**Standard mode (gdb-server TCP)**
- gdb-server (OpenOCD, JLink, etc.) handles RTT polling and exposes TCP ports.
- Limitations: JLink allows only one channel; OpenOCD requires manual polling or a breakpoint to start RTT.

**Alternate mode (GDB memory I/O)**
- The DA uses GDB to directly read/write the RTT control block in target memory.
- Bypasses the gdb-server for RTT data entirely.
- Supports up to 16 bidirectional RTT channels.
- Has an optional per-channel **pre-decoder** pipeline (e.g., `defmt-print` for Rust's defmt format).
- Performance bottleneck is the SWD interface, not the memory I/O round-trip; polling at 40 Hz is practical.

When making changes that touch RTT, determine which mode is in play. Do not assume the gdb-server TCP path is the only one.

---

## Variable Streaming (Push Model)

This debugger has a **push/subscription model for variable values** that is not present in standard DAP. Clients (webviews, external tools) can subscribe to named variables and receive streaming updates rather than polling. This is used for the graphing/live watch features. This is distinct from the standard DAP `variables` request flow and runs on a separate internal channel.

---

## Package Structure

```text
packages/
  mcu-debug/            # VS Code extension (TypeScript) — DAP server + UI
  mcu-debug-helper/     # Rust binary — da_helper + proxy_helper subcommands
  mcu-debug-proxy/      # Proxy-related extension packaging
  shared/               # Shared TypeScript types and protocol definitions
  shared/proxy-protocol # GENERATED files by ts_rs. DO NOT EDIT
  shared/serial-helper  # GENERATED files by ts_rs. DO NOT EDIT
  shared/dasm-helper    # GENERATED files by ts_rs. DO NOT EDIT
```

Some directories in the `packages/shared` dir. are generated files and the script `scripts/build-binaries.sh` contains the code to generate and prettify them

The `mcu-debug-helper` binary is pre-built and checked in under `packages/mcu-debug/bin/` and `packages/mcu-debug-proxy/bin` for each platform. It is also built locally via the `Build Helper` task.

## Building

| What                   | command                          |
| ---------------------- | -------------------------------- |
| Rust only build (dev)  | ./scripts/build-binaries.sh dev  |
| Compile all (dev)      | npm run compile                  |
| Rust only build (prod) | ./scripts/build-binaries.sh prod |
| Compile all (prod)     | npm run package                  |

prod - production builds builds all OSes and archictures (optimized and stripped)
dev  - development builds builds just the current OS+arch for

**How to apply:** When Rust structs change, regenerate the generated TS files with:

```bash
  cd packages/mcu-debug-helper && cargo test --lib da_helper::helper_requests::tests::ensure_ts_exports --quiet
  cd packages/mcu-debug-helper && cargo test --lib proxy_helper::proxy_server::tests::ensure_ts_exports --quiet
```

Or do a full dev build: `./scripts/build-binaries.sh dev` -- this is fast in most cases

See if the expected files in the `packages/shared/{proxy-protocol,serial-helper,dasm-helper)` dirs have newer timestamps
