# RTT throughput results

We will use a Rust STM32 program that streams data via RTT as fast as it can. No sleeps. We can use several gdb-servers. All of these were run under the debugger for both TS and Rust

See: /Users/hdm/src/stm32f429-rtt

All figures are session averages, computed from the last `total` line of each run rather than from a
single window. Measured at the same place in every case -- a `pipe` decoder with `output: "none"`, so
no terminal and no child process are in the data path.

| Server   | builtin (TS)  | builtin (Rust) | Rust vs TS | server RTT |
| -------- | ------------- | -------------- | ---------- | ---------- |
| OpenOCD  | 50.9 KB/s     | **74.3** ⁵     | 1.46×      | 80.1       |
| ST-LINK  | 62.4          | **89.5**       | **1.43×**  | — ²        |
| JLink    | 68.3          | 80.5           | 1.18×      | 152.1 ³    |
| pyOCD    | 24.8          | — ⁴            | —          | — ¹        |
| probe-rs | not attempted | 6.2            | —          | —          |

> **Retracted: the `bytes/pass` and `passes/sec` columns this table used to carry.** They were
> `KB/sec ÷ msgs/sec` off the consumer's stats line, and a `msg` there is **one TCP buffer at the pipe
> decoder, not one drain** — `ThroughputMonitor.record` is called once per `data` event. On a fast
> probe several drains arrive coalesced, by an amount that varies per probe, so the derived
> bytes-per-pass read high and passes-per-second read low. The giveaway is the TypeScript row for
> JLink: 619 bytes per "msg" when that engine never read more than 512 bytes at a time. Any
> cross-server comparison built on those two columns was comparing amounts of socket coalescing.
> `RttStats` now counts reads and writes in the engine itself, and the Agent reports them every five
> seconds (`RTT stats:` lines) — see _Re-measuring_ below.

¹ needs OpenOCD's `rtt start`/poll dance, which we have not implemented for pyOCD.
² the ST-LINK gdb-server has no RTT support at all, so builtin is the only option.
³ J-Link polls RTT in **probe firmware**, with no host round trip per poll. Not the same architecture,
and not a target to chase.

**pyOCD cannot run the Agent engine.** It does not refuse a memory read while the target runs and it
does not error -- it _queues_ the read and answers when the target next stops. Observed as five
consecutive two-second timeouts through a run, each answered within a millisecond of the halt that
followed, while `WrOff` advanced 0 → 0x2f9 the whole time. So the data was there and unreachable. Its
tier is `HaltedOnly`, and for pyOCD `useBuiltinRTT.implementation: "typescript"` is not a fallback but
the only option: the adapter's own engine reads over a **second** connection, where pyOCD answers
happily. See `gdb-rsp.md` §7.

⁴ pyOCD cannot run the Agent engine at all -- see below.

⁵ measured with a **production VSIX**; 66.2 was the same build run under the node inspector. The other
Rust figures in this column are still development-build numbers and are understated by roughly 12% --
see _The 12% was the development setup_ below.

### Where the ceiling is, and probe-rs proving it

Not bytes -- round trips. Each drain that finds data costs three (read the descriptor, read the data,
write `RdOff`), and it is round trips per second that the server and probe latency set.

**probe-rs is the closest thing here to a control experiment**, because its throughput is 10.7× below
OpenOCD's on the same firmware, the same target and the same design. The bytes-per-pass argument that
used to stand here is withdrawn -- it rested on the retracted columns above -- but the conclusion does
not depend on it, because the latency can be measured **without us in the picture at all**. From
probe-rs's own handshake with GDB, before the Agent had sent a single packet:

```text
 0.322  GDB>SRV  $qSupported:…      →   9.998  SRV>GDB  $PacketSize=1000;…    (~10 ms)
10.283  GDB>SRV  $vCont?            →  22.149  SRV>GDB  $vCont;c;C;s;S        (~12 ms)
22.441  GDB>SRV  $vMustReplyEmpty   →  34.664  SRV>GDB  $#00                  (~12 ms)
```

~10–12 ms to answer each of GDB's startup packets, with us doing nothing at all. So probe-rs's
gdb-server has an order of magnitude more per-packet latency than OpenOCD's, and any host-driven
feature on it inherits that. Its tier is `Full` -- it _permits_ everything -- because the tier is about
capability, not speed; a slow server should be slow rather than silently featureless.

Worth stating plainly, because it is easy to mistake for our bug: **6.2 KB/s on probe-rs is probe-rs's
round-trip latency, reproduced by its own handshake, not a property of this design.** ~20 ms per round
trip and three round trips per drain is ~59 ms per drain, and 6.2 KB/s follows from that and a drain
of a few hundred bytes without any appeal to our own counters.

It also predicts the _user-visible_ symptom, which is the same fact wearing another hat: a single step
with a shallow stack trace is 80--100 packets, so ~1 s on probe-rs against ~0.16 s on OpenOCD. That is
what was observed.

So the remaining lever is `set_depth(2)` in no-ack mode, overlapping the `RdOff` write with the next
descriptor read -- three serialised round trips down to about two. §4.2.1 says the servers are serial
so it buys nothing server-side, but the latency it hides is exactly what we are bound by.

### The 12% was the development setup, and VS Code is not a factor

Three runs, same OpenOCD, same firmware, same Agent engine, differing only in how the extension was
built and hosted:

| Run                                     | KB/s     | msgs/sec | bytes/msg | of OpenOCD's own RTT |
| --------------------------------------- | -------- | -------- | --------- | -------------------- |
| development build, VS Code + inspector  | 66.2     | 180      | 377       | 82.6%                |
| development build, CLI, no debugger     | 74.5     | 201      | 378       | 93.0%                |
| **production VSIX, VS Code, optimised** | **74.3** | 202      | 377       | **92.7%**            |
| OpenOCD's own RTT server                | 80.1     | 162      | 506       | --                   |

**The production VSIX under VS Code and the CLI agree to 0.23% -- they are the same number.** So the
earlier framing of this as "the host costs 12%" was wrong: VS Code costs nothing measurable. What cost
12% was the ordinary F5 development loop -- an unoptimised build with the node inspector attached -- and
the fix was to stop measuring that. Every conclusion drawn from the 66.2 figure about OpenOCD being
slow was drawn from a development artifact.

**So the Agent's engine reaches 93% of OpenOCD's own RTT server**, reading target memory through GDB's
own RSP connection, multiplexed, on a server whose RTT support we are not using at all. That is the
result worth quoting.

Two caveats on the rest of the table. The ST-LINK (89.5) and J-Link (80.5) Rust figures were measured
in the same development setup, so **expect both to move up by something like 12%** on a production
build; they are understated, not wrong. And the counter runs below are development-build runs too, so
the ~1.46 ms round trip is if anything pessimistic -- though the ring-buffer size it recovers does not
depend on that at all.

The first counter run below shows `gated 0`, so gate contention -- an earlier guess of ours -- was never
what this was.

**The two lines separate the two possible causes, which is what they are for.** The poll thread hands
bytes to an _unbounded_ `mpsc` channel (`proxy_server/mod.rs`: `let (event_tx, event_rx) = channel()`),
so a slow client cannot throttle it -- it can only make the queue grow. Therefore:

| What the two lines show                  | Where the loss is                                             |
| ---------------------------------------- | ------------------------------------------------------------- |
| `[RTT engine]` > `[RTT Logs stats]`      | **the host** -- the Agent drained it, node did not deliver it |
| both low together, `gated`/`errors` at 0 | the Agent genuinely drained less; the probe or the target     |
| both low together, `gated` climbing      | GDB's traffic on the shared connection                        |

In the CLI run they agree to within 0.1% (74.7 against 74.74), so nothing was lost in the host there --
and the production VSIX matching the CLI says the same thing a second way.

One consequence of that unbounded channel is worth recording separately: a client that stalls while RTT
is flowing makes the Agent accumulate at the full RTT rate -- ~75 KB/s here -- with nothing to stop it.
Not urgent, since a client stalled for long means the session is over anyway, but it is a real unbounded
queue and the drain cap does not bound it.

**bytes/msg did not budge: 377 -> 378 across a 12% change in rate.** Worth noting for two reasons. It
is further evidence the figure is an artifact of the delivery path rather than a drain size -- a real
occupancy number would respond to polling 12% more often. And if it _is_ close to the drain size, then
at ~378 against a 500-byte cap the ring buffer is **not** staying full, which means we are very nearly
keeping up with the firmware and raising `SAFE_DRAIN_BYTES` would buy little here. Those two readings
point in opposite directions for what to do next, which is exactly why the engine's own counters are
needed before changing anything.

### What the counters said, first run (OpenOCD, CLI)

```text
[RTT engine] 74.7 KB/sec | 203 drains/sec, 376 B/drain | 684 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0
[RTT Logs stats] 74.74 KB/sec | 202.9 msgs/sec | window 5.0s, 373.84 KB
```

**The consumer's line and the engine's agree on OpenOCD** -- 203 drains against 202.9 msgs, 376 B
against 374. So no coalescing happens on this path and the original OpenOCD figures were sound; the
retraction above stands as method, not as a correction to that row. The J-Link rows are where the two
must be expected to diverge.

Four things the counters settle, none of which was knowable before:

**1. A round trip on OpenOCD costs 1.46 ms**, and the loop spends essentially all of its time in them:
3.37 trips x 1.46 ms = 4.93 ms per drain, against an observed drain period of 4.93 ms. There is no
slack in the poll loop -- no sleeping, no overhead worth naming. Only fewer or larger round trips can
help. (probe-rs, for scale, is ~20 ms: 14x.)

**2. `trips/drain` measures the target's ring buffer.** A drain of `n` bytes from a uniformly
distributed `RdOff` in a ring of `S` splits into two reads exactly when `RdOff + n > S`, so the excess
over the ideal 3.0 _is_ `n / S`:

    S ~ 376 / 0.37 = 1018 bytes

`defmt-rtt`'s generated `consts.rs` for this firmware says `BUF_SIZE = 1024` -- so the statistic
recovered the buffer size to within 0.6% without reading a symbol, and corrected a 512-byte guess.
Settable with `DEFMT_RTT_BUFFER_SIZE`; a larger ring is one of the few levers on the target side.

**3. Nothing is going wrong.** `gated 0` -- the multiplexer never once refused us, so RTT is not
competing with GDB here, and gate contention is not what the VS Code deficit was. `errors 0` -- no rejected reads, no halved retries. `idle ~1` per five seconds -- the ring is
essentially never empty when we arrive.

**4. The drain cap is not what binds.** 376 B/drain against a 500-byte cap; if the cap bound us we
would be seeing 99 KB/s. The ring holds only ~376 bytes when we arrive, which means the firmware is not
keeping it full at this drain rate.

That last point does _not_ yet mean "firmware-limited", and it is worth being careful about why:
`defmt-rtt` **blocks** when its buffer is full, so the target's output rate is partly set by how fast
the reader drains. J-Link's own RTT gets 152 KB/s from this same firmware, so the target can clearly
produce twice what we are taking. 74.7 KB/s is a stable equilibrium between a blocking writer and our
4.93 ms drain period, not a ceiling either side owns alone.

### Two levers, in order of cheapness

1. **Pipelining, for which `set_depth(2)` is permission and not the mechanism.** The engine never asks
   for two things at once today, so raising the depth on its own changes nothing at all. What would have
   to change, and what the floor is, is worked out below.
2. **Raise `max_bytes_per_drain` and watch `B/drain`.** This is the decisive experiment and it is one
   session: if `B/drain` stays near 376 the source really is the limit here; if it rises, we were
   round-trip bound after all. Expect `trips/drain` to rise towards 4.0 as the cap approaches the ring
   size, since a bigger read wraps more often -- worth it if the bytes more than double.

Wrap splits are 11% of every round trip, which is the cost of a ring smaller than four drains. Growing
`DEFMT_RTT_BUFFER_SIZE` reduces it, but it is the smallest of the three numbers here.

### What can actually be pipelined, and the floor

The test is **not** "have we finished processing the previous reply". It is narrower, and it is the only
one that matters:

> A request may go out before an earlier reply arrives **iff formulating it does not require that
> reply.**

A drain is four steps, and not all of the dependencies between them are real:

| Step                 | What it needs                         | Can overlap with           |
| -------------------- | ------------------------------------- | -------------------------- |
| 1. read descriptor   | nothing -- the address is a constant  | --                         |
| 2. read data (tail)  | step 1's **reply** (`WrOff`, `RdOff`) | genuinely blocked          |
| 2b. read data (head) | step 1's reply only, **not** step 2's | **step 2**                 |
| 3. write `RdOff`     | step 2/2b to have succeeded           | **the next pass's step 1** |

So two overlaps are available, and the wrapped-read one -- the intuitive one -- is the smaller:

| Scheme                                  | trips/drain | per drain | if `B/drain` holds | gain     |
| --------------------------------------- | ----------- | --------- | ------------------ | -------- |
| today                                   | 3.37        | 4.92 ms   | 74.6 KB/s          | --       |
| overlap the two wrapped data reads      | 3.00        | 4.38 ms   | 83.8 KB/s          | +12%     |
| overlap `RdOff` write / next descriptor | 2.37        | 3.46 ms   | 106.1 KB/s         | **+42%** |
| both                                    | 2.00        | 2.92 ms   | 125.7 KB/s         | **+68%** |

**Two is the floor, and no amount of depth beats it**, because step 2's _address_ comes out of step 1's
reply. That one dependency cannot be hidden.

Three things make this cheaper than it looks:

- **`depth` counts every outstanding packet, GDB's included** (`pending.len() >= depth + open_ended`),
  and GDB sends nothing at all while the target runs. So during a run the whole budget is ours, and the
  moment GDB does speak its entry takes a slot and we fall back to today's behaviour automatically. The
  cost to invariant 2 is that GDB's worst case becomes waiting for two replies instead of one, ~1.5 ms.
- The `RdOff` write is **not deferred** by the overlap, only re-timed: it goes out at ~4.4 ms into the
  pass today and would go out at 0 ms of the next one, which is nearly the same instant. That matters,
  because `RdOff` is what unblocks a blocking writer like `defmt-rtt` and delaying it would cost real
  throughput -- the same trade-off `DrainOptions::advance_after_each_run` already records.
- RSP is strictly ordered on one connection, so a write followed by a read is processed in that order;
  the pipelined descriptor read cannot observe a pre-write `RdOff`.

And one hazard that deserves a test rather than a comment: **if the `RdOff` write fails after the next
descriptor read has already gone out**, that descriptor still carries the old `RdOff`, so the same bytes
look available again and would be delivered a second time. Duplicate RTT output is exactly the bug class
already fixed once on the TypeScript side, so the rule has to be that a failed `RdOff` write discards
the descriptor fetched alongside it.

None of this is a redesign. `Consumer::read_memory` is blocking request/reply, so the wrapped case wants
a batched primitive of roughly the shape `read_many(&[(addr, len)])` -- issue all, then collect -- and
the larger one wants `one_pass` to carry "the `RdOff` I still owe" into the next pass.

### Re-measuring

The numbers in the table are sound -- they are bytes arriving at the last consumer, measured the same
way for every row. What was never measured is _why_ a row sits where it does, and that is the open
question: **OpenOCD's own RTT server does 80.1 KB/s while we manage 66.2 through it, yet the same
engine does 80.5 through JLink.** These are memory reads either way, so one of three things is true,
and the engine's counters now separate them in a single run:

| What the `RTT stats:` line shows               | What it means                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `idle` climbing                                | the firmware had nothing; throughput is its production rate, not our cost         |
| `gated` climbing                               | we were forbidden to ask -- GDB's traffic on the shared connection, not the probe |
| `errors` climbing                              | reads being rejected and retried at half size, which silently doubles the cost    |
| `B/trip` well under the cap, none of the above | the buffer is not staying full, so we are outrunning the firmware                 |
| `B/trip` at the cap, `trips/s` low             | round-trip bound, and `SAFE_DRAIN_BYTES` is the lever                             |

These arrive in the Debug Console with **no debug flag required**, as an `[RTT engine]` line beside the
consumer's `[RTT Logs stats]` line, on the same window so the two can be read against each other.

**They share one switch, which already existed**: the per-decoder `stats` option. A session where no
decoder asks for statistics gets no `[RTT engine]` lines either -- the Agent is told `stats_interval_ms:
null` and sends nothing, so this costs a session that did not ask for it exactly nothing. No new
user-facing flag, and the right coupling besides: `trips/sec` says what the consumer's bytes _cost_, and
only the pair distinguishes "the Agent drained less" from "the host delivered less". `statsInterval`
carries across too, so both lines always describe the same window; where several decoders disagree the
shortest wins.

```text
[RTT engine]    74.4 KB/sec | 201 drains/sec, 378 B/drain | 603 trips/sec, 3.0 trips/drain | idle 12, gated 0, errors 0 | total 4.38 MB over 60.1s
[RTT Logs stats] 74.4 KB/sec | 201.5 msgs/sec | window 5.0s, 376.42 KB | total 4.37 MB over 60.1s
```

`trips/drain` is the one to watch for a surprise: a drain costs exactly three round trips (read the
descriptor, read the data, write `RdOff`), so materially more than 3.0 means wrapped drains splitting
into two reads, or reads being rejected and retried at half size.

The counters travel as an `rttStats` funnel event rather than on the Agent's stderr, which
`ProxyHelper.handleHelperStderr` discards unless `debugFlags.anyFlags` is set -- and that is computed
_excluding_ the Agent's own flags, so `rspTrace` would not have enabled it. Measuring throughput is a
feature, not debug noise. The event is **cumulative**; the client subtracts consecutive samples, so a
dropped one costs one window rather than bytes off the total.

On OpenOCD the CLI run above makes `gated` the leading candidate and the drain cap the least likely,
since 378 bytes against a 500-byte cap is not a full buffer. The cap is still the cheapest lever
wherever a server _is_ round-trip bound -- at three round trips per drain, doubling bytes per drain
very nearly doubles throughput -- and `rttConfig.max_bytes_per_drain` raises it per session, with
`ReplyRejected` already retrying at half size if a server refuses. Worth a 500 / 1000 / 2000 sweep
once the counters say which servers those are.

### Caveats on these numbers

- ST-LINK's 89.5 predates the 500-byte drain cap (`SAFE_DRAIN_BYTES`), so expect it to move slightly
  on a re-run.
- The ST-LINK gdb-server truncates a reply of exactly 1024 bytes, losing its last checksum digit to a
  NUL terminator. A 510-byte read produces exactly that, and failed 4 times out of 4. Hence the cap;
  see `SAFE_DRAIN_BYTES` for the arithmetic and the family of bad sizes.
- `polling_interval: 1` throughout, which is irrelevant at these rates: the loop does not sleep at all
  while data is flowing.
- probe-rs needed a framing fix before it worked at all. It is the only server seen to emit `#` or `$`
  as a run-length **count** byte -- eight spaces of XML indentation in its `target.xml` encode as
  ` *$` -- which the manual forbids and GDB nonetheless tolerates, because GDB consumes the byte after
  `*` inline as it scans. Our codec searched for the terminator positionally first, split the reply at
  the count byte, and then never retired GDB's pending `qXfer` entry, which at depth 1 shut the
  Agent's send gate for the whole session. See `scan_frame` in `gdb_rsp/frame.rs`.

## Builtin RTT in Typescript

### OpenOCD

```
[RTT Logs stats] 53.42 KB/sec | 195.9 msgs/sec | window 5.0s, 267.18 KB | total 267.18 KB over 5.0s
[RTT Logs stats] 52.52 KB/sec | 196.0 msgs/sec | window 5.0s, 262.67 KB | total 529.85 KB over 10.0s
[RTT Logs stats] 50.54 KB/sec | 192.9 msgs/sec | window 5.0s, 252.87 KB | total 782.72 KB over 15.0s
[RTT Logs stats] 53.06 KB/sec | 200.3 msgs/sec | window 5.0s, 265.74 KB | total 1.02 MB over 20.0s
[RTT Logs stats] 49.70 KB/sec | 191.6 msgs/sec | window 5.0s, 248.76 KB | total 1.27 MB over 25.0s
[RTT Logs stats] 50.80 KB/sec | 193.0 msgs/sec | window 5.0s, 254.31 KB | total 1.52 MB over 30.1s
[RTT Logs stats] 51.29 KB/sec | 192.8 msgs/sec | window 5.0s, 256.69 KB | total 1.77 MB over 35.1s
[RTT Logs stats] 51.26 KB/sec | 190.9 msgs/sec | window 5.0s, 256.41 KB | total 2.02 MB over 40.1s
[RTT Logs stats] 48.91 KB/sec | 189.3 msgs/sec | window 5.0s, 244.72 KB | total 2.26 MB over 45.1s
[RTT Logs stats] 51.45 KB/sec | 193.5 msgs/sec | window 5.0s, 257.37 KB | total 2.51 MB over 50.1s
[RTT Logs stats] 49.78 KB/sec | 191.9 msgs/sec | window 5.0s, 249.00 KB | total 2.75 MB over 55.1s
[RTT Logs stats] 49.98 KB/sec | 192.0 msgs/sec | window 5.0s, 250.14 KB | total 2.99 MB over 60.1s
[RTT Logs stats] 50.10 KB/sec | 191.6 msgs/sec | window 5.0s, 250.78 KB | total 3.24 MB over 65.1s
```

### pyOCD

```
[RTT Logs stats] 25.85 KB/sec | 98.2 msgs/sec | window 5.0s, 129.50 KB | total 129.50 KB over 5.0s
[RTT Logs stats] 25.27 KB/sec | 95.1 msgs/sec | window 5.0s, 126.50 KB | total 256.00 KB over 10.0s
[RTT Logs stats] 24.65 KB/sec | 93.8 msgs/sec | window 5.0s, 123.55 KB | total 379.55 KB over 15.0s
[RTT Logs stats] 24.76 KB/sec | 92.9 msgs/sec | window 5.0s, 123.95 KB | total 503.50 KB over 20.1s
[RTT Logs stats] 24.56 KB/sec | 93.5 msgs/sec | window 5.0s, 122.93 KB | total 626.43 KB over 25.1s
[RTT Logs stats] 24.69 KB/sec | 92.3 msgs/sec | window 5.0s, 123.57 KB | total 750.00 KB over 30.1s
[RTT Logs stats] 24.09 KB/sec | 93.5 msgs/sec | window 5.0s, 120.54 KB | total 870.54 KB over 35.1s
[RTT Logs stats] 24.44 KB/sec | 92.6 msgs/sec | window 5.0s, 122.46 KB | total 993.00 KB over 40.1s
```

### STLink

```
[RTT Logs stats] 64.35 KB/sec | 219.8 msgs/sec | window 5.0s, 321.83 KB | total 321.83 KB over 5.0s
[RTT Logs stats] 61.87 KB/sec | 216.8 msgs/sec | window 5.0s, 309.67 KB | total 631.50 KB over 10.0s
[RTT Logs stats] 61.28 KB/sec | 216.7 msgs/sec | window 5.0s, 306.50 KB | total 938.00 KB over 15.0s
[RTT Logs stats] 61.54 KB/sec | 216.8 msgs/sec | window 5.0s, 308.00 KB | total 1.22 MB over 20.0s
[RTT Logs stats] 61.94 KB/sec | 217.5 msgs/sec | window 5.0s, 309.83 KB | total 1.52 MB over 25.0s
[RTT Logs stats] 60.56 KB/sec | 217.3 msgs/sec | window 5.0s, 302.97 KB | total 1.82 MB over 30.0s
[RTT Logs stats] 64.59 KB/sec | 222.9 msgs/sec | window 5.0s, 323.09 KB | total 2.13 MB over 35.0s
[RTT Logs stats] 64.17 KB/sec | 222.6 msgs/sec | window 5.0s, 321.11 KB | total 2.44 MB over 40.1s
[RTT Logs stats] 62.43 KB/sec | 218.7 msgs/sec | window 5.0s, 312.57 KB | total 2.75 MB over 45.1s
```

### JLink (fw programmed into STLink)

```
[RTT Logs stats] 67.45 KB/sec | 114.2 msgs/sec | window 5.0s, 337.38 KB | total 337.38 KB over 5.0s
[RTT Logs stats] 68.26 KB/sec | 114.3 msgs/sec | window 5.0s, 341.63 KB | total 679.00 KB over 10.0s
[RTT Logs stats] 67.11 KB/sec | 113.5 msgs/sec | window 5.0s, 335.98 KB | total 1014.98 KB over 15.0s
[RTT Logs stats] 67.80 KB/sec | 111.9 msgs/sec | window 5.0s, 339.41 KB | total 1.32 MB over 20.0s
[RTT Logs stats] 69.06 KB/sec | 112.1 msgs/sec | window 5.0s, 345.66 KB | total 1.66 MB over 25.0s
[RTT Logs stats] 68.14 KB/sec | 113.7 msgs/sec | window 5.0s, 341.09 KB | total 1.99 MB over 30.1s
[RTT Logs stats] 68.95 KB/sec | 114.3 msgs/sec | window 5.0s, 345.15 KB | total 2.33 MB over 35.1s
[RTT Logs stats] 70.17 KB/sec | 112.5 msgs/sec | window 5.0s, 351.21 KB | total 2.67 MB over 40.1s
[RTT Logs stats] 69.79 KB/sec | 115.0 msgs/sec | window 5.0s, 349.50 KB | total 3.01 MB over 45.1s
```

## Builtin RTT in Rust

### OpenOCD

```
[RTT Logs stats] 66.05 KB/sec | 183.0 msgs/sec | window 5.0s, 330.58 KB | total 330.58 KB over 5.0s
[RTT Logs stats] 66.40 KB/sec | 182.1 msgs/sec | window 5.0s, 332.25 KB | total 662.83 KB over 10.0s
[RTT Logs stats] 66.57 KB/sec | 179.3 msgs/sec | window 5.0s, 333.07 KB | total 995.90 KB over 15.0s
[RTT Logs stats] 66.65 KB/sec | 180.3 msgs/sec | window 5.0s, 333.54 KB | total 1.30 MB over 20.0s
[RTT Logs stats] 66.12 KB/sec | 181.8 msgs/sec | window 5.0s, 330.94 KB | total 1.62 MB over 25.0s
[RTT Logs stats] 65.26 KB/sec | 179.3 msgs/sec | window 5.0s, 326.77 KB | total 1.94 MB over 30.1s
[RTT Logs stats] 65.65 KB/sec | 179.4 msgs/sec | window 5.0s, 328.63 KB | total 2.26 MB over 35.1s
[RTT Logs stats] 66.52 KB/sec | 181.0 msgs/sec | window 5.0s, 332.91 KB | total 2.59 MB over 40.1s
[RTT Logs stats] 66.29 KB/sec | 179.2 msgs/sec | window 5.0s, 331.80 KB | total 2.91 MB over 45.1s
[RTT Logs stats] 67.05 KB/sec | 181.7 msgs/sec | window 5.0s, 335.45 KB | total 3.24 MB over 50.1s
[RTT Logs stats] 66.91 KB/sec | 178.6 msgs/sec | window 5.0s, 334.64 KB | total 3.57 MB over 55.1s
[RTT Logs stats] 65.89 KB/sec | 180.3 msgs/sec | window 5.0s, 329.65 KB | total 3.89 MB over 60.1s
[RTT Logs stats] 66.24 KB/sec | 177.1 msgs/sec | window 5.0s, 331.38 KB | total 4.21 MB over 65.1s
[RTT Logs stats] 65.25 KB/sec | 179.3 msgs/sec | window 5.0s, 326.45 KB | total 4.53 MB over 70.1s
```

### STLink

```
[RTT Logs stats] 91.23 KB/sec | 184.9 msgs/sec | window 5.0s, 456.33 KB | total 456.33 KB over 5.0s
[RTT Logs stats] 88.87 KB/sec | 180.7 msgs/sec | window 5.0s, 444.54 KB | total 900.88 KB over 10.0s
[RTT Logs stats] 88.35 KB/sec | 177.6 msgs/sec | window 5.0s, 441.86 KB | total 1.31 MB over 15.0s
[RTT Logs stats] 92.18 KB/sec | 185.2 msgs/sec | window 5.0s, 461.01 KB | total 1.76 MB over 20.0s
[RTT Logs stats] 91.39 KB/sec | 182.1 msgs/sec | window 5.0s, 457.31 KB | total 2.21 MB over 25.0s
[RTT Logs stats] 90.15 KB/sec | 183.3 msgs/sec | window 5.0s, 451.37 KB | total 2.65 MB over 30.0s
[RTT Logs stats] 89.07 KB/sec | 178.6 msgs/sec | window 5.0s, 445.42 KB | total 3.08 MB over 35.0s
[RTT Logs stats] 91.06 KB/sec | 177.5 msgs/sec | window 5.0s, 455.47 KB | total 3.53 MB over 40.0s
[RTT Logs stats] 90.50 KB/sec | 183.0 msgs/sec | window 5.0s, 453.03 KB | total 3.97 MB over 45.1s
[RTT Logs stats] 90.57 KB/sec | 183.5 msgs/sec | window 5.0s, 453.01 KB | total 4.41 MB over 50.1s
[RTT Logs stats] 91.41 KB/sec | 180.7 msgs/sec | window 5.0s, 457.43 KB | total 4.86 MB over 55.1s
[RTT Logs stats] 90.55 KB/sec | 181.5 msgs/sec | window 5.0s, 453.09 KB | total 5.30 MB over 60.1s
[RTT Logs stats] 89.58 KB/sec | 177.0 msgs/sec | window 5.0s, 448.34 KB | total 5.74 MB over 65.1s
[RTT Logs stats] 90.81 KB/sec | 181.5 msgs/sec | window 5.0s, 454.23 KB | total 6.18 MB over 70.1s
[RTT Logs stats] 90.14 KB/sec | 184.0 msgs/sec | window 5.0s, 450.77 KB | total 6.62 MB over 75.1s
[RTT Logs stats] 89.58 KB/sec | 177.6 msgs/sec | window 5.0s, 448.00 KB | total 7.06 MB over 80.1s
```

### JLink

```
[RTT Logs stats] 80.93 KB/sec | 112.1 msgs/sec | window 5.0s, 404.96 KB | total 404.96 KB over 5.0s
[RTT Logs stats] 80.35 KB/sec | 112.5 msgs/sec | window 5.0s, 402.24 KB | total 807.20 KB over 10.0s
[RTT Logs stats] 80.62 KB/sec | 113.2 msgs/sec | window 5.0s, 403.20 KB | total 1.18 MB over 15.0s
[RTT Logs stats] 80.33 KB/sec | 114.7 msgs/sec | window 5.0s, 402.54 KB | total 1.58 MB over 20.0s
[RTT Logs stats] 80.91 KB/sec | 112.9 msgs/sec | window 5.0s, 404.94 KB | total 1.97 MB over 25.1s
[RTT Logs stats] 80.81 KB/sec | 111.9 msgs/sec | window 5.0s, 404.28 KB | total 2.37 MB over 30.1s
[RTT Logs stats] 80.10 KB/sec | 112.0 msgs/sec | window 5.0s, 401.38 KB | total 2.76 MB over 35.1s
[RTT Logs stats] 79.69 KB/sec | 110.4 msgs/sec | window 5.0s, 398.52 KB | total 3.15 MB over 40.1s
[RTT Logs stats] 79.87 KB/sec | 110.6 msgs/sec | window 5.0s, 399.42 KB | total 3.54 MB over 45.1s
[RTT Logs stats] 80.89 KB/sec | 113.0 msgs/sec | window 5.0s, 404.54 KB | total 3.93 MB over 50.1s
[RTT Logs stats] 80.69 KB/sec | 111.5 msgs/sec | window 5.0s, 403.86 KB | total 4.33 MB over 55.1s
[RTT Logs stats] 80.67 KB/sec | 111.3 msgs/sec | window 5.0s, 403.83 KB | total 4.72 MB over 60.2s
[RTT Logs stats] 80.73 KB/sec | 112.6 msgs/sec | window 5.0s, 404.20 KB | total 5.12 MB over 65.2s
[RTT Logs stats] 82.06 KB/sec | 113.2 msgs/sec | window 5.0s, 410.88 KB | total 5.52 MB over 70.2s
```

# RTT provided by gdb-server

## Openocd

```
[RTT Logs stats] 81.62 KB/sec | 162.6 msgs/sec | window 5.0s, 408.68 KB | total 408.68 KB over 5.0s
[RTT Logs stats] 81.17 KB/sec | 161.9 msgs/sec | window 5.0s, 406.02 KB | total 814.69 KB over 10.0s
[RTT Logs stats] 80.77 KB/sec | 160.8 msgs/sec | window 5.0s, 403.95 KB | total 1.19 MB over 15.0s
[RTT Logs stats] 80.12 KB/sec | 162.5 msgs/sec | window 5.0s, 400.77 KB | total 1.58 MB over 20.0s
[RTT Logs stats] 79.54 KB/sec | 161.7 msgs/sec | window 5.0s, 398.04 KB | total 1.97 MB over 25.0s
[RTT Logs stats] 79.46 KB/sec | 163.7 msgs/sec | window 5.0s, 397.92 KB | total 2.36 MB over 30.1s
[RTT Logs stats] 78.12 KB/sec | 159.2 msgs/sec | window 5.0s, 391.15 KB | total 2.74 MB over 35.1s
[RTT Logs stats] 80.68 KB/sec | 163.2 msgs/sec | window 5.0s, 403.48 KB | total 3.13 MB over 40.1s
[RTT Logs stats] 81.02 KB/sec | 162.5 msgs/sec | window 5.0s, 405.26 KB | total 3.53 MB over 45.1s
```

## pyOCD

Not functional...same issue as openocd, we have to poll and start rtt and we don't know how to do
that yet as we use the tcl channel for doing that polling. Not worth that investment.

## STlink

Not supported by stlink

## JLink (fw programmed into STLink)

```
[RTT Logs stats] 59.04 KB/sec | 24.1 msgs/sec | window 5.0s, 296.12 KB | total 296.12 KB over 5.0s
[RTT Logs stats] 150.68 KB/sec | 55.0 msgs/sec | window 5.0s, 753.68 KB | total 1.03 MB over 10.0s
[RTT Logs stats] 152.80 KB/sec | 54.7 msgs/sec | window 5.0s, 765.67 KB | total 1.77 MB over 15.1s
[RTT Logs stats] 152.67 KB/sec | 54.0 msgs/sec | window 5.0s, 763.66 KB | total 2.52 MB over 20.1s
[RTT Logs stats] 152.79 KB/sec | 54.3 msgs/sec | window 5.0s, 765.79 KB | total 3.27 MB over 25.1s
[RTT Logs stats] 152.77 KB/sec | 54.0 msgs/sec | window 5.0s, 765.98 KB | total 4.01 MB over 30.1s
[RTT Logs stats] 152.85 KB/sec | 54.9 msgs/sec | window 5.0s, 765.16 KB | total 4.76 MB over 35.2s
[RTT Logs stats] 152.96 KB/sec | 54.8 msgs/sec | window 5.0s, 764.96 KB | total 5.51 MB over 40.2s
[RTT Logs stats] 152.75 KB/sec | 54.4 msgs/sec | window 5.0s, 766.37 KB | total 6.26 MB over 45.2s
```
