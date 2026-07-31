# GDB-Server Exit Reporting — Bug & Design

**Status:** Draft / confirmed bug + proposed fix. 2026-07-31.
**Area:** Probe Agent (`mdbg proxy`) ↔ TS client (Debug Adapter) event protocol.
**Related:** [Proxy-Plan.md](./Proxy-Plan.md), [CLI-Proxy-Provisioning.md](./CLI-Proxy-Provisioning.md) §7.3 (session supervision — the `spawn_session_thread` helper this fix builds on).

---

## 1. The bug (confirmed)

**When the gdb-server exits or crashes on its own, the client is never told _that_ it exited, _why_, or with _what_ status.** The `gdbServerExited` event exists and is fully handled on the client — but the Probe Agent never emits it.

Evidence:

| Piece | Location | State |
| --- | --- | --- |
| `GdbServerExited { pid, exit_code }` wire event | [protocol.rs:420](../packages/mdbg/src/proxy_helper/proxy_server/protocol.rs) | **Defined, never sent** — zero construction sites in Rust |
| TS handler for it | [proxy-client.ts:470](../packages/mcu-debug/src/adapter/proxy-client.ts) → `handleGdbServerExited` → `emit("gdbServerExited")` | Wired end-to-end, **never fires** |
| TS consumer | [server-session.ts:131](../packages/mcu-debug/src/adapter/server-session.ts) → `serverExited(code, signal)` → "GDB Server exited unexpectedly with code…" [gdb-session.ts:1451](../packages/mcu-debug/src/adapter/gdb-session.ts) | Dead path, waiting for an event that never arrives |
| Child-exit monitoring | `child.wait()` only in `end_process()` [mod.rs:248](../packages/mdbg/src/proxy_helper/proxy_server/mod.rs) | **None** — no `try_wait` poll, no reaper thread; status learned only on the deliberate-kill path |

Note: `GdbServerLaunched` is likewise never emitted, but launch is acked via the `StartGdbServer` **ControlResponse** (which returns the pid), so launch has an alternate path. **Exit has no such response** — it is asynchronous and unsolicited — so the missing event is a genuine functional gap, not a duplicate.

### The accidental backstop, and why it isn't enough

When the gdb-server dies, its stdout/stderr pipes close → the `GdbStdout`/`GdbStderr` reader threads hit EOF → `ProxyEvent::StreamClosed` → the loop forwards a per-stream `ProxyServerEvents::StreamClosed` ([mod.rs:492](../packages/mdbg/src/proxy_helper/proxy_server/mod.rs)). So the client notices the streams vanish, but that signal:

- is **per-stream**, not "the server exited";
- carries **no exit code and no signal**;
- carries **no cause** — see §3.

Also, the dead child is not reaped until the session ends (`Drop` → `end_process` → `wait`), so a spontaneously-exited gdb-server is a **transient zombie** for the remainder of the session.

Why it never bit us in testing: OpenOCD is stable and rarely exits on its own. probe-rs, by contrast, **panics/exits abruptly and often** (unsupported chip, lost probe, target reset, internal error), which is exactly when the user most needs to be told what happened.

---

## 2. Why this matters (UX)

The gdb-server lifecycle is the single biggest friction point in the product, and the audience makes it worse: **most users don't know what a gdb-server is, many don't know what gdb is** — they come from IDEs where "debugging" is one green arrow. When the gdb-server dies:

- the debug session freezes or ends with no explanation;
- the user has no idea whether *they* did something, the *board* did something, or the *tool* broke;
- the actual cause (a probe-rs panic message, a "port already in use", an "unable to connect to target") is often sitting in the gdb-server's stderr that we *did* capture but never framed as an error.

So this is not just "emit the missing event." It is: **detect the exit, capture the cause, and translate it into a plain-language, actionable message** for someone who has never heard the term "gdb-server."

---

## 3. The exit taxonomy — provenance is the missing dimension

Today all these collapse into "streams closed." They must be distinguishable, because the right user message differs completely:

| Cause | Example triggers | What the user should see |
| --- | --- | --- |
| **A. Client-initiated shutdown** | user stops debugging; DA sends `StopGdbServer`/disconnect | Expected — quiet, or a calm "Debug server stopped." |
| **B. Spontaneous exit / crash** | probe-rs panic, probe unplugged, target power lost, port already in use, unsupported chip | **Unexpected** — surface exit code/signal **and** the captured stderr, with guidance |
| **C. Proxy-initiated kill (internal error)** | Agent hit a fatal internal error and tore the session down (see §7.3 R2) | "The debug bridge stopped the server due to an internal error (…)" |
| **D. Failed to start** (distinct) | bad path, missing binary, bad args | Already handled via the `StartGdbServer` ControlResponse **error** — *not* this bug, but the messaging should be consistent |

The core protocol gap: the exit event needs to carry **provenance** (which of A/B/C) plus **status** (exit code, and on Unix the signal), not just `exit_code: i32`.

---

## 4. Proposed design

### 4.1 Rust: detect the exit

Add a **child-reaper session thread** — a natural fit for the `spawn_session_thread` helper from §7.3 R2, so its own death is also supervised. It waits for the child and reports.

**Ownership subtlety (the crux).** `child.wait()` needs `&mut Child`, and `end_process()` needs the same handle to `kill()`. Two viable shapes:

- **Poll + shared handle (simplest):** store the child as `Arc<Mutex<Child>>`. The reaper loops `try_wait()` on a short interval (~100 ms); `end_process()` locks, sets the *solicited-kill* flag, and `kill()`s. Small detection latency, minimal restructuring.
- **Owned by reaper + kill channel:** move the `Child` into the reaper, which blocks on `wait()`. `end_process()` signals the reaper (flag + a self-`kill` via stored pid, or a `kill_tx`) to shut it down. No polling, but relocates child ownership.

Either way, introduce a **solicited-shutdown flag** (`AtomicBool` or a small `ShutdownReason` enum) that `end_process()` sets *before* killing, so the reaper can classify the exit as A/C vs. B.

### 4.2 Rust: report the exit

- New internal `ProxyEvent::GdbServerExited { pid, status, reason }` sent by the reaper.
- The event loop maps it to the wire `ProxyServerEvents::GdbServerExited { … }` and then **ends the session** (the debug session is over once the server is gone).
- **Wire protocol change:** the current `{ pid, exit_code: i32 }` is too thin. Extend to carry:
  - `exit_code: Option<i32>` and `signal: Option<i32>` (Unix distinguishes these; `ExitStatus` gives both), and
  - `reason: "client_shutdown" | "crashed" | "proxy_error"` (the A/B/C provenance).
  - This is a `ts-rs`-generated type — regenerate the bindings (`cargo test ensure_ts_exports`) and update the TS handler in lockstep. Keep it backward-tolerant if any older client may connect.

### 4.3 Event ordering — flush the cause before the obituary

**This is the subtle part, and it's where the user-visible cause lives.** When the child exits, `child.wait()` returns, but the stdout/stderr reader threads may still have **buffered bytes** — including the probe-rs panic/backtrace or the "port in use" line, i.e. *the very explanation the user needs*. If we emit `GdbServerExited` immediately, it can race ahead of that stderr.

Requirement: **drain remaining stdout/stderr (deliver those `StreamData`/`StreamClosed` frames) _before_ the `GdbServerExited` frame.** Practically: have the reaper wait until the stdout/stderr reader threads have hit EOF and their bytes are flushed to the client, *then* emit the exit event. This makes `GdbServerExited` the authoritative "it's over — here's why" marker, arriving after the evidence.

(The TS side will still need to tolerate event ordering/interleaving on its end — trailing `StreamClosed` vs `GdbServerExited` — but that's a client concern to harden separately; noted, not solved here.)

### 4.4 TS/UX: translate status → plain language

The client already has the plumbing; what it needs is **human framing** for a non-expert. Map `(reason, exit_code, signal, captured stderr)` to messages like:

- **A (client shutdown):** silent, or a calm status line — no scary red.
- **B (crash, signal):** "The debug server (probe-rs) crashed (segmentation fault). This usually means an unexpected internal error — try reconnecting the probe or re-running." + show the captured stderr in an expandable detail.
- **B (crash, nonzero code):** "The debug server exited unexpectedly (code N). Common causes: the probe was disconnected, the target lost power, or another session is using the probe." + stderr detail.
- **C (proxy error):** "The debug bridge stopped the server after an internal error." + the proxy's reason.

Principles: say **"debug server," not "gdb-server"**; name the backend (OpenOCD / probe-rs) so power users get specifics; always attach the captured stderr as detail rather than the sole signal; lead with a probable cause and a next step, not an error code.

---

## 5. Current-state code map (verified)

- Emitted `ProxyServerEvents` today: `StreamStarted`, `StreamReady`, `StreamTimedOut`, `StreamClosed`, `SerialPortError`, `SerialAvailableChanged` ([mod.rs](../packages/mdbg/src/proxy_helper/proxy_server/mod.rs), [serial.rs](../packages/mdbg/src/proxy_helper/proxy_server/serial.rs)).
- **Never emitted:** `GdbServerLaunched` (covered by `StartGdbServer` response), `GdbServerExited` (**this bug**).
- Child handle: `ProxyServer.process: Option<Child>`; killed+waited only in `end_process()`; also killed on `Drop`.
- Backstop path: gdb exit → pipe EOF → `read_and_forward` → `ProxyEvent::StreamClosed` → wire `StreamClosed` ([mod.rs:492](../packages/mdbg/src/proxy_helper/proxy_server/mod.rs)).

---

## 6. Open questions

1. **Protocol shape** — extend `GdbServerExited` to `{ pid, exit_code?, signal?, reason }`, or add a separate richer event and keep the old one? Backward-compat with any pinned client?
2. **Ownership model** — poll `try_wait` on a shared `Arc<Mutex<Child>>`, or move the `Child` into an owned-blocking reaper with a kill channel (§4.1)?
3. **Session end policy** — does `GdbServerExited` always end the session, or should some configurations allow an in-place restart of the server?
4. **Cause inference** — the proxy can report code/signal/solicited-flag reliably, but semantic causes ("probe unplugged" vs "port in use") live in the gdb-server's stderr. How much does the proxy classify vs. leave to the TS layer + stderr text?
5. **stderr flush guarantee (§4.3)** — confirm the reader threads reliably reach EOF and flush before the reaper emits; define the exact "drained" condition the reaper waits on.
