# UART / Serial Port Management — Design

Design document for UART/serial support in `mcu-debug`. Covers lifecycle, server architecture, control channel protocol, data transport, error reporting, and UI integration.

This builds on — and reuses — the existing `mcu-debug-helper proxy` server, RTT/SWO client-side fan-out code, and per-session control channel protocol.

---

## 1. Motivation & Core Flaw

The current `mcu-debug-helper serial` implementation ([run_serial.rs](../packages/mcu-debug-helper/src/serial/run_serial.rs)) opens the serial port **only after a TCP client connects** (inside the `accept()` loop). On disconnect, the port is closed.

Consequences:

- **Early FW output is lost.** Between helper startup and the VS Code panel attaching, any data the firmware emits is silently dropped by the kernel buffer.
- **Reset banners are lost on reattach.** Every disconnect/reconnect closes and reopens the serial port — common firmware diagnostic output at boot is missed.
- **Lifecycle mismatch.** The serial port's lifecycle is tied to a single TCP client connection, not to the VS Code session where the engineer is actually debugging.

Fixing this requires two changes working together:

1. **Keep the serial port open for the program lifetime** (VS Code session, via heartbeat).
2. **Buffer incoming data so late/re-attaching clients can catch up** — a ring buffer per port.

Without (2), (1) only moves the data-loss point: bytes arrive while no client is reading, kernel buffer fills, bytes drop. The ring buffer is the keystone.

---

## 2. Lifecycle Model

UARTs are **workspace-scoped**, not debug-session-scoped. They can be opened, observed, and reconfigured at any time — including when no debug session is running. A debug session may *reference* pre-configured UARTs (auto-open them on start), but does not *own* them.

| Service type            | Lifecycle                         | Examples                      |
| ----------------------- | --------------------------------- | ----------------------------- |
| Long-lived services     | VS Code session (heartbeat-gated) | **Serial ports / UARTs**      |
| Session-scoped services | Per debug session                 | gdb-server sessions, RTT, SWO |

Both are managed by the **same** `mcu-debug-helper proxy` server. There is no separate `serial` subcommand — it does not exist and is not being introduced. The proxy is a proxy for debug sessions *and* serial ports. One binary, one subcommand, two service types.

### Why workspace-scoped

Tying UARTs to debug sessions creates friction:
- Users want to view serial output *without* debugging (sanity check, initial bring-up, bootloader interaction)
- Closing UARTs on session end loses boot output when the next session starts
- The mental model "serial is always there, debug comes and goes" matches reality

### Persistence across VS Code restarts

UART configuration (which UARTs to auto-open, their settings) is persisted via `context.workspaceState` (`Memento` API). On VS Code restart:
- The helper is respawned
- Previously-open UARTs are re-opened automatically
- The panel tabs are restored

Deliberate behavior. Users who plugged in a board, configured their UART, and closed VS Code expect to find it waiting when they reopen.

### Debug session integration

`launch.json` references UARTs by label rather than defining them inline:

```jsonc
"uartConfig": {
  "enabled": true,
  "autoOpen": ["DebugUART", "Telemetry"]   // ensure these are open on debug start
}
```

UARTs themselves are defined in workspace UI (picker + form) and stored in workspace state. `launch.json` just says "these should be live when this debug config runs."

### Program lifetime = VS Code session

The heartbeat mechanism already in [proxy_helper/run.rs:178](../packages/mcu-debug-helper/src/proxy_helper/run.rs) handles this:

- Extension spawns the helper with `--heartbeat`, sends a `\n` every 5s on stdin
- Helper has a 15s timeout watchdog on the receive side
- Stdin EOF or heartbeat timeout → graceful shutdown
- Self-connect trick unblocks the listener for clean exit

Serial ports opened during this lifetime stay open until heartbeat dies. Reset banners at boot are captured from the moment the port opens (not from first-TCP-client onward).

---

## 3. Server Architecture

### Unified proxy server

```
mcu-debug-helper proxy     ← single entry point (no `serial` subcommand exists)
  │
  ├─ Control channel        ← per-session JSON-RPC (request/response + async events)
  │
  ├─ Long-lived services
  │   └─ Serial ports       ← idempotent open, lives until program death
  │
  └─ Session-scoped services
      └─ gdb sessions       ← existing per-debug-session lifecycle
```

### Uniform client flow — one way in, one way out

Every client interaction follows the same shape, regardless of whether the request is about a debug session or a serial port:

1. **Connect** to the proxy.
2. Proxy **starts a session** for this client.
3. A **control channel is established** for that session (JSON-RPC framed on the connection).
4. Client makes requests on the control channel — `session.start_gdb`, `serial.open`, `serial.list_available`, etc.
5. **Sync responses** (`id`-matched) and **async events** (no `id`) flow back on that same control channel.

There is no separate protocol, no second connection, no alternate entry point for serial. Dispatch happens server-side based on request `method`. One code path for both service types.

### Per-port model

- **One handle per serial port path**, opened once. Never closed except on explicit `serial.close` or program shutdown.
- **Reconfiguration is in-place.** `serialport::reconfigure()` adjusts baud/parity on the open fd without closing it. TCP clients remain connected; bytes after the reconfigure simply arrive under the new settings. (User-visible consequence: garbled data if mid-stream mismatch — user's concern, not the tool's.)
- **Idempotent open.** A `serial.open` request for an already-open path returns the existing TCP port. If params differ, the server reconfigures in place and returns the same TCP port.

### Fan-out

**Client-side, not server-side.** The server bridges one serial port to one TCP endpoint. The extension reads from that TCP stream and multiplexes internally — to xterm.js, to the tee file, to any AI attacher.

This is the same code path RTT/SWO already use. No server-side broadcasting, no write-arbitration logic in the helper. The extension is the single client; it owns policy.

---

## 4. Control Channel Protocol

Everything serial-related is additional messages on the **existing per-session control channel** established at connect time (§3). No new protocol, no new connection, no new framing. Serial requests and debug-session requests are peers on the same channel.

### Requests (client → server)

```jsonc
// Open (or reuse, or reconfigure) a serial port.
// Idempotent: extension does not track state. Call whenever the port should be configured a given way.
{
  "id": 42,
  "method": "serial.open",
  "params": {
    "path": "/dev/ttyUSB0",
    "transport": "direct",              // "direct" | "funnel" — client MUST specify
    "baud_rate": 115200,
    "data_bits": 8,
    "stop_bits": "one",                 // "one" | "one_point_five" | "two"
    "parity": "none",                   // "none" | "odd" | "even"
    "flow_control": "none"              // "none" | "software" | "hardware"
  }
}

// Close a port the server is holding open.
// Rarely needed — port will close on program shutdown regardless.
{ "id": 43, "method": "serial.close", "params": { "path": "/dev/ttyUSB0" } }

// Enumerate ports the server has open (NOT system enumeration — see below).
// Used on extension restart to re-adopt existing bridges without re-requesting.
{ "id": 44, "method": "serial.list_open" }

// Enumerate available serial ports on the host (path-level, no libudev).
// Used by the UI to populate the "pick a port" dropdown when adding a new UART.
{ "id": 45, "method": "serial.list_available" }

// Query whether a specific port is currently open and get its status.
// Pull-based alternative to a server-push liveness event — the client asks,
// the server answers. Doubles as a liveness probe: if the response comes back,
// the server is alive. Consistent with the existing client-driven heartbeat model.
{ "id": 46, "method": "serial.isOpen", "params": { "path": "/dev/ttyUSB0" } }
```

### Response for `serial.list_available`

```jsonc
{
  "id": 45,
  "result": {
    "ports": [
      { "path": "/dev/ttyUSB0", "description": "FTDI USB Serial" },
      { "path": "/dev/ttyACM0", "description": "ST-Link VCP" },
      { "path": "/dev/ttyS0",   "description": "" }
    ]
  }
}
```

Enumeration method, by platform. No libudev anywhere.

| Platform | Method                                                                      | Description field                     |
| -------- | --------------------------------------------------------------------------- | ------------------------------------- |
| Windows  | `serialport::available_ports()` — wraps SetupDi Win32 APIs (always present) | Friendly name + VID/PID               |
| macOS    | `serialport::available_ports()` — wraps IOKit (always present)              | Manufacturer + product + VID/PID      |
| Linux    | Custom sysfs walker (see below) — no libudev                                | Manufacturer + product where readable |

### Why Linux needs special handling

The `serialport` crate's Linux enumeration uses libudev, which we are avoiding. Its fallback without libudev is minimal. A naive `/dev` walk is also unacceptable because of **phantom entries**:

```
/dev/ttyS0 ... /dev/ttyS31    ← mostly phantoms, driver-declared but no real hardware
/dev/ttyUSB0                   ← real USB-serial (FTDI, CH340, etc.)
/dev/ttyACM0                   ← real USB CDC (Arduino, STM32 VCP, ST-Link)
/dev/ttyAMA0                   ← real on ARM SBCs (Raspberry Pi etc.)
```

Listing all 32+ phantom `ttyS*` in the picker makes it unusable.

### Linux sysfs walker algorithm

Re-implements what libudev does, in pure Rust against the sysfs filesystem. Roughly 100 lines.

```
for each entry in /sys/class/tty/:
    let name = entry.file_name()  // e.g. "ttyUSB0", "ttyS3", "console"

    // 1. Skip entries with no backing device (phantoms, consoles, ptys)
    let device_link = /sys/class/tty/<name>/device
    if !device_link.exists(): continue

    // 2. Follow the device symlink and check what bus it chains back to.
    //    Real ports chain back to /sys/bus/usb/, /sys/bus/pci/, or /sys/bus/platform/.
    //    Phantom ttyS* often have a 'device' link but no real bus ancestry
    //    (or resolve to a driver with no hardware claim — e.g. serial8250 on a port
    //    with no resources attached).
    let resolved = readlink_canonical(device_link)
    if !chains_to_real_bus(resolved): continue

    // 3. For USB devices: walk up the ancestry to find the USB device node,
    //    then read:
    //      <usb_device>/idVendor       → hex VID
    //      <usb_device>/idProduct      → hex PID
    //      <usb_device>/manufacturer   → string (may be absent)
    //      <usb_device>/product        → string (may be absent)
    //
    //    For non-USB (PCI, platform): use the driver name as description.

    yield AvailablePort {
        path: format!("/dev/{}", name),
        description: format!("{manufacturer} {product}").trim(),
        vid: ...,
        pid: ...,
    }
```

The "chains to real bus" check is the phantom filter. If the device's ancestry doesn't terminate at a USB, PCI, or platform device node with real hardware bindings, drop it.

Implementation lives in `mcu-debug-helper/src/serial/enumerate_linux.rs` alongside:
- `enumerate_windows.rs` — wraps `serialport::available_ports()`
- `enumerate_macos.rs` — wraps `serialport::available_ports()`

All three return the same struct:

```rust
struct AvailablePort {
    path: String,           // stable identifier
    description: String,    // best-effort human-readable name
    vid: Option<u16>,       // optional, for future features
    pid: Option<u16>,
}
```

`description` is **informational only** — the UI uses it to help the user pick, but never for identity. Port paths are the stable key.

**Known limitations:**
- VID/PID follow-across-rename is not implemented (would help when USB enumeration order changes). Accepted tradeoff; users reconfigure when paths move.
- Some exotic buses may be missed on Linux. The common cases (USB, built-in UART on SBCs) are covered.

### List-changed notifications: manual refresh only

The picker dropdown has a **refresh button**. User clicks → extension calls `serial.list_available` again. That's it.

No polling, no OS-level device-change hooks, no live updates in v1. Reasons:

- Polling wastes cycles to be useful (must be aggressive enough to catch plug events promptly)
- OS-level hooks (`WM_DEVICECHANGE`, IOKit notifications, netlink uevent) each require platform-specific code and nontrivial integration
- Plug/unplug during active configuration is rare — users configure once, debug for hours
- "Hit refresh to see the latest" is a trivial mental model for users to learn

If live updates become a real demand later, netlink uevent on Linux (no libudev), `WM_DEVICECHANGE` on Windows, and IOKit matching on macOS are the escape hatches. Not v1 material.

### Responses (server → client)

```jsonc
// Success
{
  "id": 42,
  "result": {
    "path": "/dev/ttyUSB0",
    "transport": "direct",
    "tcp_port": 54321                   // if transport == "direct"
    // "channel_id": "ser-usb0-1"       // if transport == "funnel"
  }
}

// Pre-open error (port not found, permission denied, already open with incompatible transport, etc.)
{
  "id": 42,
  "error": { "code": "port_not_found", "msg": "No such device: /dev/ttyUSB0" }
}
```

### Response for `serial.isOpen`

```jsonc
{
  "id": 46,
  "result": {
    "open": true,
    "tcp_port": 54321,                  // omitted if open == false
    "params": { "path": "/dev/ttyUSB0", "baud_rate": 115200, ... }  // omitted if open == false
  }
}
```

### Async notifications (server → client, no request id)

One event type for v1 — errors only. `port_closed` and `port_alive` are intentionally omitted:

- **`port_closed`** is not needed: `serial.close` is a synchronous RPC; the success response is the notification. Emitting a second async event for a client-initiated close is redundant noise.
- **`port_alive` push** is not needed: the existing heartbeat mechanism (`\n` every 5s on stdin, 15s watchdog on the server) already covers both liveness and connection keep-alive from the client side. The new `serial.isOpen` request lets the client pull per-port status on demand.

```jsonc
// Post-open fatal error — the port's TCP bridge closes immediately after this event.
// Server removes the port from its registry; a future serial.open can re-open it.
{
  "event": "serial.portError",
  "params": {
    "path": "/dev/ttyUSB0",
    "kind": "disconnected",             // | "io_error" | "permission_lost" | "timeout"
    "msg": "Device removed"
  }
}
```

### Protocol rules

- Client branches on `kind`, never parses `msg` — messages are for humans.
- New event types are additive; clients ignore unknown events.
- After `serial.portError`, the server closes the TCP bridge from its end — the client receives a TCP EOF on its data connection and does not need to close it explicitly. The client should update UI state (show `[ERROR]`, write to output channel, etc.) when the `serial.portError` event arrives or when it detects the TCP disconnect, whichever comes first.
- Port status is **pull-only** (via `serial.isOpen`) except for fatal errors, which are pushed. This keeps the server simple and the client in control of polling frequency.

---

## 5. Data Transport: Direct vs Funnel

**Client must specify explicitly** in every `serial.open` request. Implicit detection is not possible — the server has no way to know what sits between itself and the end consumer (direct TCP? NAT? container? SSH tunnel?).

| Transport | Use case                                                                                     | Handle returned                                                                                     |
| --------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `direct`  | Client can reach the server's listening host/port directly                                   | `tcp_port` — client connects to `host:tcp_port`                                                     |
| `funnel`  | Client reaches the server only via an existing proxy connection (NAT, container, SSH tunnel) | `channel_id` — bytes tunnel through the proxy control connection using the existing funnel protocol |

The client library (Node/TS) presents both as the same `Stream` abstraction so the extension code is transport-agnostic after the initial `open` response.

---

## 6. Ring Buffer (Late-Attach Catch-up)

### Why

Keeping the port open without buffering just moves the data-loss point. If no TCP client is attached, reads either block (OS buffer overrun) or drop. The ring buffer is **the** mechanism that lets late attachers see boot output.

### Behavior

- **One ring per open serial port**, bounded size (default 1 MB, configurable per port).
- **Always-on reader.** A server thread continuously reads from the serial port and writes into the ring, regardless of whether any client is attached.
- **Catch-up on connect.** When a TCP/funnel client attaches, the server first flushes the ring's current contents (snapshot), then streams live.
- **No client = older data overwritten.** Bounded memory by design.

### Interaction with the log file (see §9)

- Ring buffer = short-term catch-up for new attachers.
- Log file = long-term history for forensic search (AI, post-mortem).
- Both fed from the same serial reader. Ring is finite; file grows.

---

## 7. Error Handling

Two categories, both via the control channel.

### Pre-open errors

Returned in the `serial.open` response's `error` field.

| `code`              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `port_not_found`    | Device path does not exist                                                 |
| `permission_denied` | `/dev/ttyUSB0` exists but user can't open it (Linux `dialout` group, etc.) |
| `port_busy`         | Another process has it open                                                |
| `invalid_params`    | Baud/parity/etc. rejected                                                  |

At most one pre-open error per port per session is expected.

### Post-open errors

Emitted as a `serial.portError` async event on the control channel. The server simultaneously closes the TCP bridge from its end (dropping the client connection), so the client may observe either the event or the TCP EOF first — whichever arrives first triggers the same UI update. Client correlates by `path`:

- Server closes TCP bridge → client receives EOF on its data connection
- `serial.portError` event arrives on the control channel with matching `path`
- Client displays the error (see §8)

Stable `kind` values:

- `disconnected` — device unplugged, USB-serial removed
- `io_error` — generic I/O failure (cable issue, hardware error)
- `permission_lost` — permission revoked mid-session (rare)
- `timeout` — configured timeout exceeded

Note: the server fires the event and drops the bridge as a unit; there is no window where the bridge is open but an error has been declared.

---

## 8. UI Integration

### Panel layout

All MCU-specific output lives in a **single consolidated panel**: `MCU DEBUG`. Chosen to avoid:

- Activity bar clutter (already oversubscribed across the ecosystem)
- Terminal panel's list-on-the-right eating horizontal space
- Proliferation of MCU-related panels when the user can only look at one at a time anyway

One panel, tabs for everything:

| Tab type          | Lifecycle                                          | Created by                                          |
| ----------------- | -------------------------------------------------- | --------------------------------------------------- |
| UART tabs         | VS Code session (workspace-scoped)                 | `+` action in the panel, or `launch.json` auto-open |
| RTT channel tabs  | Debug session (reused across sessions — see below) | Debug session start                                 |
| SWO tab           | Debug session                                      | Debug session start                                 |
| Glass Cockpit tab | Debug session                                      | Debug session start                                 |

Tab ordering groups by lifecycle: UARTs first (persistent), then RTT/SWO/Cockpit (session-scoped). Visual differentiation (icon, color cue) can signal which tabs survive session end.

### Tab lifecycle and reuse

**UART tabs:** persist across debug sessions and VS Code restarts. Created via `+` or `launch.json` auto-open. Removed only by explicit user close.

**RTT/SWO/Cockpit tabs:** existing reuse pattern preserved — tabs are **not removed** when a debug session ends; they remain in an inactive state, ready to be reactivated when a new debug session creates matching channels. If the user explicitly removes one, it stays gone until a future debug session forces its recreation.

### Tab content

Each UART tab is a webview: xterm.js for output, input line at the bottom with source selector. Matches the single-source variant of the Glass Cockpit layout from [AI-Angle.md §6](AI-Angle.md).

The Glass Cockpit tab itself is the multi-source mux view with the three-region layout (live output / AI-REQUEST / USER-REQUEST input) — **no internal tabs** inside Cockpit. It is one tab within the `MCU DEBUG` panel.

### Adding a UART (UX flow)

1. User clicks `+` on the **MCU UARTs** panel
2. Dropdown populated via `serial.list_available` (see §4) — shows path + description
3. User picks a port, fills in baud/parity/etc. (defaults to 115200, 8N1, none)
4. Tab appears; UART opens immediately
5. Configuration saved to workspace state — restored on next VS Code launch

### Where errors go

| Surface                                     | What goes there                                           | Rationale                                                                              |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Inline in the terminal** (write to xterm) | Post-open errors, clean closes visible to the user        | The engineer is already looking here; the error appears exactly where the data stopped |
| **VS Code output channel**                  | All `port_error` events; unexpected `port_closed` reasons | Forensic trail, searchable, persistent                                                 |
| **Terminal rename via `onDidChangeName`**   | Error-state indicator (e.g. `UART:ttyUSB0 [ERROR]`)       | Persistent visual cue without status-bar clutter                                       |
| **Status bar**                              | *Nothing*                                                 | Deliberately avoided — status bar is already over-subscribed                           |
| **Toast notifications**                     | *Nothing routine*                                         | Avoided for normal port events                                                         |

Pre-open errors are surfaced inline wherever the open was initiated (launch feedback, panel message), not in the output channel.

### Output channel filtering

**Goes to the output channel:**
- `serial.portError` — always

**Does NOT go to the output channel:**
- Serial data bytes (these are on the TCP/funnel stream, never the control channel)
- `serial.isOpen` responses — pull-based status, not notable
- Routine request/response traffic

Rule: **errors and unexpected state changes only.**

---

## 9. Log File Support

Each UART supports an optional user-specified log file, with or without timestamps. **This reuses the existing RTT/SWO logging code** — no new logging pipeline.

Config lives in the per-UART entry in `launch.json` (see §10). The log file is written from the same reader thread that fills the ring buffer, so:

- All bytes received on the serial port land in the log file.
- The log is unaffected by TCP client connection state.
- The log is the authoritative long-term record; the ring is short-term catch-up.

This doubles as the "tee to file" backbone referenced in the AI architecture ([AI-Angle.md](AI-Angle.md)) — an AI attached to the session can grep or seek in this file for historical context.

---

## 10. Configuration Sources

UART config lives in **two places**, with distinct roles:

### Workspace state (primary source of truth)

Created and edited via the **MCU UARTs** panel UI (`+` to add, per-tab settings). Persisted via `context.workspaceState` (VS Code `Memento` API). Full schema per UART:

```jsonc
{
  "label": "DebugUART",              // optional; default = port basename
  "port": "/dev/ttyUSB0",            // or "COM3" on Windows
  "baud": 115200,
  "parity": "none",                  // "none" | "odd" | "even"
  "stopBits": 1,
  "dataBits": 8,
  "direction": "both",               // "rx" | "tx" | "both"
  "logFile": "logs/uart.log",        // optional; shared with RTT/SWO logging
  "logTimestamps": true,
  "ringBufferBytes": 1048576,        // default 1 MB
  "autoOpenOnStartup": true,         // reopen on VS Code restart
  "preDecoder": null                 // future, for binary protocols
}
```

### `launch.json` (debug-session references)

Debug configs reference UARTs by label — they don't redefine them. Keeps the debug config small and avoids duplication.

```jsonc
"uartConfig": {
  "enabled": true,                   // master toggle — keep config when disabled
  "autoOpen": ["DebugUART", "Telemetry"]   // labels of workspace-configured UARTs to ensure open
}
```

On debug session start: the extension iterates `autoOpen` and ensures each listed UART is open (idempotent — already-open UARTs are no-op).

On debug session end: nothing happens to UARTs. They were workspace-scoped before, during, and after.

### Legacy inline definition (supported, discouraged)

For users migrating from older versions or wanting `launch.json` as sole source, inline UART definitions are accepted:

```jsonc
"uartConfig": {
  "enabled": true,
  "uarts": [                         // inline — merged into workspace state on first load
    { "label": "DebugUART", "port": "/dev/ttyUSB0", "baud": 115200 }
  ]
}
```

Inline-defined UARTs are promoted to workspace state on first encounter. Use the UI to manage them thereafter.

### Default mux tags

Each source uses its most natural identifier:

| Source | Default tag                     | With label override |
| ------ | ------------------------------- | ------------------- |
| RTT    | `[RTT#0]`, `[RTT#1]`            | `[RTT:Console]`     |
| UART   | `[UART:ttyUSB0]`, `[UART:COM3]` | `[UART:DebugUART]`  |
| SWO    | `[SWO]`                         | —                   |

Existing collision-resolution logic handles rare cases (e.g. macOS `/dev/cu.X` vs `/dev/tty.X` sharing a basename).

### SSOT benefit

`launch.json` is the Single Source of Truth. The same config drives both the VS Code extension and the CLI variant ([AI-Angle.md §9](AI-Angle.md)). Adding UART here lights up both surfaces simultaneously.

---

## 11. Unique Capability: Remote Serial Ports

No other VS Code serial extension (MS Serial Monitor, ARM, Eclipse CDT, etc.) supports accessing serial ports on a **remote host**. This falls out of the existing Funnel Protocol used for gdb-server remoting.

- Probe Agent running on a lab server exposes its local serial ports via the same proxy server that already handles gdb-sessions
- Engineer laptop opens a UART as if local; bytes tunnel through the existing proxy connection
- No SSH port forwarding, no firewall changes (same "outbound SSH only" story as the debug-session remoting)
- Direct vs funnel transport is chosen per-request; UART "just works" across the boundary

This is a genuine differentiator — worth calling out in user docs when ready.

---

## 12. What We Are NOT Doing

Explicit non-goals, with reasons:

| Non-goal                                                            | Reason                                                                                                                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **libudev-based enumeration**                                       | Path-level enumeration (sysfs / registry / `/dev` walk) covers 90% of the need without pulling libudev. VID/PID and rich USB metadata are deferred. Keeps the helper binary dependency-free. |
| **Server-side fan-out to multiple clients**                         | Client-side fan-out is simpler, reuses existing RTT/SWO code, and keeps the server dumb. Write arbitration would also become a design problem.                                               |
| **`serial.reconfigure` as a distinct request**                      | Idempotent `serial.open` handles reconfiguration by design. Eliminates a state machine on the client side.                                                                                   |
| **Rejecting param mismatches**                                      | Users iterate on baud/parity while debugging. Forcing explicit close/reopen is customer-hostile. Reconfigure in place.                                                                       |
| **Mid-stream framing of the TCP bridge**                            | The bridge stays transparent (raw bytes). Errors travel on the side channel; the stream simply closes. Clean separation.                                                                     |
| **Activity bar entry**                                              | Activity bar is over-subscribed. A single consolidated panel in the panel area is a better home.                                                                                             |
| **Live port-list updates (WM_DEVICECHANGE, IOKit, netlink uevent)** | Manual refresh covers the common case. Live updates are polish, not core. Add if users demand it.                                                                                            |
| **Status-bar error indicators**                                     | Status bar is over-subscribed across extensions. Terminal rename + inline writes are cleaner.                                                                                                |
| **Toast notifications for routine port events**                     | Noise. Only truly exceptional situations should interrupt the engineer.                                                                                                                      |
| **Competing with general-purpose serial monitors**                  | MS Serial Monitor is a polished generic tool. Our differentiation is serial-integrated-with-debug, plus remote port access. Different audience, different value.                             |

---

## 13. Summary Diagram

```
┌───────────────────────── VS Code Extension ─────────────────────────┐
│                                                                      │
│  Control channel (JSON-RPC)     TCP / funnel streams (raw bytes)    │
│         │                                │                           │
│         ▼                                ▼                           │
│   ┌──────────────────────────────────────────────┐                  │
│   │  mcu-debug-helper proxy (single binary)       │                  │
│   │                                                │                  │
│   │  ┌─ Serial port manager ─────────────────┐    │                  │
│   │  │ per-port: handle, ring, log file,      │    │                  │
│   │  │ reader thread, TCP bridge / funnel     │    │                  │
│   │  └────────────────────────────────────────┘    │                  │
│   │                                                │                  │
│   │  ┌─ Debug-session manager (existing) ────┐    │                  │
│   │  │ per-session: gdb-server lifecycle      │    │                  │
│   │  └────────────────────────────────────────┘    │                  │
│   └──────────────────────────────────────────────┘                  │
│         │                                                            │
│         ▼                                                            │
│   Physical serial ports / gdb-servers                                │
└──────────────────────────────────────────────────────────────────────┘
```

One helper process, one proxy subcommand, two service types, shared control channel. Long-lived serial ports and per-session debug sessions coexist with distinct lifecycles but unified management.
