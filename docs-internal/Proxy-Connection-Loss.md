# Proxy Connection Loss — Policy & Deferred Work

**Status:** Decided. Teardown is the shipped behaviour; reconnect is deferred, not rejected. 2026-09-11.
**Area:** Debug Adapter ↔ Probe Agent (`mdbg proxy`) control connection.
**Related:** [Remote-Proxy.md](./Remote-Proxy.md), [GdbServer-Exit-Reporting.md](./GdbServer-Exit-Reporting.md)

---

## 1. The situation

The control connection from the Debug Adapter to a Probe Agent can vanish without an
end-session handshake — a dropped tunnel, a reaped NAT mapping, a suspended laptop, a
crashed adapter. The Rust side sees a closed socket and no reason for it, and has to pick a
policy without knowing whether the client is coming back.

Two connections are affected, and they are **not** symmetric:

| Connection | Reconnects? | Why |
| --- | --- | --- |
| `serial-manager.ts` → proxy | **Yes** | One connection, little state; re-opening a port is cheap |
| `proxy-client.ts` → proxy | **No** | A debug session holds ~a dozen streams whose ids would all have to be restored, and the far end has usually killed the gdb-server by then |

## 2. The choice

On an unexplained disconnect the agent can either:

1. **Hold everything and wait for the client to return.** Nothing is torn down, so a session
   could resume exactly where it left off.
2. **Call it a day.** Tear down the gdb-server, release the probe, let the next session start.

**We do (2), deliberately.** Option 1 keeps the USB probe claimed on behalf of a client that
may never come back, and a held probe blocks *every* subsequent session on that machine. A
dead session that releases the probe is strictly better than a hopeful one that blocks the
next launch.

This is the same trade decided against an idle-timeout on abandoned CLI sessions: a grace
period lets a straggler rejoin, but it holds the probe hostage meanwhile, and that cost lands
on someone who did nothing wrong. **Never hold the probe for a client that may never return.**

## 3. What prevention covers, and what it does not

`PROXY_KEEPALIVE_MS` (60s, [common/utils.ts](../packages/mcu-debug/src/common/utils.ts)) sets
TCP keepalive on both proxy sockets. Keepalive probes are empty segments, so unlike an
application-level heartbeat they keep a path warm without adding a line to the log of a
session left running overnight — which is why the `startHeartbeat()` machinery in both files
stays deliberately unused.

It matters that this covers only one of the two failure shapes:

| Failure | Covered by keepalive? |
| --- | --- |
| Session idle but awake — someone thinking at a breakpoint while a NAT or tunnel reaps the idle mapping | **Yes.** Probing keeps the mapping alive |
| Laptop suspended, network changed, roamed between networks | **No.** A sleeping machine stops probing; the far end reaps the connection during the sleep and the socket is already dead on resume |

So keepalive and reconnect address **disjoint** failures. Deferring reconnect does not leave
the first category half-covered, and no amount of keepalive tuning will reach the second.

## 4. Open gap: the agent cannot detect a vanished client

Teardown only happens if the agent *notices*, and today it may not.

Keepalive is set on the Node sockets only. Keepalive is per-socket: the side that probes is
the side that learns. That is fine for keeping the path open — Node's probes traverse every
middlebox and draw ACKs back — but it means the agent never learns that its client is gone.

If the adapter's machine disappears without sending FIN (lid closed, cable pulled, power
cut), the agent's socket stays `ESTABLISHED` and its connection thread blocks on a read that
will never return. **The session ref is never released**, so `wait_until_idle`
([lifetime.rs](../packages/mdbg/src/proxy_helper/lifetime.rs)) never sees the count reach zero
and the idle window never begins — the 5-hour timeout is not a backstop here, it simply never
starts. The gdb-server keeps running and the probe stays claimed, which is the exact outcome
§2 exists to prevent.

The one accidental escape: the agent writes to the client (gdb-server output, serial data),
and a write to a dead peer eventually fails once TCP gives up retransmitting — ten-plus
minutes. That only fires if there is something to send. A session paused at a breakpoint
produces nothing, and that is precisely when a laptop gets closed.

**Fix:** enable TCP keepalive on the agent's accepted client sockets. Neither `std::net::TcpStream`
nor tokio's exposes keepalive (only `set_nodelay`), so this goes through `socket2` — which is
**already in the build**, pulled in by tokio and maintained by the rust-lang org, so declaring it
directly compiles nothing new. It also allows setting interval and retry count, not just the idle
time Node is limited to. The only cost is its 0.x versioning: pin the same minor tokio uses, or
two copies get compiled.

The work is small; the testing is not. It needs a client that is *stranded* — `kill -STOP` the
adapter, or drop its interface — not one that closes politely, because a polite close already
works and would pass a test that proves nothing. That is why this is deliberately not bundled
with a release.

## 5. Deferred: opt-in reconnect

Worth building **when a user asks for it**, not before. The likely askers are long-distance
remote-proxy setups, and anyone who closes a laptop mid-session and expects to resume.

Two conditions are attached, and neither is optional:

- **Explicit user opt-in, with the consequence stated.** The cost is a probe held for a
  client that may never return, which blocks other sessions on that machine. That is not a
  cost to impose by default, and not one to bury in a setting description.
- **Substantial testing.** The mechanism is probably not hard — a grace window before
  teardown, and enough session state to restore stream ids. The risk is in the state
  restoration and in every partial-failure path around it, which is exactly the kind of code
  that looks finished and is not.

Do not implement this speculatively. A reconnect path that is rarely exercised is a reconnect
path that does not work, and it will be discovered at the worst moment — during a debug
session that has already gone wrong once.
