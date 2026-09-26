# `proxy-client.ts` — stream plumbing issues

A catalogue of defects in `ProxyClient`, `RemoteServer` and `RemoteStream`
(`packages/mcu-debug/src/adapter/proxy-client.ts`), found by reading the code rather than by
reproducing them. Every one **predates the RSP multiplexer work** and none is caused by it.

They survive because of a single shared property: **the local end of a stream is only ever torn down
during session teardown**, when everything is being dismantled anyway and one more broken thing looks
like normal shutdown noise. Anything that closes a consumer mid-session walks into them.

Confidence is stated per item. "Read" means traced through the source and believed correct but not
run; "observed" means seen in a log or a session.

| #   | Severity | Confidence | One line                                                            |
| --- | -------- | ---------- | ------------------------------------------------------------------- |
| 1   | High     | Read       | A closing **duplicate** stream tears down the **original**          |
| 2   | ~~High~~ | Fixed      | No `error` handler on the `net.Server`; bind failure cannot be seen |
| 3   | ~~High~~ | Fixed      | `throw` inside the socket `error` handler                           |
| 4   | Medium   | Read       | `resetStreamId` can fail while its caller proceeds regardless       |
| 5   | Medium   | Read       | `socket.write()` backpressure ignored                               |
| 6   | Medium   | Read       | `streamIdToPortInfo` is never cleaned                               |
| 7   | Low      | Read       | `pendingStreamStarts` is written twice and never read               |
| 8   | Latent   | Observed   | `toServerBuffer` is flushed but never cleared                       |
| 9   | Low      | Read       | `dataFromServer`'s `get(-1)` fallback can misroute                  |
| 10  | Low      | Read       | Unknown-stream-id logging is per chunk                              |

---

## 1. A closing duplicate stream tears down the original — High

`ProxyClient.startStream` maps a duplicate's **new** stream id to the **same `RemoteServer` object**
as the original:

```ts
this.clientStreams.set(portReserved.stream_id, remoteServer!);
```

`handleStreamClosed` then calls `close()` on whatever `clientStreams` yields, and
`RemoteServer.close()` destroys **every** socket it holds and closes the listener. So when the
live-watch GDB goes away and the Agent emits `StreamClosed` for the duplicate's id, the main GDB's
socket is destroyed and its local port unbound. `close()` also sets `endingSession = true` on the
shared object, which silences error logging for the survivor.

**Masked because** live watch normally stops at session teardown. Stopping it mid-session should
reproduce this.

**Fix direction.** Separate "close this consumer" from "close this listener" — see the plan at the end
of this document.

An earlier draft here proposed one `RemoteServer` per stream id. **That was wrong**: both consumers
connect to the _same_ local port, so there is necessarily one listener with several connections on it,
and one `RemoteServer` per local port is both correct and what already exists. Nor is this a 1:1
violation in the sense of [gdb-rsp.md](./gdb-rsp.md) §4.7.5 — each consumer does get its own connection
to the gdb-server, through `duplicateStream`. The defect is narrower than either reading.

## 2. No `error` handler on the `net.Server` — ~~High~~ **fixed**

`RemoteServer.initialize()` attaches `listening` and calls `.listen()`, and never
`.on("error", …)`. An unhandled `'error'` event on an EventEmitter is **thrown**, so `EADDRINUSE` on
`portDef.localPort` — a stale listener, a sibling session, an unrelated user process — takes the
debug adapter down instead of reporting that the port is in use.

Compounding it: `initialize()` resolves as soon as `.listen()` returns rather than on `listening`, so
the `try/catch` around it in `handleStreamReady` cannot observe a bind failure either. Both halves
need fixing together, or the handler logs into a void.

**Fixed.** `initialize()` now returns a promise settled by the listener's `listening`/`error` events,
and the `error` handler names the port. One consequence had to be handled with it: binding emits
`streamStarted`, which unblocks the launch sequence and eventually reaches `startStream()` — which
looks the id up in `clientStreams`. That lookup used to be safe only because `initialize()` returned
early, so the stream is now registered **before** the bind is awaited, and removed again on failure.

## 3. `throw` inside the socket `error` handler — ~~High~~ **fixed**

The client-socket `error` handler logs the error and then throws a new one from inside an event
callback, which is an uncaught exception reaching the process-level catchall. An `ECONNRESET` from a
GDB that was killed is ordinary and already reported by the line above. Log, do not throw.

**Fixed**, with the reason left in place of the disabled statement so it is not reinstated by someone
tidying up.

## 4. `resetStreamId` can fail while its caller proceeds — Medium

`RemoteServer.resetStreamId` logs an error and returns early when the target id is already mapped.
`RemoteStream.setStreamId` calls it and then calls `initStreamId` regardless, so the stream ends up
believing it owns an id that `socketsByStreamId` does not map to it. Inbound data for that id then
takes the unknown-stream-id path for the rest of the session. It should be a clean failure — the
caller needs the result.

## 5. `socket.write()` backpressure ignored — Medium

`RemoteStream.dataFromServer` discards `write()`'s return value, so a slow local consumer means
unbounded buffering inside Node rather than backpressure. Irrelevant at RSP volumes, relevant for SWO
and RTT. See [Stream-Flow-Control.md](./Stream-Flow-Control.md), whose policy this should follow
rather than duplicate.

## 6. `streamIdToPortInfo` is never cleaned — Medium

Entries are added when ports are allocated and again per duplicate, and removed nowhere;
`handleStreamClosed` cleans `clientStreams` only. Growth is slow, but a stale id resolves to a
`PortReservedInfo` still claiming `"connected"`, which is a wrong answer rather than a missing one.

## 7. `pendingStreamStarts` is dead — Low

Written in the duplicate path, then **written again** a few lines later with the same key and value,
deleted on both success and failure, and never read anywhere. The duplicated write is the tell that
this path was edited and left half-finished. Worth establishing what it was for before deleting it —
it may be the remains of an intended correlation between a duplicate request and its assigned id.

## 8. `toServerBuffer` is flushed but never cleared — Latent

`initStreamId` flushes the buffer through `dataFromClent` without resetting it. Harmless today only
because `setStreamId` guards against a second call; `initStreamId` has two callers, so it is one
refactor away from re-sending bytes into an RSP stream. `fromServerBuffer` is cleared correctly on its
forward path, so the asymmetry is the bug.

## 9. `dataFromServer`'s `get(-1)` fallback can misroute — Low

`socketsByStreamId.get(stream_id) || socketsByStreamId.get(-1)` sends data for an unknown id to
whichever socket happens to be mid-handshake. Narrow, and the same `-1` sentinel is why two clients
connecting simultaneously are rejected rather than handled. Replaced by an explicit `pending` field in
step 2 of the plan.

## 10. Unknown-stream-id logging is per chunk — Low

One error line per inbound chunk once a stream has no socket. Combined with the missing
client-to-Agent stream close ([gdb-rsp.md](./gdb-rsp.md) item 15c), a closed SWO viewer produces that
line for the remainder of the session. Rate-limit it, or make it impossible by telling the Agent the
consumer went away.

---

## Suggested order

1. ~~**Items 2 and 3** first: independent of everything else, cheap, and the only two that can kill the
   debug adapter.~~ **Done.**
2. **Item 1**, with items 7 and 9 folded in. They are one story: the duplicate path grafted a second
   identity onto a class that assumes one. See the plan below.
3. **Items 4, 6, 8** as cleanup alongside item 1, since they all live in the same identity plumbing.
4. **Items 5 and 10** belong with the transport work: item 5 under the flow-control policy, item 10
   under the stream-close notification (gdb-rsp.md item 15c).

---

## Plan for item 1

### What the shape actually is

One local port per reserved stream, one listener on it, and **N consumer connections on that
listener** — the first GDB plus any duplicates. Each consumer does get its own connection to the
gdb-server (`duplicateStream` makes a second one), so this is not a fan-out in the sense
[gdb-rsp.md](./gdb-rsp.md) §4.7.5 forbids. One `RemoteServer` per local port is therefore correct, and
an earlier draft of this document was wrong to propose one per stream id: two listeners cannot bind the
same port.

The defect is narrower. `ProxyClient.clientStreams` maps every stream id — original and duplicate
alike — to the same `RemoteServer`, and `RemoteServer.close()` destroys every socket and the listener.
So `handleStreamClosed(anyId)` dismantles the lot. What is missing is the distinction between **closing
one consumer** and **closing the listener**.

### Two connections, not one — why a close has to be sent

The chain for a duplicated gdb stream is:

```text
live-watch GDB ──A──> [client: RemoteStream id=11] ═══A'═══> gdb-server :2601
                                  |                             ^
                                  +--- funnel(11) --> [Agent] ---+ B
```

**A' is the logical pipe, and it is real and per-consumer** — that is what `duplicateStream` buys, and
why `-gdb-max-connections > 1` is needed at all. Its far end is a genuine, distinct connection on the
gdb-server with its own per-connection state; if the Agent had instead multiplexed two GDBs onto one
server connection, that state would collide (gdb-rsp.md §3.10, §4.7.5).

**But A' is not a socket anyone owns.** It is A plus `funnel(11)` plus B, and the client never connects
to the gdb-server itself — `TcpPortDef.remotePort` is informational on that side, used to build the
_server's_ command line and for log text. So **closing A does not tear A' down**: B belongs to the
Agent, which has no idea A existed, and TCP offers no propagation through a relay. The relay has to
forward the fact, and that is the whole reason `closeStream` exists.

It also explains which event fires when. `StreamClosed` means **B** ended. Live watch stopping ends
**A**. Confusing the two is easy and leads to looking for the bug in the wrong place.

What the Agent keeps doing while B is open and nobody is reading A:

- **GDB → server:** nothing. Once GDB is gone nothing arrives on A, so nothing is written to B.
- **server → GDB, RSP:** bounded. The server only speaks when spoken to, and a secondary connection is
  sent no stop replies (gdb-rsp.md §4.7), so the only traffic is replies to requests that were in
  flight when the consumer died — dropped with one log line each (item 10).
- **server → GDB, SWO:** unbounded. The server streams continuously, so the Agent forwards forever and
  the client logs per chunk for the rest of the session. This is the case that hurts.
- **On the server:** the connection stays in its list with its full per-connection state and keeps
  counting against `-gdb-max-connections`. Start and stop live watch a few times and the limit is
  exhausted, at which point the next attempt gets the accept-then-close refusal — which, before item 1
  was fixed, destroyed the primary GDB.

### Step 1 — split the two closes _(this is the bug)_

- `RemoteStream.close()` — destroy its own socket. It has no such method today.
- `RemoteServer.closeStream(stream_id)` — find that consumer, close it, drop it from `sockets` and
  `socketsByStreamId`, and report whether it was the last one. The listener is not touched.
- `RemoteServer.close()` — unchanged, for session teardown.
- `ProxyClient.handleStreamClosed(stream_id)` decides which to call. The discriminator is
  `stream_id === server.pInfo.stream_id`: a `RemoteServer` is always constructed with the **original**
  `PortReservedInfo`, and a duplicate never gets a `RemoteServer` of its own — it only gets an entry in
  `streamIdToPortInfo` and a second `clientStreams` key. So:
    - **duplicate** → `closeStream(id)`, then drop that id from `clientStreams` **and**
      `streamIdToPortInfo` (which is item 6 for this case). The original keeps running.
    - **original** → full `close()`, as today.

Keeping the listener bound so the original becomes re-openable is item 15c(b) in gdb-rsp.md and is
deliberately **not** in this step.

### Step 2 — the tidy-ups that live in the same code

- **Item 9.** Replace the `-1` entry in `socketsByStreamId` with an explicit
  `private pending: RemoteStream | null`. `dataFromServer` becomes
  `socketsByStreamId.get(id) ?? this.pending`, and the "two clients at once" guard becomes
  `if (this.pending)`. A routing map stops carrying a sentinel key.
- **Item 4.** `resetStreamId` returns whether it succeeded; `setStreamId` stops calling `initStreamId`
  when it did not, so the object and the map cannot disagree.
- **Item 7.** Delete `pendingStreamStarts`. Everything it could have correlated is already in the
  response (`streamStatus.stream_id` and `msg_seq`); the doubled `set` is the evidence it was abandoned
  mid-edit. Confirm that reading before deleting.
- **Item 8.** Clear `toServerBuffer` after flushing it.

### Step 3 — the regression test, which is the point

This code is now on the path **every** session takes, so it needs a test rather than an inspection. It
is testable without hardware: stub `ProxyClient` (there is precedent — `proxy-client-control.test.ts`
passes `{} as any` for its `serverSession`), bind a `RemoteServer` on a free port, connect two real
loopback sockets, and assign the second a duplicate id.

- `handleStreamClosed(duplicateId)` → the first socket is still writable, the listener still accepts a
  further connection, and only the duplicate is gone. **This is the test that fails today.**
- `handleStreamClosed(originalId)` → everything comes down. Pins today's behaviour so step 1 cannot
  change it by accident.

### Step 4 — hardware check

The scenario is deliberately reproducible now: start a session, let live watch attach, **stop live
watch mid-session**, and confirm the primary GDB survives with its local port still bound. OpenOCD is
the case to run — of the four servers verified, it is where live watch uses a second connection.

### What this does not fix

Closing a duplicate locally still leaves the Agent's **second connection to the gdb-server** open,
because the funnel has no client-to-Agent stream close (gdb-rsp.md item 15c). So after step 1 we stop
breaking the original, but the server-side connection — and the `-gdb-max-connections` slot it holds —
leaks until 15c lands.
