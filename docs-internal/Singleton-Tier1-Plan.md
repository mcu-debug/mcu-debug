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
  "started": "2026-07-31T…"
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
- **Idle-timeout**: when refs reach 0, start a timer (default **5 hours**, configurable); still 0 at expiry → exit, releasing the lock. Any new ref cancels the timer. Long on purpose: a debug session that pauses for lunch must not lose its gdb-servers, and the cost of an idle daemon is a few MB.
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

- **Phase A — Singleton identity. ✅ LANDED.** State dir + instance key + advisory lock (`fd-lock`) + `endpoint.json` + startup acquire/enforce. Second launch (any version, for now) *reuses* the existing proxy — prints its discovery JSON and exits. Implemented in [singleton.rs](../packages/mdbg/src/proxy_helper/singleton.rs) + [run.rs](../packages/mdbg/src/proxy_helper/run.rs); `--instance` / `MDBG_PROXY_INSTANCE` arg added. Notes:
  - `MDBG_PROXY_STATE_DIR` env overrides the `~/.mcu-debug/proxy` base (containers without a writable `$HOME`, tests).
  - `endpoint.json` is removed on graceful exit; on a hard kill it's left stale but the OS releases the lock, so the next launch **acquires** (not reuses) and overwrites it. Reuse only ever happens against a *held* lock (= a live proxy) — verified: a killed proxy's stale endpoint is never reused.
  - Version-based branching is deferred to Phase D; Phase A reuses any live same-instance proxy regardless of version.
- **Phase B — Use-bounded lifetime. ✅ LANDED.** Ref-counting ([lifetime.rs](../packages/mdbg/src/proxy_helper/lifetime.rs): `Lifetime` + RAII `Ref`) + an idle-monitor thread that self-exits after `--idle-timeout` (default 5 hours = 18000s; `0` = never, for a persistent lab/SSH daemon). `--heartbeat` demoted to a **window keep-alive ref** — losing it no longer kills the proxy, it just drops a ref, so a live session keeps the proxy up after the window closes. Verified end-to-end: idle-exit fires with no sessions; a held session prevents it and the proxy exits only after the session closes. Notes:
  - Each accepted session holds a ref for its thread's lifetime; the idle timer only arms when refs hit 0.
  - Small accepted race: a client connecting in the microsecond the idle monitor fires may get dropped (self-heals via relaunch). A race-free handover is Phase C/D territory (drain).
- **Phase C — Admin surface. ✅ LANDED.** First-frame discriminator ([admin.rs](../packages/mdbg/src/proxy_helper/admin.rs) `discriminate`: first byte `0x00` = funnel session, `{` = admin line-JSON) on the same listener — no second port. `mdbg proxy --status` and `--shutdown` are client modes (query a running proxy, print JSON, exit; never start one). Admin requests carry the token. `--shutdown` = **graceful drain**: set `draining`, mark `endpoint.json` `state:"draining"`, then **give up the instance immediately** — stop the accept loops, remove `endpoint.json`, release the lock — and serve existing sessions to completion headless, exactly like an upgrade hand-off minus the successor. Once its accept loops stop — milliseconds after the request — a draining proxy has no listener and no record, so it is unreachable for admin requests too, exactly like a superseded one: it cannot be listed by `--status` or reached by `--close-serial`. The recourse for a lingering one is to close its client or kill its pid. (Only in that brief transition are new sessions refused while admin requests are still answered.) A launch that finds the lock held no longer reads `endpoint.json` and goes: `singleton::await_holder` waits until either a non-draining record appears (reuse it, or ask it to hand over) or the lock frees (take the instance). That covers both windows where a held lock and a usable record disagree — a starting proxy that holds the lock before publishing, and a departing one that has marked its record `draining` or already removed it. The acquire loop also reuses a *new* live owner if a concurrent launch wins the freed lock first, instead of waiting out its deadline; the departing proxy's own pid is never handed out. (Corrected 2026-09-14. Drain originally kept the lock and listener until its last session ended, and refused every connection before discriminating. One long-lived session — a serial port left open in an editor panel, whose funnel connection the extension never closes — then wedged the whole instance: `--status` reported zero instances because its admin query was refused, no upgrade could reach it, and new launches were handed its discovery line only to be refused. That contradicted §0: a draining proxy is a session host that has given up its listener identity.) Verified: status (running + not-running), drain with no sessions (immediate exit), and drain with an active session (stays alive, reports "1 active", exits after it ends — **does not kill live sessions**). Notes:
  - Only graceful drain is implemented; a `--force` immediate teardown needs an Agent-level session registry (to shut down each session's socket) — deferred; pairs naturally with Phase D.
  - Admin threads don't hold a lifetime ref, so `active_refs` in `--status` reflects real sessions.
- **Phase D — Upgrade/handover. ✅ LANDED.** A newer-versioned launch detects the running proxy via `endpoint.json`, sends an admin `upgrade` request, and takes over: the old proxy validates the requester is strictly newer, marks itself `draining`+`superseded`, releases its lock and relinquishes `endpoint.json` **immediately** (breaks its accept loop), then serves its existing sessions to completion headless before exiting. The new proxy retries the lock (probe-then-acquire loop, sidestepping NLL problem case #3) and becomes the singleton. Version compare via `singleton::is_newer` (suffix-ignoring semver). `MDBG_PROXY_VERSION` overrides the self-version for testing/forcing. Verified end-to-end: newer takes over + old exits; **downgrade guard** (older launch reuses the newer proxy, no eviction); and **handover with an active session** (log timestamps: old handed off, kept serving, exited exactly one session-duration later). Notes:
  - Probe-contention during drain (§6) and stale-file takeover (§7) are the remaining edges — a new session on the successor that needs a probe the draining old proxy still holds gets a transient OS "busy" error; not yet given a friendly message.
  - Shell `kill -0`/`wait` proved unreliable in the test harness; the proxy's own log timestamps are the source of truth for the lifecycle assertions.

- **Phase D.1 — Same-version handover by executable mtime. ✅ LANDED.** `is_newer` decides nothing
  when the versions are equal, and equal is the common case in practice: a release happens once,
  while a test build is carried to half a dozen machines and reinstalled over itself repeatedly,
  each time leaving a daemon whose version matches and whose code is stale. Each proxy now stamps
  its own executable's path and mtime at startup (`singleton::ExeStamp`, published in
  `endpoint.json` and held in `AdminContext`), and a launch supersedes a running daemon when the
  versions are equal **and** the path is identical **and** its own file is strictly newer. One pure
  function, `singleton::decide_handover`, is run by both ends — the challenger to decide whether to
  ask, the incumbent to decide whether to agree — so a challenger cannot argue its way past a rule
  the incumbent applies for itself. Notes:
  - **Stat at startup, never again.** Both ways of replacing the binary swap the inode rather than
    writing into it (`copy_artifact` does `mv` deliberately; VS Code extracts an extension into a
    fresh directory), so a later stat describes the *replacement*. On Linux it is worse: after a
    swap the running daemon's `current_exe()` reads back as `…/mdbg (deleted)` and the stat fails.
  - Milliseconds, not nanoseconds, so the value stays exactly representable as a JSON double for
    any JavaScript reader of `endpoint.json`.
  - **`MDBG_PROXY_AUTO_UPGRADE=0`** suppresses it. Default **on**: opt-in would have meant a
    variable to remember on every machine you test on — the same failure mode as remembering to
    kill the daemon, with the same silent symptom. And the outcomes are not symmetric: not
    upgrading means debugging against code you did not build, while upgrading unnecessarily costs a
    graceful drain in which live sessions finish where they are. The variable gates whether a launch
    *asks*, never whether a daemon agrees — otherwise a daemon started by an ordinary window could
    never be replaced, which is the hole this closes.
  - `upgrade` is now **loopback-only**, like `widen`/`narrow`. Replacing a binary is inherently
    local, so there is no remote upgrade to support, and accepting a same-version handover on
    self-reported file evidence should not be reachable from off-box. `shutdown` is deliberately
    left open: draining a lab daemon from elsewhere is a real use.
  - Guards, each with a unit test and verified live: an older *version* never wins however new its
    file (rebuilding an old checkout makes a new file with old code); differing paths are treated as
    incomparable rather than ordered (a fresh install can easily hold an older file than a dev
    build); an identical file reuses, so a second window does not churn the daemon; and a running
    record with a path but no mtime reuses, since reading that as "old" would hand over on every
    launch.
  - **One-time limitation:** a daemon running code from *before* this landed refuses an
    equal-version handover, because its own `begin_upgrade` predates the rule. The launch falls back
    to reuse and logs the refusal, so the first relaunch after upgrading to this still needs
    `mdbg proxy --shutdown --all`. Every one after that is automatic.
  - `scripts/build-binaries.sh` no longer calls `stop_running_proxies` (`pkill -f 'mdbg proxy'`).
    That hammer took out every instance, including one another window was mid-session on, and killed
    rather than drained. The function is kept for a daemon too wedged to answer its admin channel.

- **Phase D.2 — Diagnostics. ✅ LANDED.** The singleton is shared, detached and long-lived, which
  made it the one component nothing could see. Three pieces, each where it is for a reason:
  - **`--status` reports the executable**, not just the port: the mtime the agent started with,
    what is at that path now (both as epoch ms *and* a local-time string), and
    `replaced_since_start` — the derived answer to "is this serving code that is still on disk?".
    The agent computes it rather than the caller: it is the only process that knows what it
    started with, and the only one certain to share a filesystem with the file. `--status` was
    already instance-agnostic, so one call covers a `dev` agent beside the default one.
  - **`mcu-debug-proxy.proxyStatus`** (proxy extension, no palette entry) spawns `--status` and
    returns the JSON. It cannot live on the main extension: the binary sits inside *this*
    extension's install directory and the admin port is loopback on the probe host, which in a
    remote window is not the workspace machine. Commands cross extension hosts; paths and sockets
    do not.
  - **`mcu-debug.probeAgentStatus`** → *"Show Probe Agent Status"* (main extension) is the command
    users run — the main extension is the one always installed, so it is the only one that can
    report a *missing* proxy extension. `mcu-debug.checkProxy` became
    **`checkProxyExtension`**/*"Check Proxy Extension"*: "proxy" had come to mean both the
    companion extension and this daemon, and those are two questions. The daemon is the **Probe
    Agent** throughout the docs, so the commands now use that word for it.

  The `--status` document is a wire type and is generated for TypeScript by ts-rs like the rest
  (`StatusReport`, `StatusInfo`, `ExeStatus`, `SerialStatus`). The admin channel had never been
  exported because nothing in TS read an admin reply until this command existed. Notes:
  - **No standalone cleanup utility.** It was considered, and Phase D.1 removed the need: the
    agent upgrades itself, `--shutdown --all` drains every instance, and `--status` already
    answers the rest. The extensions ask; they do not reimplement.
  - Deferred: the discovery line does not say which branch `acquire_or_reuse` took, so a
    *refused* handover is indistinguishable from an ordinary reuse without reading the agent's
    log. An `"action": "started" | "reused" | "upgraded"` field would settle it —
    `#[serde(default)]` keeps that compatible. Not worth it while nothing is biting.

**Tier 1 is complete** (A–D, plus D.1 and D.2). The singleton is discoverable, use-bounded, admin-controllable, and self-upgrading. Next up is Tier 2 (credentials §8, provisioning ladder §4–6) from [CLI-Proxy-Provisioning.md](./CLI-Proxy-Provisioning.md).

---

## Open decisions (confirm before/inside the relevant phase)

1. **Control channel** (§2): same-port first-frame discriminator **(A, recommended)** vs. separate control port (B).
2. **Downgrade** (§3): older-launched-vs-newer-running → use-existing silently, or warn + exit?
3. **Idle-timeout default** — ~~5 min reasonable, or longer for a lab daemon?~~ **Settled: 5 hours** (`5*60*60`). 5 minutes was far too short — it reaped the daemon out from under anyone who stepped away mid-session. `0` remains the persistent lab/SSH daemon.
4. **Takeover aggressiveness** (§7) — how much evidence before removing another process's stale files?
5. **Locking crate** — `fd-lock` vs `fs2` vs hand-rolled per-OS.
