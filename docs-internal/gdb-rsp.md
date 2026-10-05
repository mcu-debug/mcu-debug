# GDB RSP Multiplexer in the Probe Agent — Design & Plan

**Status:** **Phases 1–3 are done bar item 11b**, and the mux is in the data path on the branch
`rsp-mux`. The design's central premise is confirmed on hardware: OpenOCD answers a memory read in
0.5 ms on a connection that itself has a `c` outstanding (§7, `rsp-probe`), so its tier is `Full`.
356 Rust tests, 180 of them in `gdb_rsp/`.

With no consumers attached the mux is a pass-through, and that is what item 15 is checking. It has
held on hardware for session setup — a dual-core PSoC 6 under OpenOCD, mux on the controller only,
the live-watch GDB left alone as `Secondary`, ~60–80 µs of added setup cost on the message-loop
thread. What is untested there is the steady state: flash/load, stepping, pause, breakpoints.

Switches, both per session over `initialize` because one Agent serves many sessions:
`debugFlags.rspTrace: "off" | "packets" | "all"` and `debugFlags.rspMux: false` (§4.7.3).
`--rsp-trace` and `--no-rsp-mux` are that proxy's defaults, which a session overrides.

**§8 is settled and Phase 4 is unblocked.** Every session — local and remote — now runs through the
Agent, and `syncFiles` no longer copies anything for a local one (items 18 and 18a). Verified on
hardware against **OpenOCD, pyOCD, ST-LINK and J-Link**.

**Next:** finish item 15, then item 11b, then item 19.

_Known unrelated flake:_ `proxy_helper::listeners::tests::two_specific_addresses_can_share_a_port`
fails intermittently (port-binding race, pre-existing, untouched by this work) — don't read it as a
regression. Revised 2026-09-21.

**Goal:** make the Probe Agent (`mdbg proxy`) a **multiplexer on the GDB Remote Serial Protocol
connection to the gdb-server**. GDB becomes one client on that connection; the Agent's own
features — RTT, PC-sampling profiling, ETB/ETF drain, stack probing — become others. This puts
target memory access next to the probe, in Rust, instead of at the far end of two hops driven by a
second GDB process.

**Related:** [Proxy-Plan.md](./Proxy-Plan.md) (Funnel protocol, topologies),
[Stream-Flow-Control.md](./Stream-Flow-Control.md) (the "never touch RSP" rule),
[uart-management.md](./uart-management.md) (the `PortHandle` / `attach_client` pattern this design
copies), [../AGENTS.md](../AGENTS.md) §"RTT: Two Modes".

---

## 1. What this is for

Every planned feature reduces to **one primitive**: _read (and occasionally write) target memory,
on demand, while the target is running._

| Feature                  | What it actually needs                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| RTT (alternate mode)     | Poll the SEGGER RTT control block: read `wrOff`, read ring bytes, write `rdOff`. ~40 Hz. |
| DWT PC sampling          | Periodically read `DWT_PCSR` (`0xE000_101C`); one 4-byte read per sample.                |
| Stack probing            | Read `SP`, then a window of stack memory; find the high-water mark.                      |
| ETB / ETF trace drain    | Enable via CoreSight registers, then bulk-read the trace buffer.                         |
| Capability / state model | `PacketSize`, `x`-packet support, ack mode, target run state — all free, by snooping.    |

So this is not "an RSP feature framework". It is **one memory-access primitive plus a run-state
model**, with the features as ordinary clients. Build the multiplexer well and the features are
small.

### Why not keep doing it the way we do now

Today the primitive comes from a **second GDB process** — `LiveWatchMonitor`
(`packages/mcu-debug/src/adapter/live-watch-monitor.ts`) — which connects to the same gdb port and
is driven over GDB/MI. It works, and it is the proof that the servers themselves are happy to
answer memory requests while the target runs. It costs a whole extra GDB process, a GDB/MI round
trip per read, a per-core connection-limit bump the user's OpenOCD config has to load (§2), and it
sits on the wrong side of the network hop in remote topologies.

**The live GDB does not go away.** It is what translates _expressions_ (`myStruct.field[i]`,
`&buf`) into memory accesses, using the DWARF it has loaded. That is a large amount of work we
have no intention of reimplementing, and variables/live-watch keep using it. What moves to the
Agent is the class of work that is _pure address-and-length polling at a fixed rate_ — RTT,
sampling, trace — where GDB adds a round trip and contributes nothing.

**The split is per feature, not a doctrine.** GDB is one tool available to us, used where it earns
its place and skipped where it does not. The mux gives us the choice; nothing here obliges a
feature to take either route, and some features have a real decision to make. Stack probing is the
clearest example:

- **Straight from Rust** — poll `SP` and the stack window on the mux. Higher sampling rate, and
  strictly speaking GDB need not be involved at all beyond (possibly) initialisation.
- **Through GDB** — let it drive the sampling and produce a proper backtrace after a halt, which is
  work it is genuinely good at and we would otherwise be reimplementing.

Neither is obviously right, and the answer may be "both, for different questions the user is
asking". The rule is only this: **if GDB adds no value, or gets in the way, we do not use it** —
and equally, if it does the job better, we do.

### Why not just use the servers' own RTT

We will keep offering server-side RTT, because sometimes it is the right answer (J-Link's
implementation is genuinely high-throughput). But it is not a substitute:

- **J-Link** exposes only **one** RTT channel through the gdb-server.
- **OpenOCD** never polls to discover that the firmware has initialised the RTT control block. So
  either something outside pokes it, or the user has to halt and type `rtt start` — unusable from
  an IDE, for no good reason.
- Neither offers the per-channel pre-decoder pipeline (e.g. `defmt-print`) we already have.

Ours is up to 16 bidirectional channels, no manual start, decoders included. Offer both; let users
choose.

---

## 2. Architecture: the Agent owns the socket

**Decision (confirmed in review): one path for all servers.** The Agent owns the single TCP
connection to the gdb-server's gdb port. GDB is a client of the Agent's multiplexer. There is no
second connection to the server.

```text
Engineer Machine                      Probe Host (mdbg proxy = Probe Agent)
┌──────────────┐                      ┌────────────────────────────────────────────────────┐
│ GDB (main)   │─ local port ─┐       │  ProxyServer (one per session)                     │
│ GDB (live)   │─ local port ─┤       │                                                    │
│ TS DA        │              │       │   stream 3 (gdbPort) ──▶ ┌──────────────┐          │
└──────────────┘              │       │                          │   RspMux     │          │
       │ Funnel frames (one TCP conn.)│   RTT worker ──────────▶ │  (per core)  │─ TCP ──▶ │ gdb-server
       └──────────────────────────────┼─  profiler ────────────▶ │              │          │ (one socket)
                                      │   trace drain ─────────▶ └──────┬───────┘          │
                                      │                                 │                  │
                                      │                    send queue + pending FIFO       │
                                      │                    (sole reader & writer)          │
                                      └────────────────────────────────────────────────────┘
```

The mux is the **sole reader and sole writer** of that socket. That single fact is what makes the
rest of the design tractable: the mux has total ordering knowledge, so it can match positional
replies and untagged acks to the requests that caused them (§4).

### The one remaining risk

The mux depends on the gdb-server answering our requests on a connection where GDB already has a
`c`/`vCont;c` outstanding. One way a server can refuse: **it only serves requests while the target
is halted.** A server that gates _all_ packet handling on `TARGET_HALTED` gives us halted-only
operation. Note this is about _state-free_ requests (memory/MMIO read/write); a server refusing
_those_ while running is the disqualifying case.

**For OpenOCD this is settled, from the source rather than by inference** — its memory-read path has
no halt check at all. See §4.2.1, which reads the relevant parts of `gdb_server.c` and also corrects
what pipelining can and cannot buy. For the other servers it stays a Phase-3 matrix item (§11
item 17), and the outcome is a per-server-type capability tier (§7), not a yes/no.

### A connection is told about the resume _it_ issued — not about anyone else's

This was initially recorded the wrong way round, and the correction matters because the wrong
version made the design look more fragile than it is. The earlier claim was "only the first
connection is told what the target is doing." **That is not the mechanism.** OpenOCD's source says
so plainly:

| Step                                                                                           | Where                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The target-event callback is registered **per connection**                                     | `gdb_new_connection` → `target_register_event_callback(…, connection)` |
| The handler filters by **target only**, then calls `gdb_frontend_halted` for _each_ connection | `gdb_target_callback_event_handler`                                    |
| …which sends the stop reply only `if (gdb_connection->frontend_state == TARGET_RUNNING)`       | `gdb_frontend_halted` — that connection's **own** state                |
| `frontend_state = TARGET_RUNNING` is set only in **that connection's** resume/step paths       | `gdb_server.c` resume handling                                         |

So the rule is **behavioural, not positional**: a connection receives the stop reply for a resume it
issued itself. Nothing discriminates by connection order.

**That fully explains what live watch sees.** The live GDB is contractually forbidden to resume —
precisely OpenOCD's documented contract for an extra client ("must promise not to issue pause,
continue or step") — so its `frontend_state` never becomes `TARGET_RUNNING` and it is never sent a
stop reply. The comment at `live-watch-monitor.ts:139` attributes this to non-stop mode; that is
wrong, and so was the "first connection" correction that replaced it. The cause is simply that the
live GDB never resumes.

**Why this is better news.** "The first connection" would be a property we neither control nor can
check. "The connection that issued the resume" is one we know exactly: it is the user's GDB, by
definition, because it is the only thing driving execution. The mux sits there (item 14) and
therefore sees every transition — not by luck of ordering, but structurally.

### Evidence from real sessions (PSoC 6 / KitProg3, OpenOCD)

Two captures with the main GDB and the live-watch GDB both attached. OpenOCD tags each connection
`{1}` (main) and `{2}` (live watch) in its debug log, which settles several cells directly. The
sessions had **different shapes**, so they prove different things — read them separately rather than
side by side.

**Session A — target mostly running.** Several continue/pause cycles, no breakpoints.

| Observation                                                       | Count  | Establishes                                                                                                                         |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **conn2 memory reads answered while conn1 had a `c` outstanding** | **66** | **OpenOCD serves `m` while the target runs.** Previously only inferred from the absence of a halt gate in `gdb_read_memory_packet`. |
| conn2 memory reads answered while halted                          | 10     | baseline                                                                                                                            |
| Async stop replies → conn2                                        | **0**  | conn2 is never told about a resume it did not issue                                                                                 |
| Async stop replies → conn1                                        | 8      | `6×T02`, `2×T05` — both `T05`s were single-steps                                                                                    |

**Session B — breakpoints actually hit.** Breakpoints set from the main GDB in the normal flow, hit
repeatedly. This is the **autonomous halt** case: the core halts itself on an FPB comparator match,
detected by OpenOCD's background poll with no requesting connection in scope.

| Observation                              | Count  | Establishes                                                                                                                  |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `BREAKPOINT` debug reasons               | **4**  | real autonomous halts, not host-requested                                                                                    |
| `Z1,` / `z1,` on conn1                   | 10/10  | hardware breakpoints, set by the main GDB                                                                                    |
| Breakpoint stop replies → conn1          | **4**  | all of them                                                                                                                  |
| Breakpoint stop replies → conn2          | **0**  | **an autonomous halt routes exactly like a requested one**                                                                   |
| conn1 async stop replies, total          | **11** | = 4 BREAKPOINT + 3 DBGRQ + 4 SINGLESTEP — the arithmetic closes exactly                                                      |
| conn2 reads answered while conn1 running | 0      | not a contradiction of session A: with breakpoints firing the target was mostly halted, so conn2's polls landed while halted |

In both sessions conn2's only stop-shaped packet was the **synchronous answer to its own `?`** at
connect, logged via `gdb_last_signal()` rather than the async `gdb_frontend_halted` path. conn2 is not
deaf — in session A it exchanged 128 requests and 123 replies including 76 memory reads. It never
receives anything **unsolicited**.

**Why the mechanism is uniform, in one sentence:** the server never says "your breakpoint", it says
_stopped, SIGTRAP_. GDB compares the PC against its own breakpoint table to decide whether it owns
that address, and if it does not it still has to handle the stop. So at the RSP level a breakpoint hit
is just a stop reply like any other, and there is no special path because there is nothing special to
say.

**What is established, and how:**

| Claim                                                         | Source reading | Hardware            |
| ------------------------------------------------------------- | -------------- | ------------------- |
| No positional discrimination anywhere in the path             | ✅             | —                   |
| The async gate is that connection's own `frontend_state`      | ✅             | consistent          |
| OpenOCD answers `m` while the target runs                     | ✅             | ✅ **66 reads** (A) |
| A connection is not told about resumes it did not issue       | —              | ✅ **0 of 8** (A)   |
| **An autonomous halt routes the same way as a requested one** | ✅             | ✅ **0 of 4** (B)   |

### Both remaining cells closed by `rsp-probe` on hardware

Run against the live OpenOCD (`mdbg rsp-probe --port 2009 -v`). The two questions no GDB session can
reach are now answered, and they are the two the design actually depended on:

| Row                                                          | Result                                 |
| ------------------------------------------------------------ | -------------------------------------- |
| **`m` answered while a `c` is outstanding, same connection** | **YES — replied in 0.5 ms**            |
| **A resume issued on conn2, answered on conn2**              | **YES — `T02thread:1;`**               |
| `QStartNoAckMode` honoured                                   | yes                                    |
| `depth = 2` in no-ack mode                                   | yes — both replies arrived             |
| Second connection accepted                                   | yes                                    |
| conn2 told about conn1's resume                              | no — expected under either explanation |

**The first row is the premise of the whole design, now measured rather than reasoned about.** 0.5 ms
is no penalty at all; the interleaved read is served as promptly as a halted one.

**The second settles behavioural versus positional empirically.** A connection _is_ answered about a
resume it issued, even as the second connection on the port. So connections genuinely are equals, and
`frontend_state` is the only thing that differs — exactly what the source said, now confirmed on the
wire.

**This sharpens §4.7's rule without changing it.** The reason a mux cannot live on a secondary is not
that secondaries are second-class — they are not. It is that **the mux may not resume** (§4.5), and
neither does the secondary's GDB, so nobody on that connection ever resumes and no stop reply is ever
generated for it. The mux must sit where the resumes happen, which is the controller. Same conclusion,
precise reason.

The probe's `qSupported` reply also matches the transcribed fixture in `caps.rs` byte for byte
(`PacketSize=4000`, no `binary-upload`), so that fixture is accurate.

**A side benefit for §4.7:** session A's 66 reads are the "inject on the secondary connection"
arrangement already working in production — it is what live-watch RTT does today. That idea is not
speculative; it is current shipping behaviour seen from another angle.

The other fact from building live watch still stands, and is unrelated:

**Connection slots are rationed, per core, with a default of 1.** OpenOCD's `-gdb-max-connections` is
a **per-target** property whose default is 1. Live watch only works because `CDLiveWatchSetup` in
`packages/mcu-debug/support/openocd-helpers.tcl` walks `[target names]` and increments it on each
one. That helper is added unconditionally to the OpenOCD command line, so the slot exists whether or
not live watch is enabled — but it has no analogue on any other server.

Under the mux there is exactly one connection to the server and **we are it**, so:

- No connection-limit bump is needed for the Agent's own consumers. The `CDLiveWatchSetup` hack
  remains only for as long as `duplicateStream` gives additional GDB clients their own server
  connections (§4.7) — and disappears entirely under the maximal version of the mux.
- **The run/stop state model comes to us directly**, because the mux sits on the connection that
  issues the resumes. The state model in §3.10 is therefore not best effort; it is the server's own
  view, and for a structural reason rather than an incidental one.

### It is GDB that forbids inspection while running, not the server

Worth stating plainly, because it is the whole justification for this work: the prohibition on
reading target memory while the target runs is **GDB's** rule, from the all-stop protocol model it
presents to the user. The gdb-servers themselves generally have no such restriction — a Cortex-M
read over AHB-AP does not need the core halted. Injecting our own requests alongside GDB's is
therefore not a workaround for a server limitation; it is how we decline to inherit a _client_
limitation we never needed. RISC-V implementations may allow bus access or not (vendors choice)

Non-stop mode is **not** part of this design. It requires per-thread execution control — some
threads running while others are stopped — which is not a thing on an MCU, and effectively nothing
in our server list implements it. Left as a matrix line item to confirm, not as a dependency.

### What "GDB's transactions are sacred" now means

We are interleaving, so the invariant must be stated precisely rather than as a slogan:

1. **GDB's bytes are forwarded verbatim** — never modified, never dropped, never reordered
   relative to each other. Likewise every server reply destined for GDB.
2. **GDB's traffic has strict priority** in the send queue. One of our packets is sent only when
   doing so cannot delay a GDB packet already queued. GDB never waits on us except where the
   protocol itself serialises (one reply at a time on the wire).
3. **`\x03` is forwarded in order, like every other byte — it does not jump the queue.** It is not a
   framed packet, so it creates no pending entry and expects no reply; but we are a byte forwarder,
   and a byte cannot overtake bytes already queued ahead of it. An earlier draft of this list claimed
   it "bypasses everything", which contradicted invariant 1 one line above.
   It is also **not inert**: it elicits a stop reply, so it is a transaction and has to be modelled as
   one. The subtlety is that the stop reply it provokes is _the same_ stop reply that completes the
   resume already outstanding — there is only ever one — so giving the interrupt its own pending entry
   means deciding which entry that reply retires. That is why it has none today.

    **What we owe our own consumers on an interrupt is a notification, not a policy — and what they do
    with it is TBD, per consumer.** An earlier draft of this list had the mux close its injection gate
    on `\x03`; that was too clever. A consumer's memory read is the same kind of traffic GDB itself is
    about to do, and live watch demonstrates it today: it has reads in flight behind a ctrl-C on every
    pause, across a second connection, with nothing observed to fail. A trace consumer draining an ETB
    FIFO might want one last pass, or might want to stop at once; only it knows. So the mux publishes
    "an interrupt is pending" and each consumer decides, which is the §4.8 division of
    responsibilities. The number to decide against: the servers are strictly serial (§4.2.1), so any
    request of ours still outstanding is SWD time the server spends before it even looks at the
    `\x03`, so continuing to inject costs measurable latency on the user's pause. `StateTracker`
    already records `interrupt_pending`; **nothing consults or publishes it yet** — item 15b.

4. **We never emit a packet that mutates connection-scoped state GDB depends on.** See §3.10 —
   this was merely advisable with a second connection; on a shared socket it is the difference
   between working and corrupting the user's debug session.
5. **Replies destined for GDB are forwarded as the original bytes**, including their original
   run-length encoding and escaping. We decode a copy for snooping; we never re-encode.

---

## 3. RSP facts that constrain the design

Each of these kills an otherwise-reasonable implementation.

1. **Framing.** `$<data>#<cc>`, where `cc` is two lowercase hex digits of `sum(data) mod 256`.
2. **Acks.** `+` / `-` per packet in both directions, _unless_ no-ack mode is active. The stub
   advertises `QStartNoAckMode+` in its `qSupported` reply; **GDB** then sends
   `QStartNoAckMode`, and after the `OK` neither side acks again. In practice GDB does this
   immediately on connecting to any server that offers it (OpenOCD does), so a session is in ack
   mode only for its first few packets. We must implement **both modes and the exact switch
   point** — see §4.3, where ack accounting becomes the mux's job.
3. **Escaping.** Inside packet data, `}` escapes the next byte as `byte ^ 0x20`, applied to `#`,
   `$`, `}` and `*`. Present in every binary payload (`X`, the `x` reply, `qXfer`, `vFile`).
4. **Run-length encoding**, stub→GDB only. See §5 — it is not conventional RLE and the encodable
   counts have holes in them.
5. **`\x03` is not a packet.** A bare Ctrl-C byte outside framing, sent by GDB to interrupt a
   running target. The codec must pass it through without trying to frame it.
6. **Notifications.** In non-stop mode the stub sends `%Stop:…` unsolicited, drained by GDB with
   `vStopped`. Not replies, not acked. We must recognise them so they never retire a pending
   request, even though we do not expect to see them.
7. **`O` and `F` arrive mid-transaction.** `O…` (console output) and `F…` (file-I/O request) can
   appear between a request and its real reply. "A packet arrived" is not "the reply arrived".
8. **RSP has no request ids. Replies are positional.** This is the real constraint — not "one
   outstanding request". Pipelining is legal for anyone who knows the order packets went out in,
   and the mux knows by construction. §4.2 exploits this.
9. **All-stop makes `c` open-ended.** GDB's `c` / `vCont;c` has no reply until the target stops —
   possibly never. A pending-request model that assumes replies arrive promptly will wedge.
10. **Two kinds of shared state, at two different scopes.** This distinction matters more than it
    looks, because the two scopes fail differently.

    **Per-connection (framing and view).** Negotiated once per socket; every later packet on that
    socket is interpreted in it.
    - `qSupported`, `QStartNoAckMode`, `QNonStop` — framing and reply-timing mode for _everything_
      after. Re-negotiating mid-session corrupts the stream from that byte on.
    - `Hg` / `Hc` — selected thread for subsequent `g`/`p`/`m`. If we set it, GDB's next register
      read silently reads the wrong context.
    - `qXfer` — GDB reads objects in offset-windowed chunks; a reply to the wrong asker desyncs it.

    **Per-core (the debug session itself).** Shared by every connection to that core's gdb port,
    because it _is_ the target, not a view of it.
    - Run/stop state. One core is running or halted; there is no per-connection answer. But the
      server only _reports_ a transition to the connection that asked for it (§2) — so the state is shared
      while the notification is not.
    - `Z` / `z` — the breakpoint table is target state on most servers, so a stray `z` from us
      removes a breakpoint the user set, on every connection at once.
    - Reset, halt, resume, flash writes — all of it lands on the core.

    The rule that follows covers both: **we emit only packets that touch neither scope.** `m`,
    `M`, `x`, `X` and `qRcmd` qualify. `Hg`, `Z`/`z`, `QNonStop`, `QStartNoAckMode`, `qSupported`,
    `qXfer`, `c`, `s`, `vCont`, `k`, `R` do not, and are unconditionally forbidden to us (§4.5).

    The practical consequence of the per-core half is that **the mux's `TargetState` is a property
    of the core, shared by all consumers and all GDB clients on it** — one state machine per mux,
    not one per attached client (§4.7).

### 3.11 GDB going away is only sometimes visible on the wire

Settled from `gdb/remote.c`, because it decides whether the mux can notice this itself or has to be
told. GDB has **two** ways to leave, and only one of them says so:

| GDB command  | On the wire                     | Source                                       |
| ------------ | ------------------------------- | -------------------------------------------- |
| `detach`     | `D`, answered `OK`              | `remote_detach_1`, `remote.c:6428`           |
| `disconnect` | **nothing** — socket close only | `remote_target::disconnect`, `remote.c:6626` |

The comment directly above `disconnect` is explicit: _"Same as remote_detach, but don't send the `D`
packet; just disconnect."_ OpenOCD handles both ends of this — `case 'D'` → `gdb_detach()`, plus a
`connection_closed_handler` for the silent case (`gdb_server.c:3746`, `:1138`).

Four consequences for the mux:

1. **`D` is a free, reliable signal** for the clean case, and it is the mux's cue to reset the GDB
   side: drop GDB's pending entries, reset ack mode, re-learn caps on the next `qSupported`. Our own
   pending requests survive it — they are still legitimate.
2. **`disconnect` gives the mux nothing at all**, by design. The socket that closes is GDB's, and it
   terminates on the _client_ side; the Agent's socket to the gdb-server is untouched. So this case
   cannot be detected in-band at any level of cleverness.
3. Therefore the backstop is **`qSupported` from the GDB side means a new GDB**, whatever happened
   before. It is self-synchronising: it needs no notification, no cooperation from a detach the
   server may mishandle, and no clean shutdown — which matters, because teardown is exactly when the
   debug adapter is most likely to be killed mid-flight.
4. **But the transport can simply tell us, and that is the better primary signal.** GDB's socket
   closes on the _client_ side, where the client sees it plainly — it just had no way to say so. The
   funnel had no client→server stream close at all: `serial.close` exists because serial ports outlive
   sessions, while streams were assumed to live exactly as long as the session. That assumption is
   what was wrong. A stream's **consumer** comes and goes within a session — GDB reconnecting, an SWO
   viewer opened and closed, the live-watch GDB going away — and nothing told the Agent. So this was
   not an RSP problem at all, and fixing it there would have been fixing it in the wrong place. **Done
   as item 15c**: `CloseStream` on the funnel, and `stop_rsp_mux` calls `gdb_disconnected()` when it is
   the client that left. The in-band signals above stay useful as backstops for the case the transport
   cannot see: a GDB that detaches without its socket closing.

**The mux must never delay or swallow a `D`.** Refusing a detach leaves the firmware in whatever
state the halt left it, which is a real cost to the user and the thing several upstream detach fixes
(OpenOCD, and a SEGGER fix for J-Link) were about. GDB's frames are forwarded unconditionally in
`on_gdb_bytes` — never gated by pipelining depth or by the server tier, which apply only to packets
_we_ inject — so this holds by construction and is worth a test that says so.

A GDB **reconnect** on a connection that already negotiated `QStartNoAckMode` is a separate hazard
and not one the mux creates: the server stays in no-ack mode on that socket for ever, while a fresh
GDB expects acks. The mux cannot fix it — it cannot put the server back — but it is the only thing
positioned to _notice_ it, so it should say so in the log and the trace rather than leave GDB
retransmitting into silence.

### 3.12 GDB arriving needs a target that stays halted for the whole handshake

Diagnosed from a real failure: a second GDB connecting a few hundred ms after the first got `E0E`
(EFAULT) to its `g` packet and aborted `target-select`. Worth writing down because the obvious reading
— "a race, so fix the timing" — is wrong, and the correct reading changes what is possible.

**Registers are the only thing that needs a halt, and they are the only thing GDB insists on at
connect.** `armv7m_get_core_reg` (`src/target/armv7m.c:250`) returns `ERROR_TARGET_NOT_HALTED`
outright when `target->state != TARGET_HALTED`, while memory goes through the MEM-AP with no such gate
(§4.2.1 — 0.5 ms with a `c` outstanding). GDB's connect sequence reads registers unconditionally.

| Target state across the handshake  | `?` reply                                             | `g`   | Connect |
| ---------------------------------- | ----------------------------------------------------- | ----- | ------- |
| Halted throughout                  | a true stop reply (`T02`/`T05`)                       | works | ✓       |
| **Running throughout**             | still a stop reply — a lie (`T00`, or a stale reason) | `E0E` | ✗       |
| Halted, then resumed mid-handshake | likewise a lie                                        | `E0E` | ✗       |

Rows two and three fail identically, so the requirement is not "avoid the in-between" — it is **halted
for the entire duration of the handshake**.

**The rule the server breaks is `?`'s contract.** The manual: _"This is sent when connection is first
established to query the reason the target halted. The reply is the same as for step and continue."_ A
stop reply asserts the target is stopped, and **all-stop mode has no way to say "running"** — that is
the mode's premise. OpenOCD answers `T00`, which its own source flags as impossible:
`case DBG_REASON_NOTHALTED: return 0x0; /* no signal... shouldn't happen */`. With one connection it
_is_ impossible; with two, connection 1 resumes the target underneath connection 2, and §4.7's missing
resume notification means nothing can tell connection 2 that its world-view is stale. **GDB is the
victim of exactly the limitation that keeps our mux on the controller connection.**

**`set remote interrupt-on-connect off` is not the exemption it appears to be.** It defaults to off
(`gdb/remote.c:2101`) and only stops _GDB_ sending `\x03`. Something must still halt the target or the
connect fails, and in practice that something is the `gdb-attach` event handler: a passing session
shows `gdb-attach`, then `halted due to debug-request`, then a clean handshake. OpenOCD's
second-GDB scheme works **because** it halts; the guidance moved the rudeness from GDB into Tcl rather
than removing it.

**So a genuinely non-intrusive attach needs one of two things**, neither of which is a timing fix:

1. **Non-stop mode**, where `?` answers `OK` if all threads are running and GDB does not read registers
   for a running thread. That reply exists precisely for this case. OpenOCD declines non-stop; pyOCD
   advertises it (item 17c), which makes pyOCD the only server in §7 that might manage a true
   never-halt attach.
2. **No GDB in the path** — the Agent reading memory over the MEM-AP, which needs no handshake, no
   registers and no halt (item 20a).

**Consequence for the always-running use cases** (motor control being the one that prompted this): the
ordering fix below helps live watch at session start, where the target is halted anyway, and cannot
help here at all. This applies to the **primary** GDB as much as a secondary. Note also that 20a alone
is not sufficient for a session that must _never_ halt, because 20a still presumes a controller GDB
that attached — and attaching halted it. A never-halt monitoring session means no GDB at all, which is
a larger feature than this design covers.

### 3.13 The interrupt, audited against the manual

Checked line by line against
[E.9 Interrupts](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Interrupts.html) — the
authoritative text, not the archived copy that turns up first in a search, which predates half of
this. Only the all-stop column matters; we do not run non-stop (§4.7). Every row holds today, and the
two that hold only by accident of structure now have tests.

| What the manual says                                                                                                                            | What we do                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `\x03` is "the single byte `0x03` without any of the usual packet overhead"                                                                     | `FrameKind::Interrupt`, one byte, forwarded verbatim. **No pending entry** — it is not a packet, so there is nothing to match or time out                                                                                                                                                                                              |
| "When a `0x03` byte is transmitted as part of a packet, it is … packet data and does _not_ represent an interrupt" — e.g. inside an `X` payload | Holds structurally: `0x03` is only examined as the _first_ byte of the buffer, and once a `$` is seen the scan runs to the terminating `#`. Now pinned by a test                                                                                                                                                                       |
| "Stubs are not required to recognize these interrupt mechanisms"                                                                                | Nothing of ours waits for a reply to one. Had we given it a pending entry, a stub that ignores `\x03` would have left it outstanding for ever                                                                                                                                                                                          |
| A successful stub "should send one of the stop reply packets"                                                                                   | In all-stop that reply also answers GDB's outstanding resume, so it matches that entry rather than arriving unattributed. If none is outstanding it is unmatched and forwarded to GDB, with the state observed either way (§4.1)                                                                                                       |
| "Interrupts received while the program is stopped are **queued** and the program will be interrupted when it is resumed next time"              | `interrupt_pending` now **survives a resume**. It used to be cleared, which described the following run as open-ended when it was about to stop at once. Any halt clears it, so it cannot stick                                                                                                                                        |
| In non-stop GDB sends `vCtrlC` instead                                                                                                          | Not modelled, deliberately, and `classify_client` says so at the spot where it would go. It is a packet, so if one ever arrives it is classified `ORDINARY` (`OK`/`E nn`) — accidentally the right shape                                                                                                                               |
| `BREAK`, or `BREAK` then `g`, selectable with `interrupt-sequence`; over TCP the telnet `BREAK` sequence                                        | Forwarded byte for byte, because unrecognised bytes between frames are `FrameKind::Garbage` and **garbage is still forwarded**. So a user who sets `interrupt-sequence break` is not broken by us — but the trace calls those bytes garbage, which would mislead anyone reading it. Cosmetic; worth a special case if it ever comes up |

**The one rule that matters beyond forwarding.** A queued interrupt fires on the _next_ resume,
whoever issues it. If the Agent could resume the target, a `\x03` that GDB sent and gave up on would
halt the target under our resume, and GDB would receive a stop reply for a run it never started.
§4.5 forbids us from sending any resume, so this cannot happen — but it is a second, independent
reason for that rule, and a reason it must not be relaxed for "just a single step".

Multiple `\x03`s need no handling at all: each is implementation-defined, extras are queued, and we
count none of them. This was checked because it looked like it might need bookkeeping; it does not.

---

## 4. The multiplexer

### 4.1 Sources, queues, and routing

```rust
/// Who a request came from, so its reply can be routed back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RspSource {
    /// The user's GDB, on a funnel stream. Bytes in and out are verbatim.
    Gdb(u8),
    /// One of our internal consumers (RTT, profiler, trace drain).
    Agent(ConsumerId),
}

struct Pending {
    source: RspSource,
    /// Our own monotonic id. Not on the wire — RSP has no request ids (§3.8);
    /// this exists for logging, timeouts and retiring the FIFO head.
    seq: u64,
    kind: PacketKind,
    sent_at: Instant,
    /// Set for `c`/`s`/`vCont;c` — no reply until the target stops (§3.9).
    open_ended: bool,
}
```

The mux holds one `VecDeque<Pending>` in send order. Resolving an entry yields its `source`, which
says where the bytes go:

- `Gdb` → forward the **raw** reply bytes as a funnel frame on that stream.
- `Agent(id)` → decode and complete that consumer's one-shot.

#### Replies do not arrive in send order, so the head is the wrong answer

An earlier draft of this section said a reply "retires the head". **That is wrong, and it is wrong
in exactly the case the whole design exists for.** While GDB has an open-ended `c` outstanding we
send an `m` behind it; the `m` reply comes back first, because the `c` is answered only when the
target halts, perhaps minutes later. Retiring the head would hand our memory data to GDB as its
stop reply, and hand the real stop reply to a consumer expecting bytes.

The rule that works: **a reply resolves the earliest pending request that could have produced it.**
Each entry records what its reply set contains:

| Request                       | Stop reply?         | Anything else? | Open-ended? |
| ----------------------------- | ------------------- | -------------- | ----------- |
| `c`, `C`, `s`, `S`, `vCont;c` | yes                 | no             | **yes**     |
| `?`                           | yes                 | no             | no          |
| `vAttach`, `vRun`             | yes                 | yes            | no          |
| `m`, `M`, `x`, `X`, `q…`      | no                  | yes            | no          |
| `R`, `k`                      | — no reply at all — |                |

A two-way "is it a resume" split is **not** enough, and the unit tests caught that: `?` is not a
resume yet is answered by a stop reply, and `vAttach` may be answered either way. The two classes
stay distinguishable because a stop reply's tag is uppercase (`S`/`T`/`W`/`X`) while hex memory data
is lowercase, so no `m` reply can be read as one.

`R` and `k` draw no reply, so they get **no pending entry** (beyond ack accounting). Tracking them
would hold a slot for ever and — worse — let them match a reply belonging to one of _our_ requests,
routing target memory to GDB.

**Open-ended requests are exempt from the pipelining budget.** Otherwise a single `c` at depth 1
would block the Agent for the entire run, which is precisely the interval we exist to work in. A
_prompt_ request of GDB's does count: at depth 1, one of our reads waits behind GDB's `m`.

Two further rules, both of which started as bugs the tests found:

- **Observe run state before matching, and whether or not anything matches.** A stop reply is a
  fact about the target regardless of which request drew it, and some are unsolicited — the target
  can halt on its own, or in response to a `\x03`, which is not a packet and so has no entry to
  match. Skipping the update for unmatched replies left the state at `Unknown` and the send gate
  shut for the whole session.
- **An ack we cannot attribute goes to GDB.** We swallow only acks positively matched to our own
  packets; dropping one GDB was owed stalls it permanently.

### 4.2 Pipelining

**Read the server-behaviour findings in §4.2.1 before tuning this.** The short version: the servers
are strictly serial, so pipelining buys much less than it appears to, and in ack mode it is
actively unsafe. Implement `depth = 1` first; treat `depth = 2` as a measured optimisation gated on
no-ack mode, configurable, with a per-server override from the matrix (§11 item 17).

The send gate — the whole policy in one predicate:

```rust
fn may_send_agent_packet(&self) -> bool {
    self.handshake_settled                  // ack mode + first stop reply observed (§4.4)
        && self.gdb_send_queue.is_empty()   // invariant 2: GDB never waits on us
        && self.pending.len() < self.depth
        && !self.pending.iter().any(|p| p.kind.is_file_io())   // F reply must follow its request
        && (self.answers_while_running || self.state == TargetState::Stopped)
}
```

Note what is _not_ in the gate: the presence of an `open_ended` GDB `c` in the FIFO. That is
exactly the case we need to work, and whether it does is the `answers_while_running` capability.
A server without it degrades to halted-only, and the gate says so honestly.

GDB's packets are never gated. They go out as they arrive, ahead of anything of ours that is
queued but unsent.

### 4.2.1 What the servers actually do — read from OpenOCD's source

These are not inferences. `src/server/gdb_server.c` in the OpenOCD tree settles four things, and
the shape is expected to be common to the others: they are single-threaded, and they read the first
byte of the next packet only _after_ replying to the last one. Ctrl-C arrives through that same
path, not a side channel.

**1. The risk in §2 is resolved for OpenOCD: memory reads are not gated on halt.**
`gdb_input_inner`'s dispatch switch sends `'m'` straight to `gdb_read_memory_packet`, which calls
`target_read_buffer` with **no check on `target->state` or `frontend_state`**. Same for `'M'`. So a
memory request arriving while the target runs is served, exactly as this design needs. Combined
with the "lingering reply" comment in `gdb_frontend_halted` — which is OpenOCD's own name for the
open-ended `c` of §3.9 — the interleaving this design depends on is something OpenOCD's structure
already accommodates.

**2. Pipelining is unsafe in ack mode, and safe in no-ack mode.** After writing a reply,
`gdb_put_packet_inner` does:

```c
if (gdb_con->noack_mode)
        break;
retval = gdb_get_char(connection, &reply);   /* expects '+' or '-' */
...
} else if (reply == '$') {
        LOG_ERROR("GDB missing ack(1) - assumed good");
        gdb_putback_char(connection, reply);
```

So in **ack mode** a second packet sent before we acked the first reply lands where the `+` was
expected. OpenOCD recovers — it puts the `$` back and logs "GDB missing ack" — but that is an error
path, and nothing says another server is as forgiving. In **no-ack mode** it breaks out
immediately and the next packet is read normally.

> **Rule:** `depth > 1` requires no-ack mode. The handshake quiet period (§4.4) already prevents us
> sending anything before the mode has settled, so this costs nothing to enforce.

**3. Pipelining's benefit is small, and not the one stated above.** `gdb_input_inner` wraps its
dispatch in `do { … } while (gdb_con->buf_cnt > 0)`, so it does drain several queued packets per
wakeup rather than returning to `select()` between them. But it handles them **strictly in
sequence** — there is no overlap of the SWD work itself, because there is one thread. So depth 2
does not keep the probe busier; it only removes the loopback round trip and our own scheduling from
between consecutive requests. Against SWD reads measured in hundreds of microseconds, that is
noise. Worth measuring, not worth designing around.

**4. A stray ack in no-ack mode is noticed.** `gdb_get_packet_inner` logs
`"acknowledgment received, but no packet pending"` for a `+` once `noack_mode > 1`. So the rule in
§4.3 — ack only in ack mode, never in no-ack mode — is enforced by the server's log if we get it
wrong. Useful during bring-up: that warning in OpenOCD's output means the mux's ack accounting is
broken.

### 4.3 Ack accounting is now our problem

In ack mode, acks are untagged — a bare `+`. On a shared socket this would be hopeless except for
the sole-writer property: the mux knows the exact order it wrote packets, so the server's acks come
back in that order. Concretely:

- The server's `+` for **GDB's** packet → forward to GDB.
- The server's `+` for **our** packet → swallow it. Forwarding it would give GDB an ack it never
  earned, and GDB counts.
- A reply destined for **us** must be acked _by us_ — the server is waiting for one and will
  retransmit otherwise.
- A `-` means resend the packet at that position. Three failures on one of ours is a fatal channel
  error for that consumer; three on GDB's is a fatal channel error for the session.

And the switch point: when the mux sees GDB's `QStartNoAckMode` and the server's `OK`, it flips
both directions of its codec **at that exact byte boundary**. A one-packet error here desynchronises
everything after it. This deserves its own test with a captured transcript.

### 4.4 Handshake quiet period

No Agent packet is sent until the mux has observed:

1. GDB's `qSupported` exchange complete (so `RspCaps` is known — `PacketSize` in particular, which
   bounds our reads), **and**
2. ack mode settled (either `QStartNoAckMode`+`OK` seen, or GDB's first few packets acked such
   that we know it is staying in ack mode), **and**
3. a first stop reply, so `TargetState` is not `Unknown`.

This costs nothing — no consumer has anything useful to do before the session is connected — and
removes a whole class of startup races.

### 4.5 Forbidden packets — a single choke point

Every outbound Agent packet passes through one function that rejects, with a `debug_assert` and a
hard error in release:

- **Execution control:** `c`, `C`, `s`, `S`, `vCont;*`, `R`, `vRun`, `vAttach`, `k`, `\x03`,
  `vCtrlC`. The user's GDB owns execution. A profiler that halts the target to sample it is
  measuring itself.
- **Breakpoints/watchpoints:** `Z`, `z`.
- **Mode and selection:** `Hg`, `Hc`, `QNonStop`, `QStartNoAckMode`, `qSupported`.
- **Transfers GDB is mid-way through:** any `qXfer`.

OpenOCD documents essentially this contract for its own second-connection case — the extra client
must run with `set remote interrupt-on-connect off` and must never pause, continue or step. We get
the `interrupt-on-connect` half for free by speaking raw RSP: we simply never send `\x03`.

**Allowed:** `m`, `M`, `x`, `X`, and `qRcmd` (monitor) subject to review per command.

**Deferred, with caveats:** `g` / `p` (register read). Almost certainly requires the target
halted, and formally depends on `Hg` — which we are forbidden to set. On a single-core MCU the
selected thread never changes, so reading with whatever GDB selected is probably right; that
"probably" is why it is deferred rather than in the first cut. Stack probing needs `SP`, so this
becomes real at Phase 4 item 23, not before.

### 4.6 Threading and placement in `ProxyServer`

Today a gdb RSP stream is asymmetric, and this dictates the shape:

- **server → GDB** runs on a per-stream thread: `read_and_forward()` in
  `proxy_helper/proxy_server/gdb_server.rs`.
- **GDB → server** runs on the **message-loop thread**: `ProxyEvent::IncomingData` is demuxed in
  `message_loop()` (`proxy_server/mod.rs`) and written straight to `pinfo.stream`.

The mux takes ownership of the server socket in place of `PortInfo.stream` for
`StreamKind::GdbRsp` streams, and owns two threads of its own:

- a **reader thread** (replacing that stream's `read_and_forward`) which decodes frames, updates
  state, retires the FIFO, and emits `ProxyEvent::StreamData` for GDB-destined bytes;
- a **writer thread** draining the send queue, so that nothing — not a slow server, not a full
  socket buffer — can block the message loop.

`feed_from_gdb(&bytes)` is therefore _enqueue and return_. It is called on the message-loop thread
and must never block. This is a hard requirement: the message loop is single-threaded and already
warns when a request waits 250 ms behind other work.

### 4.7 One mux, on the controller connection

A core's gdb port carries one **controller session** — the GDB that drives execution — and zero or
more **secondary sessions** (the live-watch GDB today; a second user GDB in principle). The naming
describes the _role_, not the ordering; describing it positionally is what produced the wrong
explanation in §2 in the first place.

**The mux goes on the controller connection, and nowhere else.** Two settled facts make that the only
workable arrangement rather than a preference:

1. **A stop reply reaches only the connection that issued the resume.** OpenOCD notifies every
   connection _internally_ — the doubled `gdb-end` in §2 proves each connection's callback runs — but
   `gdb_frontend_halted` filters on that connection's own `frontend_state` before anything reaches
   the socket. Measured: 4 breakpoint halts, **0 packets of any kind** to the secondary.
2. **RSP has no resume notification at all, for anyone.** No packet means "the target is now
   running"; the resuming client knows because it asked. That is a protocol-level absence, so **no
   server can ever fix it.**

Together those make a secondary connection's run-state model **structurally impossible to maintain by
listening** — it would miss every resume even if halts did propagate. Polling `?` is the only
alternative, and that is a poll with a stale window, not a state model.

The controller connection gets both halves for nothing: it issues the resumes, so it knows when the
target starts, and it is where the stop reply comes back. A mux sitting there has an exact state model
with no added traffic.

**So secondaries need no mux and need not be modelled.** The live-watch GDB keeps doing exactly what
it does today via `handle_duplicate_stream` and `read_and_forward` — untouched, and none of the mux's
business. A secondary still costs a connection slot (hence `CDLiveWatchSetup`) and contends for the
probe, but neither is a protocol matter.

**This simplifies the design rather than constraining it.** `MuxCore` handles exactly one GDB client
(`RspSource::Gdb` is singular) and owns its own `StateTracker`; since the only connection ever muxed is
the one that resumes, that is correct by construction. An earlier draft treated the per-connection
tracker as a latent bug needing a per-core extraction before a second stream could be muxed — with this
rule there is no second stream to mux.

One mux per core still follows, because there is one controller per core.

**Superseded for the case that motivated it.** Live watch is to become one of the Agent's own
consumers — memory reads and writes on the controller connection — rather than a second GDB (item
20a). That delivers everything the list below promises, with no per-client virtualisation at all,
because there is no second GDB left to virtualise. The maximal mux is therefore only interesting if
someone wants a genuine **second user GDB**, which nobody has asked for. Kept for the record:

The maximal version — all GDB clients _and_ all our consumers on a single server socket per core —
has grown more attractive in light of §2:

- It would make live watch work even on a strictly single-connection server.
- It would **remove the need for `CDLiveWatchSetup` entirely** — no `-gdb-max-connections` bump, no
  Tcl helper the user has to load before `init`, and no equivalent to invent for every other
  server.
- **It would stop a second connection wiping the first one's breakpoints — see §4.7.4.**
- It would let the mux _give_ a secondary the run/stop state no server can send it (see above: RSP has
  no resume notification, so this is not a server shortcoming to wait out). That is a capability the
  current architecture cannot provide at all.

Against that, it requires the mux to **virtualise per-connection state per client** (§3.10, first
half): separate `qSupported` negotiation, separate ack mode, separate `Hg`, separate `qXfer`
windows, and an ownership policy for `Z`/`z` — which is per-core state that two GDBs would both
believe they own. That last one is the hard part and is not a small design. Out of scope here;
recorded in §12 q4, and the Phase-2 FIFO should be written so as not to preclude it.

### 4.7.4 A second GDB connection wipes breakpoints and watchpoints (OpenOCD)

`gdb_new_connection()` (`src/server/gdb_server.c:1023`) calls, unconditionally:

```c
breakpoint_remove_all(target);
watchpoint_remove_all(target);
```

It is registered as `.new_connection_handler` (`:3934`), so it runs for **every** connection, and
`gdb_actual_connections++` happens _after_ these lines — there is not even a latent guard. The removal
reaches the hardware rather than just OpenOCD's bookkeeping: `breakpoint_remove_all` →
`breakpoint_remove_all_internal` → `breakpoint_free` → `target_remove_breakpoint`
(`src/target/breakpoints.c:295`). On an SMP group it hits every target in the group.

**It dates from 2008** — `a71ca65c5`, "Clear all dangling breakpoints upon GDB connection". Commit
`e5888bda3` (Aug 2025) only renamed the calls from `breakpoint_clear_target`; the old function was
line-for-line the same logic through the same `breakpoint_remove_all_internal`. (Its watchpoint half
did change behaviour for SMP groups, per that commit's own message.)

The consequence worth planning around: **no OpenOCD version is free of this**, so the decade-old
builds still shipping in some distributions behave exactly like master. There is nothing to backport
and nothing to wait for, which means a workaround has to exist on our side regardless — as one has,
in the debug adapter, for years.

**How much it hurts depends on GDB's insertion mode, and the default mostly saves us.**
`set breakpoint always-inserted` defaults to **off**: _"breakpoints are inserted only when execution
continues, and removed when execution stops"_ (`gdb/breakpoint.c`, the setting's own help text). So:

| When the second connection arrives             | Effect                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Target **halted** (our normal live-watch flow) | Near-no-op — GDB had already removed them at the last stop, and re-inserts on the next continue                                         |
| Target **running**                             | **Breakpoints yanked out of hardware; GDB is never told.** The target runs past them until the next stop→continue cycle re-inserts them |
| `always-inserted on`                           | Gone until the user deletes and recreates them                                                                                          |

Watchpoints are the larger exposure: they are typically set once and left, so nothing re-inserts them
on the next resume the way breakpoints get re-inserted.

Two things follow:

1. **The cleanup is in the wrong place, and guarding it on the connection count would not fix it.**
   The comment justifies the removal as cleaning up after _"a previous GDB session [that] could leave
   dangling breakpoints if e.g. communication timed out"_ — but that is a **detach** obligation, and
   `gdb_connection_closed()` (`:1140`) does no breakpoint or watchpoint cleanup at all. Doing it on
   connect instead breaks the one operation that must never disturb target state: **an attach.** That
   is why debuggers attach first and only then reset, which is what re-establishes breakpoints for a
   launch-type session; an attach-type session attaches and goes, and must find the target as it left
   it. A `gdb_actual_connections == 0` guard would still wipe on the first connection, so it would
   still break attach — it would only narrow the damage. The fix belongs in the close path.
2. **It is an argument for the maximal mux (§12 q4) that has nothing to do with performance.** One
   connection means `gdb_new_connection` runs once, so no arrival of a live-watch or second user GDB
   can disturb target state at all. Every other server in §7 needs checking for the same pattern.

**Decision recorded:** once §7's matrix is filled, **live watch moves onto the controller session** for
every server that supports it — no second GDB connection, so none of this applies. A mixed fleet, if
one turns up, is a bridge to cross then. Note also that OpenOCD's own documentation describes the
second-GDB-connection method for inspecting memory, which is where our live-watch design came from;
that makes the wipe-on-connect a documented approach undermined by its own implementation.

**Adapter-side, meanwhile:** connect the live-watch GDB **immediately after the primary's connection
succeeds, and before doing anything else with the primary.** Not tied to `InitializedEvent` or
`configurationDone` — those are driven by VS Code, which sets breakpoints and can resume in between, so
they leave both the §4.7.4 breakpoint window and the §3.12 halt window open.

Anchoring on the primary's success closes both by **causation rather than timing**: the primary's own
connect read registers, which _proves_ the target was halted at that instant (§3.12), and the only
thing that would resume it is the primary work we have not started yet. It also means the second
attach's `gdb-attach` halt is a no-op, so nothing is halted rudely.

Two refinements belong in it. **Spawn the live GDB process early but let it attach late** — the process
launch is the slow part and touches nothing, so it can overlap the primary's connect while only the
attach waits for the halted window; otherwise session start pays the whole cost serially. And **a
live-watch failure must not fail the session** — it is an optional feature, and moving it onto the
critical path turns an unguarded failure from cosmetic into fatal. The same ordering has to hold on the
restart/re-attach path. Tracked as a debug-adapter sequencing fix, separate from this design.

### 4.7.5 One local connection, one server connection

**The Agent mirrors the gdb-server rather than improving on it.** Each local consumer gets its own
connection to the server — which is what `duplicateStream` is for — and if the server refuses the
second one, so do we. No local fan-out of one server connection to several consumers.

**Scope: streams that _are_ a gdb-server port.** `gdbPort`, `swoPort`, `tclPort`, `telnetPort`. It says
nothing about services the Agent provides itself: once RTT is ours (item 20) we set its policy, which
has nothing to do with any gdb-server's. Note also that RTT is **bidirectional** — down channels take
host input — so it was never a candidate for "safe to fan out" reasoning in the first place. SWO is the
only genuinely unidirectional one, and for it mirroring the server is fine; if real demand for several
viewers ever appears, fan-out can be added _on top_ without disturbing this rule.

This is a correctness position, not a purity one. A fan-out would silently share **per-connection
state** between consumers: one `qSupported` negotiation, one ack mode, one `Hg`, one `Z`/`z` table
seen by two clients that each believe they own it (§3.10). That is precisely the corruption the
maximal mux would have to do real work to avoid, arrived at by accident instead. And it would hide a
server's limits at the moment they matter: **probe-rs allows only one GDB connection.** A user whose
live watch quietly misbehaves is worse off than one told it is unavailable, and the same reasoning
retired the RSP-port probe in §4.6 — do not do things to a server it cannot distinguish from a real
client, and do not pretend on a server's behalf.

It also settles a question the transport gap raises (item 15c): with 1:1 there is exactly **one
consumer per stream**, so "my consumer went away" is unambiguous. A fan-out would have forced a
distinction between "one of several closed" and "the last one closed".

**Expect no `ECONNREFUSED`, and make the refusal attributable anyway.** OpenOCD at its connection
limit `accept()`s and immediately `close()`s, logging _"rejected '%s' connection, no more connections
allowed"_ (`src/server/server.c:560`). That is not sloppiness — a server cannot close its _listening_
socket while it is still serving other clients, so accept-then-close is the only refusal available to
it. So `wait_and_connect_sync` succeeds, the client is told `StreamStatus: Connected`, and the refusal
arrives moments later as a bare `StreamClosed` with no stated cause. RSP is client-speaks-first, so a
legitimate new connection is silent too and timing alone cannot separate them. Clients do learn this
quickly by experiment, so this is a clarity improvement rather than a defect: **a stream that closes
before carrying a single byte in either direction is a failed open, not a close**, reported against
the request that created it.

**Where discovery-by-attempt was not acceptable: probe-rs used to crash rather than refuse a second
connection**, so "try it and see" cost the whole session. **Re-measured on a current version (2026-09):
it now refuses cleanly and the first GDB session carries on** -- though it says nothing on its own
stdio about having refused, so the only evidence is on our side. That makes discovery-by-attempt
survivable there, but the limit is still better **declared per server** than probed: probe-rs errors
and panics readily on anything slightly unexpected, and its gdb-server is a side project rather than
its supported interface. §7's matrix has the row.

**The consequence to accept deliberately:** on a strictly single-connection server, honest 1:1 means
live watch is _unavailable_ rather than quietly degraded. That makes item 20a — live watch as an Agent
consumer on the controller connection — the only route to it there, rather than an optimisation of a
path that already works. It stays low priority for OpenOCD and J-Link; it is the whole story for
probe-rs.

### 4.7.1 Chunking belongs in the Agent, not in the clients

**Decision.** A logical memory access is split into packets, and the replies reassembled, on the
**Agent side** — `chunk.rs`, layered on top of `MuxCore`. Consumers ask for an address and a length
and get bytes; they never see `PacketSize`, the `x`-versus-`m` choice, or a short reply.

Two reasons this is the right side of the line:

1. **Only the Agent knows the answer.** `PacketSize` comes out of the `qSupported` exchange, which
   only the mux observes. The TypeScript side has never had a way to find out, and so chunks every
   memory request at a blind **512 bytes** regardless of the server — a number inherited from
   OpenOCD's old limit, which has been 16384 for years. Splitting Agent-side deletes that guess
   rather than relocating it.
2. **It protects the session from one careless client.** A consumer asking for a megabyte gets a
   megabyte in as many packets as it takes, not a broken connection.

**`MuxCore` stays out of it.** It holds no state for splitting requests or coalescing replies and
routes single packets only — the simplicity is deliberate, because the routing rules in §4.1 are
subtle enough on their own. `chunk.rs` is the layer above, and is itself pure: it plans packets and
accepts replies, with no I/O and no knowledge of how they travel.

**TypeScript still gets told the number.** Phase 3 item 13 adds `packet_size` to `PortReserved`
(already on the wire for every `gdbPort` stream), so a client that wants to size its own requests
can, and the 512 can be retired even on paths that do not go through `chunk.rs`.

### 4.7.2 GDB is the mux's first client, so the mux gets its own TCP port

**GDB is the mux's number-one client** — by packet volume, and as the only one whose latency a human
feels. The Agent's internal consumers poll in the background; GDB is what someone is sitting in front
of pressing Step. So the transport question is settled by GDB's needs, and the consumers' needs are a
footnote to it rather than the other way round.

**GDB is a TCP client, in every topology.** It connects to a port and speaks RSP. That never varies.
What varies is only _who binds that port_:

| Topology  | Who binds the port GDB connects to           | Path from GDB to the gdb-server         |
| --------- | -------------------------------------------- | --------------------------------------- |
| **Local** | the **Agent**, in front of the mux           | GDB → mux → gdb-server, all in Rust     |
| Remote    | the TS proxy-client, on the Engineer Machine | GDB → funnel → Agent → mux → gdb-server |

So the mux's client side is **primarily a TCP listener**, and the funnel is the variant forced on us
when the probe is on another machine — not the other way about. There is genuinely no choice remotely:
GDB cannot reach a loopback port on the Probe Host, which is why the funnel exists at all.

#### `TcpPortDef` already models this, so the churn is small

`TcpPortDef { name, localPort, remotePort }` (`adapter/servers/common.ts`) already carries exactly the
split this needs, and the codebase already honours it:

- **`localPort`** — where GDB connects. `connectCommands()` builds
  `target extended-remote 127.0.0.1:<localPort>`.
- **`remotePort`** — the gdb-server's own port. `serverArguments()` passes it as `gdb_port <remotePort>`.

Today the TS proxy-client binds `localPort` (`proxy-client.ts`, `.listen(portDef.localPort, "127.0.0.1")`)
and funnels to `remotePort`. **The local-with-mux case is the same shape with both ends on one
machine**: the only change is that the _Agent_ binds `localPort` and the mux sits directly behind it.
GDB's contract does not change, `connectCommands()` does not change, and no new concept enters the TS
data model. The Agent simply has to report the port it bound — which is one more field on
`PortReserved`, alongside the `packet_size` already planned for Phase 3 item 13.

That also disposes of a worry worth stating so nobody re-raises it: this is **not** two extra ports per
core. It is the same two ports the proxy path already allocates, both bound on the Probe Host in the
local case.

#### Why not just funnel locally too

| Path                               | TCP hops | Node.js in the RSP hot path?                       |
| ---------------------------------- | -------- | -------------------------------------------------- |
| Today, local, no proxy             | 1        | no                                                 |
| Local via the funnel               | 3        | **yes** — every packet through the TS proxy-client |
| Local via a mux-owned TCP listener | 2        | no                                                 |

The hop count is the lesser argument. The real one is that funnelling locally puts the Node event loop
between GDB and the gdb-server for _every RSP packet_ — jitter on interactive latency, not a fixed
cost, and the kind of thing users experience as "the debugger feels sluggish" without ever filing a
useful bug. A mux-owned listener keeps the whole RSP path in Rust, costs one extra loopback hop over
today, and keeps the mux in the byte path so Agent-side RTT works locally, which is what §8 needs.

**The core does not care.** `on_gdb_bytes` and `Action::ToGdb` are a byte sink and source; `MuxCore`
cannot tell a funnel frame from a TCP accept. Being sans-IO makes this a deployment choice rather than
a rewrite, and lets Phase 4 item 21 settle it by measurement.

#### The Agent's own consumers need no transport at all

RTT, the profiler and the trace drain are **in-process** with the mux once they are in Rust — a channel
call on the Probe Host, next to the probe. That is the entire point of moving them; handing their
results back out over TCP or a funnel stream would reintroduce the hop this design exists to delete.
`ConsumerId` routes a reply to the right consumer; it is not ownership.

The serial `attach_client`/`detach_client` protocol is deliberately **not** copied, for a real
difference rather than taste. A serial port is a **shared resource that outlives every session**:
`OpenPort` carries `direct_refs` and a per-session funnel map precisely so the device survives one
session ending while another still holds it, and so an admin force-close can take it away. The RSP mux
has none of those properties — per session, per core, created when the gdb stream connects and
destroyed with the session (the _parent_ session for chained configurations; §12 q8). Nothing to
refcount, nothing to keep alive, no second owner.

There is also **no TypeScript-side RSP consumer today**: the memory view and live watch both go through
GDB. If one ever appears, the right shape is a typed control-channel request — "read me these bytes" is
an RPC with `seq` correlation, not a byte pipe — and not a new funnel stream.

**RTT data flowing _out_ to the UI is a different question with a different answer**: that _is_ a byte
stream to the extension, so it is a funnel stream, exactly like serial's funnel transport. Keeping it
distinct from RSP _access_ is what stops the consumer side being over-built.

#### The load profile is reassuring

RTT and profiling run while the target is _running_; GDB's heavy traffic — stack walks, variable reads —
happens while it is _halted_. The two loads barely contend for the link. What needs protecting is GDB's
interactive latency, which is paid per packet per hop, which is the table above.

### 4.7.3 Packet tracing

**`trace.rs`, to its own file, enabled from `debugFlags`.**

GDB's `set debug remote` and OpenOCD's `gdb_log_*_packet()` are **endpoint** traces: two directions,
each side seeing only its own half. The mux is a **relay with four parties**, and the two that matter
most are invisible to both of those tools:

| Party     | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| `GDB>SRV` | forwarded from GDB — GDB's own trace shows this too     |
| `SRV>GDB` | forwarded to GDB — likewise                             |
| `AGT>SRV` | **injected by the Agent** — no other tool can show this |
| `SRV>AGT` | **consumed by the Agent**, never forwarded — likewise   |

Every token is exactly seven ASCII characters, so columns align and `grep AGT` isolates the Agent's
traffic exactly. The interleaving of `AGT>SRV` against an outstanding `GDB>SRV` continue is the thing
that cannot be seen any other way, and it is where §4.1's subtleties live.

```text
# mdbg RSP trace  stream=gdbPort  level=All
      0.076  GDB>SRV  $qSupported:multiprocess+;swbreak+#f7
      3.891  SRV>GDB  $PacketSize=4000;QStartNoAckMode+;vContSupported+#02
     11.498  GDB>SRV  $vCont;c#a8
     15.261  AGT>SRV  $m20000000,4#4f   c1/s42
     19.035  SRV>AGT  $deadbeef#3c   c1/s42 rtt=0.412ms
     22.818  SRV>GDB  $0* #b0   (rle/esc)
     26.589  AGT>SRV  $X20000010,3:\x00\x01\xff#00   c1/s43
```

Decisions worth keeping:

- **Its own file, not the shared log.** Volume; timing value diluted by prose; you want to diff two
  runs. Decisively: routing trace lines through the shared logger puts that logger's locking and
  formatting in the RSP hot path.
- **Never adds latency; lossy under pressure instead.** A bounded queue drained by a dedicated
  writer thread. When full, records are **dropped and counted**, and the gap is written into the
  file rather than passing as silence. Same principle as
  [Stream-Flow-Control.md](./Stream-Flow-Control.md) — a trace that slows what it measures produces
  numbers nobody can trust. Timestamps are taken at record time, not write time, because under load
  the queue delay is exactly the interval being investigated.
- **Raw bytes, as on the wire**, so lines can be compared against GDB's and OpenOCD's own traces.
  Non-printables as `\xNN`, truncated at 512 bytes with the full length noted, and an RLE or escaped
  body flagged `(rle/esc)` because raw would otherwise look corrupt.
- **Round-trip time on our replies**, which makes it a profiling tool and not just a dump.
- **Three levels** — `off` / `packets` / `all`. `all` includes acks: noisy, and exactly what an
  ack-accounting problem needs.
- **The core emits, the shell writes.** `MuxCore` produces `Action::Trace`, `channel.rs` records it.
  That keeps the core sans-IO while putting the decision where the knowledge is — **provenance is
  only knowable in the core**: by the time the shell sees `ToServer` bytes it cannot tell GDB's
  forwarded packet from ours, and the replies we consume never become a `ToGdb` at all. (An earlier
  sketch proposed adding a `source` field to `Action::ToServer`; an explicit `Trace` action turned
  out cleaner and left the existing tests untouched.)
- **Level is switchable on a live channel**, so a trace can be turned on while a session is already
  misbehaving rather than only on the next run.

**Enablement is `debugFlags.rspTrace` in launch.json**, carried to the Agent over the control
channel. `debugFlags` already holds `gdbTraces`, `liveGdbTraces` and friends, so this is where users
already look, and a control request can toggle a _running_ singleton Agent — which an environment
variable cannot. No `MDBG_RSP_TRACE`: the `MDBG_PROXY_TOKEN` precedent exists to keep a _secret_ out
of a `launch.json` under source control, and a trace level is not a secret. Server-side defaults, if
ever wanted, are command-line flags.

> **Editing note:** `debugFlags` is declared in `packages/mcu-debug/manifest-src/definitions.js`.
> `package.json` is **generated** from it — editing the manifest directly is lost on the next build.

**Built, and per session, which is the only thing that can work.** `debugFlags.rspTrace` and
`debugFlags.rspMux` travel on `initialize` as `SessionDebugFlags` — per connection, therefore per
session. This is not a preference: **a proxy is a shared daemon serving several sessions and clients
at once**, so a process-wide switch cannot express "trace _this_ session". Turning tracing on would
trace everybody's, and turning the mux off would take it out of the path for someone else's session
mid-debug.

`--rsp-trace` and `--no-rsp-mux` remain as that proxy's **defaults**, for a dev daemon you want set
one way throughout; a session's own value overrides them. Only the two flags the Agent can act on are
on the wire — the client maps them across rather than forwarding `debugFlags` wholesale, which keeps
the protocol in snake_case and out of the launch schema's business.

One consequence worth recording: these flags must **not** count towards the extension's `anyFlags`,
which means "print my own debug output". Without the exclusion (`AGENT_DEBUG_FLAGS` in
`servers/common.ts`, applied in `gdb-session.ts` and `cli/main.ts`), `rspMux: true` would silently
switch on every GDB/MI trace in the Debug Console — and the two would behave differently from each
other purely because one happens to be a string.

One file per muxed stream, named `rsp-trace-<stream>-<pid>-<n>.txt` in the proxy's log directory. The
`<n>` is not decoration: one proxy serves many sessions and stream ids restart at 3 in each, so pid
and name alone would have two concurrent sessions interleaving into one file.

### 4.8 How mux clients must behave

The mux enforces what it can (§4.5), but most of the discipline has to live in the clients — RTT,
the profiler, the trace drain. **GDB behaves well implicitly**, because it is a mature RSP client
that negotiates before it acts. Our clients have to do the same thing explicitly, and they are the
ones being written from scratch:

- **Check the capability before using it, every time.** Never send a packet on the hope that this
  server supports it. `RspCaps` and the tier in §7 exist to be consulted, not to be logged.
- **If a capability needed for a feature is absent, find another way or decline the feature.** Say
  "not supported with this gdb-server" plainly and stop. Do not degrade into probing, retrying, or
  guessing — a client that keeps trying something the server does not do is how a stable session
  becomes an unstable one.
- **Never send anything speculative.** No capability probes of our own, no "let's see if this
  works" packets. Whatever we learn, we learn by watching GDB's negotiation (§4.4) or from the
  tier table.
- **Assume nothing about atomicity.** A read while the target runs can tear (§12 q6). Clients that
  care must validate what they read — the RTT ring protocol already does — rather than assuming the
  mux gives them a coherent snapshot. It does not, and cannot.

This is a rule about our code, not about any particular server, and it is worth stating because the
cost of getting it wrong is not a failed read — it is a destabilised debug session that the user
will blame on the debugger.

---

## 5. Run-length encoding — what the manual is actually saying

You are right to find the GDB manual confusing here, and the "5 or 6" memory is a real thing.
It is not conventional RLE and it has holes.

**The encoding.** In a stub→GDB reply, `*` means: the character _before_ the `*` repeats, and the
character _after_ the `*` encodes the count as `chr(n + 29)`. So the count character is decoded as
`n = byte - 29`. GDB's own `read_frame()` in `remote.c` computes it as `c - ' ' + 3`, which is the
same thing (`c - 32 + 3`).

**Where the "5/6" comes from.** The manual says the count characters `$`, `#`, `+` and `-`, and
anything above ASCII 126, must not be used. Work those back through `n = byte - 29` and you get a
set of counts that simply **cannot be expressed**:

| Excluded character | ASCII | Unencodable count `n` | Why excluded                                   |
| ------------------ | ----- | --------------------- | ---------------------------------------------- |
| `#`                | 35    | 6                     | **Structural** — framing terminates at `#`     |
| `$`                | 36    | 7                     | **Structural** — framing resynchronises at `$` |
| `+`                | 43    | 14                    | Convention — would confuse an ack scanner      |
| `-`                | 45    | 16                    | Convention — would confuse an ack scanner      |

So the encodable counts are `n` in `[3, 97]` **minus `{6, 7, 14, 16}`**. The floor of 3 is because
below that the encoding does not save space; 97 is the ceiling because `chr(126)` is the last
printable byte. A run of exactly 6 or 7 has to be emitted some other way (literally, or as a
shorter run plus literals) — which is almost certainly the "5/6 repeats" detail you remember, read
back the wrong way round.

**The two exclusion reasons are not the same, which the implementation made obvious.** Counts 6 and
7 are not merely forbidden by the spec — they are **impossible to represent at all**, because the
framing layer consumes `#` and `$` before any payload decoder sees them. GDB's `read_frame()` is
built the same way: `case '#'` is an unconditional terminator and `case '$'` logs _"Saw new packet
start in middle of old one"_ and restarts. Counts 14 and 16, by contrast, are only conventionally
excluded; `+` and `-` are ordinary bytes between `$` and `#` and decode fine. `frame.rs` has a test
for each group, asserting the impossibility of the first and the acceptance of the second.

**What this means for us: nothing, in the good direction.** We only ever **decode** RLE (it is
stub→GDB only, and we never emit it), so the holes do not constrain us — a decoder just computes
`n = byte - 29` and accepts whatever arrives. And per invariant 5 (§2), GDB-destined replies are
forwarded as the original bytes, so we never have to re-encode a run.

### Settled from source — `gdb/remote.c`, `read_frame()`

Phase 1 item 2 is done. All three answers come from GDB's own decoder, which is the definition of
correct here regardless of what the prose says.

**`n` is the number of _additional_ copies, not the total.**

```c
repeat = c - ' ' + 3;            /* == c - 29 */
/* The character before ``*'' is repeated.  */
if (repeat > 0 && repeat <= 255 && bc > 0)
  {
    memset (&buf[bc], buf[bc - 1], repeat);
    bc += repeat;
```

The literal character is already in the buffer at `bc - 1`, and `repeat` more are appended. So a
run of length `L` encodes as the character plus `*` plus `chr(L - 1 + 29)`, and `0*<space>`
decodes to **four** zeros (`n = 32 - 29 = 3`, plus the literal). Total run = `1 + n`.

**GDB's decoder is lenient**, and ours should match it rather than enforcing the encoder's rules:
it accepts any `repeat` in `1..=255` — below the `n >= 3` floor and above the 97 ceiling — and
requires only `bc > 0`, i.e. a `*` may not be the first character of a payload. Rejecting counts
the encoder is not supposed to produce would make us stricter than GDB for no gain.

**The checksum covers the _encoded_ bytes, not the expanded ones.** `read_frame` does `csum += c`
for both the `*` and the count character as it goes. So the verifier must sum the raw bytes as
received; summing the expanded payload gives the wrong answer for any reply containing a run.
This is the one place the `raw`/`decoded` split in `Frame` (§6) is load-bearing for correctness
rather than just for forwarding.

**GDB does not verify the checksum in no-ack mode at all** — `read_frame` returns early on
`rs->noack_mode`, on the stated grounds that without acks there is no way to ask for a
retransmission. **We verify regardless.** We are not obliged to accept what we cannot re-request:
a corrupt frame can be reported as garbage and, if it was a reply to one of our memory reads,
failed to that consumer. Silently handing a client corrupted target memory is a worse outcome than
a failed read, and unlike GDB we have a channel-level error path to use.

### Settled from source — the `x` reply, and a chunking bound

From `remote_target::remote_read_bytes_1`:

**The `x` reply is `b` followed by escaped binary data.** `if (*p != 'b') return TARGET_XFER_E_IO;`
then `p++` and `remote_unescape_input`. An **empty** reply means the stub does not implement `x`,
and GDB falls back to `m` and remembers — so `x` support is detectable by trying it, not only from
`binary-upload+`. We do not probe (§4.8), so for us it is the feature bit; the empty-reply case is
worth handling as a graceful fallback rather than an error.

**Chunk at `packet_size / 2`, not `packet_size`.** GDB caps a single read at

```c
todo_units = std::min (len_units, (ULONGEST) (buf_size_bytes / unit_size) / 2);
```

The `/ 2` is there because `m` returns two hex characters per byte, and GDB applies it for `x` as
well rather than tracking two limits. Mirroring that is both correct for `m` and safely
conservative for `x`, and it is one less thing to get wrong per server.

### `PacketSize` excludes the framing — so no allowance for it is needed

Worth settling explicitly, because the arithmetic changes if it is wrong. The manual's `qSupported`
entry says:

> `PacketSize=bytes` — The remote stub can accept packets up to at least _bytes_ in length. GDB
> will send packets up to this size for bulk transfers, and will never send larger packets. This is
> a limit on the data characters in the packet, **not including the frame and checksum.**

So `$`, `#` and the two checksum digits sit _outside_ the budget. `PacketSize` is a **payload**
limit, not a wire limit. That is also why GDB's plain `PacketSize / 2` for a hex read is exact
rather than approximate: `2N ≤ PacketSize` is the whole constraint, with nothing left to subtract.

**It is also hexadecimal**, with no `0x`. `PacketSize=4000` is 16384, not four thousand — a unit
test of ours got this wrong before the assertion caught it.

### Short replies are legal, which makes the arithmetic an optimisation

The manual says of both `m` and `x`: _"The reply may contain fewer addressable memory units than
requested."_ GDB's own comment agrees — _"Return what we have. Let higher layers handle partial
reads."_

So a reader has to loop and resume regardless of how carefully it chunked. That is what makes exact
sizing a performance matter rather than a correctness one, and it is why **a stub that is wrong
about its own advertised size cannot break us** — as OpenOCD's was for years, advertising 512 while
its buffer held 511 (fixed upstream by allocating 512+1). We compute a sane chunk, accept whatever
comes back, and ask again from where it stopped.

### Neither `m` nor `x` is safe for memory-mapped I/O

The most consequential thing in this section, and it lands on two planned consumers. The manual
gives both packets the identical warning:

> The stub need not use any particular size or alignment when gathering data from memory for the
> response; even if _addr_ is word-aligned and _length_ is a multiple of the word size, the stub is
> free to use byte accesses, or not. **For this reason, this packet may not be suitable for
> accessing memory-mapped I/O devices.**

`DWT_PCSR` and the CoreSight trace registers are MMIO. A 32-bit sampling register fetched as four
byte accesses returns nonsense, and `PCSR` in particular has read side effects. **RTT is
unaffected** — it reads ordinary SRAM, where access width does not matter.

In practice OpenOCD's `target_read_buffer` does use word accesses for aligned, word-sized requests
on Cortex-M, so this is likely to work; but "likely" is not a guarantee the protocol offers, and a
different server may differ. Consequences:

- It is a **per-server matrix item** (§7), not an assumption.
- If a server does not oblige, the guaranteed route for MMIO is a **monitor command** (`qRcmd`,
  e.g. OpenOCD's `mdw`) — server-specific, which is why §4.5 permits `qRcmd` at all.
- It sharpens the ordering in §11: RTT (Phase 4 item 20) rests on nothing uncertain here; PC
  sampling (item 22) and trace (item 23) do.

### Using `x` is gated on `binary-upload`, not on trying it

> GDB will only use this packet if the stub reports the `binary-upload` feature is supported in its
> `qSupported` reply.

So `x` is never a guess. Note that `binary-upload` is a **stub-only** feature — the server
volunteers it and GDB never asks for it, which a captured `qSupported` request confirms. The empty
reply that `remote_read_bytes_1` handles is a belt-and-braces fallback, not the primary signal, and
we treat it the same way: feature bit decides, empty reply degrades gracefully to `m`.

Whether a stub advertising `binary-upload` also implements `m` is not stated anywhere, and no such
stub is known. The fallback is one-directional in practice, and the empty-reply path covers it
either way.

---

## 6. Module layout

New directory `packages/mdbg/src/gdb_rsp/` — crate-level, **not** under `proxy_helper`, because
§8 requires it to be reachable from more than one entry point.
`proxy_helper/proxy_server/gdb_rsp.rs` shrinks to the glue that wires a mux into `ProxyServer`.

| File                  | Contents                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gdb_rsp/mod.rs`      | Public surface: `RspMux`, `RspSource`, `ConsumerId`, `RspError`, `TargetState`, `RspCaps`.                                                                                                                                                                                                 |
| `gdb_rsp/frame.rs`    | `PacketCodec`: incremental byte stream → `Frame`. Escaping, RLE decode, checksum verify, ack-mode switch, `\x03` passthrough, `%` notifications. Pure, no I/O.                                                                                                                             |
| `gdb_rsp/packet.rs`   | Builders/parsers for what we care about: `m`/`M`/`x`/`X`, `?`, `qSupported`, `QNonStop`, `QStartNoAckMode`, `vCont`, stop replies. Hex and binary-escape helpers.                                                                                                                          |
| `gdb_rsp/caps.rs`     | `RspCaps` — parsed `qSupported` reply, plus the per-server-type capability tier (§7).                                                                                                                                                                                                      |
| `gdb_rsp/state.rs`    | `TargetState` + the transition table driven by observed resume packets and stop replies.                                                                                                                                                                                                   |
| `gdb_rsp/mux.rs`      | `RspMux`: owns the socket, reader + writer threads, send queue, pending FIFO, ack accounting, the send gate, the forbidden-packet choke point.                                                                                                                                             |
| `gdb_rsp/consumer.rs` | The `read_memory`/`write_memory` API its clients use, over `chunk.rs`. **No `attach`/`detach`** — see §4.7.2; this row originally proposed registration copied from `serial/port.rs`, which was wrong, because a serial port outlives the sessions that use it and these consumers do not. |
| `gdb_rsp/tests/`      | Codec and state unit tests; mock-stub integration tests; recorded-transcript fixtures.                                                                                                                                                                                                     |

### Frame type — the API detail that enforces invariant 5

```rust
pub struct Frame<'a> {
    /// The original bytes, exactly as received, including framing, escapes and RLE.
    /// This is what gets forwarded to GDB. Never re-encode.
    pub raw: &'a [u8],
    /// Unescaped, RLE-expanded payload — for our own inspection only.
    pub decoded: Cow<'a, [u8]>,
    pub kind: FrameKind,
}

pub enum FrameKind {
    Packet,          // a normal request or reply
    Notification,    // `%Stop:…`
    Ack, Nack,
    Interrupt,       // bare 0x03
    ConsoleOutput,   // `O…`   — never retires a pending request
    FileIo,          // `F…`   — never retires; blocks the send gate
    Garbage,         // bad checksum or junk before `$`
}
```

Carrying `raw` alongside `decoded` is not a convenience; it is how "forwarded verbatim" becomes
something the compiler helps with rather than something a reviewer has to notice.

### Replacing the current stubs

The existing `GdbRsp` enum (`QNonStop`, `qSupported`) goes away — a flat enum of packet _names_ is
the wrong shape; the work splits into a codec, typed builders and a capability struct. Two further
corrections to the stub as written:

- `memory_read_type` must default to **`Hex`** (`m`), not `XPackets`. `m` is mandatory for every
  stub; `x` is optional and negotiated via `binary-upload+`. Under the mux we learn which from
  GDB's own `qSupported` exchange, for free.
- `vContSupported` → `vcont_supported`. Rust is snake_case and clippy runs at `-D warnings`
  (AGENTS.md), so the camelCase form will not compile clean.

---

## 7. Per-server capability tiers

Not a blacklist with two values — three tiers, decided per `servertype`, recorded in `caps.rs`
and surfaced to the user once per session when it is not `Full`:

| Tier          | Meaning                                                  | Consequence                                                                                                                                                           |
| ------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Full`        | Answers state-free requests while the target runs.       | Everything works: RTT, sampling, trace.                                                                                                                               |
| `HaltedOnly`  | Answers only while halted.                               | The send gate blocks while running. Still useful — flush RTT on stop, read state on halt — but no live RTT, no sampling. Say so plainly rather than appearing broken. |
| `Unsupported` | Mishandles interleaved packets, or breaks GDB's session. | Agent-side features off; fall back to server-side RTT and the live-GDB path, with a one-time notice.                                                                  |

**probe-rs is the interesting case.** It is believed not to allow a second gdb connection — which
under this design does not matter at all, since we do not open one — while possibly allowing
requests while running. If so, the mux makes probe-rs work where a second-connection design could
not. That is a point in favour of the choice made in §2, and it is a matrix item, not a claim.

### Prerequisite: the gdb-server must expose a TCP port — Black Magic Probe does not

The mux sits between two endpoints and speaks RSP to both. That presumes the gdb-server side _is_ an
endpoint it can connect to, which for every server in the matrix means a TCP port. **Black Magic
Probe does not meet that requirement**, and it is worth writing down rather than discovering later.

BMP has no gdb-server process at all: the probe firmware is itself the RSP stub, reached over a
CDC-ACM serial link. `BMPServerController` reflects this exactly —
`portsNeeded: string[] = []`, and `connectCommands()` is
`target-select extended-remote ${BMPGDBSerialPort}`, a device path rather than a host and port. So
there is no TCP endpoint for the mux to interpose on, and the proxy's port-allocation machinery never
applies to it either.

**Decision: BMP is out of scope for remoting, and for Agent-side features with it.** It stays fully
supported for local, direct debugging — nothing here takes that away. Documented as a requirement
BMP does not meet.

**For the record, this is a hardware-availability decision, not an architectural one.** `MuxCore` is
sans-IO on _both_ sides — its server side is a byte sink and source just as its GDB side is — and
`mdbg` already contains a complete serial stack (`serial/port.rs`, reader thread, ring buffer). A BMP
bridge would therefore be: the Agent opens the CDC-ACM device, presents a TCP listener to GDB, and
runs the mux in between. That is a small piece of work, and it is the _only_ route by which BMP could
ever be remoted, so the architecture is the enabler rather than the obstacle. It is unstaffed because
nobody has donated a probe to test against, not because it does not fit.

### Filling the matrix: `mdbg rsp-probe`

```sh
mdbg rsp-probe --port 3333            # OpenOCD; J-Link 2331, etc.
mdbg rsp-probe --port 3333 -v         # log every packet both ways
mdbg rsp-probe --port 3333 --no-resume  # leave the target alone (skips the key test)
```

Run it against a live gdb port with **no GDB attached**, or as a second client where the
server allows one. It prints the column below, ready to transcribe.

**Why a tool rather than two GDB sessions.** Attaching a second GDB and watching what it
sees answers the notification question, but it **cannot** answer the one the design rests
on — whether a server replies to `m` while a `c` is outstanding on the same connection.
GDB refuses to send anything while the target runs; that client-side rule is exactly what
the mux exists to sidestep, so no arrangement of GDB processes can test around it. The
probe is a raw RSP speaker, built on `frame.rs` and `packet.rs` (codec and builders, no
policy) and deliberately **not** on `MuxCore`, whose job is to refuse these packets.

**It resumes and halts the target**, because having a `c` outstanding is the state under
test. It restores a halt afterwards, but a target that was running free is left halted —
the report says so. `--no-resume` skips those tests entirely.

Questions it answers in one pass: `PacketSize` and every `qSupported` feature; whether
`QStartNoAckMode` is honoured after being advertised; `?` behaviour; a halted baseline
read; `x` when `binary-upload` is claimed; whether `depth = 2` pipelining survives in
no-ack mode; whether a second connection is accepted; **whether `m` is answered while a
`c` is outstanding**; and whether a second connection is told about run/stop.

That last pair is what §2 and §4.7 turn on. `YES` on the critical row means `Full`; `no`
means `HaltedOnly` at best. A `no` on the second-connection-notifications row confirms
§2's asymmetry; a `YES` refutes it, and would mean either connection could host the mux.

### The matrix to fill in

Phase 3 item 17 answers these per server and records the answers here — `rsp-probe` above
does the asking. OpenOCD's column came from
reading `gdb_server.c` (§4.2.1) — where a server ships source, read it; it is faster and far more
definite than probing.

| Question                                                  | Why it matters                                                               | OpenOCD                                                                               | J-Link                      | pyOCD                               | ST-LINK                     | probe-rs          | QEMU |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------- | --------------------------- | ----------------- | ---- |
| Answers `m`/`x` while the target **runs**?                | The premise the design rests on.                                             | **Yes** — 66 reads observed (§2 A)                                                    | ?                           | ?                                   | ?                           | ?                 | ?    |
| …on a connection that **itself** has the `c` outstanding? | The narrower form the mux needs.                                             | **Yes — 0.5 ms**, `rsp-probe` on hardware; chain also traced to `mem_ap_read_buf`     | **Yes** — 70 s of Agent RTT | **No — queues until the next halt** | **Yes** — 70 s of Agent RTT | ?                 | ?    |
| Tolerates `depth = 2` in no-ack mode?                     | Sets the pipelining rule.                                                    | **Yes** — both replies arrived (`rsp-probe`); warns and recovers in ack mode (§4.2.1) | ?                           | ?                                   | ?                           | ?                 | ?    |
| `PacketSize`? Advertises `binary-upload+`?                | Bounds chunking; picks `x` over `m`.                                         | **16384**; **no `binary-upload`** — no `x` packet at all                              | ?                           | ?                                   | ?                           | ?                 | ?    |
| Advertises `QNonStop+`, and honours it?                   | Confirms it is as irrelevant as §2 assumes.                                  | **no** — not advertised                                                               | ?                           | ?                                   | ?                           | ?                 | ?    |
| `QStartNoAckMode` honoured after advertising it?          | The codec must switch at the right byte (§4.3).                              | **Yes**                                                                               | ?                           | ?                                   | ?                           | ?                 | ?    |
| Connection limit — default, and per core?                 | Whether the maximal mux (§4.7) removes a real burden elsewhere or only here. | **`-gdb-max-connections`, per target, default 1**                                     | ?                           | ?                                   | ?                           | ?                 | ?    |
| Is a **secondary** told about a halt it did not cause?    | Whether a non-controller connection could host a mux (§4.7).                 | **No** — 0 packets across 4 breakpoint halts (§2 B)                                   | ?                           | ?                                   | ?                           | ?                 | ?    |
| Is a resume issued on **conn2** answered on conn2?        | Behavioural vs positional. No GDB session can produce this.                  | **Yes** — `T02thread:1;` (`rsp-probe`). **Behavioural, confirmed**                    | ?                           | ?                                   | ?                           | ?                 | ?    |
| **Tier (§7)**                                             |                                                                              | **`Full`**                                                                            | **`Full`**                  | **`HaltedOnly`**                    | **`Full`**                  | **`Full`** (slow) | ?    |

#### Four servers measured, by running Agent-side RTT on them

Not with `rsp-probe` in the end, but with the feature itself — 70-second runs of Agent-side RTT on
real hardware, which asks the narrow question (§12 q2) continuously rather than once. The decisive
column is "answers on a connection that itself has the `c` outstanding". Only the OpenOCD row has been measured
The `Agent RTT` column is the stock
configuration — a 1024-byte `defmt-rtt` ring and a 500-byte drain cap — so it compares _servers_, not
what any of them can be pushed to. **ST-LINK tuned reaches 126.1 KB/s, 1.57× OpenOCD's own RTT
server**, and [rtt-benchmarks.md](./rtt-benchmarks.md) has the sweep plus the contention model that
accounts for the rest: throughput is `153.1 KB/s − 109 bytes per round trip`, whose zero-round-trip
intercept lands within 0.7% of J-Link's probe-firmware RTT.

| Server   | Verdict                                         | Tier         | Agent RTT | Adapter RTT |
| -------- | ----------------------------------------------- | ------------ | --------- | ----------- |
| OpenOCD  | Yes — and from source, no halt gate (§4.2.1)    | `Full`       | 74.3 KB/s | 50.9 KB/s   |
| ST-LINK  | Yes — a minute, no stall                        | `Full`       | 78.0 KB/s | 62.4 KB/s   |
| J-Link   | Yes — a minute, no stall                        | `Full`       | 80.5 KB/s | 68.3 KB/s   |
| probe-rs | Yes — but at ~20 ms a round trip                | `Full`       | 6.2 KB/s  | —           |
| pyOCD    | **No — it queues the read until the next halt** | `HaltedOnly` | —         | 24.8 KB/s   |

**probe-rs permits everything and is an order of magnitude slower at it.** The latency is its own, and
visible without us — which is the only evidence needed, and the only evidence to rely on: its
handshake with GDB takes ~10–12 ms per packet before the Agent has sent anything (`qSupported` 0.3 → 10.0 ms, `vCont?` 10.3 → 22.1 ms, `vMustReplyEmpty` 22.4 → 34.7 ms). The
tier stays `Full` because a tier describes what a server _permits_; gating it on speed would make a
slow server silently featureless instead of merely slow. Trace excerpt in
[rtt-benchmarks.md](./rtt-benchmarks.md).

probe-rs is also the only server observed to emit `#` or `$` as a run-length **count** byte, which the
manual forbids and GDB tolerates anyway. That cost a framing fix on our side — `scan_frame` in
`gdb_rsp/frame.rs` — and the lesson generalises: a relay must be **at least as tolerant as GDB**,
because being stricter turns another implementation's liberty into our own outage.

**pyOCD is the one that does not work, and it fails in a way worth recording.** It does not refuse
the read and it does not error: it _queues_ it and answers when the target next stops. Observed as
five consecutive two-second timeouts through a run, every one of them answered within a millisecond
of the halt that followed. The target was running throughout — `WrOff` advanced from 0 to 0x2f9 — so
the data was there and unreachable. Its late replies then matched nothing and were forwarded to GDB,
which reported `Unknown remote qXfer reply` against our RTT descriptor; that consequence is fixed
(`MuxCore::abandoned_replies`), but the tier is what stops it arising. For pyOCD,
`engine: "builtin-typescript"` is not a fallback but the only option, because the
adapter's own engine reads over a **second** connection where pyOCD answers happily.

**`ServerTier::Unknown` still gates as `HaltedOnly`, and the case for that has weakened.** Three of
four measured servers answer while running, so the pessimistic default is now the minority
behaviour, and it fails _silently_ — RTT simply produces nothing on an unmeasured server, which
reads as a bug rather than as caution. Against that: pyOCD proves the permissive default can be
wrong. What has changed since this paragraph was written is the blast radius. A server that queues
now produces logged timeouts and dropped late replies instead of a corrupted GDB session, so
optimism costs a diagnosable failure rather than a broken debug session.

Still a judgement call about servers neither measurement covers — probe-rs, QEMU, Black Magic, custom
stubs — and `debugFlags.rspTier` is how to settle each. Changing the default remains a one-line edit
to `ServerTier::allows_while_running` plus its test, deliberately kept that cheap.

---

## 8. All sessions should go through the Agent

`ServerSession.startServer()` only builds a `ProxyClient` when `args.hostConfig` is set
(`packages/mcu-debug/src/adapter/server-session.ts:73`). In the plain local case — probe on the
same machine as the DA, which is most users — `mdbg proxy` is not in the data path at all, and GDB
connects to the gdb-server directly. **A mux that is not in the data path cannot mux anything.**

The mechanism to fix this already exists: `hostConfig.type = "local"`
(`packages/mcu-debug/src/adapter/servers/common.ts:294` — _"`local` is internal/testing only, not
exposed in package.json schema"_), and the serial subsystem already uses it. So the route is:
**make every debug session run through the Agent on loopback**, exposed or not.

This is now the preferred outcome for its own sake, independent of this feature — one data path,
one implementation, one set of behaviours to test — and the singleton work
([Singleton-Tier1-Plan.md](./Singleton-Tier1-Plan.md)) already makes a long-lived local Agent
ordinary. The alternative (a separate `mdbg` subcommand the DA spawns for local sessions, sharing
the `gdb_rsp` module but not the proxy) exists as a fallback and is why §6 puts the engine at
crate level, but it is second choice.

**One thing has to go first: file syncing.** A session with `hostConfig` set syncs files from the
extension's install directory to a remote working directory. That is right for a real remote probe
and wrong for every local session, which would be all of them under this plan — copying files to a
directory on the same disk they came from. Local mode exists today as a way to **simulate** a remote
session without owning a second machine, and it earned its keep; but the simulation's cost is
exactly the behaviour that must not survive into production. Turn the syncing off before making local
sessions the default path, not after — item 18a, which gates item 19.

**Blocking for Phase 4.** Phases 1–3 are unaffected: the codec, the mux and its tests are the same
code either way.

---

## 9. Rejected alternatives

**A second RSP connection to the server (the "companion" design).** The Agent opens its own
connection per core and never touches GDB's socket, making the sacredness invariant structural.
Rejected on four counts, and the last two only became clear in review:

1. It requires every server to accept a second connection on the gdb port — which at least one
   (probe-rs) is believed not to — so it needs a second code path for the servers that refuse.
   The mux needs only _one_ server behaviour (answers state-free requests while running); the
   companion needs _two_.
2. A second connection is not free even where allowed: the slot has to be bought, per core, from a
   limit whose default is 1 (§2). On OpenOCD that means shipping and loading `CDLiveWatchSetup`;
   on other servers it means finding the equivalent, or discovering there is none.
3. **A companion could never learn the run state on its own.** A server tells a connection only
   about resumes _that connection_ issued (§2), and a companion is forbidden to resume — so it
   would have to reconstruct target state by snooping GDB's socket anyway, reintroducing the
   observer this design was trying to delete and leaving the state model permanently second-hand.
4. It cannot ever offer what the maximal mux can (§4.7): giving the live GDB the state the server
   withholds from it.

Preserved here because if a server turns out to mishandle interleaved packets but accept a second
connection, this is the contingency for that server.

**Non-stop mode.** Needs per-thread execution control, which MCUs do not have and our servers do
not implement. Not a dependency; a matrix line to confirm.

**Interrupting the target to read memory.** Perturbs the program under measurement. A profiler
that halts to sample, or RTT that halts to drain, is not measuring the user's system.

**Server side channels (OpenOCD tcl port, J-Link's own ports).** Per-server, so N
implementations, and some servers have nothing. Reserve for a server that lands in `Unsupported`
and matters enough to warrant special-casing.

**Retiring the live-GDB path.** Not possible and not wanted: GDB does the DWARF work that turns
an expression into an address. Live watch and variables stay on it. Only fixed-rate
address-and-length polling moves to the Agent.

---

## 10. Testing

The codec and state machine are pure functions over byte slices. Test them hard — everything rests
on them.

- **`frame.rs` unit tests.** Fuzz the chunk-split points (a packet arriving in N arbitrary reads
  must decode identically); escapes spanning a boundary; RLE expansion including the excluded-count
  characters and the total-vs-additional question from §5; bad checksums; `\x03` mid-packet;
  `%` notifications; garbage before `$`; and the **ack-mode switch at the exact byte**.
- **`state.rs` unit tests.** Table-driven: sequences of (direction, packet) → expected
  `TargetState`. Include `O` output during a `c`, `F` requests, `vStopped` drains.
- **Mux unit tests** against an in-process fake socket:
    - FIFO routing with interleaved sources — a GDB `c` outstanding, two of our `m`s behind it,
      replies arriving in order, each landing in the right place.
    - Ack accounting in ack mode: our `+`s swallowed, GDB's forwarded, our replies acked by us.
    - The send gate: nothing of ours goes out before the handshake settles, while a GDB packet is
      queued, while an `F` is pending, or while `HaltedOnly` and running.
    - `depth = 1` and `depth = 2` produce identical results, different timing.
- **Verbatim-forwarding test.** Feed a recorded GDB↔server transcript through the mux with no
  Agent consumers attached and assert the forwarded byte streams are **identical to the input in
  both directions**. This is invariant 1 as a test, and it must be impossible for a later change to
  break it silently.
- **Forbidden-packet test.** Drive a full mock session with RTT-like traffic and assert on the
  captured packet log that no execution-control, breakpoint or mode packet was ever emitted by us.
- **Capture real traffic.** `set debug remote 1` in GDB produces a usable transcript; capture one
  per server (OpenOCD, J-Link, pyOCD, ST-LINK, probe-rs, QEMU) and commit them as fixtures. They
  pay for themselves the first time a server does something unexpected.
- Run with **`npm run test:rust`**, not bare `cargo test` (AGENTS.md — only the wrapper syncs
  the ts-rs generated TS into `packages/shared`).

---

## 11. Plan

Phases 1–3 do not depend on the §8 decision. Each item is sized to be a reviewable commit.

### Phase 1 — Codec and state (pure, no I/O)

- [x] **1.** Create `packages/mdbg/src/gdb_rsp/`, registered in `lib.rs`. Removed the orphan
      `proxy_helper/proxy_server/gdb_rsp.rs` — it had **no `mod` declaration anywhere**, so it had
      never been compiled, which is why its camelCase field never tripped clippy. `packet.rs`,
      `caps.rs` and `state.rs` are created by their own items below rather than as empty files.
- [x] **2.** Settle the two protocol details from §5 against the GDB manual and `remote.c`: RLE
      count semantics (total vs additional) and the `x` reply's leading marker. Record the answers
      in this document. Cheap now, expensive later.
- [x] **3.** `PacketCodec` in `frame.rs` with the `Frame { raw, payload, kind }` shape: framing,
      checksum, unescape, RLE decode, `\x03` passthrough, `%` notifications, ack-mode switch,
      resync on a mid-packet `$`. Plus `encode_packet` for Agent-originated packets (escapes, never
      RLE — we are never the stub).
- [x] **4.** 32 codec unit tests, including exhaustive single-split-point coverage and
      byte-at-a-time feeding (both assert frames are identical to feeding the input whole).
- [x] **5.** `RspCaps` + `qSupported` reply parser in `caps.rs`, with `ServerTier` (§7) and the
      chunking budgets. Defaults come from GDB: 399 bytes (`remote_packet_size = 400 - 1`) when no
      `PacketSize` is advertised, floor 20 (`MIN_MEMORY_PACKET_SIZE`).
- [x] **6.** Builders and parsers in `packet.rs` for `m`/`M`/`x`/`X`/`?`/`qRcmd` and stop replies,
      with hex helpers. Builders emit **payloads**, not framed packets, so the §4.5 choke point can
      inspect one before it reaches the wire — and there is deliberately no builder for any
      forbidden packet, so the restriction is partly structural.
- [x] **7.** `StateTracker` in `state.rs` + table-driven tests, including the `O`/`F`-during-`c`
      traps and `vCont?` (a capability query, not a resume).

### Phase 2 — The mux

- [x] **8.** `MuxCore` in `mux.rs`: send queue, pending FIFO, routing, frame-boundary forwarding.
      **Built sans-IO** — no socket, no threads, no clock it is not handed — so every §4 rule is
      testable without a gdb-server or a sleep.
- [x] **8b.** `channel.rs` — the threaded shell: reader thread, writer thread (which doubles as the
      core's clock), one-shot reply delivery, idempotent teardown that fails everything outstanding.
      `feed_from_gdb` is guaranteed non-blocking, with a test that hammers it while nothing drains
      the far side. The GDB side is a `GdbSink` trait and the server side a plain `Read`+`Write`
      pair, so `gdb_rsp` still names nothing from `proxy_helper` (D6) — and a serial-port server
      side would need no change to this file (§7, BMP).
- [x] **8c.** `trace.rs` — four-party packet tracing to its own file (§4.7.3): bounded queue,
      dedicated writer, drop-and-count under pressure, runtime-switchable level. The core emits
      `Action::Trace`; the shell writes it. **Still to do:** the `debugFlags.rspTrace` →
      control-request plumbing, which lands with item 14 — until the mux is wired in there is no
      channel for a control request to address.
- [x] **9.** Ack accounting (§4.3): the no-ack switch at the exact `OK` that answers
      `QStartNoAckMode`, `-` retransmit with a 3-strike limit, our acks swallowed and GDB's
      forwarded, and unattributable acks forwarded to GDB.
- [x] **10.** The send gate (§4.2) and the forbidden-packet choke point (§4.5), with tests for
      both. `depth` defaults to 1 and `set_depth` **refuses** above 1 outside no-ack mode (§4.2.1).
      The choke point is a **whitelist**, so a newly-added builder is denied until explicitly
      allowed.
- [x] **11a.** Chunking and reassembly in `chunk.rs` (§4.7.1): `plan_read`/`plan_write` for a
      caller that wants the whole schedule, `ReadAssembler`/`WriteAssembler` for one that goes step
      by step. Handles **short replies** by resuming from where the stub stopped, refuses to spin on
      a zero-length answer, and reports how far a failed write got. Pure — no I/O.
- [x] **11b.** The blocking `read_memory`/`write_memory` façade over `chunk.rs` + `MuxCore`, in
      `consumer.rs`. **No attach/detach protocol** (§4.7.2): consumers are in-process and
      session-scoped, so `ConsumerId` for reply routing is all that is needed. `Consumer` is a
      channel handle, an id, a timeout and an endianness, and is cheap to clone onto a feature's own
      thread. Capabilities are re-read **per call**, not cached at construction: they are learned
      from GDB's `qSupported` exchange, which may not have happened when the consumer was built, and
      a consumer created too early would otherwise chunk to the 400-byte default for the whole
      session.
      Two things came out of writing it. **`Consumer::ready()`**, over a new
      `MuxCore::agent_gate_open()` — the send gate with the "is anything queued" test removed.
      Everything in that gate makes a submitted packet _wait_ rather than fail, so a poll loop that
      submits while the gate is shut gets `Timeout` seconds later, which is both slow and a
      misdiagnosis of a stall as a fault. And **`read_memory_partial`/`write_memory_partial`**, which
      give `ReadAssembler::collected()` and `WriteAssembler::remaining()` the callers they were
      written for. `read_memory` still discards a partial, deliberately: RTT must not consume half a
      ring buffer, because advancing the read pointer by what arrived desynchronises the channel for
      the rest of the session.
- [x] **12.** Verbatim-forwarding test — both directions fed **one byte at a time, interleaved**,
      asserting the forwarded streams are byte-identical to the input with no consumers attached.
      Plus routing, gating, ack and timeout unit tests.

### Phase 3 — Integration into `ProxyServer`

- [x] **13.** Retain `stream_id_str` on `PortInfoListner`/`PortInfo` (it is already on the wire in
      `PortReserved`; the Agent throws it away today). **Also add to `PortReserved`**, for `GdbRsp`
      streams: `packet_size` (§4.7.1), so the TypeScript side can retire its blind 512-byte chunking
      on paths that do not go through `chunk.rs`; and the **mux listener port** the Agent bound for
      GDB in the local topology (§4.7.2), which becomes that stream's `localPort`. Add
      `StreamKind { Control, Stdout,
Stderr, GdbRsp { core }, Swo, Tcl, Telnet, Console, Other }` classified once at allocation.
      The rule is `gdbPort` + optional digits — note `createPortName()`
      (`packages/mcu-debug/src/adapter/servers/common.ts:650`) suffixes only when `procNum != 0`,
      so core 0 is plain `gdbPort` and matching the literal `gdbPort1` would miss nearly every
      session. Unit-test the classifier against every name in every server controller's
      `portsNeeded`.
      _This enum is also what [Stream-Flow-Control.md](./Stream-Flow-Control.md) needs for its own
      throttling policy — one classification serves both._
- [ ] **13a.** _(deferred, needs a TypeScript consumer.)_ The `PortReserved` wire fields item 13
      described but did not need: `packet_size` (§4.7.1), so the TS side can retire its blind
      512-byte chunking on paths that do not go through `chunk.rs`; and the mux listener port for the
      local topology (§4.7.2), which becomes that stream's `localPort`. Both are additive and wait on
      item 19.

- [x] **14.** Give the mux ownership of the server socket for `StreamKind::GdbRsp` streams,
      replacing that stream's `read_and_forward` and the direct `pinfo.stream` write in
      `message_loop`. **One mux, on the core's controller `GdbRsp` stream only** (§4.7) — the
      connection that drives execution, and so the only one with a usable run-state model. Secondary
      streams from `handle_duplicate_stream` (the live-watch GDB) keep `read_and_forward` as today and
      are not the mux's concern.
      _Done in `proxy_server/rsp_mux.rs`, the only file that names both `gdb_rsp` and the proxy._
      Three things were not obvious until the wiring was written:
      **(a)** the decision has to be made on the message-loop thread, where `stream_meta` lives, and
      _sent_ to the port waiter — which is already holding a read clone and would otherwise read it
      too. Two readers on one socket do not duplicate traffic, they **split** it, so each thread gets
      part of every packet. Hence `StreamForward::{Direct, MuxOwned}` returned on the existing
      readiness handshake, one decision point instead of two.
      **(b)** the mux gets two fresh `try_clone`s and `message_loop` keeps `pinfo.stream`, because the
      remaining uses of that field are all `is_some()` liveness checks (`StreamStatus`,
      `DuplicateStream`, `StartStream`). The single write site is now behind the `rsp_channels`
      lookup, so the two paths can never both be live for one stream.
      **(c)** the mux must start _before_ the stream is registered, or GDB's first bytes could be
      written straight to the socket and the mux would take over mid-packet.
- [ ] **15.** End-to-end pass-through validation: a real debug session against OpenOCD with the mux
      in the path and **no consumers attached** must be indistinguishable from today — same
      behaviour, no measurable added latency. This is the gate before any consumer work; if it
      does not hold, nothing after it matters.
      **`--no-rsp-mux` is the control arm**: the same binary, the same session, the old
      `read_and_forward` path. Run it both ways and compare rather than comparing against memory.
      `--rsp-trace packets` on the mux arm shows what actually crossed the wire; the round-trip times
      on it are the latency figure this item asks for.
      _Already passing against a fake RSP server through the real proxy binary_ — classification, mux
      ownership, the waiter standing down, both directions byte-for-byte, `TargetState::Stopped`
      observed from the `?` reply, and the trace file written. That clears the wiring; only hardware
      can clear the timing and OpenOCD's real packet mix.
- [ ] **15b.** React to the GDB packets that mean something to us. None of this needs a wire change or
      any client cooperation, which makes it a useful backstop whatever else is true — though the
      _primary_ signal for "GDB went away" belongs in the transport, not here (item 15c).
      **(a)** Reset the GDB side of `MuxCore` on `D`+`OK` and on a fresh `qSupported`, and log the
      no-ack-reconnect hazard when it is detectable. Tests: a `D` is forwarded even with a request of
      ours in flight, and a second `qSupported` clears the previous GDB's pending entries without
      touching ours.
      **(b)** Publish `\x03` to consumers rather than gating them (§2 invariant 3). The signal is
      already there and unused — `StateTracker` sets `interrupt_pending` and only its own tests read
      it. What a consumer should do with it is **TBD and per consumer**: a memory read is what GDB is
      about to do anyway, while a trace drain may want a final pass or an immediate stop. Settle it by
      experiment, one consumer at a time, once there are consumers to experiment on.
      **(c)** ~~Decide whether `\x03` gets a pending entry of its own.~~ **Settled: it stays
      unmodelled**, and the manual is what settles it — see §3.13. "Stubs are not required to
      recognize these interrupt mechanisms", so a pending entry for an interrupt could legitimately
      never be retired; and when the stub _does_ honour it, the stop reply that follows is the one the
      outstanding resume is already waiting for, so there is nothing for a second entry to match. The
      FIFO does not need to learn that one reply can retire two entries. Note for (b): a queued
      interrupt survives a resume (§3.13), so a consumer that backs off while one is pending must not
      assume a resume cleared it.
- [x] **15c.** **The funnel had no client→server stream close.** Not an RSP matter — it affects every
      stream the Agent serves — but the mux is what made the cost visible, so it is recorded here. The
      client-side defects it interacts with are catalogued in
      [Proxy-Client-Stream-Issues.md](./Proxy-Client-Stream-Issues.md).
      What it cost, by stream, and why each is now closed:
      **SWO** kept streaming bytes nobody would read — real bandwidth in the remote topology, and an
      unbounded `fromServerBuffer` in the client. A **duplicated gdb stream** kept its second
      connection to the gdb-server open after the live-watch GDB had gone, holding a
      `-gdb-max-connections` slot for nothing (§4.7). For the **controller gdb stream** it was the
      missing call to `RspChannel::gdb_disconnected()`, which existed with no caller.
      **Done**, in four pieces:
    - `ControlRequest::CloseStream { stream_id }` on the wire, sent from `cleanupSocket` in
      `proxy-client.ts` — the only place that can see it, since a consumer's socket terminates on the
      client side and the Agent has no way to observe it.
    - `ProxyServer::release_stream`, shared by the client-initiated close and the gdb-server-initiated
      one, implementing both decisions below.
    - `stop_rsp_mux` now takes a `StreamEnd`, and tells the mux `gdb_disconnected()` when the
      **client** is what left. That is the transition §3.11 says is invisible on the wire, so the
      transport is the only thing that can report it. Thin today because no consumers are attached
      yet; the ordering is what makes it stop being thin without a redesign.
    - The **cascade**: `RemoteServer.close()` sets `endingSession` before destroying its sockets,
      which silences `cleanupSocket`, so closing the _original_ stream never reported the duplicates
      on its listener. `close(notifyAgent)` reports them first. Covered by
      `proxy-client-streams.test.ts`.
      Both decisions were taken as written. **(a)** A duplicated stream is dismantled completely; it
      was created on demand and its port belongs to its parent. **(b)** The original becomes
      re-openable rather than gone: `conn = StreamConn::Idle` — that variant already means "port
      known, nothing connected" — at the cost of `StreamStatus` reporting `Ready` rather than
      `NotAvailable`, which is the more truthful answer anyway. (b) applies to **both** paths now; the
      server-initiated one still did `streams.remove()`, so a reconnect after the gdb-server dropped a
      connection failed as an unknown stream id.
      The 1:1 rule in §4.7.5 is what makes the notification unambiguous: one consumer per stream.
      **Not unit-tested on the Rust side.** `release_stream` needs a live `ProxyServer`, which has no
      cheap constructor, so the split is covered only by the TS tests and the full-server test. If it
      regresses, the symptom is a reconnect refused as an unknown stream id.
- [ ] **15d.** **Keep the mux alive across a GDB reconnect.** Falls out of 15c and is deliberately not
      part of it. Today the channel's lifetime is the server connection's: GDB leaving closes it, and a
      new GDB gets a new connection and a new mux. That is coherent and it is what makes (b) above
      simple, but it means a reconnecting GDB walks into §4.7.4 — OpenOCD wipes breakpoints and
      watchpoints on every new connection. Holding the server connection open across the gap would
      avoid that, and would let Agent consumers keep working while no GDB is attached, which is what
      `gdb_disconnected()` retains our pending requests _for_. The cost is a stream that is `Muxed`
      with no GDB on it — a state nothing else models — and `handle_start_stream` having to reattach to
      a live channel instead of spawning a port waiter. It would also retire the no-ack hazard at the
      end of §3.11: a reconnecting GDB expects acks from a socket that is still in no-ack mode, and the
      mux can currently only _notice_ that, because it cannot put the server back. Reusing the
      connection means there is nothing to put back — the mux's own ack state is already correct for
      it. **Worth doing only once consumers exist**
      (Phase 4), since without them an idle mux holds a `-gdb-max-connections` slot and buys nothing.
- [ ] **16.** Publish the mux's observations to interested parties (`TargetState` changes, `RspCaps`,
      GDB disconnect). **No per-core state extraction needed** — §4.7's controller rule means the only
      connection ever muxed is the one that resumes, so `MuxCore`'s own `StateTracker` is correct by
      construction. Revisit only if the maximal mux (§12 q4) is ever taken on.
- [ ] **16b.** Check each server in §7 for the §4.7.4 pattern — target state disturbed, or worse, by
      the mere arrival of a second GDB connection. **probe-rs crashes** rather than refusing, so for it
      the answer must come from a declared limit and never from an attempt (§4.7.5). OpenOCD wipes breakpoints and watchpoints; the others are
      unknown and `rsp-probe` cannot see it, since it is a side effect on the _first_ connection.
      Worth an upstream one-liner for OpenOCD regardless of what we do here.
- [x] **17a.** `mdbg rsp-probe` (§7) — a raw-RSP diagnostic that asks a live gdb-server every
      matrix question in one pass, including the one **no arrangement of GDB processes can test**
      (does it answer `m` while a `c` is outstanding). Tested against fake servers that do and do
      not answer while running, so a `no` is a real finding rather than a timeout in our own code.
- [x] **17b (OpenOCD).** Run on hardware: both critical cells **YES** — `m` answered in 0.5 ms with a
      `c` outstanding on the same connection, and a resume issued on conn2 answered on conn2. Tier
      **`Full`**. §7's OpenOCD column is complete.
- [ ] **17c.** The other five: J-Link, ST-LINK, pyOCD, probe-rs, QEMU.
      **Test `JLinkGDBServer`, and do not infer from Ozone.** SEGGER's own debugger talks to the DLL
      directly and can do things its gdb-server does not expose over RSP; the matrix is about what the
      gdb-server answers, so an Ozone capability is not evidence for a column here. The same caution
      applies to any vendor GUI debugger sharing a probe backend with a gdb-server. `rsp-probe` is the way in for
      the closed ones; pyOCD and probe-rs have source to read, as OpenOCD did.
      **pyOCD now advertises `QNonStop`**, which is suggestive rather than conclusive. Non-stop mode's
      defining property is that the stub keeps answering packets while threads run, so a stub that
      implements it honestly must have no halt gate on its memory path — which is the §7 question. But
      advertising a feature is not implementing it, and the tier we care about is about **all-stop**
      behaviour on a connection with a `c` outstanding; we never enter non-stop mode (§3.6). So treat
      it as a strong prior that pyOCD is at least `Full`, and confirm with `rsp-probe` plus the
      source now in hand. If it holds, it is the second independent data point that `Full` is normal
      rather than an OpenOCD peculiarity.
      **Measure in the mode we actually use.** A server may legitimately behave differently once
      non-stop is negotiated — the same way a stub is supposed to withhold extended behaviours from a
      plain `remote` client that did not ask for `extended-remote`. So a `Full` result observed in
      non-stop would not transfer to all-stop, and all-stop is where we live. `rsp-probe` never
      negotiates non-stop, which is exactly why that is the right default. Worth knowing too that
      OpenOCD **declines** `QNonStop` outright and says why — its threading model cannot honour it —
      which is the honest position; a server that advertises it may simply mean something narrower by
      it.

### Phase 4 — Consumers _(blocked on §8)_

- [x] **18.** Decide and record how local (non-proxy) sessions reach the Agent. **Done: every session
      goes through the Agent**, which was the preferred outcome in §8 — one data path, one
      implementation, one set of behaviours to test. Verified against OpenOCD, pyOCD, ST-LINK and J-Link.
- [x] **18a.** Stop syncing files when the "remote" is local. **Done** — `syncFiles` skips a local
      session, so nothing is copied to a directory on the same disk it came from. Local mode had been
      standing in for a remote session without a second machine and did that job well; this retired
      the simulation, not the feature, and real remote sessions still sync.
- [ ] **19.** Expose the primitive to TypeScript: control requests/events for memory read/write and
      state subscription, authored in Rust with `ts_rs` and exported in `ensure_ts_exports`
      (AGENTS.md — never hand-write the generated TS).
- [ ] **20.** Port RTT: move the control-block walk from `rtt-builtin.ts` onto the mux, on its own
      thread, with the existing decoder pipeline unchanged. Keep the TS path behind a switch until
      parity is measured. Server-side RTT stays available and unchanged.
- [ ] **20a.** _(low priority.)_ Move live watch onto the controller connection as an Agent
      **consumer** — memory reads and writes through item 11b/19, not a second GDB. This is the
      answer to §12 q4 and it removes, in one move, `duplicateStream`'s extra connection,
      `CDLiveWatchSetup` and `-gdb-max-connections`, the §4.7.4 breakpoint wipe, and the fact that a
      secondary connection can never learn the run state. **Priority is per use case, not global:** for
      sessions that halt normally it stays low, because the two-GDB path works; for a target that must
      keep running it is the only route with OpenOCD at all (§3.12), and there it is not an
      optimisation. The route is known — live watch stops being a GDB and becomes a consumer like RTT —
      so this is scheduling, not design risk.
- [ ] **21.** Measure. RTT throughput and latency, Agent vs. live-GDB, in both topologies, plus
      GDB's own step/continue latency with a consumer active. Also settle §4.7.2 empirically:
      **local via a mux-owned TCP listener vs. local via the funnel**, watching jitter as well as
      mean latency, since the funnel path runs every RSP packet through the Node event loop. The
      justification for this work is a number; produce it.
- [ ] **22.** DWT PC sampling: poll `DWT_PCSR`, aggregate, stream results. Symbolication via
      `da_helper` is a separate design.
- [ ] **23.** Stack probing and ETB/ETF drain — separate designs, same primitive. Stack probing has
      a route decision first (§1, "The split is per feature"): sample from Rust on the mux for rate,
      or let GDB sample and backtrace after a halt. Only the Rust route needs the `g`/`p` decision
      from §4.5, so settle the route before spending anything on that.

---

## 12. Open questions

1. **§8 — local topology.** Blocking for Phase 4. Confirm `hostConfig.type = "local"` for all
   sessions is the intended route.
2. **Do the _other_ servers answer state-free requests while GDB has a `c` outstanding on the same
   connection?** Was the single biggest risk; **answered for OpenOCD from its source** (§4.2.1 — no
   halt gate on the memory-read path). Still open for J-Link, pyOCD, ST-LINK, probe-rs and QEMU:
   Phase 3 item 17. A server that says no drops to `HaltedOnly`; if several do, the companion design
   in §9 returns as a contingency for exactly those.
3. **Does `depth = 2` pipelining upset any stub?** Largely answered and largely moot — see §4.2.1.
   The servers are single-threaded and strictly serial, so depth 2 removes only loopback latency,
   not SWD time; and in ack mode it collides with the server's post-reply ack read. The rule
   (`depth > 1` only in no-ack mode, default 1) follows from OpenOCD's code. What remains is
   whether any other server is _less_ tolerant than OpenOCD, which recovers with a warning.
4. **§4.7 — should the mux eventually carry multiple GDB clients on one server socket?** ~~Open~~ —
   **answered no, by removing the need.** Everything it promised (no `duplicateStream` connections,
   no `CDLiveWatchSetup`, live watch on single-connection servers, run/stop state for the second
   client, and no §4.7.4 breakpoint wipe) follows from making live watch an Agent **consumer**
   instead of a second GDB — item 20a. That needs none of the hard part: no per-client `qSupported`,
   ack mode, `Hg` or `qXfer` virtualisation, and no `Z`/`z` ownership policy between two GDBs that
   both think they own the breakpoint table. It would only come back for a genuine second _user_
   GDB, which nobody has asked for.
5. **`g`/`p` register reads** (§4.5) — halted-only, and formally `Hg`-dependent on a socket where
   we may not set `Hg`. Needed for stack probing. Decide at Phase 4 item 23.
6. **Reads while the target runs are not atomic with respect to the target.** RTT copes by design
   (the ring protocol assumes it). A multi-word structure read or a stack probe may tear. The mux
   offers no atomicity guarantee and must not pretend to; each consumer owns the problem — see §4.8,
   which is where that obligation is written down.
7. **Poll-rate arbitration** — mostly self-answering. A consumer that asks for a very high drain
   rate simply gets whatever the connection and the probe allow; the request rate is bounded by the
   link, not by a policy we have to invent. The mux's send queue provides the backpressure. What is
   left is narrower: whether a greedy consumer can measurably degrade **GDB's** step/continue
   latency, which it could not when the load sat on a separate connection. Phase 4 item 21 measures
   it; if it is a problem, the fix is a per-consumer rate cap, not an arbitrator.
8. **Multi-core: two different server families, and we support both or a mix.**
    - **OpenOCD family** — one server process serves every core, each on its own gdb port. All cores
      must be prepared when the process starts. But **one GDB connects to one core**, so a VS Code
      session debugs a single core; additional cores are additional sessions via
      `chainedConfigurations`, which share the parent's server process and its ports
      (`getTCPPorts(useParent)` takes them from `args.pvtParent.pvtPorts`).
    - **J-Link family** — a 1:1 server-instance-to-core relationship, so every session looks like a
      single-core session with no sharing between cores.

    Consequence for the mux, and the actual open item: because chained children reuse the parent's
    ports, **every core's RSP traffic flows through the parent session's `ProxyServer`**. So one
    `ProxyServer` can own several muxes, and a mux's lifetime is tied to the _parent_ session rather
    than to the session debugging that core. Confirm that lifetime is handled correctly when a child
    session ends before its parent, and when the parent ends first. Nothing here needs speculative
    multi-core machinery; the per-core mux granularity already matches both families, and
    `launch.json` plus our own config tell us which one a given session is.
