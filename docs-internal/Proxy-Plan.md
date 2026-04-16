# Remote Probe Proxy — Architecture Plan

## Terminology Note

"Local" and "remote" are genuinely ambiguous here — VS Code uses them one way, engineers use them another way. This document uses the following **fixed terms** throughout to avoid confusion:

| Term                   | Meaning                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Engineer Machine**   | The physical machine the engineer sits at. Runs VS Code UI. Has source code.                                                                                                                                                         |
| **Probe Host**         | The machine the USB debug probe and target hardware are physically attached to. Runs the Probe Agent and gdb-server. May be the same as Engineer Machine (local case) or a completely different machine across a network (LAB case). |
| **Probe Agent**        | `mcu-debug-helper proxy` — the Rust binary that manages gdb-server lifecycle and implements the Funnel Protocol. Always runs on the **Probe Host**.                                                                                  |
| **Debug Adapter (DA)** | The TypeScript core of `mcu-debug`. Communicates with GDB and with the Probe Agent. Runs on the Engineer Machine (or VS Code's workspace extension host, which may be WSL/container on the Engineer Machine).                        |

---

## Problem

This document covers two distinct scenarios where the DA cannot directly spawn the gdb-server because the probe and hardware are not accessible to the process doing the debugging.

---

## Topology A — VS Code Remote (WSL / Dev Container / SSH)

The engineer's source code and toolchain live inside WSL, a Dev Container, or on a remote machine via VS Code Remote SSH. The **probe is physically on the Engineer Machine**. VS Code's workspace extension host (where the DA runs) cannot reach the USB probe directly.

```
┌──────── Engineer Machine ───────────────────────────────────────┐
│  VS Code UI process                                             │
│  mcu-debug UI extension  ──► spawns/manages Probe Agent         │
│  Probe Agent (mcu-debug-helper proxy)  ◄─────────────────────-─┐│
│  GDB Server (OpenOCD, J-Link, etc.)  ◄── USB ──► Probe/Target  ││
│                                                                ││
│  ┌── WSL / Dev Container / VS Code Remote SSH ───────────────┐ ││
│  │  VS Code Workspace Extension Host                         │ ││
│  │  mcu-debug DA (Debug Adapter)  ───────────────────────────┘ │
│  │  GDB                                                        │
│  │  Source code, ELF files                                     │
│  └─────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
```

The DA reaches the Probe Agent via `127.0.0.1` (for WSL Mirrored / local), `host.docker.internal` (Docker), or equivalent. No significant network boundary — both sides are on the same physical machine. This is the `type: "auto"` case.

---

## Topology B — LAB (Probe on a Remote Physical Machine)

The probe and target hardware are on a **physically separate machine** — a lab server, a machine on another continent, a shared test rig. The engineer's entire VS Code setup (UI, DA, GDB, source) is on their own machine. There is no VS Code remoting involved.

```
┌──────── Engineer Machine (VS Code, GDB, source code) ───────────┐
│  VS Code (no remote — UI and Workspace on the same machine)     │
│  mcu-debug UI extension  → manages SSH, tunnel, deployment      │
│  mcu-debug DA (Debug Adapter)                                   │
│  GDB                                                            │
│  Source code, ELF files                                         │
│  Ghost ports on 127.0.0.1 (local ends of SSH -L tunnels)        │
└─────────────────────────────────────────────────────────────────┘
         ▲  outbound SSH only — no inbound firewall rules needed
         │  ssh -L 127.0.0.1:<localPort>:127.0.0.1:<sshProxyPort> user@lab
         ▼
┌──────── Lab Server (probe attached here) ────────────────────────┐
│  Probe Agent (mcu-debug-helper proxy)  — started by extension    │
│  OR manually launched as a persistent daemon                     │
│  GDB Server (OpenOCD, J-Link, etc.)  ← spawned by Probe Agent    │
│  USB Probe ──────────────────────────────────► Target Hardware   │
└──────────────────────────────────────────────────────────────────┘
```

### One-time SSH key setup (Engineer Machine)

Do this once on your machine. Skip if you already have an SSH key pair.

```bash
# Generate a new key pair (works on Linux, macOS, Windows WSL/Git Bash)
ssh-keygen -t ed25519 -C "your-name@your-machine"
# Accept the default location (~/.ssh/id_ed25519) and set a passphrase if desired.

# Display your public key — you will paste this on the Lab Server below
cat ~/.ssh/id_ed25519.pub
```

The **private key** (`~/.ssh/id_ed25519`) stays on your machine and is never shared.  
The **public key** (`~/.ssh/id_ed25519.pub`) is what you install on the Lab Server.

---

### Lab Server one-time setup

```bash
# Install and start sshd (if not already running)
sudo apt-get install -y openssh-server
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd   # NOTE: transient — must re-run after reboot/container restart

# Install your engineer machine's public key
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "<paste output of cat ~/.ssh/id_ed25519.pub from your machine>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Firewall: on a real Linux server, ensure port 22 is open (or whatever port sshd uses).
# On Docker: instead add  "appPort": ["2222:22"]  to devcontainer.json (no firewall needed).
```

### Engineer Machine one-time setup

Add an entry to `~/.ssh/config` so you don't need to specify host/port/user each time:

```
# For Docker testing with port 2222:
Host lab-docker
  HostName 127.0.0.1
  Port 2222
  User vscode
  IdentityFile ~/.ssh/id_ed25519

# For a real lab server:
Host lab-server
  HostName <lab-server-ip-or-hostname>
  Port 22
  User <username>
  IdentityFile ~/.ssh/id_ed25519
```

Verify: `ssh lab-docker` (or `ssh lab-server`) should drop you into a shell with no password prompt.

The DA connects through the SSH tunnel to `127.0.0.1:<localPort>` — it is completely unaware it is talking across a continent. GDB uses `target remote 127.0.0.1:<ghost_port>` — same story. The Funnel Protocol carries all GDB RSP bytes through the single tunnel connection.

This is the `type: "ssh"` case.

**Latency:** GDB's RSP protocol is the same protocol that was used over serial modems in the late 1980s — it was designed for exactly this. Single-step and breakpoints are interactive, sub-second round-trips even on intercontinental links. High-bandwidth streaming (RTT, Live Watch) is naturally throttled or disabled in this scenario — this is the tradeoff for the ability to debug hardware they cannot physically touch.

---

## Probe Agent Responsibilities

`mcu-debug-helper proxy` (the Probe Agent) always runs on the **Probe Host** regardless of scenario:
- Allocates TCP ports on the Probe Host for gdb-server channels
- Spawns and manages the gdb-server process lifecycle
- Implements the Funnel Protocol (multiplexed binary framing over one TCP connection)
- Stages workspace config files (e.g. OpenOCD `.cfg`) sent from the DA into a temp directory

The **DA** connects to the Probe Agent via TCP and speaks the Funnel Protocol. The DA has **no VS Code APIs** — everything it needs is resolved by the UI extension and passed in `ConfigurationArguments`.

---

## The Two-Extension Split

The extension is split into two separate VS Code extensions with fixed `extensionKind`:

| Extension         | `extensionKind` | Runs on              | Responsibilities                                      |
| ----------------- | --------------- | -------------------- | ----------------------------------------------------- |
| `mcu-debug-proxy` | `["ui"]`        | Always local machine | Proxy lifecycle, SSH tunneling, IPC to workspace side |
| `mcu-debug`       | `["workspace"]` | Always remote side   | Debug Adapter, GDB, source/ELF handling               |

Communication between them uses `vscode.commands.executeCommand`, which VS Code's remote protocol proxies transparently across the boundary — no raw sockets or pipes needed at the extension level.

### Cross-boundary IPC flow

```typescript
// UI extension (local) registers when proxy is ready:
// token was generated BEFORE spawning the agent and passed as --token <value>;
// it is not read back from Discovery JSON.
vscode.commands.registerCommand('mcu-debug-proxy.startProxyServer', () => ({
    host: resolvedProxyHost,   // e.g. '127.0.0.1', 'host.docker.internal', etc.
    port: discoveredPort,      // OS-assigned port from Discovery JSON
    token: knownToken,         // Set by launcher; never extracted from agent stdout
}));

// Workspace extension (remote) calls before debug session:
const endpoint = await vscode.commands.executeCommand<ProxyEndpoint>(
    'mcu-debug-proxy.startProxyServer'
);
// Then injects into ConfigurationArguments as pvtProxyHost / pvtProxyPort / pvtProxyToken
// so the DA (which has no VS Code APIs) can connect without knowing about VS Code at all.
```

---

## Token Design

The token is a short-lived shared secret used to verify that the DA connecting to the Probe Agent is the one that is supposed to be there. It is **not** a substitute for transport security — that is the job of the SSH tunnel or network topology. Its purpose is to prevent a rogue process on the same machine from connecting to a Probe Agent that belongs to someone else.

**Design principle: the launcher sets the token, not the agent.**

Whoever starts the Probe Agent decides the token and passes it as `--token <value>`. The agent never invents a token — it only accepts and validates one. This reversal from the earlier design (where the agent generated the token and emitted it in Discovery JSON) has two benefits:

1. The extension already knows the token before the agent starts, so it does not need to parse it back out of stdout. The Discovery JSON simplifies to just `{"status", "port", "pid"}` — no secret leaking through a channel the extension doesn't fully control.
2. In daemon mode, the person starting the daemon decides the token (or omits it), which is the natural place for that decision.

### Token modes

| How agent is started                                | Token source                                                                              | Agent behavior                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Extension-launched (per-session or VS Code session) | Extension generates `crypto.randomBytes(16).toString('hex')`, passes as `--token <value>` | Validates token on every `initialize` from the DA                                                   |
| Manually launched, explicit token                   | User passes `--token mytoken`                                                             | Validates token; ~~writes value to `~/.mcu-debug/agent.token` for the extension to read~~           |
| ~~Manually launched, no flag                        | Agent generates a random token, writes to stdout as part of json output itself            | Validates token; ~~writes generated value to `~/.mcu-debug/agent.token` for the extension to read~~ |
| Manually launched, `--no-token`                     | User explicitly opts out                                                                  | Skips token validation entirely; extension connects without a token                                 |

Issue: Writing to ~/.mcu-debug/agent.token may not work because the home directories may be in different OS instances and may not be a shared directory. For all such instances the launch.json contains a token override.

The **token file** (`~/.mcu-debug/agent.token`) is the handshake mechanism for daemon mode. The extension reads it via direct file read (`auto`) or `ssh cat ~/.mcu-debug/agent.token` (`ssh` type) after the agent is confirmed running. This requires no out-of-band communication and no user configuration in the common case.

### Token as a `hostConfig` override

The `token` field in `hostConfig` follows the same override pattern as `serverpath`, `gdbPath`, etc. — the extension has a sensible automatic behavior (read the token file for daemon mode, generate one for extension-launched mode), and `token` lets the user override that when they have a reason to:

```jsonc
// Most users never set this.
// Useful when the daemon token is fixed by lab policy and
// reading the token file via SSH is not practical.
"hostConfig": {
    "type": "ssh",
    "sshHost": "user@lab-server",
    "token": "mytoken"   // overrides auto-read from ~/.mcu-debug/agent.token
}
```

`token` should **never** go into a committed `launch.json` — it belongs in user settings or a `.env`-style file excluded from source control. Document this clearly in the user-facing docs.

---

## `hostConfig` in `launch.json`

Only two user-facing types. Everything else is an implementation detail.

```jsonc
{
    "hostConfig": {
        // "auto"  — extension detects VS Code remote environment automatically (default)
        // "ssh"   — explicit SSH to a separate probe host (lab machines)
        "type": "auto",

        // Required only for type "ssh"
        "sshHost": "user@lab-server",   // or an alias from ~/.ssh/config

        // Optional, type "ssh" only — daemon mode. Port the Probe Agent is already listening on
        // at the lab server. When set, the extension connects to the pre-running agent rather than
        // launching a new one (daemon mode). When omitted, a new agent is launched per debug session.
        "sshProxyPort": 54321,

        // Optional, type "auto" WSL NAT only. Fixed port for the Probe Agent to bind to on Windows.
        // Windows Firewall blocks OS-assigned ports; set this to a port you have pre-opened.
        // Not needed for WSL Mirrored mode. Ignored for all other auto sub-modes.
        "wslProxyPort": 54320,

        // Optional — per-session mode: path to a pre-installed mcu-debug-helper binary on
        // the remote host. When set, the extension skips binary deployment entirely and
        // uses this path to launch the Probe Agent. Use this when macOS Gatekeeper, Windows
        // SmartScreen, or lab policy prevents running a freshly-copied executable.
        "sshProxyServerPath": "/usr/local/bin/mcu-debug-helper",

        // Optional for both types: workspace files to copy to the probe host
        // before gdb-server launch (e.g. OpenOCD .cfg files). Use relative paths and you can reference
        // to them in gdb-server config/options in a similar way
        "syncFiles": ["*.cfg", "board/*.cfg"],

        // Optional: override the token the extension would otherwise auto-manage.
        // For daemon mode when the token file is not accessible or a fixed
        // lab-policy token is preferred. Do NOT commit this to source control.
        "token": "mytoken"
    }
}
```

`"local"` is a third type used **internally for testing** (DA and Proxy on the same machine). It is not listed in the `package.json` schema and not documented for users.

---

## `"auto"` Type: How the Probe Agent Host Is Resolved

In the `auto` case the Probe Agent runs on the **Engineer Machine** (spawned by the UI extension). The DA runs inside a VS Code remote environment on the same physical machine. The UI extension reads `vscode.env.remoteName` to figure out how the DA's network namespace sees the Engineer Machine, and computes `pvtProxyHost`:

| `vscode.env.remoteName`    | VS Code scenario            | Probe Agent host seen by DA              |
| -------------------------- | --------------------------- | ---------------------------------------- |
| `undefined`                | Plain local VS Code         | `127.0.0.1`                              |
| `"wsl"` + mirrored network | WSL2 (Win11, mirrored mode) | `127.0.0.1`                              |
| `"wsl"` + NAT network      | WSL2 (default NAT)          | Gateway IP from `/etc/resolv.conf`       |
| `"dev-container"`          | Docker Dev Container        | `host.docker.internal`                   |
| `"ssh-remote"`             | VS Code Remote SSH          | `127.0.0.1` (probe is on VS Code client) |

The user never sees or sets this. The extension computes it and injects it as `pvtProxyHost` into `ConfigurationArguments` before the DA starts.

**WSL NAT note:** The Probe Agent on Windows must listen on `0.0.0.0` (not `127.0.0.1`) so the WSL guest can reach it via the gateway IP. Windows Firewall blocks inbound connections on OS-assigned ports by default. There are two ways to deal with this:

**Option A — Switch to WSL Mirrored mode (recommended, Windows 11 only)**

WSL Mirrored networking makes the WSL guest share the Windows loopback, so the Probe Agent can bind to `127.0.0.1` and no firewall rule is needed. Enable it by adding the following to `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then restart WSL (`wsl --shutdown`). VS Code will automatically detect mirrored mode and use `127.0.0.1` as the Probe Agent host. No `wslProxyPort` needed.

**Option B — Fixed port with a firewall rule (WSL NAT, Windows 10 / older Windows 11)**

Set `hostConfig.wslProxyPort` to a fixed port (or the start of a range you intend to reserve) and open it in Windows Firewall once. The extension will pass `--port <N>` and `--host 0.0.0.0` to the Probe Agent so it binds to the exact port the firewall rule covers.

Recommended: reserve a small block (e.g. 54320–54329) so you have room for multiple simultaneous VS Code sessions without needing additional firewall changes. Only one port per VS Code session is needed — the Proxy Agent handles any number of concurrent DA connections (including multi-core debug) on a single port.

One-time firewall setup (run elevated in PowerShell on the Windows host):

```powershell
# Open a block of 10 ports for the Probe Agent
New-NetFirewallRule -Name "MCU Debug Proxy" -DisplayName "MCU Debug Proxy" `
    -Direction Inbound -Protocol TCP -LocalPort 54320-54329 -Action Allow
```

Corresponding `launch.json`:

```jsonc
"hostConfig": {
    "type": "auto",
    "wslProxyPort": 54320   // fixed port within the range you opened
}
```

The UI extension detects WSL NAT mode and will warn at session start if `wslProxyPort` is not set, reminding the user to either set a fixed port or switch to Mirrored mode.

---

## `"ssh"` Type: LAB — Probe Agent on a Remote Physical Machine

This is the LAB scenario (Topology B above). The Probe Agent runs on the **Lab Server** (the Probe Host), not on the Engineer Machine. VS Code has no remoting active — both the UI extension and the DA run on the Engineer Machine. The UI extension uses SSH to deploy, start, and tunnel to the Probe Agent on the lab server.

### Per-session flow (per-session mode)

1. **Version check:** `ssh user@lab "mcu-debug-helper --version"` — is binary present and current?
2. **Deploy if needed:** Stream binary over SSH stdin: `ssh user@lab "mkdir -p ~/.mcu-debug/bin && cat > ~/.mcu-debug/bin/mcu-debug-helper && chmod +x ..."` — arch detected via `uname -sm` first. **Skipped entirely** when `sshProxyServerPath` is set in `hostConfig` (binary already installed and permissions already granted by the user).
3. **Generate token:** Extension generates `token = crypto.randomBytes(16).toString('hex')`
4. **Launch Probe Agent on lab server:** `ssh user@lab "~/.mcu-debug/bin/mcu-debug-helper proxy --port 0 --token <token>"` — token is an input, not an output
5. **Parse Discovery JSON:** `{ "status": "ready", "port": 54321, "pid": 9876 }` — no token in output; extension already has it
6. **Open SSH tunnel from Engineer Machine to lab server:** `ssh -L 127.0.0.1:<localPort>:127.0.0.1:54321 -N user@lab` with keepalives (`ServerAliveInterval=15 ServerAliveCountMax=3`)
7. **Inject into args:** `pvtProxyHost = "127.0.0.1"`, `pvtProxyPort = localPort`, `pvtProxyToken = token`
8. **Stage files:** Send `syncFiles` contents to Probe Agent via Funnel `stageFiles` RPC — Agent writes them to a temp dir on the lab server and returns the path; DA rewrites gdb-server args accordingly
9. **Debug session runs** — GDB talks to `127.0.0.1:<ghost_port>` on Engineer Machine; tunnel carries bytes to gdb-server on Lab Server
10. **Cleanup:** Tear down SSH tunnel; Probe Agent exits (kills gdb-server if still running); staging dir cleaned up

**Daemon alternative:** If the Probe Agent is already running on the lab server (manually or via a system service), skip steps 1–6. The UI extension reads `~/.mcu-debug/agent.token` from the lab server via `ssh cat` to get the token (or uses the `hostConfig.token` override if set), then connects directly to the known port. This is the preferred model for shared lab infrastructure.

### Starting the Probe Agent manually (daemon mode)

The Probe Agent binary (`mcu-debug-helper`) is not distributed separately — it ships inside the VS Code extension installation and can be found at:

```
~/.vscode/extensions/mcu-debug.mcu-debug-<version>/bin/mcu-debug-helper
```

Pick the appropriate subdirectory for the Lab Server's architecture (e.g. `linux-x64/`, `linux-arm64/`). Copy or symlink it to a convenient location such as `~/.mcu-debug/bin/mcu-debug-helper` — the extension does this automatically in per-session mode.

**Minimal launch (auto-assigned port):**

```bash
mcu-debug-helper proxy --token my-secret-token
```

Prints a single line to stdout and then runs silently:

```json
{"status": "ready", "port": 54321, "pid": 9876, "token": "my-secret-token"}
```

Note the `port` value — you'll need it in `hostConfig.sshProxyPort` in `launch.json`.

**Fixed port (easier for persistent lab machines):**

```bash
mcu-debug-helper proxy --port 54321 --token my-secret-token
```

**With logging (recommended for daemon mode):**

```bash
mcu-debug-helper proxy --port 54321 --token my-secret-token --log-dir ~/.mcu-debug/logs
```

Log files are always written when `--log-dir` is set. Add `--log-stderr` to also echo log lines to stderr (useful when running under a system service that captures stderr).

**Listen on all interfaces** (required for non-SSH access; not needed when the extension always uses an SSH tunnel):

```bash
mcu-debug-helper proxy --host 0.0.0.0 --port 54321 --token my-secret-token
```

**Run as a background daemon** (simple backgrounding; use a system service for production):

```bash
nohup mcu-debug-helper proxy --port 54321 --token my-secret-token \
    --log-dir ~/.mcu-debug/logs >> ~/.mcu-debug/logs/proxy.out 2>&1 &
echo $! > ~/.mcu-debug/proxy.pid
```

**Corresponding `launch.json` `hostConfig`:**

```jsonc
// Per-session mode (extension deploys and launches the binary automatically)
"hostConfig": {
    "type": "ssh",
    "sshHost": "lab-server",      // matches your ~/.ssh/config Host alias
}

// Per-session mode with pre-installed binary (skip deployment, avoids Gatekeeper/SmartScreen)
"hostConfig": {
    "type": "ssh",
    "sshHost": "lab-server",
    "sshProxyServerPath": "/usr/local/bin/mcu-debug-helper"  // binary already installed on the remote
}

// Daemon mode (proxy server started manually or as a service)
"hostConfig": {
    "type": "ssh",
    "sshHost": "lab-server",      // matches your ~/.ssh/config Host alias
    "sshProxyPort": 54321,        // port the daemon is listening on
    "token": "my-secret-token"    // must match --token passed at launch
}
```

> **Security note:** Do not put `token` in a committed `launch.json`. Use a VS Code user setting or a `.env`-style file excluded from source control, then reference it via a variable substitution or leave it out and rely on the automatic token-file mechanism.

### Why `ssh -L` needs no firewall changes

The `-L` tunnel is established by the `ssh` client running on the **Engineer Machine** (outbound connection to the lab server's port 22, which must already be open). The tunnel endpoints are both `127.0.0.1` (loopback) — no new inbound ports on either machine. The lab server only needs `sshd` running, which is standard on any Linux machine.

---

## Probe Agent Lifecycle

| Scenario                  | Agent runs on    | Agent lifetime  | Who starts it                 | Notes                                                                             |
| ------------------------- | ---------------- | --------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `auto` — local/WSL/Docker | Engineer Machine | VS Code session | UI extension `activate()`     | One agent serves all debug sessions in the VS Code session; USB context is stable |
| `ssh` — per-session       | Lab Server       | Debug session   | UI extension at session start | Agent spawned via SSH; killed when tunnel tears down                              |
| `ssh` — daemon            | Lab Server       | Persistent      | User / system service         | Pre-started agent; UI extension connects to known port; preferred for shared labs |

### Probe Agent startup & discovery

The Probe Agent always prints a single-line Discovery JSON to stdout immediately on startup:

```json
{ "status": "ready", "port": 54321, "pid": 9876 }
```

No token in the output — the launcher already knows the token because it supplied it as `--token`. The UI extension reads this from the child process stdout (or the SSH session stdout for `ssh` type) and stores `{port}` in memory. The token was already known before the agent started.

For daemon mode (agent started without `--token` or with `--token <value>`), the agent writes the token to `~/.mcu-debug/agent.token` on the Probe Host. The extension retrieves it via direct file read (`auto`) or `ssh cat ~/.mcu-debug/agent.token` (`ssh` type) before the first connection.

All subsequent debug sessions in the same VS Code session reuse the same endpoint (for `auto`).

### Watchdog / crash recovery

The proxy is crash-safe by **design** (no persistent mutable state that can't be reconstructed). The UI extension is the watchdog:

```typescript
proxyProcess.on('exit', (code, signal) => {
    if (this.shouldBeRunning) {
        this.restartProxy();   // re-spawns, re-reads Discovery JSON, re-registers command
        vscode.window.showWarningMessage('Probe Agent restarted. Active debug sessions may need to be restarted.');
    }
});
```

If an in-Rust watchdog is desired for the daemon case (no UI extension present), a supervisor loop using Tokio:

```rust
loop {
    let result = tokio::spawn(run_proxy_main()).await;
    match result {
        Ok(Ok(())) => break,          // intentional clean exit
        Ok(Err(e)) => eprintln!("Proxy error: {e}"),
        Err(e)     => eprintln!("Proxy panic: {e}"),
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
}
```

---

## `ConfigurationArguments` Private Fields

The DA receives all connection info as private fields injected by the UI extension via the frontend (which has VS Code APIs). These are never set by the user:

| Field           | Set by   | Meaning                                                                                                                       |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pvtProxyHost`  | Frontend | Resolved host string for DA to connect to                                                                                     |
| `pvtProxyPort`  | Frontend | Proxy port (from Discovery JSON for extension-launched; configured port for daemon) or being used as ssh local port           |
| `pvtProxyToken` | Frontend | Token — generated by extension (extension-launched), read from token file (daemon), or taken from `hostConfig.token` override |

---

## Funnel Protocol (Brief)

Single TCP connection between DA and Proxy. Binary framing:

| Field          | Size    | Description                                                                   |
| -------------- | ------- | ----------------------------------------------------------------------------- |
| Stream ID      | 1 byte  | `0` = Control (JSON-RPC), `1` = stdout, `2` = stderr, `3` = GDB, `4` = RTT, … |
| Payload Length | 4 bytes | UInt32 little-endian                                                          |
| Payload        | N bytes | JSON string (control) or raw bytes (data streams)                             |

Control channel (Stream ID 0) uses JSON-RPC 2.0 for: `initialize`, `allocatePorts`, `stageFiles`, `launchServer`, `endSession`, `heartbeat`, `streamStatus`. Stream IDs 1/2 are for stdout/stderr of the gdb-server that will be launched. TBD: Steam 1 will be the `stdin` for the gdb-server.

Data channels (Stream IDs 3+) carry raw bytes with zero interpretation — the DA and gdb-server speak their own protocols through the tube. The actually stream-ids are dictated by the client and the order in which they appear. Only Control 0, 1 and 2 are special. All streams are bindirectional even if there is no interest in data from a certain direction

See `ARCHITECTURE.md` for full packet format details and fragmentation handling.

---

## Implementation Phases

### Phase 1 — Funnel Protocol in Rust (local only)
- `mcu-debug-helper proxy` subcommand with the 5-byte frame parser
- JSON-RPC control channel: `initialize`, `allocatePorts`, `launchServer`, `endSession`, `heartbeat`
- Binary stream forwarding for GDB channel
- Test: DA ↔ Proxy on `127.0.0.1`, `type: "local"`, no SSH

### Phase 2 — `auto` type: UI extension integration
- UI extension spawns proxy on activation, reads Discovery JSON
- Registers `mcu-debug-proxy.startProxyServer` command
- Workspace extension injects `pvtProxy*` fields before debug session
- Host resolution from `vscode.env.remoteName`
- Test: Local, WSL Mirrored, Dev Container

### Phase 3 — `ssh` type: tunnel + deploy
- Version check, SCP deploy, SSH-launch-parse-tunnel sequence
- SSH keepalive configuration
- `stageFiles` RPC: send `syncFiles` contents, receive staging dir path
- Path rewriting in `rewriteArgs()` at the central launch point
- Test: macOS → Linux, Windows → WSL NAT

### Phase 4 — Polish
- Auto-update (version mismatch → redeploy)
- Clear user-facing error messages at each state machine transition
- Graceful session teardown (kill gdb-server, close tunnel, clean staging dir)
- WSL NAT firewall helper
- Proxy self-restart (daemon mode)
