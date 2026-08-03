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
| **Rendezvous**    | A pair of files (`<handle>.req` / `<handle>.res`) on a filesystem visible to both Client and Broker, used to exchange the request and the result.                              |
| **Master key**    | Long-lived secret held **only** inside the Probe Agent. Never leaves the Probe Host.                                                                                           |
| **Session token** | Short-lived, revocable capability minted from the master key. This is the only credential a Client ever sees.                                                                  |
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

**Best-effort auto, guaranteed manual.** Rungs 0–3 are "auto" — best-effort, and any of them may legitimately not apply (no `code`, headless, no shared FS, …). They are not obligated to cover 100% of environments; they cover the common ones and **degrade cleanly to manual (rung 4)**. Manual already exists: the user starts the daemon themselves and supplies `{host, port, token}` via `hostConfig` in `launch.json`. So "auto" failing is not a dead end — it's a fall-through to a path that always works.

**Rung 1 (WSL) needs no Windows username** — it uses the *WSL-side* filesystem addressed by UNC (`\\wsl.localhost\<distro>\run\user\<uid>\…`), derivable from `$WSL_DISTRO_NAME` + `id -u` alone (§5.2).

**Rung 3 is the only place the Windows username matters**, because it writes into the *Windows* per-user temp. There is no native env var for it in WSL (the WSL user ≠ the Windows user). Rather than reconstruct the name, ask Windows for the whole path and convert it:

```bash
wslpath -u "$(cmd.exe /D /C 'echo %TEMP%' 2>/dev/null | tr -d '\r')"
# or, if the wslu package is present:  wslpath -u "$(wslvar TEMP)"
```

Requires Windows interop enabled; run from `~` (not a `/mnt/...` cwd) to avoid the "UNC not supported" warning. Rung 3 works with **no VS Code at all** — the user just ran `mdbg proxy` on Windows, and the Client reads its `endpoint.json` (§7) from that temp dir. So the Broker is an *enhancement* (it auto-*launches* the Agent and gates access), not a discovery dependency.

---

## 4. The `provision` URI (rung 1) — via the VS Code extension bridge

A shared host↔guest filesystem exists **only for WSL** (`\\wsl.localhost`). **Dev Containers and Remote-SSH have none**, so a rendezvous *file on the host* can't be the general rung-1 return path. But every VS Code remote already runs a **bidirectional bridge between the UI extension host and the workspace (WS) extension host** (the remote protocol). We use *that* as the return path — so the only file involved is **guest-local**, and the mechanism works uniformly across WSL, Dev Containers, and Remote-SSH.

### Three hops

```
guest CLI ──[1] code --open-url──▶ Broker = UI extension (host)
Broker ─────[2] executeCommand───▶ WS extension (guest)
WS extension ─[3] writes guest-local file──▶ guest CLI polls it
```

1. **Guest → UI host.** The injected `code` shim crosses the remote boundary and fires the Broker's `UriHandler`. The Broker is `extensionKind: ["ui"]`, so it runs on the UI side where it can reach USB.
2. **UI host → WS guest.** The Broker runs the host-side work (ensure the Probe Agent §7, mint a session token §8), then hands the result to the **WS extension** via `vscode.commands.executeCommand`. This RPC is always present in a remote window — **no shared FS required**.
3. **WS guest → CLI.** The WS extension (guest-side) writes a **guest-local** results file (§5.1); the CLI polls it. Same filesystem on both ends.

### The URL

```bash
code --open-url "vscode://mcu-debug.mcu-debug-proxy/provision?v=1&nonce=<n>&authority=<a>&api=<name>&args=<...>&resultsFile=<guest-path>"
```

| Param         | Req | Meaning                                                                                     |
| ------------- | --- | ------------------------------------------------------------------------------------------- |
| `v`           | ✓   | Protocol version. Broker rejects unknown majors.                                            |
| `authority`   | ✓   | Guest identity for TOFU (§6), e.g. `dev-container+<hash>`, `ssh-remote+host`.               |
| `api`         | ✓   | Which provisioning op to run — **whitelisted** (see failure modes below).                   |
| `args`        | –   | Optional args for the api.                                                                  |
| `resultsFile` | ✓   | **Guest** absolute path the WS extension writes the result to. URL-encode it. include nonce |

**No secret in the URL** (they land in extension-host + OS URI-dispatch logs). The `nonce`/`authority`/`api` are not secrets; the credential (session token) travels only in the guest-local results file. `--open-url` is fire-and-forget — the results file is the return channel.

Including the nonce in the resultsFile makes an implicit nonce check and nonce is not a secret anyways

### Flow

```
Broker UriHandler(provision):
  1. Parse + version-check; TOFU gate on `authority` (§6).
  2. Run the whitelisted `api`: ensure Probe Agent (§7); mint session token (§8).
  3. executeCommand("mcu-debug.depositProvision", { resultsFile, result | error }).

WS deposit command (guest):
  - write `resultsFile` atomically (temp + rename) with the §5.1 payload.

Client (guest CLI):
  - poll `resultsFile` with a timeout;
    read { port, token }; fill `host` from §2; delete the file.
```

Failures are **written** to the file (`status:"error"`/`"denied"`), never left to time out — the CLI gets a reason, not silence.

### Precondition — is VS Code the right mechanism here?

The bridge needs a running VS Code (remote) to relay through, and calling `code --open-url` with **no** window running can **spawn one** — so don't invoke it blindly. Signals, strongest first:

1. **Launched by the extension** — the definitive, safe case: VS Code is present and bridging, and the extension can hand the CLI the bridge details directly. This is the primary way the bridge is meant to be used.
2. **`code` on `PATH`** — the *necessary* condition for a *standalone* CLI to even attempt it, and roughly "VS Code is installed." But it does **not** mean a window is open, so a standalone `code --open-url` can spawn one. Therefore, for standalone use treat the bridge as a **fallback / opt-in**, not the default: prefer the direct rungs (the WSL `cmd.exe` launcher §3, or SSH §9) where they exist, and use the bridge only where there is **no direct alternative** (notably Docker Dev Containers) or the user explicitly opts in.

Do **not** gate on **`VSCODE_IPC_HOOK_CLI`**. Its purpose is to route `code` at the window owning VS Code's *integrated terminal*, so it is set only when the CLI runs inside that terminal — supported, but not the normal case. If it happens to be set it's a nice positive signal (a reachable window, and the right one), but it must not be a requirement.

If `code` is missing from `PATH` where the bridge is wanted (notably macOS, where it's opt-in), notify the user to run *"Shell Command: Install 'code' command in PATH."*

### Don't pre-detect failure — try, then fall back

There are cases where the bridge *can't* work but are hard to predict: `code` on PATH in a **headless** env (plain SSH/telnet, no `$DISPLAY` → Electron can't launch), no window open, wrong window, wrong remote. Do **not** try to enumerate/pre-detect them (e.g. a `$DISPLAY` check is actively wrong — the **Remote-SSH integrated terminal works even headless**, since the `code` shim relays to the *client's* VS Code, no server-side display). Instead, they all funnel into **one** path: the results file never appears → **timeout → fall back to the next rung / manual**. One robust fallback handles the whole class.

### Activation is declarative, not retried

The one real hazard is either extension not being activated when the bridge reaches it. Solve it with activation events, not retries:

- **Broker (UI):** declare `onUri`. The fully-qualified-id URI *is* the activation trigger — VS Code activates the extension, waits, then delivers to the registered `UriHandler`. So a slow `onStartupFinished` is irrelevant here.
- **WS extension:** declare `onCommand:mcu-debug.depositProvision`. `executeCommand` triggers that activation, waits, then runs the command — so calling it is what activates the WS side. With the command registered synchronously in `activate()`, it is one-shot; retries are only a backstop for a wedged host.

### Why this beats the shared-FS rendezvous (§5)

- **Uniform across WSL, Dev Container, and Remote-SSH** — no host↔guest shared FS (the Docker/SSH blocker is gone).
- The only file is **guest-local**, so the host-path resolution, allowlist, and cross-boundary permission wrinkles of §5.2–5.4 collapse away for this rung.
- Transport is VS Code's own already-authenticated bridge.

### Failure modes to handle

| Class                  | Failure                                                                                                                                                                                             | Handling                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bridge misses**      | `code` not on PATH; `--open-url` fires nothing (VS Code not running, handler not installed, extension not activated); `code` starts a new VS Code or targets the wrong install (stable vs insiders) | detect `command -v code` / `VSCODE_IPC_HOOK_CLI`; **timeout** on the results file → clear "VS Code didn't respond" message; fall back to another rung                                                                                                                       |
| **Wrong window**       | multiple windows → which `UriHandler` fires is ambiguous                                                                                                                                            | benign for a per-user singleton (any window yields the same proxy), **but** the results file is written by *that* window's WS extension — if it's a *different* remote, the guest path isn't its FS. `nonce` validation keeps it correct; a mismatch → keep waiting / retry |
| **Op / deposit fails** | api throws on host; WS extension not activated or has no deposit command → `executeCommand` rejects/hangs                                                                                           | api errors → write `{status:"error"}`; WS registers the command with an activation event; Broker catches the `executeCommand` rejection (and, if it can't reach the WS side, still times out on the CLI)                                                                    |
| **File / nonce**       | partial read (mid-write); stale/replayed file; path with spaces                                                                                                                                     | atomic write (temp+rename); **fresh unique `resultsFile` per request** + reject on `nonce` mismatch + cleanup; URL-encode the path                                                                                                                                          |
| **Security**           | any local process can `code --open-url` and invoke `api`                                                                                                                                            | **whitelist** api-names, validate args, gate with TOFU (§6) — this is a provisioning endpoint, not a general command executor                                                                                                                                               |

---

## 5. Rendezvous files (shared-FS fallback)

> **Superseded for rung 1 by the §4 bridge.** With the VS Code extension bridge, the request travels in the URL and the reply is written **guest-locally** by the WS extension — there is no `.req`, and no host-addressable `.res`. This section is retained for:
> - the **results-file payload** (§5.1 `.res` — the WS extension writes exactly this, guest-locally); and
> - the **shared-FS variants** that still apply where a shared FS genuinely exists: WSL (`\\wsl.localhost` UNC) as a bridge-free option, and rung 3's `endpoint.json` (§3, §7) read over `/mnt/c`.
>
> The host-path resolution (§5.2), Broker allowlist (§5.3), and cross-boundary permissions (§5.4) apply **only** to those shared-FS variants, not to the §4 bridge.

### 5.1 Payloads

**`<handle>.req`** — *(shared-FS variant only)* written by the Client (O_CREAT|O_EXCL) before invoking the URI. Under the §4 bridge the request is the URL instead:

```json
{
  "v": 1,
  "phase": "request",
  "nonce": "<128-bit base64url — the reply must echo this>",
  "authority": "wsl+Ubuntu-22.04",
  "client": "mdbg CLI — Ubuntu-22.04"
}
```

**`<handle>.res` / results file** — written by the Broker on the shared FS (WSL/rung 3), or **guest-locally by the WS extension** under the §4 bridge:

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

| Env               | Directory — guest view (Client) | Same directory — host view (Broker)                          |
| ----------------- | ------------------------------- | ------------------------------------------------------------ |
| **WSL2**          | `/run/user/<uid>/mcu-debug/`    | `\\wsl.localhost\$WSL_DISTRO_NAME\run\user\<uid>\mcu-debug\` |
| **Dev Container** | `<dedicated-mount>/mcu-debug/`  | `<host-side mount root>\mcu-debug\`                          |
| **SSH / LAB**     | — (uses stdout over SSH, §9)    | —                                                            |

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

| Fault                                    | Default outcome                    | Contained to one session? | Mechanism                                            |
| ---------------------------------------- | ---------------------------------- | ------------------------- | ---------------------------------------------------- |
| Panic in a session thread (unwind)       | that thread dies; hook logs it     | Yes — **if supervised**   | R2 supervised spawn + R3 cancel fan-out              |
| Panic while holding a **shared** `Mutex` | *other* sessions get `PoisonError` | Only with R4              | R4 non-poisoning / brief panic-free critical section |
| Panic inside a `Drop` during unwinding   | **process abort** (double-panic)   | No                        | R5 panic-free teardown Drops                         |
| Unbounded queue growth (slow/stuck peer) | **OOM → abort**                    | No                        | R6 bounded channels + backpressure                   |
| Stack overflow / SIGSEGV / OOM           | **process death**                  | No — irreducible          | R8 out-of-process gdb-servers; pure safe-Rust funnel |

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
- **R6 — Bounded queues.** An unbounded `mpsc` behind a stuck writer grows until OOM, which aborts — killing all sessions. Per-session data queues must be bounded with backpressure. *Partially done:* the serial per-client path is bounded (`ClientSink`). The **event channel bound is deferred** — a correct bound requires per-stream classification (RSP and SWD/Serial/RTT must never be dropped or throttled; only gdb-server stdout/stderr may be shed), so it is folded into the throttling design in [Stream-Flow-Control.md](./Stream-Flow-Control.md). Interim risk is pre-existing and accepted (see that doc).
- **R7 — Join on teardown.** The supervisor must join a session's threads so they don't leak; leaked threads accumulate stacks and eventually exhaust thread creation.
- **R8 — Shrink the uncatchable surface.** `catch_unwind` cannot catch SIGSEGV, stack overflow, or OOM — those drop every session. This is the irreducible singleton cost, already structurally mitigated: gdb-servers run **out-of-process**, and the funnel is pure safe-Rust TCP. Keep it that way — audit `unsafe` and native-linking crates (libusb, serial drivers) in the funnel path, since those are the only realistic SEGV sources.

**Worked example — the serial subsystem (implemented).** An audit of the 16 `Mutex` sites found the isolation model already sound (session = one client connection + its `ProxyServer`; the only cross-session state is the serial subsystem — the `serial_registry`, the availability hub, and each `Arc<PortHandle>` for a shared physical port). No architectural change was needed, only two hardening passes:

- **R4 applied uniformly.** Only `FrameWriter` recovered from poison; every other lock used `.lock().unwrap()`. Added `MutexExt::lock_recover()` ([common/sync.rs](../packages/mdbg/src/common/sync.rs)) and routed all shared locks through it, so a poisoned lock recovers instead of cascading panics across sessions. A `clippy.toml` `disallowed-methods` entry turns a raw `Mutex::lock()` back into a lint error, preventing regression.
- **R3 + R6 applied to the one hot spot.** The per-port reader thread previously held the cross-session `clients` lock across a **blocking** `write_all` to every client — the single place violating "no blocking IO under a shared lock." Reworked to a **bounded per-client queue + dedicated drain thread** ([serial/port.rs](../packages/mdbg/src/serial/port.rs), `ClientSink`): the reader only `try_send`s under the lock (brief, non-blocking), each client's own drain thread does the blocking socket write off-lock, and a client that falls `CLIENT_QUEUE_DEPTH` behind is disconnected rather than growing memory. One slow session can no longer stall — or OOM — the others sharing a port. As a bonus, the new queue let us close a long-standing late-attach race: `attach_client` now **seeds the ring snapshot as the first queue item, atomically with going live** (the reader's ring-push + fan-out is one critical section), making catch-up **exactly-once** — no bytes lost between snapshot and attach, none duplicated.
- **R5 audited — already satisfied.** All four `Drop` impls (`ProxyServer`, `PortHandle`, `TcpBridge`, `PollingWatcher`) and every teardown helper they reach are panic-free: `lock_recover` for locks, `let _ = join()` (which returns `Err` rather than re-panicking on a panicked thread), and `.ok()`/`let _ =` on best-effort cleanup. `ClientSink`'s drain `JoinHandle` is *detached* on drop (never joined from the reader), so no teardown blocks or panics. Residual exposure is limited to third-party `Drop`s (`std::process::Child`, `TcpStream`, the `serialport` handle) — the irreducible baseline.
- **R2 (core) applied — no session thread dies silently.** The session's existing event loop is already its supervision spine (every background thread reports to `message_loop` via `event_tx`), but a *panic* skipped the clean-exit `send` — worst case a panicking control reader stranding the loop on `recv()` forever (the loop always holds a sender, so it never sees `Disconnected`), leaking the session and its child. Added `spawn_session_thread` ([mod.rs](../packages/mdbg/src/proxy_helper/proxy_server/mod.rs)): the body runs under `catch_unwind` and **any** exit emits `ProxyEvent::SessionThreadExited { role, panicked }`. The loop ends the session on a fatal role (`ControlReader`) and notes the rest. All six session threads (control reader, gdb stdout/stderr, port monitor, port waiters, serial error forwarder) route through it; Agent-level threads (accept loop, heartbeat, availability watcher) are intentionally out of scope.
- **R3 (cancel fan-out) applied — no lingering session threads.** `ProxyServer::cancel()`, called from `Drop`, does the prompt teardown that killing the child doesn't cover: it `shutdown(Both)`s the control socket (so the reader's blocked `read` on its own clone returns at once) and sets a shared `cancel` flag. The port waiters poll it inside `wait_and_connect_sync` (returning `WaitPortResult::Cancelled` instead of blocking up to 10 min), and the serial error forwarder switches to `recv_timeout` + flag poll (instead of blocking forever on an `err_tx` that outlives the session in the shared `PortHandle`). `cancel()` lives in `Drop`, **not** `end_process`, because the `EndSession` path calls `end_process` and still needs the control socket to send its response.

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

|                            | **A. Broker-mediated (default)**               | **B. Refresh token**                                                                                                                                           |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How CLI gets fresh tokens  | Round-trips `provision` each time              | First provision drops a long-lived, authority-bound, revocable **refresh token** (guest side); CLI presents it **directly** to the Agent to mint access tokens |
| Needs live VS Code window? | Yes, at provision time (promptless after TOFU) | No — works after the window closes, as long as the Agent is still alive per §7                                                                                 |
| Complexity                 | Minimal                                        | Adds refresh-token issuance, storage, rotation, revocation                                                                                                     |
| Thing to protect           | Nothing persistent                             | The refresh token becomes the sensitive at-rest secret                                                                                                         |

**Recommendation:** ship **A** (simplest, most secure; the URI round-trip is imperceptible once TOFU is granted), and add **B** only when a genuine *CLI-without-VS-Code-window* workflow is required. Given the CLI-first framing, B may well become necessary — design the token claims in §8 so a refresh grant slots in later without a format break.

---

## 11. CLI provisioning state machine

| State          | Action                                                                                         | Transitions                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Discover**   | Locate `endpoint.json` (via shared FS if guest); acquire-lock test + ping control channel      | live + credential valid → **Connect**; else → **SelectRung**                  |
| **SelectRung** | Detect environment (VS Code shim? SSH config? shared FS?)                                      | → **Broker** / **Ssh** / **SharedFs** / **Manual**                            |
| **Broker**     | Pre-create rendezvous dir; write `<handle>.req` (O_EXCL); `code --open-url …/provision`        | → **WaitReply**                                                               |
| **WaitReply**  | Poll for `<handle>.res` (timeout ~15 s); require `phase==reply` + matching nonce               | `ready` → **Connect**; `denied`/`error` → **Fail(msg)**; timeout → **Manual** |
| **Ssh**        | Deploy/verify Agent; `ssh … mdbg proxy --port 0`; parse stdout; open `-L`                      | parsed → **Connect**; fail → **Fail**                                         |
| **SharedFs**   | Read host `endpoint.json` via `/mnt/c/…`                                                       | found + fresh → **Connect**; else → **Manual**                                |
| **Manual**     | Print paste-ready `mdbg connect --host … --port … --token …` (Agent also prints this on start) | user pastes → **Connect**                                                     |
| **Connect**    | Dial `host:port` (host from §2), present token, add lifetime ref                               | ok → **Ready**; auth fail → **SelectRung** (token may be stale)               |
| **Ready**      | Funnel established                                                                             | —                                                                             |

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
