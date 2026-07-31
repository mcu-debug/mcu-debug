# CLI Proxy Provisioning — Protocol Draft

**Status:** Draft / design discussion. 2026-07-30.
**Builds on:** [Proxy-Plan.md](./Proxy-Plan.md) (terminology, funnel protocol, topologies).
**Supersedes the discovery notes in:** [Remote-Proxy.md](./Remote-Proxy.md) (SSH deploy flow), which stays valid for Topology B.

---

## 1. Scope

[Proxy-Plan.md](./Proxy-Plan.md) covers the case where the **UI extension** is present and hands the DA its connection details. This document covers the gap:

> **How does a client learn `{host, port, credential}` when there is no UI extension handing it over?**

That gap appears in three situations:

- **CLI mode** — the user runs `mdbg` from a terminal. No extension exists to launch the Probe Agent or publish its coordinates.
- **WSL / Dev Container** — the DA/CLI runs in the guest, the probe is on the Engineer Machine (Topology A), but the user is in a terminal rather than driving a debug session from the UI.
- **SSH / LAB** — the probe is on a physically separate Probe Host (Topology B), with or without VS Code on either end.

The goal is **autodetection**: the only irreducible manual step should be *"start the Probe Agent on the Probe Host"* — because something has to own the USB. Everything else (`host`, `port`, `credential`) should be discovered, not pasted.

### Terminology

Reuses [Proxy-Plan.md](./Proxy-Plan.md): **Engineer Machine**, **Probe Host**, **Probe Agent** (`mdbg proxy`), **DA**. This document adds:

| Term              | Meaning                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Client**        | Whatever is trying to reach the Probe Agent: the DA, or the `mdbg` CLI. Symmetric for this protocol.                                                                           |
| **Broker**        | The `mcu-debug.mcu-debug-proxy` VS Code UI extension acting as a URI handler. Runs on the Engineer Machine UI side. Ensures the Probe Agent is running and issues credentials. |
| **Rendezvous**    | A pair of files (`<handle>.req` / `<handle>.res`) on a filesystem visible to both Client and Broker, used to exchange the request and the result.                             |
| **Master key**    | Long-lived secret held **only** inside the Probe Agent. Never leaves the Probe Host.                                                                                           |
| **Session token** | Short-lived, revocable capability minted from the master key. This is the only credential a Client ever sees.                                                                 |
| **TOFU**          | *Trust On First Use* — prompt the first time an identity is seen, remember the decision, stay silent afterward (the SSH known-hosts pattern). See §6.                          |

### What the Probe Agent is — and is not

The Agent (`mdbg proxy`) manages **process lifecycle and the funnel**. It is **probe-agnostic**: it does *not* enumerate USB probes and does *not* know which gdb-server will be used or which probes that server can see. All of that lives in the **session's launch config**, which the Client supplies when it opens a session; the Agent then spawns the configured gdb-server (OpenOCD / J-Link / pyOCD / probe-rs, each of which supports its own probe set) and funnels its TCP ports. Consequently this protocol carries **no probe identity** — probe selection is a downstream concern of the gdb-server, not of provisioning.

---

## 2. The two-plane split

The single most important idea: discovery and transport are **separate problems with separate answers**. Conflating them is what makes this feel hard.

- **Control plane (handshake).** Client learns `{port, token}`. Small, one-time, tolerant of an awkward/slow channel.
- **Data plane (transport).** The funnel/gdb traffic. High volume, needs a genuinely open network path.

The data plane is the *easy* one, because in every environment one direction is already open — you just have to use the open one:

| Environment                | Probe Agent lives on       | Naturally-open direction                   | Data-plane path                                                                       |
| -------------------------- | -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| **WSL2**                   | Engineer Machine (Windows) | guest → host                               | Client dials host: `127.0.0.1` (mirrored networking) or default-gateway IP (NAT mode) |
| **Docker / Dev Container** | Engineer Machine (host)    | guest → host                               | Client dials `host.docker.internal`                                                   |
| **SSH / LAB**              | remote Probe Host          | local → remote (the SSH connection itself) | `ssh -L` local-forward; Client dials `127.0.0.1:<localPort>`                          |

**Corollary:** the Client always computes its own dial address (`host`) — it is guest-side knowledge. The Broker never reports `host`; it only returns `port` + `token`. This avoids the Broker having to reason about how the guest sees the network.

So the whole design effort goes into the **control plane**, per environment.

---

## 3. Provisioning ladder

The Client tries these in order and stops at the first that works. Each rung degrades gracefully to the next.

```
0. Reuse           Is a live Probe Agent already recorded, with a usable credential?  → Connect, no round-trip.
1. VS Code Broker  VSCODE_IPC_HOOK_CLI present + `code` shim works?  → `vscode://…/provision`  (auto-launches Agent)
2. SSH             Configured Probe Host (Topology B)?  → ssh launch + stdout handshake + `-L` tunnel
3. Shared-FS       User already ran `mdbg proxy` on the host?  → read endpoint file over shared FS (no VS Code needed)
4. Manual          Nothing else worked  → Agent prints a paste-ready `mdbg connect …` line
```

Rungs 1 and 3 are the WSL/Docker story; rung 2 is the SSH/LAB story; rung 4 is the always-works floor.

**Rung 1 (WSL) needs no Windows username** — it uses the *WSL-side* filesystem addressed by UNC (`\\wsl.localhost\<distro>\run\user\<uid>\…`), derivable from `$WSL_DISTRO_NAME` + `id -u` alone (§5.2).

**Rung 3 is the only place the Windows username matters**, because it writes into the *Windows* per-user temp. There is no native env var for it in WSL (the WSL user ≠ the Windows user). Rather than reconstruct the name, ask Windows for the whole path and convert it:

```bash
wslpath -u "$(cmd.exe /D /C 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
# or, if the wslu package is present:  wslpath -u "$(wslvar TEMP)"
```

Requires Windows interop enabled; run from `~` (not a `/mnt/...` cwd) to avoid the "UNC not supported" warning. Rung 3 works with **no VS Code at all** — the user just ran `mdbg proxy` on Windows, and the Client reads its `endpoint.json` (§7) from that temp dir. So the Broker is an *enhancement* (it auto-*launches* the Agent and gates access), not a discovery dependency.

---

## 4. The `provision` URI (rung 1)

Invoked from the guest via the injected `code` CLI shim, which crosses the remote boundary and fires the Broker's `UriHandler` on the UI host:

```bash
code --open-url "vscode://mcu-debug.mcu-debug-proxy/provision?v=1&rendezvous=<host-path-to-.req>"
```

### Inverted handshake — the file *is* the request

Almost nothing travels in the URL. The Client first drops a **request file**, then points the Broker at it. This keeps request data out of URL logs, forces the Broker to actually read the file (which validates its access), and — because the file handle is random and exclusively created — resists squatting.

| Param        | Req | Meaning                                                                                                                              |
| ------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `v`          | ✓   | Protocol version. Currently `1`. Broker rejects unknown majors.                                                                       |
| `rendezvous` | ✓   | **Host-side** absolute path of the `<handle>.req` file the Client already created. `<handle>` is random and unguessable (see §5.2). |

Everything else — `nonce`, `authority`, `client` label — lives **inside** `<handle>.req` (§5.1). The URL carries no secret and no nonce.

Notes:

- **No secret in the URI.** URIs land in extension-host logs and OS URI-dispatch logs. The credential travels only via the `.res` file.
- `--open-url` is fire-and-forget; there is no synchronous return. The `.res` file *is* the return channel.
- The `code` shim is present in WSL, Dev Containers, and Remote-SSH; detect via `VSCODE_IPC_HOOK_CLI` or `command -v code`. The Broker extension is `extensionKind: ["ui"]`, so its handler runs on the UI side where it can reach USB.

### Broker handling of `provision`

```
1. Parse + version-check. Validate `rendezvous` against the host allowlist (§5.3); it must already exist and end in `.req`.
2. Read <handle>.req  → { nonce, authority, client }.
3. TOFU gate on authority (§6). On deny → write <handle>.res {status:"denied"} (echo nonce) and stop.
4. Ensure Probe Agent running (§7): reuse the singleton if alive, else spawn it.
5. Ask the Agent to mint a session token, subject = authority (§8).
6. Atomically write <handle>.res (temp file + rename) with the result, echoing nonce.
7. Add a lifetime ref for this window (§7).
```

The Client never has the Broker overwrite the file it is polling — request and reply are **separate files** (`.req` / `.res`), so there is no read/write race on a single file.

---

## 5. Rendezvous files

### 5.1 Payloads

**`<handle>.req`** — written by the Client (O_CREAT|O_EXCL) before invoking the URI:

```json
{
  "v": 1,
  "phase": "request",
  "nonce": "<128-bit base64url — the reply must echo this>",
  "authority": "wsl+Ubuntu-22.04",
  "client": "mdbg CLI — Ubuntu-22.04"
}
```

**`<handle>.res`** — written by the Broker (rung 1), or by `mdbg proxy` itself (rung 3):

```json
{
  "v": 1,
  "phase": "reply",
  "nonce": "<echoed from the request>",
  "status": "ready",
  "error": null,
  "port": 54321,
  "token": "<session token — see §8>",
  "tokenExpires": "2026-07-30T19:12:00Z",
  "proxyPid": 9876,
  "proxyVersion": "1.4.2"
}
```

- `status` ∈ `ready | denied | error`. On `denied`/`error`, `error` carries a user-facing message and `token` is absent.
- The Client accepts the reply only if `phase == "reply"` **and** `nonce` matches the one it wrote — confirming the reply came from a party that actually read *this* `.req`.
- `host` is deliberately **absent** — the Client fills it from §2.
- **No probe list.** Provisioning is probe-agnostic (§1); probe selection happens later, in the session's gdb-server config.

### 5.2 Path resolution (Client computes both views)

The Client knows its environment best, so it computes **both** the guest path (to create `.req` / read `.res`) and the host path (to pass in `rendezvous`). `<handle>` is a fresh random stem; on collision the O_EXCL create fails and the Client picks a new one.

| Env               | Directory — guest view (Client)      | Same directory — host view (Broker)                        |
| ----------------- | ------------------------------------ | ---------------------------------------------------------- |
| **WSL2**          | `/run/user/<uid>/mcu-debug/`         | `\\wsl.localhost\$WSL_DISTRO_NAME\run\user\<uid>\mcu-debug\` |
| **Dev Container** | `<dedicated-mount>/mcu-debug/`       | `<host-side mount root>\mcu-debug\`                          |
| **SSH / LAB**     | — (uses stdout over SSH, §9)         | —                                                          |

Why `/run/user/<uid>` for WSL rather than `/tmp` or `/mnt/c`: it is tmpfs, `0700`, honors real Linux permissions, is reachable host-side by UNC, and needs **only** `$WSL_DISTRO_NAME` + `id -u` — no Windows username. (`/mnt/c/…/AppData/Local/Temp` is reserved for rung 3, §3.)

Dev Containers have **no shared FS by default** — this rung requires the mcu-debug dev-container *feature* to bind-mount a dedicated `mcu-debug` rendezvous dir with restrictive host-side permissions. Without it, containers fall back to rung 2/4. (Open question §13.)

### 5.3 Broker path allowlist (security)

The Broker must never touch an arbitrary path a URI hands it. Validate that `rendezvous`:

- is under an approved root — WSL: a `\\wsl.localhost\<distro>\` / `\\wsl$\<distro>\` UNC; Dev Container: the feature's known mount root;
- ends in `.req` and already exists (the Client created it; the Broker never creates the `.req`);
- resolves (after normalization) still inside the approved root (reject `..`).

### 5.4 Permissions — rely on the directory, not the mode bits

Unix mode bits are **unreliable across these boundaries**, so the security comes from the *choice of directory*, not from `chmod`:

- **WSL `/run/user/<uid>` (ext4/tmpfs in the VHDX):** real Unix perms apply among Linux processes; UNC access tunnels through the 9p server running *as* the WSL user. This is the safe default.
- **WSL `/mnt/c` (DrvFs):** Unix mode is largely synthesized — access is actually governed by **NTFS ACLs**. Fine, because the Windows per-user temp is already ACL'd to that user (this is the rung-3 location).
- **Dev Container bind mount:** uid mapping is often odd (container-root vs host-user); mode bits may not mean what you expect → the feature must create the mount with restrictive *host-side* perms.

Belt-and-suspenders regardless of location: the Client pre-creates the `mcu-debug` dir, creates `.req` with **O_CREAT|O_EXCL** (squat-resistant), and the token inside the `.res` is short-TTL and single-use.

---

## 6. Authorization — TOFU keyed on remote authority

### What the prompt actually gates

Not "spawning a proxy" — the Agent is benign and idempotent, and spawning it is harmless. The real boundary is **"may this guest identity drive debug hardware on this host?"** So:

- **No prompt on Agent start.**
- **Prompt on first credential issuance** for a given `authority`, this window.

### Model

Trust-on-first-use, subject = `authority` (read from the `.req`):

- First `provision` from an authority → modal:
  `Allow «client» from «authority» to access debug hardware on this machine?`
  `[Allow once] [Allow for this window] [Always allow this host/distro] [Deny]`
- Cache the grant: in-memory for the window; `globalState` for "always."
- Subsequent provisions for a granted authority → **silent**: mint + write. Fast, no prompt.
- Deny → `.res` `status:"denied"`.

This makes reuse pleasant without re-prompting, and it is a *meaningful* boundary (you trusted a specific distro / container / SSH host), unlike a per-connection prompt that users reflexively click through.

---

## 7. Probe Agent lifecycle & discovery

### 7.1 Discovery source of truth — filesystem + OS, not VS Code global state

Global state is UI-side only, is invisible to the CLI, and lies across crashes. The authority is a small state dir on the Probe Host, readable by both the extension and the CLI:

```
~/.mcu-debug/proxy/<instance>/
├── proxy.lock       # advisory lock; the OS releases it automatically on process death
├── endpoint.json    # how to reach + confirm the Agent (below)
└── master.key       # 0600, never leaves this host
```

```jsonc
// endpoint.json
{
  "v": 1,
  "instance": "default",
  "pid": 9876,
  "version": "1.4.2",
  "startedAt": "2026-07-30T18:55:00Z",
  "transport": { "kind": "uds", "path": ".../control.sock" }
  //           | { "kind": "pipe", "name": "\\\\.\\pipe\\mcu-debug-<user>-default" }
  //           | { "kind": "tcp",  "port": 51234 }
}
```

**Discovery is ground-truth, not a guess:**

- *Is one running?* Try to acquire `proxy.lock`. **Can't** → one exists → read `endpoint.json` → connect the control channel to confirm it is really alive. **Can** → none (or it died and the OS released the lock) → you may start one.
- A **refused connect** on a present endpoint = stale → clear it and recreate. No PID guessing, no zombie records.
- `mdbg proxy --status` / `--shutdown` always find and stop the real one.

The extension may still mirror this into `globalState` as a convenience *cache*, but must always confirm against the control channel before trusting it.

**Transport primitive (control channel).** Unix: an AF_UNIX socket file in the state dir. Windows: a named pipe — note a Windows pipe lives **only** in the `\\.\pipe\` namespace and *cannot* be a real filesystem path, so `endpoint.json` merely *names* it (`\\.\pipe\mcu-debug-<user>-<instance>`). AF_UNIX on a real path also works on Windows 10 1803+, but is **not** in Rust `std` (needs `uds_windows`/`windows` crate or tokio support). A loopback-TCP port is the simplest cross-platform fallback, but is visible to all local users → it leans on the token for auth, whereas UDS/pipe give OS-level ACLs. Either way, the home-dir `endpoint.json` stays the discovery anchor.

### 7.2 Singleton, ref-counted, idle-timeout — decoupled from the VS Code window

Today the Agent dies with the window. That's wrong for CLI-primary users who may have no window, or outlive it. New model:

- **Singleton** per (Probe Host, user, **instance**). Enforced by `proxy.lock` + the control channel. A second `mdbg proxy` for the same instance detects the live one and no-ops (or forwards).
- **Instance key** for isolation: `--instance <name>` / `MDBG_PROXY_INSTANCE`, default `default`. When you **debug `mdbg` itself**, launch it as `--instance dev` (set in `launch.json`); it gets its own state dir, lock, control channel, and USB claims, and won't collide with the production Agent. This is the escape hatch that keeps "strict singleton" from getting in your way during development.
- **Ref-counting.** Clients register interest: the Broker adds a ref on first provision for a window and drops it on window close / `deactivate`; each CLI session holds a ref for the life of its connection.
- **Idle timeout.** When refs reach 0, start a timer (default 5 min, configurable). Still 0 at expiry → graceful exit, **releasing the serial ports / gdb-servers it was holding**. Any new provision cancels the timer.
- **Decoupled lifetime.** Closing the VS Code window drops *its* ref only; the Agent survives if a CLI session still holds one.

Singleton + discoverable + idle-timeout is exactly the fix for *"UARTs held open forever by an unknown proxy"*: there is one well-known Agent per instance, you can always see it (`--status`) and stop it (`--shutdown`), and when nobody needs it, it lets the ports go. Because it is reused, the launch cost (binary start, gdb-server spawn) is paid **once per host**, not per session (one Agent funnels many sessions in parallel), so there is no per-session startup penalty and no reason to spawn per session.

### 7.3 Fault isolation — the cost of the singleton

One process serving many sessions means **a crash can take down every session at once**. The mitigating fact: Rust's default `panic = "unwind"` makes a panic **thread-scoped** — a panicking per-port reader thread dies alone and the process survives. So containment is not "all or nothing"; it is *engineerable*, provided we don't accidentally convert a thread panic into a process death. The goal: **a fault is contained to the session it happened in.**

**Blast-radius, and what keeps each fault contained:**

| Fault                                       | Default outcome                    | Contained to one session? | Mechanism                                            |
| ------------------------------------------- | ---------------------------------- | ------------------------- | --------------------------------------------------- |
| Panic in a session thread (unwind)          | that thread dies; hook logs it     | Yes — **if supervised**   | R2 supervised spawn + R3 cancel fan-out             |
| Panic while holding a **shared** `Mutex`    | *other* sessions get `PoisonError` | Only with R4              | R4 non-poisoning / brief panic-free critical section |
| Panic inside a `Drop` during unwinding      | **process abort** (double-panic)   | No                        | R5 panic-free teardown Drops                        |
| Unbounded queue growth (slow/stuck peer)    | **OOM → abort**                    | No                        | R6 bounded channels + backpressure                  |
| Stack overflow / SIGSEGV / OOM              | **process death**                  | No — irreducible          | R8 out-of-process gdb-servers; pure safe-Rust funnel |

**Requirements:**

- **R1 — Keep `panic = "unwind"`.** Never set `panic = "abort"` in the Agent's release profile; it would make every thread panic fatal to all sessions. (Currently unset = unwind ✓.)
- **R2 — Session supervision unit.** Centralize thread creation so no raw `thread::spawn` escapes the pattern. Each session thread runs its body under `catch_unwind(AssertUnwindSafe(..))`; on panic *or* error it cancels its own session and exits. A per-session supervisor joins the workers (with timeout), kills the gdb-server `Child`, removes the registry entry, and sends **one** error frame to **that** client.

  ```rust
  fn spawn_session_thread<F>(session: Arc<Session>, name: &str, body: F) -> JoinHandle<()>
  where F: FnOnce(&Session) -> anyhow::Result<()> + Send + 'static {
      let s = session.clone();
      thread::Builder::new().name(format!("sess{}-{name}", s.id)).spawn(move || {
          match std::panic::catch_unwind(AssertUnwindSafe(|| body(&s))) {
              Ok(Ok(()))  => {}
              Ok(Err(e))  => s.fail(format!("error: {e:#}")),
              Err(_)      => s.fail("panic (see log)".into()), // hook already logged details
          }
          s.cancel(); // set AtomicBool + shutdown(Both) on every socket registered to this session
      }).unwrap()
  }
  ```

- **R3 — Interruptibility.** A cancel must actually stop siblings blocked in `read()`. `Session::cancel()` sets a flag *and* fans out `shutdown(Both)` to all sockets registered with the session (the pattern already used in `bridge.rs` / `gdb_server.rs`), which unblocks their reads so they observe the flag and exit. No un-cancelable blocking read: either register the socket for shutdown, or use `set_read_timeout` and poll the flag.
- **R4 — No cross-session poisoning.** A `std::sync::Mutex` shared across sessions, if held during a panic, poisons *other* sessions. Use `parking_lot` (no poison concept) for any lock shared across sessions; keep `std::sync` only for per-session or short-lived locks whose critical sections contain no panic-capable code. Where std is retained and shared, recover: `.lock().unwrap_or_else(|e| e.into_inner())` when safe.
- **R5 — Panic-free teardown Drops.** A panic inside a `Drop` *while already unwinding a panic* aborts the whole process — the one common way a thread panic becomes fatal. Audit the Drop impls on the session-teardown path (socket/child cleanup) to never panic (`.ok()` / log, don't `unwrap`).
- **R6 — Bounded queues.** An unbounded `mpsc` behind a stuck writer grows until OOM, which aborts — killing all sessions. Per-session data queues must be bounded with backpressure.
- **R7 — Join on teardown.** The supervisor must join a session's threads so they don't leak; leaked threads accumulate stacks and eventually exhaust thread creation.
- **R8 — Shrink the uncatchable surface.** `catch_unwind` cannot catch SIGSEGV, stack overflow, or OOM — those drop every session. This is the irreducible singleton cost, already structurally mitigated: gdb-servers run **out-of-process**, and the funnel is pure safe-Rust TCP. Keep it that way — audit `unsafe` and native-linking crates (libusb, serial drivers) in the funnel path, since those are the only realistic SEGV sources.

**Worked example — the serial subsystem (implemented).** An audit of the 16 `Mutex` sites found the isolation model already sound (session = one client connection + its `ProxyServer`; the only cross-session state is the serial subsystem — the `serial_registry`, the availability hub, and each `Arc<PortHandle>` for a shared physical port). No architectural change was needed, only two hardening passes:

- **R4 applied uniformly.** Only `FrameWriter` recovered from poison; every other lock used `.lock().unwrap()`. Added `MutexExt::lock_recover()` ([common/sync.rs](../packages/mdbg/src/common/sync.rs)) and routed all shared locks through it, so a poisoned lock recovers instead of cascading panics across sessions. A `clippy.toml` `disallowed-methods` entry turns a raw `Mutex::lock()` back into a lint error, preventing regression.
- **R3 + R6 applied to the one hot spot.** The per-port reader thread previously held the cross-session `clients` lock across a **blocking** `write_all` to every client — the single place violating "no blocking IO under a shared lock." Reworked to a **bounded per-client queue + dedicated drain thread** ([serial/port.rs](../packages/mdbg/src/serial/port.rs), `ClientSink`): the reader only `try_send`s under the lock (brief, non-blocking), each client's own drain thread does the blocking socket write off-lock, and a client that falls `CLIENT_QUEUE_DEPTH` behind is disconnected rather than growing memory. One slow session can no longer stall — or OOM — the others sharing a port.

**Threads vs async (recorded decision).** The Agent stays **thread-per-port (sync IO)**, not tokio. The funnel handles dozens of connections, not the tens-of-thousands the async/C10k argument targets; its IO sources (serial ports, gdb-server child stdout) are blocking and would need `spawn_blocking` (i.e. threads) under tokio anyway; and async's one real advantage here — structured cancellation — is already covered by R2/R3. Linear stack traces and simple debugging matter more for a debug tool than raw connection scaling. **Revisit only** if simultaneous-connection counts ever reach the thousands (they won't, for physical probes).

---

## 8. Credential model

### Master key vs session tokens

- The Agent generates a **master key** (256-bit) at first start, stored `0600` at `~/.mcu-debug/proxy/<instance>/master.key` (or OS keychain). It never leaves the Probe Host.
- The **Broker is a co-located, privileged local client** of the Agent (same user, same host UI side). It authenticates to the Agent's control channel using the master key it can read on the shared host filesystem, and asks the Agent to **mint** a session token.
- A **session token** is a signed capability (MAC/JWT-style) with claims:

  ```
  { sid, sub: <authority>, iat, exp, jti }
  ```

  Signed with the master key; validated by the Agent on connect. TTL short (default 10 min). Revocable by `jti`/`sid`. Note: **no probe/hardware scope** — provisioning is probe-agnostic (§1); the token authorizes *opening a session*, and what that session drives comes from the launch config the Client sends afterward.

- **Admission vs session:** the token gates *opening* a funnel session. Once the funnel is established, the live connection persists even past `exp` — the token is an admission ticket, not a keepalive. Revocation tears down active sessions by `sid`.
- **Revocation triggers:** window close, user "disconnect", or explicit `mdbg proxy --revoke <sid>`.

Because every provision mints a **fresh, TTL'd** token, there is no long-lived shared secret to distribute or hide. This is what dissolves the "how do we hide the secret under reuse?" problem: reuse of the *Agent* is fully decoupled from reuse of any *secret* — there is none to reuse.

---

## 9. SSH / LAB (rung 2)

Topology (corrected): **local = wherever the workspace is** (possibly itself WSL/Docker/VM, with or without VS Code); **remote = wherever the USB/DUT is**. The Probe Agent runs on the **remote** Probe Host.

The open direction is **local → remote via SSH itself**, so:

- **Transport:** `ssh -L 127.0.0.1:<localPort>:127.0.0.1:<agentPort> user@probehost`. Client dials `127.0.0.1:<localPort>`.
- **Handshake is nearly free:** SSH is an authenticated bidirectional pipe, so the Agent prints its discovery JSON to **stdout** and the Client reads it directly — no rendezvous file, no URI. This is the cleanest control plane of the three. (Deploy/version/`--port 0` flow: see [Remote-Proxy.md](./Remote-Proxy.md).)
- **Credential:** SSH auth *is* the primary gate. A session token is optional defense-in-depth (protects the forwarded loopback port from other users on a shared local box) and rides the same SSH pipe.

SSH is therefore the fallback whenever there is no Broker on the host side — which matches the intuition that the SSH mechanism already exists and generalizes.

---

## 10. Open design fork: does the CLI outlive the VS Code window?

This is the one decision that changes the credential machinery. It is **not yet decided**.

|                            | **A. Broker-mediated (default)**               | **B. Refresh token**                                                                                                                                                   |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How CLI gets fresh tokens  | Round-trips `provision` each time              | First provision drops a long-lived, authority-bound, revocable **refresh token** (guest side); CLI presents it **directly** to the Agent to mint access tokens         |
| Needs live VS Code window? | Yes, at provision time (promptless after TOFU) | No — works after the window closes, as long as the Agent is still alive per §7                                                                                         |
| Complexity                 | Minimal                                        | Adds refresh-token issuance, storage, rotation, revocation                                                                                                             |
| Thing to protect           | Nothing persistent                             | The refresh token becomes the sensitive at-rest secret                                                                                                                 |

**Recommendation:** ship **A** (simplest, most secure; the URI round-trip is imperceptible once TOFU is granted), and add **B** only when a genuine *CLI-without-VS-Code-window* workflow is required. Given the CLI-first framing, B may well become necessary — design the token claims in §8 so a refresh grant slots in later without a format break.

---

## 11. CLI provisioning state machine

| State              | Action                                                                                          | Transitions                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Discover**       | Locate `endpoint.json` (via shared FS if guest); acquire-lock test + ping control channel       | live + credential valid → **Connect**; else → **SelectRung**                  |
| **SelectRung**     | Detect environment (VS Code shim? SSH config? shared FS?)                                        | → **Broker** / **Ssh** / **SharedFs** / **Manual**                            |
| **Broker**         | Pre-create rendezvous dir; write `<handle>.req` (O_EXCL); `code --open-url …/provision`          | → **WaitReply**                                                              |
| **WaitReply**      | Poll for `<handle>.res` (timeout ~15 s); require `phase==reply` + matching nonce                 | `ready` → **Connect**; `denied`/`error` → **Fail(msg)**; timeout → **Manual** |
| **Ssh**            | Deploy/verify Agent; `ssh … mdbg proxy --port 0`; parse stdout; open `-L`                        | parsed → **Connect**; fail → **Fail**                                         |
| **SharedFs**       | Read host `endpoint.json` via `/mnt/c/…`                                                         | found + fresh → **Connect**; else → **Manual**                                |
| **Manual**         | Print paste-ready `mdbg connect --host … --port … --token …` (Agent also prints this on start)   | user pastes → **Connect**                                                     |
| **Connect**        | Dial `host:port` (host from §2), present token, add lifetime ref                                 | ok → **Ready**; auth fail → **SelectRung** (token may be stale)               |
| **Ready**          | Funnel established                                                                               | —                                                                             |

---

## 12. Security checklist

- [ ] URL carries only `v` + `rendezvous`; nonce/authority/label live in `.req`; credential only in `.res` / SSH stdout.
- [ ] `.req` created with O_CREAT|O_EXCL under a random, unguessable handle (squat-resistant).
- [ ] Broker validates `rendezvous` against a path allowlist; requires an existing `.req`; rejects `..` and out-of-root paths; writes `.res` atomically (temp + rename).
- [ ] Client accepts `.res` only when `phase==reply` and the echoed nonce matches.
- [ ] Security rests on the *directory choice* per environment (§5.4), not on cross-boundary mode bits.
- [ ] Master key `0600`, never leaves the Probe Host, never sent to a Client.
- [ ] Session tokens: short TTL, `jti`-revocable; admission-only (don't extend a live session's auth); no probe scope (probe-agnostic).
- [ ] Discovery source of truth is `endpoint.json` + lock + control channel, not VS Code global state (cache only).
- [ ] TOFU gates *hardware access per authority*, not Agent startup; "always allow" persists per host/distro only.
- [ ] Idle-timeout releases serial ports / gdb-servers; window close revokes that window's sessions and drops its ref.
- [ ] Fault isolation (§7.3): `panic = "unwind"` retained; every session thread spawned via the supervised helper (catch_unwind + cancel fan-out), no raw `thread::spawn` in session paths; per-session queues bounded; teardown Drops panic-free; cross-session locks non-poisoning.
- [ ] mDNS/Bonjour deliberately **not** used — unreliable/leaky in shared labs (see [Remote-Proxy.md](./Remote-Proxy.md) §5).

---

## 13. Open questions

1. **Fork §10** — commit to A now, or build B's refresh-token path up front?
2. **Docker rendezvous** — mandate the dev-container feature's dedicated bind mount, or accept rung-2/4 fallback for containers without it?
3. **`authority` trust** — the Broker can't cryptographically verify the caller's remote authority from a `.req` it merely reads. Is TOFU-on-a-claimed-string acceptable, or should the Broker cross-check against `vscode.workspace.workspaceFolders` / open remote windows before prompting?
4. **Token TTL vs UX** — is a 10-min admission window enough for a slow first connect (gdb-server startup, SSH deploy)?
5. **Control-channel primitive** — standardize on AF_UNIX (real socket file) everywhere and take the non-`std` Windows dependency, or use `\\.\pipe\` on Windows + UDS on Unix, or loopback-TCP+token as the portable common denominator?
