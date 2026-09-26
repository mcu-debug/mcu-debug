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
| 2   | High     | Read       | No `error` handler on the `net.Server`; bind failure cannot be seen |
| 3   | High     | Read       | `throw` inside the socket `error` handler                           |
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

**Fix direction.** One `RemoteServer` per stream id rather than one object holding a socket list.
That is also what the 1:1 rule in [gdb-rsp.md](./gdb-rsp.md) §4.7.5 implies — one local connection
per server connection — so the class no longer needs to represent a fan-out it should not perform.

## 2. No `error` handler on the `net.Server` — High

`RemoteServer.initialize()` attaches `listening` and calls `.listen()`, and never
`.on("error", …)`. An unhandled `'error'` event on an EventEmitter is **thrown**, so `EADDRINUSE` on
`portDef.localPort` — a stale listener, a sibling session, an unrelated user process — takes the
debug adapter down instead of reporting that the port is in use.

Compounding it: `initialize()` resolves as soon as `.listen()` returns rather than on `listening`, so
the `try/catch` around it in `handleStreamReady` cannot observe a bind failure either. Both halves
need fixing together, or the handler logs into a void.

## 3. `throw` inside the socket `error` handler — High

The client-socket `error` handler logs the error and then throws a new one from inside an event
callback, which is an uncaught exception reaching the process-level catchall. An `ECONNRESET` from a
GDB that was killed is ordinary and already reported by the line above. Log, do not throw.

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
connecting simultaneously are rejected rather than handled. Goes away with the per-id `RemoteServer`
of item 1.

## 10. Unknown-stream-id logging is per chunk — Low

One error line per inbound chunk once a stream has no socket. Combined with the missing
client-to-Agent stream close ([gdb-rsp.md](./gdb-rsp.md) item 15c), a closed SWO viewer produces that
line for the remainder of the session. Rate-limit it, or make it impossible by telling the Agent the
consumer went away.

---

## Suggested order

1. **Items 2 and 3** first: independent of everything else, cheap, and the only two that can kill the
   debug adapter.
2. **Item 1**, with items 7 and 9 folded in. They are one story — the duplicate path grafted a second
   identity onto a class that assumes one — and a `RemoteServer` per stream id dissolves all three.
3. **Items 4, 6, 8** as cleanup alongside item 1, since they all live in the same identity plumbing.
4. **Items 5 and 10** belong with the transport work: item 5 under the flow-control policy, item 10
   under the stream-close notification (gdb-rsp.md item 15c).
