# RTT throughput results

Agent-side RTT reads the target's ring buffer over **GDB's own RSP connection**, multiplexed behind
whatever GDB is doing, using no RTT support from the gdb-server at all. This records what that costs
and what limits it.

Target: a Rust STM32F429 program (180 MHz) that streams `defmt` over RTT as fast as it can, no sleeps
-- `/Users/hdm/src/stm32f429-rtt`. Every figure is measured at the **same place**: a `pipe` decoder with
`output: "none"`, so no terminal and no child process are in the data path. Session averages, from the
steady state; every run has a ~10-second transient at the start which is excluded.

## Where this ended up

| Configuration                                                |      KB/s | vs the best gdb-server RTT |
| ------------------------------------------------------------ | --------: | -------------------------- |
| ST-LINK, 4096-byte ring, 2000-byte cap                       | **126.1** | **1.57×** OpenOCD's own    |
| ST-LINK, same but a 4000-byte cap                            |     133.3 | 1.66×                      |
| ST-LINK, stock 1024-byte ring, 500-byte cap (where we began) |      78.0 | 0.97×                      |
| OpenOCD's own RTT server, for reference                      |      80.1 | --                         |
| J-Link's RTT, polled in **probe firmware**                   |     152.1 | 1.90×                      |

Two numbers in that table are not ours and are worth separating. OpenOCD's 80.1 is the thing to beat,
because it is host-driven RTT with privileged access -- in-process, no RSP, no packet framing -- and we
are now 1.57× past it _through_ RSP. J-Link's 152.1 is a different architecture: it polls the ring
inside the probe and never makes a host round trip. It is the physical ceiling, not a competitor, and
the section below shows we are within 17% of it and can say exactly where the remainder goes.

## The model: throughput is round trips, and round trips slow the target down

Each drain that finds data costs **three** round trips -- read the descriptor, read the data, write
`RdOff` -- plus one more whenever the data wraps the end of the ring. Measured `trips/drain` matched
`3 + B/drain ÷ SizeOfBuffer` to two decimals at every cap and at both ring sizes, so that part is
settled.

What was not expected is the second half. Fitting delivered throughput against round trips per second
over seven runs spanning two ring sizes and five cap values gives **one straight line**:

```text
KB/s = 153.1 - 109 bytes per round trip

 trips/s   measured    fit    err   ring   cap
     956       53.0   51.1   -1.9   1024    200
     715       78.0   76.8   -1.2   1024    500
     612       87.2   87.8   +0.6   1024   1000
     605       86.4   88.6   +2.2   1024   2000
     592       87.6   90.0   +2.4   4096    500
     404      108.8  110.0   +1.2   4096   1000
     284      126.1  122.8   -3.3   4096   2000
```

**Every debugger round trip costs the firmware about 109 bytes of its own output.** That is AHB
contention: the AHB-AP steals SRAM cycles from the Cortex-M4 that is filling the ring, so a read does
not merely take time on the wire, it _slows the producer_. It is why a smaller drain cap loses twice --
smaller bites, and more of them.

The line's intercept is the check worth trusting it for. Extrapolated to **zero** host round trips it
predicts **153.1 KB/s**, and J-Link's RTT -- which polls in probe firmware and makes no host round trip
-- measures **152.1 KB/s** on this same firmware. Two independent measurements 0.7% apart. J-Link's
advantage stopped being mysterious: it is the zero-round-trip case of this line.

The agreement holds _because_ both measured the same firmware build, which is also the caveat: see
_the firmware is the next lever_ below.

## The drain cap, and why 500 was costing 40%

`DrainOptions::max_bytes` bounds one drain so a single channel cannot hold the shared connection while
GDB waits behind it (§4.2 invariant 2). It was 500 everywhere, for a good reason that had been
generalised too far -- and it was the largest single loss in the whole measurement.

| cap  | ring 1024 | ring 4096 | B/drain (4096) | % of cap | trips/s |
| ---- | --------: | --------: | -------------: | -------: | ------: |
| 200  |      53.0 |         - |              - |      91% |     956 |
| 500  |      78.0 |      87.6 |            470 |      94% |     592 |
| 1000 |      87.2 |     108.8 |            883 |      88% |     404 |
| 2000 |      86.4 | **126.1** |           1545 |      77% |     284 |
| 3000 |         - |     132.4 |           1990 |      66% |     239 |
| 4000 |         - |     133.3 |           2160 |      54% |     221 |

Two things to read off it.

**The stock ring caps the cap.** `defmt-rtt` defaults to `BUF_SIZE = 1024`, so `available` can never
exceed 1023 and every cap at or above ~1000 is the same cap. That is why the 1024-ring column flattens
at 87 and the 4096-ring column keeps climbing. Raising `DEFMT_RTT_BUFFER_SIZE` is a _target-side_ change
and has to come first; it is worth +46% at cap 2000 on its own.

**The curve has a knee at 2000**: +24%, +16%, then +5.0%, then +0.6%. Past that the reply a single read
produces keeps doubling while the return vanishes -- a 4000-byte read is an 8 KB reply, and invariant 2
means GDB's worst case is waiting behind one of our reads, so that is ~15 ms bought for 0.6%. Hence the
default sits at the knee.

### The defaults, and why they are per server

```rust
"openocd"          => 500,   // and it stays there
"stlink" | "jlink" => 2000,  // measured on ST-LINK; J-Link inherits it
"probe-rs"         => 500,   // ~20 ms a round trip; bytes are not its problem
_                  => 500,   // unmeasured is unmeasured
```

OpenOCD stays at 500 and not out of timidity: it carried a 512-byte memory-request bug for years, fixed
upstream by this project's author, and the version that runs is whatever a vendor's IDE installer
shipped. A macOS update silently replacing ST's bundled OpenOCD _mid-benchmark_ is how much control
there is over that.

**`PacketSize` cannot supply this number, and the asymmetry is the whole point.** The manual is
specific -- "the remote stub can accept packets up to at least bytes length. GDB will send packets up to
this size for bulk transfers, and will never send larger packets" -- so it bounds what the stub
_receives_ and is no evidence whatever about the size of reply it can produce. ST-LINK advertises
`PacketSize=4000` (hex: 16384 bytes) and truncates a reply of exactly 1024. So a _large_ advertised
value buys nothing; a _small_ one is a server telling us its buffers are small, which is worth believing
in the conservative direction. It is applied as a ceiling only:

```rust
drain_cap(server, packet_size) = drain_cap_for_server(server).min(packet_size / 2 - 8)
```

`packet_size / 2 - 8` leaves the reply 12 bytes short of the advertised figure (`2n + 4 = PacketSize -
12`) and, as a side effect, can never land on a power of two when `PacketSize` is one -- which matters
for the reason below.

### The poison sizes

A hex `m` reply is `$` + 2n + `#` + 2 = **2n + 4** bytes. A stub whose reply buffer is a power of two
therefore has no room for its NUL terminator at exactly **one** request length per buffer size:

| n    | reply |                                                         |
| ---- | ----- | ------------------------------------------------------- |
| 254  | 512   | OpenOCD's buffer, historically                          |
| 510  | 1024  | **measured failing on ST-LINK, four times out of four** |
| 1022 | 2048  |                                                         |
| 2046 | 4096  |                                                         |
| 4094 | 8192  |                                                         |

Keeping the _default_ below the smallest of them was the first fix and it was incomplete: a read length
is `min(remaining, budget)`, so it lands wherever the caller's data happens to end. A 1024-byte ring
reaches `available == 1022` routinely; a 4096-byte ring reaches 2046 routinely. `safe_read_len` in
`gdb_rsp/chunk.rs` now guards the one place a packet's length is chosen, so every caller is covered at a
cost of one byte on one length per buffer size. Consecutive replies differ by 2, so a single decrement
always suffices.

ST-LINK's behaviour above 1024 is now settled, incidentally: at cap 4000 individual reads exceeded 2864
bytes, so replies of **at least 5.7 KB** were served cleanly with `errors 0`. The 1024 failure is a
boundary bug, not a buffer limit.

## What is left, in order of size

**1. The firmware, and it is not close.** 153 KB/s undisturbed at 180 MHz is **1149 CPU cycles per byte
emitted**, for code whose job is to copy bytes into a ring. The cause is `opt-level = 0` in the
firmware's own `[profile.release]`. Fixing it moves the intercept of the line above -- and the slope
too, in opposite directions: contention steals a fixed number of _cycles_, so fewer cycles per byte
means each round trip costs _more_ bytes. Both parameters move, so the model needs refitting rather than
rescaling, and every absolute figure in this document is a property of the unoptimized build.

**2. Pipelining, now worth much less than when it was first costed.** The drain-cap work ate most of it,
because larger drains already cut round trips per byte:

| scheme                                  | trips/drain |  KB/s |  gain |
| --------------------------------------- | ----------: | ----: | ----: |
| today                                   |        3.38 | 123.6 |    -- |
| overlap the two wrapped data reads      |        3.00 | 126.3 | +2.2% |
| overlap `RdOff` write / next descriptor |        2.38 | 131.0 | +6.1% |
| both                                    |        2.00 | 134.1 | +8.5% |

The same table computed when a drain was 500 bytes gave +21% for "both". **That is the correction worth
keeping**: the value of an optimisation is not a property of the optimisation. It was recorded here as
+68% against a constant-`B/drain` assumption that the contention model has since replaced.

**3. Nothing else is measurable.** `gated 0` in every run -- the multiplexer has never once refused the
RTT engine, so RTT is not competing with GDB. `errors 0` -- no rejected reads. `idle` is 0--3 per
five-second window, which at a 1-millisecond interval is 0.02% of the run, so the poll loop does not
sleep in any sense that matters and `polling_interval` is not a knob.

### What can actually be pipelined, and the floor

The test is **not** "have we finished processing the previous reply". It is narrower, and it is the only
one that matters:

> A request may go out before an earlier reply arrives **iff formulating it does not require that
> reply.**

| Step                 | What it needs                         | Can overlap with           |
| -------------------- | ------------------------------------- | -------------------------- |
| 1. read descriptor   | nothing -- the address is a constant  | --                         |
| 2. read data (tail)  | step 1's **reply** (`WrOff`, `RdOff`) | genuinely blocked          |
| 2b. read data (head) | step 1's reply only, **not** step 2's | **step 2**                 |
| 3. write `RdOff`     | step 2/2b to have succeeded           | **the next pass's step 1** |

**Two is the floor, and no amount of depth beats it**, because step 2's _address_ comes out of step 1's
reply. That one dependency cannot be hidden. Three things make the rest cheaper than it looks:

- **`depth` counts every outstanding packet, GDB's included** (`pending.len() >= depth + open_ended`),
  and GDB sends nothing at all while the target runs. So during a run the whole budget is ours, and the
  moment GDB does speak its entry takes a slot and we fall back to today's behaviour automatically. The
  cost to invariant 2 is that GDB's worst case becomes waiting for two replies instead of one.
- The `RdOff` write is **not deferred** by the overlap, only re-timed: it would go out at 0 ms of the
  next pass instead of near the end of this one, which is nearly the same instant. That matters, because
  `RdOff` is what unblocks a blocking writer like `defmt-rtt` and delaying it would cost real
  throughput -- the trade-off `DrainOptions::advance_after_each_run` already records.
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

## The per-server matrix

Stock firmware -- 1024-byte ring, 500-byte cap -- so these compare _servers_, not configurations. The
ST-LINK and OpenOCD figures are production-VSIX runs; J-Link's is a development build and understated.

| Server   | builtin (TS)  | builtin (Rust) | Rust vs TS | server RTT |
| -------- | ------------- | -------------- | ---------- | ---------- |
| OpenOCD  | 50.9 KB/s     | 74.3           | 1.46×      | 80.1       |
| ST-LINK  | 62.4          | 78.0           | 1.25×      | — ²        |
| JLink    | 68.3          | 80.5           | 1.18×      | 152.1 ³    |
| pyOCD    | 24.8          | — ⁴            | —          | — ¹        |
| probe-rs | not attempted | 6.2            | —          | —          |

¹ pyOCD copied OpenOCD's one-shot `rtt start`: it reports "not found" and does not poll. Driving that
loop needs a side channel to re-issue the command, which for OpenOCD is its tcl interface. pyOCD has
none, and there are **no plans to implement** one. So `engine: 'gdb-server'` is refused for pyOCD in the
config resolver rather than attempted -- and `rtt_start_retry` is an OpenOCD-only property, not a
general one.
² the ST-LINK gdb-server has no RTT support at all, so builtin is the only option.
³ J-Link polls RTT in **probe firmware**, with no host round trip per poll. Not the same architecture;
see _the model_ above, where it turns out to be the zero-round-trip case of our own fit.
⁴ pyOCD cannot run the Agent engine at all -- see below.

**pyOCD cannot run the Agent engine.** It does not refuse a memory read while the target runs and it
does not error -- it _queues_ the read and answers when the target next stops. Observed as five
consecutive two-second timeouts through a run, each answered within a millisecond of the halt that
followed, while `WrOff` advanced 0 → 0x2f9 the whole time. So the data was there and unreachable. Its
tier is `HaltedOnly`, and for pyOCD `engine: "builtin-typescript"` is not a fallback but
the only option: the adapter's own engine reads over a **second** connection, where pyOCD answers
happily. `engine: "gdb-server"` is refused for pyOCD outright -- it has a `monitor rtt` command set,
but OpenOCD's RTT is driven over its tcl interface and pyOCD has no equivalent, so the commands were
issued and then waited on for ever. See `gdb-rsp.md` §7.

**probe-rs permits everything and is an order of magnitude slower at it.** Its latency is its own and
visible without us in the picture at all -- from its handshake with GDB, before the Agent had sent a
single packet:

```text
 0.322  GDB>SRV  $qSupported:…      →   9.998  SRV>GDB  $PacketSize=1000;…    (~10 ms)
10.283  GDB>SRV  $vCont?            →  22.149  SRV>GDB  $vCont;c;C;s;S        (~12 ms)
22.441  GDB>SRV  $vMustReplyEmpty   →  34.664  SRV>GDB  $#00                  (~12 ms)
```

~10–12 ms per packet with us doing nothing. ~20 ms a round trip and three round trips a drain is ~59 ms
a drain, and 6.2 KB/s follows without any appeal to our own counters. Its tier stays `Full` because a
tier is about what a server _permits_; gating it on speed would make a slow server silently featureless
instead of merely slow. It predicts the user-visible symptom too: a single step with a shallow stack
trace is 80--100 packets, so ~1 s on probe-rs against ~0.16 s on OpenOCD, which is what was observed.

## The writer's mode decides what you measured

Two rigs, both Cortex-M4, both OpenOCD, both a 4096-byte up buffer -- and they are not measuring the
same thing:

|                            | writer            | mode                 | B/drain | cap ceiling | observed | % of ceiling |
| -------------------------- | ----------------- | -------------------- | ------- | ----------- | -------- | ------------ |
| NUCLEO-F429ZI, 180 MHz     | `defmt-rtt`       | **blocks** when full | 471     | 89.8 KB/s   | 84.2     | 93.7%        |
| PSoC6 CY8CKIT-062, 150 MHz | SEGGER, `putchar` | **skips** when full  | 500     | 95.1 KB/s   | 94.4     | 99.3%        |

The ceiling is `cap × drains/sec`, i.e. what the 500-byte cap allows at the round-trip rate actually
achieved.

**Blocking couples the firmware to the host.** The writer stalls until space frees, so production
rate _is_ drain rate and every measurement is a fixed point of the two together. A host-side
improvement then shows up partly as the firmware speeding up rather than as throughput, which makes
attribution harder. It also costs about **6%**: the writer does not refill the instant space appears,
so `available` is usually below the cap and a drain takes what is there.

**Skip mode is an unlimited source.** The firmware runs at a constant rate and discards what will not
fit, so the host takes everything it can and the number is purely the host's. `B/drain` then pins
exactly at the cap, which makes "cap-limited" directly readable from the counter instead of inferred.
At 99.3% of ceiling you are measuring the engine; at 93.7% you are partly measuring the handshake.

So **skip mode is the better benchmark rig** -- but defmt cannot use it. defmt needs a lossless
stream, because bytes dropped mid-frame desynchronise the decoder; it would produce garbage rather
than less data. Blocking is a requirement of the format, not a configuration choice, so any
defmt-based figure is inherently a coupled one.

### What this does and does not invalidate

Comparisons **within** one target and firmware are unaffected, which is nearly everything worth
knowing: F429 OpenOCD gives 84.2 (Agent), 82.3 (TypeScript) and 105.2 (OpenOCD's own RTT) on one
firmware and one probe. The invalid comparison is F429 against PSoC6, and the fix is not to change
PSoC6 -- that would spend the one uncoupled rig to make an unnecessary comparison valid. The fix is
not to make that comparison, or to build a non-defmt skip-mode writer for a second target and compare
those.

Core clock is unlikely to confound a skip-mode comparison: 95 KB/s leaves over a thousand cycles per
byte at 150 MHz, and a ring-buffer write costs tens, so both cores outpace the host by orders of
magnitude. Note also that the **slower** core showed the **lower** per-trip cost (1.66 ms against
1.75 ms), so core clock does not explain that figure -- probe hardware and SWD clock do, and those are
what a cross-target rig has to hold constant.

## OpenOCD: faster per trip, slower overall

The surprise in the OpenOCD numbers is not that its own RTT wins by 25%. It is why:

|         | ms per trip | B/drain | KB/s |
| ------- | ----------- | ------- | ---- |
| OpenOCD | **1.75**    | 471     | 84.2 |
| J-Link  | 3.38        | 1613    | 137  |

OpenOCD services a round trip in **half** J-Link's time and still delivers 40% less, entirely because
its reply cap is four times tighter. Throughput is bytes per trip; the cap sets that, and per-trip
latency barely matters once it does.

**OpenOCD's own RTT does not go through RSP at all.** It reads the target through its internal API --
no `PacketSize`, no reply-size ceiling, no RSP round trip -- and ships 902 bytes per TCP write against
our 471-byte drains. So the 25% is not a verdict on engine quality; it is the cost of reading through
a 500-byte RSP window, and any engine on our side of that window lands where we did.

Two consequences:

- The Agent's engine and the TypeScript one come within **2.2%** of each other here (84.2 vs 82.3),
  against a large margin on J-Link and ST-LINK. The Rust engine's advantage is removing GDB and the
  MI text layer _per read_; at 471 bytes that saving is a rounding error beside 1.75 ms of server
  time. The convergence is that advantage being measured, not contradicted.
- **Pipelining is the only lever left for OpenOCD**, since the cap cannot move. At 3.1 trips/drain
  against a floor of 2, reaching 2.1 is **+48%** -- about 125 KB/s, past OpenOCD's own 105. Its low
  per-trip latency is exactly the profile where pipelining pays best.

### SWD clock barely matters at a 500-byte cap, and that is the model confirming itself

PSoC6 refuses to go above 2000 kHz; the ST boards sit comfortably at 4000 kHz. Doubling the clock
made almost no difference to throughput, which looks wrong until the arithmetic is done.

A 500-byte AP read is 125 word transactions, and a SWD word read is roughly 56 bits (8-bit request,
turnaround, 3-bit ack, turnaround, 33 bits of data and parity, idle):

|                       | SWD clock | 500 B transfer | drain period | residual |
| --------------------- | --------- | -------------- | ------------ | -------- |
| PSoC6 / KitProg3      | 2000 kHz  | 3.50 ms        | 5.14 ms      | 1.64 ms  |
| F429 / on-board probe | 4000 kHz  | 1.75 ms        | 5.44 ms      | 3.69 ms  |

**The F429 has twice the clock and a longer drain period.** That conclusion needs no estimate of
bits-per-word to hold -- it follows from the two measured drain periods alone. So SWD bit time is not
what sets the drain rate at this size; fixed per-request overhead is, and it differs by 2.3x between
the two probes. Likely USB: a request-response through a full-speed link costs on the order of a
millisecond in frame scheduling alone, before the probe firmware does anything.

This is the central claim of the model -- _throughput is round trips, not bytes_ -- arriving from a
direction the model was not fitted to. It also says where the levers are:

- **At OpenOCD's 500-byte cap, raising the SWD clock is nearly free of effect.** Reducing trips is
  the only thing that helps, which is the pipelining argument again.
- **At a 2000-byte cap it inverts.** The same read becomes 7.0 ms at 4000 kHz and 14.0 ms at
  2000 kHz, so SWD time overtakes the fixed overhead and clock starts to matter. J-Link bears this
  out: 1613 B/drain at an 11.5 ms drain period splits roughly half SWD, half overhead.

So pin the clock in every rig and record it -- not because it moves these numbers much, but because
it will move them once the cap does, and a figure whose clock was not recorded cannot be compared
afterwards.

## Reading the counters

The engine reports its own numbers as an `[RTT engine]` line beside the consumer's `[RTT Logs stats]`,
on the same window, with **no debug flag required** -- they share the per-decoder `stats` option, so a
session that did not ask for statistics gets neither:

```text
[RTT engine]     126.1 KB/sec | 84 drains/sec, 1545 B/drain | 284 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 9.29 MB over 75.1s
[RTT Logs stats] 126.19 KB/sec | 84.0 msgs/sec | window 5.0s, 632.06 KB | total 9.31 MB over 75.3s
```

| Field                          | What it tells you                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `trips/sec`                    | the figure throughput is made of; everything else is derived                      |
| `trips/drain`                  | 3 is ideal; the excess is `B/drain ÷ SizeOfBuffer`, i.e. wrap splits              |
| `B/drain` well under the cap   | a **blocking** writer refilling slowly, not spare capacity -- see the cap section |
| `idle` climbing                | the ring was empty; throughput is the firmware's rate, not our cost               |
| `gated` climbing               | the multiplexer refused us -- GDB's traffic, not the probe                        |
| `errors` climbing              | reads rejected and retried at half size, silently doubling their cost             |
| engine line **above** consumer | loss in the **host**: we drained it, node did not deliver it                      |

That last row is worth its place. The poll thread hands bytes to an _unbounded_ `mpsc` channel, so a
slow client cannot throttle the engine -- it can only make the queue grow. The two lines therefore
separate "the Agent drained less" from "the host delivered less", which no single figure can.

One consequence of that unbounded channel, recorded for whoever meets it: a client that stalls while
RTT is flowing makes the Agent accumulate at the full RTT rate, and the drain cap does not bound it.

## Five things we got wrong

Kept because each was believed for a while on the strength of a real-looking number.

**1. `bytes/pass` and `passes/sec` columns, derived from the consumer's `msgs/sec`.** A `msg` there is
one TCP buffer, not one drain -- `ThroughputMonitor.record` fires once per `data` event, and on a fast
probe several drains arrive coalesced. The giveaway was the TypeScript row for J-Link: 619 bytes per
"msg" when that engine never read more than 512 bytes at a time. Any cross-server comparison built on
those columns was comparing amounts of socket coalescing. Fixed by counting in the engine.

**2. "VS Code costs 12%".** It costs nothing measurable. A production VSIX under VS Code and the CLI
agree to 0.23%. What cost 12% was the ordinary F5 loop -- an unoptimized build with the node inspector
attached.

**3. Every VS Code figure, for a while, because `"debugServer"` was set in the firmware project's
launch.json.** That makes VS Code _attach_ to an already-running debug adapter instead of starting one,
and the one it attached to had been up for hours from older code. The tell was in the runs themselves:
no `[RTT engine]` line, although the installed VSIX contained that code. Now diagnosed at the top of
every session by the two identity lines, which name the build and the process age.

**4. "The cap is not what binds", argued from `B/drain` (381) being below the cap (500).**
Necessary but nowhere near sufficient: with a blocking writer the cap limits the space released per
cycle, which bounds what accumulates before the next visit, so it sets the level even when the mean sits
under it. Measured: `B/drain` is 91% of the cap at 200, 76% at 500, 51% at 1000. Raising it from 500 to
2000 was worth **+46%**. This was the largest single win in the exercise and it was argued away for a
day on a sufficient-looking inference.

**5. A wrap-truncation model for `B/drain` sitting below the cap, which fitted to 0.3%.** The claim
was that a drain crossing the ring end is truncated to the remainder, giving
`E[B] = (1 - C/S)·C + (C/S)·(C/2)` = 469.5 against an observed 470.8 on the F429. The fit was a
coincidence on the wrong mechanism, and the PSoC6 run discriminates: same 4096-byte ring, so
truncation would apply there too, and it does not -- `B/drain` is exactly 500 in every window. The
real reason is the one already written in mistake 4 above: a **blocking** writer releases space only
as the host frees it, so `available` is usually below the cap and there is nothing to truncate. Worth
recording because the answer was already in this document, and a three-decimal agreement was enough to
stop the check.

## A note on comparing results across sections

The three OpenOCD blocks below were taken in one sitting on one build, one firmware and one probe, so
they are comparable with each other. The figures they replaced are not comparable with them: the
**gdb-server's own** number moved from 80.3 to 105.2 KB/s, and nothing on our side could do that. The
firmware's up buffer had grown to 4096 bytes in between, which lets OpenOCD's RTT take more per poll
and costs us fewer wrap splits.

So a block replaced in this document records a _measurement_, not a regression or an improvement.
Where the gain is ours, the section says so.

## Builtin RTT in Typescript

### OpenOCD

```
[RTT builtin stats] 85.30 KB/sec | 208.2 msgs/sec | window 5.0s, 426.59 KB | total 426.59 KB over 5.0s
[RTT builtin stats] 83.04 KB/sec | 204.2 msgs/sec | window 5.0s, 415.59 KB | total 842.18 KB over 10.0s
[RTT builtin stats] 80.92 KB/sec | 197.1 msgs/sec | window 5.0s, 404.82 KB | total 1.22 MB over 15.0s
[RTT builtin stats] 81.72 KB/sec | 200.0 msgs/sec | window 5.0s, 408.93 KB | total 1.62 MB over 20.0s
[RTT builtin stats] 81.59 KB/sec | 198.2 msgs/sec | window 5.0s, 408.02 KB | total 2.02 MB over 25.0s
[RTT builtin stats] 81.74 KB/sec | 199.0 msgs/sec | window 5.0s, 409.03 KB | total 2.42 MB over 30.0s
[RTT builtin stats] 81.31 KB/sec | 199.0 msgs/sec | window 5.0s, 407.02 KB | total 2.81 MB over 35.1s
[RTT builtin stats] 82.64 KB/sec | 201.2 msgs/sec | window 5.0s, 413.71 KB | total 3.22 MB over 40.1s
[RTT builtin stats] 83.67 KB/sec | 204.1 msgs/sec | window 5.0s, 418.96 KB | total 3.63 MB over 45.1s
[RTT builtin stats] 81.25 KB/sec | 199.2 msgs/sec | window 5.0s, 406.67 KB | total 4.02 MB over 50.1s
```

Mean **82.3 KB/s** -- within 2.2% of the Agent's engine. See "OpenOCD: faster per trip, slower
overall" for why the two converge here and not elsewhere.

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
[RTT engine] 86.7 KB/sec | 188 drains/sec, 472 B/drain | 587 trips/sec, 3.1 trips/drain | idle 1, gated 0, unusable 0, errors 0 | total 433.8 KB over 5.0s
[RTT engine] 85.0 KB/sec | 185 drains/sec, 471 B/drain | 575 trips/sec, 3.1 trips/drain | idle 0, gated 0, unusable 0, errors 0 | total 858.8 KB over 10.0s
[RTT engine] 83.4 KB/sec | 182 drains/sec, 468 B/drain | 568 trips/sec, 3.1 trips/drain | idle 0, gated 0, unusable 0, errors 0 | total 1.25 MB over 15.0s
[RTT engine] 83.4 KB/sec | 182 drains/sec, 470 B/drain | 566 trips/sec, 3.1 trips/drain | idle 1, gated 0, unusable 0, errors 0 | total 1.65 MB over 20.0s
[RTT engine] 83.1 KB/sec | 180 drains/sec, 472 B/drain | 561 trips/sec, 3.1 trips/drain | idle 1, gated 0, unusable 0, errors 0 | total 2.06 MB over 25.0s
[RTT engine] 83.9 KB/sec | 183 drains/sec, 469 B/drain | 572 trips/sec, 3.1 trips/drain | idle 1, gated 0, unusable 0, errors 0 | total 2.47 MB over 30.0s
[RTT engine] 83.0 KB/sec | 181 drains/sec, 469 B/drain | 565 trips/sec, 3.1 trips/drain | idle 1, gated 0, unusable 0, errors 0 | total 2.88 MB over 35.0s
[RTT engine] 85.6 KB/sec | 186 drains/sec, 471 B/drain | 579 trips/sec, 3.1 trips/drain | idle 0, gated 0, unusable 0, errors 0 | total 3.29 MB over 40.0s
[RTT engine] 83.6 KB/sec | 181 drains/sec, 473 B/drain | 564 trips/sec, 3.1 trips/drain | idle 0, gated 0, unusable 0, errors 0 | total 3.70 MB over 45.0s
[RTT engine] 83.8 KB/sec | 181 drains/sec, 473 B/drain | 565 trips/sec, 3.1 trips/drain | idle 0, gated 0, unusable 0, errors 0 | total 4.11 MB over 50.0s
```

Mean **84.2 KB/s**, 1.75 ms per round trip. `B/drain` 471 against a cap of 500 -- a blocking writer
refilling as space frees, not spare capacity.

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

Wed Sep 30 16:26:57 EDT 2026

[RTT engine] 86.3 KB/sec | 231 drains/sec, 382 B/drain | 779 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 431.4 KB over 5.0s
info: [RTT Logs stats] 86.35 KB/sec | 231.3 msgs/sec | window 5.0s, 431.93 KB | total 431.93 KB over 5.0s
[RTT engine] 85.0 KB/sec | 228 drains/sec, 382 B/drain | 768 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 856.4 KB over 10.0s
info: [RTT Logs stats] 85.08 KB/sec | 227.8 msgs/sec | window 5.0s, 425.48 KB | total 857.41 KB over 10.0s
[RTT engine] 78.1 KB/sec | 211 drains/sec, 379 B/drain | 711 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 1.22 MB over 15.0s
info: [RTT Logs stats] 78.18 KB/sec | 211.4 msgs/sec | window 5.0s, 390.95 KB | total 1.22 MB over 15.0s
[RTT engine] 79.0 KB/sec | 209 drains/sec, 387 B/drain | 706 trips/sec, 3.4 trips/drain | idle 2, gated 0, errors 0 | total 1.60 MB over 20.0s
info: [RTT Logs stats] 78.97 KB/sec | 209.0 msgs/sec | window 5.0s, 395.24 KB | total 1.61 MB over 20.0s
[RTT engine] 78.7 KB/sec | 211 drains/sec, 382 B/drain | 712 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 1.99 MB over 25.0s
info: [RTT Logs stats] 78.88 KB/sec | 211.5 msgs/sec | window 5.0s, 394.61 KB | total 1.99 MB over 25.0s
[RTT engine] 78.9 KB/sec | 214 drains/sec, 377 B/drain | 721 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 2.37 MB over 30.0s
info: [RTT Logs stats] 79.02 KB/sec | 214.4 msgs/sec | window 5.0s, 395.18 KB | total 2.38 MB over 30.0s
[RTT engine] 77.2 KB/sec | 208 drains/sec, 381 B/drain | 701 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 2.75 MB over 35.0s
info: [RTT Logs stats] 77.29 KB/sec | 207.8 msgs/sec | window 5.0s, 386.75 KB | total 2.75 MB over 35.0s
[RTT engine] 78.1 KB/sec | 211 drains/sec, 379 B/drain | 711 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 3.13 MB over 40.0s
info: [RTT Logs stats] 77.94 KB/sec | 211.1 msgs/sec | window 5.0s, 389.91 KB | total 3.13 MB over 40.1s
[RTT engine] 77.7 KB/sec | 209 drains/sec, 381 B/drain | 704 trips/sec, 3.4 trips/drain | idle 2, gated 0, errors 0 | total 3.51 MB over 45.0s
info: [RTT Logs stats] 77.83 KB/sec | 209.0 msgs/sec | window 5.0s, 389.46 KB | total 3.52 MB over 45.1s
[RTT engine] 78.0 KB/sec | 209 drains/sec, 382 B/drain | 705 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 3.89 MB over 50.0s
info: [RTT Logs stats] 78.08 KB/sec | 209.3 msgs/sec | window 5.0s, 390.86 KB | total 3.90 MB over 50.1s
[RTT engine] 77.8 KB/sec | 209 drains/sec, 381 B/drain | 706 trips/sec, 3.4 trips/drain | idle 2, gated 0, errors 0 | total 4.27 MB over 55.0s
info: [RTT Logs stats] 77.88 KB/sec | 210.0 msgs/sec | window 5.0s, 389.78 KB | total 4.28 MB over 55.1s
[RTT engine] 78.9 KB/sec | 213 drains/sec, 379 B/drain | 719 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 4.66 MB over 60.0s
info: [RTT Logs stats] 78.95 KB/sec | 213.0 msgs/sec | window 5.0s, 394.80 KB | total 4.66 MB over 60.1s
[RTT engine] 77.5 KB/sec | 210 drains/sec, 379 B/drain | 706 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 5.04 MB over 65.0s
info: [RTT Logs stats] 77.62 KB/sec | 209.9 msgs/sec | window 5.0s, 388.23 KB | total 5.04 MB over 65.1s
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

Wed Sep 30 16:35:52 EDT 2026

[RTT engine] 76.0 KB/sec | 206 drains/sec, 377 B/drain | 696 trips/sec, 3.4 trips/drain | idle 2, gated 0, errors 0 | total 380.4 KB over 5.0s
info: [RTT Logs stats] 76.14 KB/sec | 206.7 msgs/sec | window 5.0s, 380.92 KB | total 380.92 KB over 5.0s
[RTT engine] 76.1 KB/sec | 207 drains/sec, 376 B/drain | 698 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 760.8 KB over 10.0s
info: [RTT Logs stats] 76.11 KB/sec | 207.9 msgs/sec | window 5.0s, 380.77 KB | total 761.68 KB over 10.0s
[RTT engine] 77.2 KB/sec | 210 drains/sec, 377 B/drain | 706 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 1.12 MB over 15.0s
info: [RTT Logs stats] 77.40 KB/sec | 209.6 msgs/sec | window 5.0s, 387.06 KB | total 1.12 MB over 15.0s
[RTT engine] 77.1 KB/sec | 211 drains/sec, 374 B/drain | 711 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 1.50 MB over 20.0s
info: [RTT Logs stats] 77.13 KB/sec | 211.3 msgs/sec | window 5.0s, 385.81 KB | total 1.50 MB over 20.0s
[RTT engine] 76.8 KB/sec | 211 drains/sec, 373 B/drain | 709 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 1.87 MB over 25.0s
info: [RTT Logs stats] 76.87 KB/sec | 211.4 msgs/sec | window 5.0s, 384.43 KB | total 1.87 MB over 25.0s
[RTT engine] 77.1 KB/sec | 209 drains/sec, 377 B/drain | 705 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 2.25 MB over 30.0s
info: [RTT Logs stats] 77.27 KB/sec | 209.5 msgs/sec | window 5.0s, 386.79 KB | total 2.25 MB over 30.0s
[RTT engine] 77.1 KB/sec | 211 drains/sec, 375 B/drain | 709 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 2.63 MB over 35.0s
info: [RTT Logs stats] 77.19 KB/sec | 210.6 msgs/sec | window 5.0s, 386.03 KB | total 2.63 MB over 35.0s
[RTT engine] 77.1 KB/sec | 209 drains/sec, 377 B/drain | 705 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 3.00 MB over 40.0s
info: [RTT Logs stats] 77.13 KB/sec | 209.4 msgs/sec | window 5.0s, 385.74 KB | total 3.01 MB over 40.1s
[RTT engine] 75.7 KB/sec | 208 drains/sec, 372 B/drain | 700 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 3.37 MB over 45.0s
info: [RTT Logs stats] 75.76 KB/sec | 208.2 msgs/sec | window 5.0s, 379.10 KB | total 3.38 MB over 45.1s
[RTT engine] 76.2 KB/sec | 208 drains/sec, 376 B/drain | 699 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 3.74 MB over 50.0s
info: [RTT Logs stats] 76.17 KB/sec | 208.0 msgs/sec | window 5.0s, 381.16 KB | total 3.75 MB over 50.1s
[RTT engine] 76.3 KB/sec | 207 drains/sec, 377 B/drain | 698 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 4.12 MB over 55.0s
info: [RTT Logs stats] 76.44 KB/sec | 207.2 msgs/sec | window 5.0s, 382.50 KB | total 4.12 MB over 55.1s
[RTT engine] 76.1 KB/sec | 207 drains/sec, 377 B/drain | 696 trips/sec, 3.4 trips/drain | idle 1, gated 0, errors 0 | total 4.49 MB over 60.0s
info: [RTT Logs stats] 76.15 KB/sec | 207.0 msgs/sec | window 5.0s, 380.84 KB | total 4.49 MB over 60.1s
[RTT engine] 77.2 KB/sec | 208 drains/sec, 379 B/drain | 702 trips/sec, 3.4 trips/drain | idle 0, gated 0, errors 0 | total 4.87 MB over 65.0s
info: [RTT Logs stats] 77.35 KB/sec | 208.6 msgs/sec | window 5.0s, 386.83 KB | total 4.87 MB over 65.1s
```

# RTT provided by gdb-server

## Openocd

```
[RTT Logs stats] 111.50 KB/sec | 125.3 msgs/sec | window 5.0s, 558.04 KB | total 558.04 KB over 5.0s
[RTT Logs stats] 106.27 KB/sec | 120.5 msgs/sec | window 5.0s, 531.68 KB | total 1.06 MB over 10.0s
[RTT Logs stats] 101.43 KB/sec | 116.3 msgs/sec | window 5.0s, 507.76 KB | total 1.56 MB over 15.0s
[RTT Logs stats] 101.58 KB/sec | 116.3 msgs/sec | window 5.0s, 508.32 KB | total 2.06 MB over 20.0s
[RTT Logs stats] 103.84 KB/sec | 117.9 msgs/sec | window 5.0s, 519.52 KB | total 2.56 MB over 25.1s
[RTT Logs stats] 104.04 KB/sec | 117.5 msgs/sec | window 5.0s, 520.83 KB | total 3.07 MB over 30.1s
[RTT Logs stats] 105.84 KB/sec | 120.8 msgs/sec | window 5.0s, 530.16 KB | total 3.59 MB over 35.1s
[RTT Logs stats] 107.08 KB/sec | 120.4 msgs/sec | window 5.0s, 536.14 KB | total 4.11 MB over 40.1s
```

Mean **105.2 KB/s** at 902 bytes per TCP write. OpenOCD's own RTT does not go through RSP, so the
500-byte reply cap that bounds our engine does not apply to it.

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
