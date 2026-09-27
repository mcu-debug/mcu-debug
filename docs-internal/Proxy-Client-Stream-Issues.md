# `proxy-client.ts` — stream plumbing issues

A catalogue of defects in `ProxyClient`, `RemoteServer` and `RemoteStream`
(`packages/mcu-debug/src/adapter/proxy-client.ts`), found by reading the code rather than by
reproducing them. Every one **predates the RSP multiplexer work** and none is caused by it.

They survived because of a single shared property: **the local end of a stream was only ever torn down
during session teardown**, when everything is being dismantled anyway and one more broken thing looks
like normal shutdown noise. Anything that closes a consumer mid-session walked into them. That
property is what [gdb-rsp.md](./gdb-rsp.md) item 15c removed, which is why most of this list is now
closed.

Confidence is stated per item. "Read" means traced through the source and believed correct but not
run; "observed" means seen in a log or a session.

| #   | Severity   | Confidence | One line                                                               |
| --- | ---------- | ---------- | ---------------------------------------------------------------------- |
| 1   | ~~High~~   | Fixed      | A closing **duplicate** stream tore down the **original**              |
| 2   | ~~High~~   | Fixed      | No `error` handler on the `net.Server`; bind failure cannot be seen    |
| 3   | ~~High~~   | Fixed      | `throw` inside the socket `error` handler                              |
| 4   | Medium     | Read       | `resetStreamId` can fail while its caller proceeds regardless          |
| 5   | Medium     | Read       | `socket.write()` backpressure ignored                                  |
| 6   | ~~Medium~~ | Fixed      | `streamIdToPortInfo` was never cleaned                                 |
| 7   | Low        | Read       | `pendingStreamStarts` is written twice and never read — confirmed dead |
| 8   | ~~Latent~~ | Fixed      | `toServerBuffer` was flushed but never cleared                         |
| 9   | Low        | Read       | `dataFromServer`'s `get(-1)` fallback can misroute                     |
| 10  | Low        | Read       | Unknown-stream-id logging is per chunk — now a narrow race             |
| 11  | ~~High~~   | Fixed      | Closing the original never released the duplicates on its listener     |

---

## 1. A closing duplicate stream tore down the original — ~~High~~ **fixed**

`ProxyClient.startStream` maps a duplicate's **new** stream id to the **same `RemoteServer` object**
as the original:

```ts
this.clientStreams.set(portReserved.stream_id, remoteServer!);
```

`handleStreamClosed` then called `close()` on whatever `clientStreams` yielded, and
`RemoteServer.close()` destroys **every** socket it holds and closes the listener. So when the
live-watch GDB went away and the Agent emitted `StreamClosed` for the duplicate's id, the main GDB's
socket was destroyed and its local port unbound. `close()` also sets `endingSession = true` on the
shared object, which silenced error logging for the survivor.

**Masked because** live watch normally stops at session teardown. Stopping it mid-session reproduces
it.

**Fixed.** `handleStreamClosed` splits on `stream_id === server.pInfo.stream_id`, and
`RemoteServer.closeStream(id)` / `RemoteStream.close()` close one consumer without touching the
listener. Four tests in `proxy-client-streams.test.ts` pin it, including the direction that is easy to
get wrong: a close **we** performed must not be reported back to the Agent as a close request.

An earlier draft here proposed one `RemoteServer` per stream id. **That was wrong**: both consumers
connect to the _same_ local port, so there is necessarily one listener with several connections on it,
and one `RemoteServer` per local port is both correct and what already exists. Nor was it a 1:1
violation in the sense of [gdb-rsp.md](./gdb-rsp.md) §4.7.5 — each consumer does get its own connection
to the gdb-server, through `duplicateStream`. The defect was narrower than either reading.

## 2. No `error` handler on the `net.Server` — ~~High~~ **fixed**

`RemoteServer.initialize()` attached `listening` and called `.listen()`, and never
`.on("error", …)`. An unhandled `'error'` event on an EventEmitter is **thrown**, so `EADDRINUSE` on
`portDef.localPort` — a stale listener, a sibling session, an unrelated user process — took the
debug adapter down instead of reporting that the port was in use.

Compounding it: `initialize()` resolved as soon as `.listen()` returned rather than on `listening`, so
the `try/catch` around it in `handleStreamReady` could not observe a bind failure either. Both halves
needed fixing together, or the handler logs into a void.

**Fixed.** `initialize()` now returns a promise settled by the listener's `listening`/`error` events,
and the `error` handler names the port. One consequence had to be handled with it: binding emits
`streamStarted`, which unblocks the launch sequence and eventually reaches `startStream()` — which
looks the id up in `clientStreams`. That lookup used to be safe only because `initialize()` returned
early, so the stream is now registered **before** the bind is awaited, and removed again on failure.

## 3. `throw` inside the socket `error` handler — ~~High~~ **fixed**

The client-socket `error` handler logged the error and then threw a new one from inside an event
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

**There are two ways to desynchronise, not one.** The collision above, and the `this.stream_id >= 0`
case: `setStreamId` logs an error, skips `resetStreamId` because of the `if (this.stream_id < 0)`
guard, and then still lets `initStreamId` rewrite `this.stream_id`. So the object moves and the map
does not, from a branch that has already decided it is looking at a mistake.

## 5. `socket.write()` backpressure ignored — Medium

`RemoteStream.dataFromServer` discards `write()`'s return value, so a slow local consumer means
unbounded buffering inside Node rather than backpressure. Irrelevant at RSP volumes, relevant for SWO
and RTT. See [Stream-Flow-Control.md](./Stream-Flow-Control.md), whose policy this should follow
rather than duplicate.

## 6. `streamIdToPortInfo` was never cleaned — ~~Medium~~ **fixed**

Entries were added when ports were allocated and again per duplicate, and removed nowhere;
`handleStreamClosed` cleaned `clientStreams` only.

**Fixed for the case that grew**: a duplicate's entry is dropped both when the Agent reports it closed
and when we ask the Agent to close it, so starting and stopping live watch repeatedly no longer
accumulates anything.

**The original's entry is deliberately kept**, which is the opposite of what this item originally
asked for. It is not a leak: item 15c decision (b) leaves the stream connectable on the Agent side, and
`streamIdToPortInfo` is what the client consults to reconnect it. Deleting it would make a reconnect
fail as an unknown stream. The set is bounded by the ports the session allocated, so there is nothing
to reclaim.

## 7. `pendingStreamStarts` is dead — Low

Written in the duplicate path, then **written again** a few lines later with the same key and value,
deleted on both success and failure, and never read anywhere. The duplicated write is the tell that
this path was edited and left half-finished.

**Confirmed dead**, which this item asked for before deleting it: there is no read anywhere in the
repo, and everything it could have correlated arrives in the response — `ret.streamStatus.stream_id`
is used three lines later. Safe to delete.

## 8. `toServerBuffer` was flushed but never cleared — ~~Latent~~ **fixed**

`initStreamId` flushed the buffer through `dataFromClent` without resetting it. Harmless only because
`setStreamId` guarded against a second call; `initStreamId` has two callers, so it was one refactor
away from re-sending bytes into an RSP stream. `fromServerBuffer` was cleared correctly on its forward
path, so the asymmetry was the bug — and it is now symmetric.

## 9. `dataFromServer`'s `get(-1)` fallback can misroute — Low

`socketsByStreamId.get(stream_id) || socketsByStreamId.get(-1)` sends data for an unknown id to
whichever socket happens to be mid-handshake. Narrow, and the same `-1` sentinel is why two clients
connecting simultaneously are rejected rather than handled. The replacement is an explicit `pending`
field; see "what remains" below.

## 10. Unknown-stream-id logging is per chunk — Low

One error line per inbound chunk once a stream has no socket.

**Much narrower than when this was written.** The case that hurt was a closed SWO viewer producing that
line for the remainder of the session, because the Agent had no idea the consumer had gone. It is now
told (item 15c), so the window is one control round trip rather than the rest of the session. Still
worth rate-limiting; no longer worth prioritising.

## 11. Closing the original never released the duplicates on its listener — ~~High~~ **fixed**

Found while implementing item 1, and the mirror image of it. `RemoteServer.close()` sets
`endingSession = true` **before** destroying its sockets, which is exactly what stops `cleanupSocket`
from reporting them — deliberately, so that a close we performed ourselves is not reported back to the
Agent as a request (item 1's fourth test). But `handleStreamClosed(originalId)` also goes through
`close()`, and there the duplicates on that listener are genuinely news to the Agent: it told us about
the original, and knows nothing about the others. Each one it still believes in holds a connection to
the gdb-server and a `-gdb-max-connections` slot with it.

**Fixed.** `close(notifyAgent)` reports the other consumers before setting the flag. It stays off for
real session teardown, where the session releases everything anyway and a control round trip per
consumer on the way out buys nothing.

---

## Background: why a close has to be _sent_

Kept because it is the part that is easy to get wrong, and the reason items 1, 10 and 11 all traced
back to the same gap.

One local port per reserved stream, one listener on it, and **N consumer connections on that
listener** — the first GDB plus any duplicates. Each consumer does get its own connection to the
gdb-server (`duplicateStream` makes a second one), so this is not a fan-out in the sense
[gdb-rsp.md](./gdb-rsp.md) §4.7.5 forbids. One `RemoteServer` per local port is therefore correct, and
an earlier draft of this document was wrong to propose one per stream id: two listeners cannot bind the
same port.

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

What the Agent kept doing while B was open and nobody was reading A:

- **GDB → server:** nothing. Once GDB is gone nothing arrives on A, so nothing is written to B.
- **server → GDB, RSP:** bounded. The server only speaks when spoken to, and a secondary connection is
  sent no stop replies (gdb-rsp.md §4.7), so the only traffic is replies to requests that were in
  flight when the consumer died — dropped with one log line each (item 10).
- **server → GDB, SWO:** unbounded. The server streams continuously, so the Agent forwarded forever and
  the client logged per chunk for the rest of the session. This was the case that hurt.
- **On the server:** the connection stayed in its list with its full per-connection state and kept
  counting against `-gdb-max-connections`. Start and stop live watch a few times and the limit was
  exhausted, at which point the next attempt got the accept-then-close refusal — which, before item 1
  was fixed, destroyed the primary GDB.

---

## What remains

All three are small, none is load-bearing, and they live in the same identity plumbing:

- **Item 9.** Replace the `-1` entry in `socketsByStreamId` with an explicit
  `private pending: RemoteStream | null`. `dataFromServer` becomes
  `socketsByStreamId.get(id) ?? this.pending`, and the "two clients at once" guard becomes
  `if (this.pending)`. A routing map stops carrying a sentinel key.
- **Item 4.** `resetStreamId` returns whether it succeeded; `setStreamId` stops calling `initStreamId`
  when it did not, so the object and the map cannot disagree. Both branches described in item 4, not
  just the collision.
- **Item 7.** Delete `pendingStreamStarts`.

Then, on their own schedules:

- **Item 5** under the flow-control policy in [Stream-Flow-Control.md](./Stream-Flow-Control.md).
- **Item 10** rate-limited, or left alone — it is one line per chunk for one round trip now.

## Hardware check still owed

The scenario is deliberately reproducible: start a session, let live watch attach, **stop live watch
mid-session**, and confirm the primary GDB survives with its local port still bound. OpenOCD is the
case to run — of the four servers verified, it is where live watch uses a second connection. The
matching negative case is `-gdb-max-connections` left at 1: live watch should fail with
`Live watch expressions will not work.` and the session should start normally anyway.
