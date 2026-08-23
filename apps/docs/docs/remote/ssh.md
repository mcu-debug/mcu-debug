---
sidebar_position: 4
title: SSH / Lab Server
---

# SSH / Lab Server

Debugging when the probe is physically connected to a remote server — for example, a shared lab server with embedded hardware, while you develop on a laptop. This is page is not relevant when using VSCode remote-ssh - it is handled by the "auto" type hostConfig. It applies when ssh is being used without using VSCode services.

:::important
Only the fully automatic setup requires a Unix-based remote host (Linux or macOS), and only
because that is the path where *we* install the binary — `uname` to pick the build, POSIX shell
commands to place it. Install `mdbg` on the host yourself and set `ssh.serverPath`, and the
remote OS stops mattering; **Windows hosts work from there on**.
See [What the remote host has to provide](#what-the-remote-host-has-to-provide).
:::

## Configuration

### Automatic — you give us the host, we do the rest

Only `ssh.host` is specified; everything else is discovered by deploying and running the proxy
executable on the remote. **This path is Linux/macOS only**, because it runs `uname -sm` to pick
the right binary and uses `mkdir`/`cat`/`chmod` to install it.

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug via SSH",
  "servertype": "openocd",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "serverpath": "<path-to-gdb-server-on-remote>",
  "configFiles": ["interface/stlink.cfg", "target/stm32f4x.cfg"],
  "hostConfig": {
    "enabled": true,
    "type": "ssh",
    "ssh": {
      "host": "lab-server"  // Or use IP address
    }
  }
}
```

### You install the binary — we still launch it

Install `mdbg` on the remote host yourself and point `serverPath` at it. We skip OS detection and
deployment — the only Unix-specific part — but still start the agent for each session and read
back the port and token it reports, so there is nothing left for you to manage. **The remote can
be Windows.**

```json
"hostConfig": {
  "enabled": true,
  "type": "ssh",
  "ssh": {
    "host": "lab-server",
    "serverPath": "C:\\Program Files\\mcu-debug\\mdbg.exe"  // or /opt/mcu-debug/mdbg
  }
}
```

See [Getting the `mdbg` binary](#getting-the-mdbg-binary) below for where to find it.

### You start the agent — we only tunnel

Start a Probe Agent on the remote host yourself, then name its port and token. We skip detection,
deployment and launching entirely, and the only thing we ask of the remote is an SSH server that
permits port forwarding. **The remote can be Windows**, and this configuration works with the CLI
tools too.

On the remote host:

```sh
mdbg proxy --port 5689 --token <your-token>
```

In `launch.json`:

```json
"hostConfig": {
  "enabled": true,
  "type": "ssh",
  "ssh": {
    "host": "lab-server",
    "proxyPort": 5689,
    "token": "${env:MDBG_PROXY_TOKEN}"  // Avoid putting the actual token here
  }
}
```

`token` is required whenever `proxyPort` is set — an agent we did not launch has a token we cannot
know. Prefer `${env:MDBG_PROXY_TOKEN}`: the agent reads the same variable, so one export configures
both ends and the secret stays out of source control.

### What the remote host has to provide

| You specify                    | We run on the remote                      | Remote OS              |
| ------------------------------ | ----------------------------------------- | ---------------------- |
| `host`                         | `uname -sm`, deploy the binary, launch it | Linux or macOS         |
| `host` + `serverPath`          | launch the binary you installed           | any, including Windows |
| `host` + `proxyPort` + `token` | nothing — only the SSH `-L` tunnel        | any, including Windows |

Only the first row is Unix-bound, and only because of how we *install* the binary — `uname -sm`
to pick the right build, and `mkdir`/`cat`/`chmod` to place it. Install `mdbg` yourself and point
`serverPath` at it, and that step disappears: all we then run is your binary, by the path you
gave us. Quoting is handled, so a path like `C:\Program Files\mcu-debug\mdbg.exe` is fine.

On Windows, `serverPath` must be a path the remote's own shell understands — a native
`C:\...` path for the default cmd.exe shell. Note that these two rows differ in *when* the agent
runs: `serverPath` starts one per session, while `proxyPort` expects one you are already running.

The `ssh.host` value is an SSH hostname alias from `~/.ssh/config` (or a literal hostname/IP).

## SSH Config

Configure your SSH connection in `~/.ssh/config`:

```
Host lab-server
  HostName 192.168.1.100
  User engineer
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
```

Key-based authentication is **required**, not merely recommended. Every `ssh` we spawn runs with
`BatchMode=yes` and no terminal attached, so a password or key-passphrase prompt cannot be
answered — it is failed immediately with the reason reported, rather than left to hang. A key held
by `ssh-agent` works; so does a passphrase-less key. If your key has a passphrase, make sure the
agent holding it is visible to VS Code, which is not automatic when VS Code is launched from a
desktop icon rather than a shell.

For the same reason the host key must already be known. A first-ever connection has nothing to
confirm the prompt with, so either connect once by hand, or set `StrictHostKeyChecking accept-new`
for the host.

Verify both at once — this is the exact call mcu-debug makes first:

```sh
ssh -o BatchMode=yes lab-server uname -sm
```

## How mcu-debug Sets Up the Connection

When a session starts with SSH `hostConfig`, mcu-debug:

1. Runs `uname -sm` over SSH to identify the host's OS and CPU
2. Copies the matching `mdbg` binary to the host — unconditionally, overwriting whatever was
   there, so the deployed binary always matches the extension you are running
3. Starts `mdbg` on the host and reads back the port and token it reports
4. Establishes an SSH `-L` tunnel to that port
5. Connects the local debug adapter through the tunnel

All of this happens automatically before GDB starts. Steps 1–2 are skipped when you set
`serverPath`; steps 1–3 are all skipped when you set `proxyPort` and `token`, which is why the
remote OS only constrains the fully automatic path.

On a later session that finds the tunnel already up, mcu-debug asks the agent for a heartbeat
before reusing it. A tunnel whose agent has died is torn down and rebuilt from step 1 — an `ssh -L`
process stays alive and keeps its local port bound long after the far end is gone, so its being
alive proves nothing on its own.

## Proxy Binary Deployment

mcu-debug deploys the proxy binary to `~/.mcu-debug/bin/mdbg` on the remote host. The binary is statically linked (on Linux) or has zero external library dependencies (on macOS), requiring no pre-installed dependencies.

### Getting the `mdbg` binary

`mdbg` is not published as a standalone download. It ships **inside the extension**, so the copy
you want is already on your machine — and taking it from there is what guarantees the versions
match. Look under the installed extension's `bin` directory:

```
~/.vscode/extensions/mcu-debug.mcu-debug-<version>/bin/<platform>/mdbg
```

`<platform>` is one of `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, or `win32-x64`
(where the file is `mdbg.exe`). Pick the one matching the **remote** host, not your own machine.

The `mcu-debug-proxy` extension carries an identical `bin` directory, so either will do. Adjust
the root for your setup: `~/.vscode-insiders/extensions` for Insiders, `%USERPROFILE%\.vscode\extensions`
on Windows.

Copying it to a lab server is then one command:

```sh
scp ~/.vscode/extensions/mcu-debug.mcu-debug-0.1.11/bin/linux-x64/mdbg lab-server:~/.mcu-debug/bin/
ssh lab-server chmod +x ~/.mcu-debug/bin/mdbg
```

:::tip
The version is in the directory name, which makes it the easiest way to answer "what version
must the agent be?" — `ls ~/.vscode/extensions | grep mcu-debug`.
:::

If you would rather not touch the extensions directory, download the `.vsix` and unzip it (a VSIX
is a zip archive); the same `bin/<platform>/` tree is inside, under `extension/`.

:::warning
The agent's version must match the extension's **exactly** — not "close enough", and not
"newer is fine". `0.1.10` against `0.1.11` is refused in either direction, and the rejection
happens late, after the tunnel is already up. When we deploy the binary this is automatic; when
you install it yourself, updating the extension means re-copying the binary at the same time.
Verify with `ssh lab-server ~/.mcu-debug/bin/mdbg --version`.
:::

## Multi-User Lab Servers

On a shared lab server, each user runs their own proxy instance on a different port. mcu-debug negotiates the port automatically — no manual port assignment is needed.

## Latency Considerations

SSH tunneling adds latency to every GDB RSP packet. For typical embedded debugging this is negligible. For heavy use of memory read-intensive features (Live Watch, Memory View scanning), you may notice slower update rates compared to local debugging.

## VS Code Port Forwarding

VS Code forwards the debug adapter's internal ports back to your local machine. That is normal and
harmless — they bind loopback and stay as private once forwarded. Just don't open them in a
browser: a `GET / HTTP/1.1` arriving at the gdb, tcl or telnet endpoint can disrupt the session.
See [VS Code Port Forwarding](./index.md#vs-code-port-forwarding), which applies to every remote
topology, not just this one.

## Troubleshooting

### SSH connection refused

- Verify the host is reachable: `ssh lab-server echo ok`
- Check SSH key is loaded: `ssh-add -l`
- Ensure `sshd` is running on the remote host

### Proxy fails to start

Check whether the proxy binary deployed correctly:

```sh
ssh lab-server ~/.mcu-debug/bin/mdbg --version
```

If the binary is missing or fails, copy it to the host manually — see
[Getting the `mdbg` binary](#getting-the-mdbg-binary).

A version mismatch does not show up here: `--version` will happily report a number that the
extension then refuses. Compare it against `ls ~/.vscode/extensions | grep mcu-debug`.
