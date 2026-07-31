# Singleton Tier 1 — Implementation Plan

**Status:** Draft plan, ready to implement in phases. 2026-07-31.
**Goal:** Make `mdbg proxy` a discoverable, single-instance-per-(user, instance) daemon whose lifetime is bounded by *use* (idle-timeout), decoupled from the VS Code window, with graceful **version upgrade / handover**.
**Builds on:** the fault-isolation work (R2–R8) in [CLI-Proxy-Provisioning.md](./CLI-Proxy-Provisioning.md) §7.3. **Prerequisite for:** provisioning (§4–6) and the credential model (§8), which both discover through the `endpoint.json` defined here.

---

## 0. The core idea: split "listener identity" from "session host"

A running proxy plays two roles, and separating them is what makes the whole plan (especially upgrade) clean:

1. **Listener identity** — owns the well-known discovery anchor and accepts *new* connections. Exactly **one** proxy per (user, instance) may hold this.
2. **Session host** — serves the connections it has already accepted, holding their gdb-servers and probes. Multiple proxies may coexist as session hosts **as long as they don't contend for the same physical probe** (a USB reality, not a design limit).

Upgrade = transfer role 1 from old → new, while old keeps role 2 until its sessions drain. "Drain mode" = a session host that has given up its listener identity.

---

## 1. State directory & discovery anchor

Per (user, instance), on the Probe Host:

```
~/.mcu-debug/proxy/<instance>/
├── proxy.lock       # advisory file lock; OS releases it on process death
├── endpoint.json    # the discovery anchor (below)
└── master.key       # (later, §8) — not in Tier 1
```

- **Instance key**: `--instance <name>` / `MDBG_PROXY_INSTANCE`, default `default`. Separate dir per instance → running a dev build (`--instance dev`) never collides with production. (This is the escape hatch from §7.2.)

`endpoint.json` — the stable identity is *the file*, not the port (the port is `--port 0`, OS-assigned, and changes across upgrades):

```jsonc
{
  "v": 1,
  "instance": "default",
  "pid": 9876,
  "version": "0.1.9",          // semver of the running proxy
  "port": 51234,               // loopback control/funnel port
  "token": "…",                // connection token (Tier-1 shared token; §8 replaces later)
  "state": "active",           // "active" | "draining"
  "startedAt": "2026-07-31T…"
}
```

---

## 2. Control-channel primitive (decision needed)

**Recommendation: loopback TCP + token, reusing the existing funnel listener.** Rationale: portable (no AF_UNIX-on-Windows `std` gap, no `\\.\pipe\` namespace special-casing), and it reuses the listener, token, and `--port 0` discovery the proxy already has. `endpoint.json` carries `port` + `token`.

**Sub-decision:** coordination/admin messages (status, shutdown, upgrade) are proxy-*global*, not session-scoped, so they need an **Agent-level** path. Two options:
- **(A, recommended)** same listener, **first-frame discriminator**: the client's first control frame declares intent — `session` (→ spawn a `ProxyServer` as today) or `admin:{status|shutdown|prepareUpgrade}` (→ handled by the accept-loop/Agent, then close). One port, no new surface.
- **(B)** a second, control-only loopback port in `endpoint.json`. Cleaner separation, but two ports and more moving parts.

---

## 3. Startup sequence (the lock / liveness / version dance)

```
1. Resolve state dir from instance; ensure it exists.
2. Try to acquire proxy.lock (advisory, non-blocking).

   ACQUIRED → no live proxy (or a dead one whose lock the OS already released).
     • Discard any stale endpoint.json.
     • Bind listener on 127.0.0.1:0; write endpoint.json {state:"active"}.
     • Become the singleton. Run.

   NOT ACQUIRED → a proxy holds it. Read endpoint.json, connect its control channel:
     • connect refused / no response → treat as dead/wedged (stale endpoint):
         fall back to takeover (see §7). 
     • connected → version handshake:
         new == existing  → NOT an upgrade. This invocation just *uses* the
                            existing proxy (the "reuse" rung). Print its
                            discovery info and exit (or act as client).
         new  > existing  → UPGRADE (§5).
         new  < existing  → DOWNGRADE guard: do not replace. Use the existing
                            proxy, or warn + exit. (Never let an older binary
                            evict a newer running one.)
```

Cross-platform locking: use an advisory-lock crate (`fd-lock` / `fs2`) — `flock` on Unix, `LockFileEx` on Windows. The lock's value is that the **OS releases it on process death**, so a crashed proxy never leaves a lock that blocks a restart.

---

## 4. Lifecycle: ref-counting + idle-timeout

- **Refs** = reasons to stay alive. Tier 1: each accepted **session** is +1, dropped to −1 on session end. (Provisioning later adds "keep-alive" refs from the Broker/CLI, §7.2.)
- **Idle-timeout**: when refs reach 0, start a timer (default 5 min, configurable); still 0 at expiry → exit, releasing the lock. Any new ref cancels the timer.
- **Decoupled from the VS Code window**: today `--heartbeat` (stdin pings from the launching extension) *is* the lifecycle — no heartbeat → die. New model: `--heartbeat` becomes just **one ref source** (a window keep-alive), not the killer. The proxy outlives the window if a CLI session still holds a ref. (Migration note, §8.)

---

## 5. Upgrade / handover (drain-and-replace)

When a **newer** proxy launches while an older one runs:

```
new → existing:  Admin PrepareUpgrade { version: <new> }
existing:        validate new > self; then enter DRAIN:
                   1. stop the accept loop / close the listener
                   2. release proxy.lock and relinquish endpoint.json ownership
                   3. set state = "draining" (for --status visibility)
                   4. ACK "released"
new:             acquire proxy.lock; bind a fresh 127.0.0.1:0; write endpoint.json
                 {state:"active", new port, new version, new pid}.  → new singleton
existing:        keep serving its in-flight sessions headless; exit when refs == 0.
```

Notes:
- **Drain = the idle lifecycle with the accept loop disabled.** No new refs can be added; exit fires when the last session ends (or immediately if already 0). Reuses §4 entirely.
- A client that read the *old* `endpoint.json` and dials the old (now-closed) port gets connection-refused → re-reads `endpoint.json` (now the new one) → connects to the new proxy. So discovery needs a **retry-on-stale** step (the provisioning ladder already pings/validates, so this is free there).
- The version handshake can be a quick read of `endpoint.json.version` plus an authoritative check over the control channel (the file can lag a live proxy).

---

## 6. Probe contention during drain (the honest constraint)

Two processes **cannot** drive the same physical probe (USB). So during drain:
- the **old** proxy keeps the probes its live sessions are using;
- the **new** proxy can serve only probes that are **free**.

If a new session asks for a probe the draining old proxy still holds, the new proxy's attempt to open it fails at the OS level → return a **clear, transient error** ("probe in use by a draining proxy — retry shortly"). As the old sessions finish, the probes free up and retries succeed. There is deliberately **no session migration** — an active debug session can't move to another process because its probe can't. Drain-to-completion is the only coherent semantics.

---

## 7. Orphans, staleness, and takeover

- **Stale lock**: impossible to *hold* — the OS drops `flock`/`LockFileEx` when the holder dies. A restart always re-acquires.
- **Stale `endpoint.json`** (dead pid, or a wedged proxy that holds the lock but won't answer): on NOT-acquired + control-channel unresponsive, define a **takeover**: confirm the pid is dead (or unresponsive past a timeout), remove the stale files, re-acquire. Be conservative — only take over on clear evidence the old is gone/wedged, to avoid two live listeners.
- `mdbg proxy --status` → `{pid, version, port, uptime, sessions, state}` via the admin path.
- `mdbg proxy --shutdown [--graceful]` → immediate exit, or drain (stop accepting, exit at refs==0). Fall back to pid-kill from `endpoint.json` only if the control channel is unresponsive.

---

## 8. Migration from current behavior

- **`--port 0` + stdout discovery JSON**: keep it — the SSH "spawn and read stdout" flow ([Remote-Proxy.md](./Remote-Proxy.md)) still needs it. `endpoint.json` is an *additional* persistent anchor for local discovery + singleton coordination.
- **`--heartbeat`**: from lifecycle-owner → one ref source (§4).
- **`--token`**: stays as the Tier-1 connection token in `endpoint.json`; the minted per-session tokens of §8 replace/augment it later without changing this plan.

---

## 9. Implementation phases (each lands green + reviewable)

- **Phase A — Singleton identity.** State dir + instance key + advisory lock + `endpoint.json` + startup acquire/enforce. Second same-version launch *uses* the existing proxy (no upgrade yet). Delivers a true singleton.
- **Phase B — Use-bounded lifetime.** Ref-counting + idle-timeout; demote `--heartbeat` to a ref source. Delivers "outlives the window, self-reaps when idle."
- **Phase C — Admin surface.** First-frame admin discriminator (§2A) + `--status` / `--shutdown [--graceful]` + `state:"draining"`.
- **Phase D — Upgrade/handover.** Version handshake + `PrepareUpgrade` → drain-and-replace (§5), with probe-contention errors (§6) and takeover (§7).

---

## Open decisions (confirm before/inside the relevant phase)

1. **Control channel** (§2): same-port first-frame discriminator **(A, recommended)** vs. separate control port (B).
2. **Downgrade** (§3): older-launched-vs-newer-running → use-existing silently, or warn + exit?
3. **Idle-timeout default** — 5 min reasonable, or longer for a lab daemon?
4. **Takeover aggressiveness** (§7) — how much evidence before removing another process's stale files?
5. **Locking crate** — `fd-lock` vs `fs2` vs hand-rolled per-OS.
