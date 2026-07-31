# Stream Flow Control — Per-Stream Classification & gdb-server Output Throttling

**Status:** Design captured; **deferred future enhancement** (not blocking the singleton). 2026-07-31.
**Origin:** R6 discussion in [CLI-Proxy-Provisioning.md](./CLI-Proxy-Provisioning.md) §7.3. A fast source + slow sink can grow the proxy's unbounded event channel and, worse, melt the client terminal.

---

## The decision: classify each stream — one-size-fits-all is wrong

The Probe Agent funnels several kinds of stream through one event channel. They have **completely different flow-control needs**, so any uniform policy (uniform drop, uniform backpressure, uniform bound) is wrong for some of them. Classify and treat separately:

| Stream | Flow-control policy | Why |
| --- | --- | --- |
| **GDB RSP** (forwarded gdb port) | **Never touch.** No drop, no added latency, no throttle. | Dropping corrupts the debug protocol; even added latency degrades the debug experience. |
| **SWD / Serial / RTT** (forwarded data, serial funnel) | **Never throttle.** | These don't tie up the pipe in practice, and the **user already controls their rate** (baud, RTT poll, trace config). Not ours to second-guess. |
| **Control** (stream 0) | Never drop. | Protocol/handshake integrity. |
| **gdb-server stdout/stderr** (OpenOCD / J-Link / probe-rs logs) | **Throttleable** (see below). | Diagnostic logging is lossy-tolerable, and it is the *only* stream that actually firehoses. |

The firehose is always the **gdb-server's own stdout/stderr**, and that is exactly the one class where shedding load is acceptable. So the safe streams and the dangerous stream never collide.

### The triggering pain (real, observed)

- **OpenOCD on USB-cable disconnect**: enters an error loop emitting messages several times a second, **forever** — it never exits, so exit-detection can't catch it. Brings terminals (especially the VS Code integrated terminal) to their knees; the whole IDE gets sluggish.
- **Verbose logging** on OpenOCD and J-Link produces the same sustained flood.

---

## Throttling strategy for gdb-server stdout/stderr (future enhancement)

Only stdout/stderr, only while flooding. Sketch (to be refined against real output — see below):

1. **Trigger on line rate.** Pass output through untouched until the *line rate* exceeds a threshold; only then engage throttling. Normal operation is never altered.
2. **During high-rate periods only, coalesce repeated lines.** Emit a repeated line **once every 1–5 s** with a **repeat count**, instead of every occurrence.
3. **"Mostly repeated," not just identical.** Treat lines as repeats when **≥ ~60 % of the content matches** (these servers vary a counter/address/timestamp per line, so exact-match dedup would miss most of it).
4. **Precedent:** the VS Code Debug Console already does a repeat-count collapse for *consecutive identical* lines — good UX to mirror, but we need the fuzzy (≥60 %) match because gdb-server spew is rarely byte-identical.
5. **Honesty:** whatever is suppressed must be reflected (the repeat count is the honest signal); never silently drop with no indication.

### Open work before implementing

- **Study the actual output patterns** of OpenOCD, J-Link, and probe-rs during floods (disconnect loops, verbose mode) to tune the threshold, the similarity metric, and the coalescing window. The strategy above is a hypothesis, not a spec.
- Decide the similarity metric (prefix match? token overlap? edit distance?) and its cost at high line rates.
- Consider **tee-to-file** on the Probe Host so the full, unthrottled log is recoverable even when the live stream is coalesced.
- Consider a **runaway signal** to the user ("server output abnormally high — possible disconnect/error loop"), since OpenOCD-on-disconnect never exits and this is otherwise a silent, mysterious IDE freeze.

---

## Interaction with R6 (event-channel bound)

The memory-safety half of R6 — bounding the currently-unbounded event channel so a firehose can't OOM the singleton — is **entangled with this classification** and deferred with it: a bound is only correct if it knows *which* stream to shed (stdout/stderr) versus which to protect (RSP, SWD/Serial/RTT). A uniform bounded/backpressured channel would, for example, backpressure the serial reader and cause the per-port queue to drop serial data — exactly what we said never to do.

**Accepted interim risk:** until this lands, a pathological gdb-server firehose can still grow the event channel. This is **pre-existing** behavior (not a singleton regression), bounded in practice by the 5 s client-write timeout that tears down a fully-stuck client, and lower-likelihood than the terminal-melting UX problem this doc is really about. Acceptable to defer while the singleton core is completed.
