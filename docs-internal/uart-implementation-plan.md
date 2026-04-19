# UART / Serial Support — Implementation Checklist

Step-by-step plan for implementing the design in [uart-management.md](uart-management.md). Each item is sized to be a reviewable commit. Check off as you go.

Critical path: **4 → 6 → 7 → 8 → 11**. Everything else can parallelize around that spine.

---

## Phase 1 — Rust helper: unify under `proxy`

- [ ] **1.** Delete `serial` subcommand wiring. Remove the CLI arg and dispatch in `main.rs`. Keep `src/serial/run_serial.rs` on disk as a reference during rewrite; delete at end of Phase 2.
- [ ] **2.** Add `serialport` crate with `default-features = false` to `packages/mcu-debug-helper/Cargo.toml`. Verify Linux build has no libudev dependency (`ldd` the binary, or `cargo tree -e no-dev | grep -i udev`).
- [ ] **3.** Create `src/serial/` module skeleton: `mod.rs`, `port.rs`, `ring.rs`, `enumerate_linux.rs`, `enumerate_windows.rs`, `enumerate_macos.rs`. Empty stubs + `cfg(target_os)` gating.

## Phase 2 — Rust helper: serial port manager

- [ ] **4.** Ring buffer (`ring.rs`) — bounded, thread-safe, `push(bytes)` + `snapshot()` for flush-on-connect. Unit tests for wrap behavior, snapshot correctness, concurrent push/snapshot.
- [ ] **5.** Port enumeration — Linux sysfs walker (phantom filter, USB VID/PID via ancestry walk), wrap `serialport::available_ports()` on Win/macOS. Return uniform `AvailablePort { path, description, vid, pid }`. Unit test on Linux against a fixture sysfs tree.
- [ ] **6.** Per-port handle (`port.rs`) — owns the serial fd, always-on reader thread, ring buffer, optional log-file writer. API: `open()`, `reconfigure()`, `attach_client(writer)` / `detach`, `close()`. In-place reconfigure via `serialport::reconfigure()`.
- [ ] **7.** TCP bridge for `direct` transport — listener per port, on accept: flush ring snapshot first, then stream live. Explicitly **not** the old "open-inside-accept-loop" pattern.
- [ ] **8b.** Delete `src/serial/run_serial.rs` once parity is reached.

## Phase 3 — Rust helper: control channel

- [ ] **8.** Extend proxy control-channel dispatcher with `serial.open`, `serial.close`, `serial.list_open`, `serial.list_available` handlers. Idempotent `serial.open` (reconfigure in place if already open).
- [ ] **9.** Async event emission — `serial.event` with `port_error` / `port_closed` / `port_alive`. Reader-thread errors fire `port_error` then close the bridge. `port_alive` every ~30s per open port.
- [ ] **10.** Funnel transport for serial — reuse existing funnel channel code path; route serial bytes through a new `channel_id` kind.

## Phase 4 — TypeScript extension: client library

- [ ] **11.** Control-channel client additions — TS types for the new requests/events, thin wrappers returning promises + event emitter for async events.
- [ ] **12.** Serial stream abstraction — single `Stream` interface over `direct` (TCP socket) and `funnel` (channel id on existing proxy conn), transport-agnostic for callers.
- [ ] **13.** UART manager service (TS) — workspace-state persistence via `Memento`, `ensureOpen(label)`, auto-open on extension activation, auto-open on debug session start from `launch.json` `autoOpen` list.

## Phase 5 — TypeScript extension: UI

- [ ] **14.** Consolidated `MCU DEBUG` panel scaffolding — single panel, tab container. Migrate existing RTT/SWO/Cockpit tabs into it; preserve existing reuse semantics (tabs survive session end).
- [ ] **15.** UART tab webview — xterm.js + input line + source selector. Reuse RTT/SWO rendering components where possible.
- [ ] **16.** Add-UART flow — `+` action → picker populated from `serial.list_available` with refresh button → form (baud/parity/etc., defaults 115200 8N1 none) → save to workspace state → open.
- [ ] **17.** Error surfaces — inline xterm writes on post-open errors, output-channel filter rules per §8, `onDidChangeName` for error-state tab title (e.g. `UART:ttyUSB0 [ERROR]`).

## Phase 6 — Config + polish

- [ ] **18.** `launch.json` schema — add `uartConfig` block with `enabled` + `autoOpen` (by-label). Validation + hover docs in the JSON schema.
- [ ] **19.** Legacy inline `uarts: [...]` migration — on first load, promote into workspace state, leave a one-time notice.
- [ ] **20.** Log-file wiring — share pipeline with RTT/SWO logging; write from the same reader thread that fills the ring.

## Phase 7 — Testing

- [ ] **21.** Manual test matrix — local UART on Linux/macOS/Windows; WSL-mirrored + WSL-NAT; dev container; SSH lab topology. **Boot-banner capture check** (the original bug): helper up → board reset → banner visible in tab attached after reset.
- [ ] **22.** Late-attach catch-up test — open UART, wait N seconds with traffic, attach client, verify ring snapshot arrives before live data and no duplicates across the seam.

---

## Dependencies at a glance

```
4 (ring) ──► 6 (port) ──► 7 (bridge) ──► 8 (RPC) ──► 11 (TS client) ──► 13 (service) ──► 14+ (UI)
                                          │
                                          └──► 9 (events), 10 (funnel)  [parallel]
```

## Suggested first PR

Phase 1 steps 1–3 **plus step 4** (ring buffer with tests). Self-contained, unblocks the keystone of the design, and passing tests give confidence before anything else changes.
