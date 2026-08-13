---
sidebar_position: 1
title: Remote Debugging
---

# Remote Debugging

mcu-debug supports debugging scenarios where the debug probe is on a different machine or OS from your editor. This is common in Windows+WSL development workflows, Docker dev containers, and shared lab server setups.

:::note
For terminology, for example with WSL or Docker, `"remote"` is your host machine/OS and `"local"` is your WSL/Docker/Guest-VM environment. Local is where your files and build artifacts live. Remote is also where your debug probe is physically attached to.
:::

## Architecture

In the picture below, the "Workspace" and the "Probe Proxy" can be on very different comuters. The "proxy" server provides access to the HW Probe as if it is locally available. The connection is handled depending on the type of the environment each part is. The Workspace can be inside WSL or Docker. The "Probe" could be on a host machine hosting the WSL/Docker environment or some other machine The system automatically detects the type of the "Workspace" environment with the help of VSCode. But you can always use `ssh` to connect the two environments. The same architecture is also used for CLI mode except VSCode services cannot be used but the Probe environment can be described in launch.json. However, for WSL, CLI mode will detect and make the connection automatically

```mermaid
flowchart
  subgraph WS["Workspace"]
     direction TD
     SRC["Source code<br>Compilers<br>launch.json"]
     MD["MCU Debug<br>Extension"]
     DA["Debug Adapter"]
     PC["Proxy Client"]
     GDB["GDB"]
     VIEWS["Views (RTT, SWO, UART<br>Memory, RTOS, SVD)"]
  end
  SRC --> MD
  MD <--> DA
  DA <--> PC
  PC <--> GDB
  PC --> VIEWS

  subgraph PROXY["Probe Proxy"]
     direction TD
     MDP["MCU Debug<br>Proxy Extension"]
     MDBG["MCU Debug<br>Proxy Server"]
     GDBS["Gdb server<br>(openocd, jlink)"]
     PROBE["Debug Probe<br>(STLink, KitProg3, JLink)"]
  end
  MCU["MCU"]

  MDP   --> MDBG
  MDBG  --> GDBS
  GDBS <--> PROBE
  PROBE <--> MCU
  MDBG --> VIEWS

  PC <--> MDBG
```

## Supported Topologies

| Topology                     | Use Case                                                | Setup                                                          |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| [WSL](./wsl.md)              | Linux dev environment, probe physically on Windows host | Auto-detected via `WSL_DISTRO_NAME`; minimal config            |
| [Docker](./docker.md)        | Dev container, probe on Docker host machine             | Auto-detected via `/.dockerenv`; set `hostConfig.type: "auto"` |
| [SSH / Lab Server](./ssh.md) | Probe on remote server, developer on laptop             | Explicit `hostConfig` with host name                           |

## The `hostConfig` Property

All remote topologies are configured via the `hostConfig` block in `launch.json`: For everything except for 'ssh', the `hostConfig` can be a simple boolean

```json
"serverpath": "<path-to-gdb-server-on-remote>",
"hostConfig": true
```

the above is equivalent to the following

```json
"serverpath": "<path-to-gdb-server-on-remote>",
"hostConfig": {
  "enabled": true,
  "type": "auto"
}
```

For explicit SSH configuration:

```json
"serverpath": "<path-to-gdb-server-on-remote>",
"hostConfig": {
  "enabled": true,
  "type": "ssh",
  "host": "lab-server"
}
```

## Connecting to an Agent You Started Yourself

Every topology above detects your environment and launches the Probe Agent for you. When
that is not what you want — a CLI-only container, a CI runner, a shared lab machine, or
anywhere the agent's lifetime is managed outside the editor — name the endpoint directly
and mcu-debug will skip detection entirely:

```json
"hostConfig": {
  "enabled": true,
  "proxy": {
    "host": "172.28.240.1",
    "port": 55555,
    "token": "${env:MDBG_PROXY_TOKEN}"
  }
}
```

Start the agent yourself on the machine with the probe:

```sh
export MDBG_PROXY_TOKEN=$(openssl rand -hex 16)   # any value, as long as both ends agree
mcu-debug proxy --host 172.28.240.1 --port 55555
```

`mcu-debug proxy --status` reports the `port` and the `hosts` it is bound to — use those
values. The `host` must be an address the agent is actually bound to *and* that the debug
adapter can reach; those are two different questions when a container or VM is involved.

:::note
**All three fields are required.** An endpoint without a token is rejected by the agent
at connect time, which surfaces far from the mistake and is hard to diagnose, so
mcu-debug reports the incomplete configuration up front instead. The one flexibility:
the token may come from the `MDBG_PROXY_TOKEN` environment variable instead of
`launch.json`, which is the recommended way — a token in `launch.json` is a shared secret
committed to source control. The agent reads the same variable, so one export configures
both ends.
:::

When `proxy` is set, `type` is ignored — you have told mcu-debug where the agent is, so
there is nothing left to detect. This does **not** apply to the SSH topologies: `ssh`
needs its `-L` tunnel established before any endpoint exists, and VS Code Remote-SSH
needs its reverse tunnel. For a pre-running agent on a lab server over SSH, use
`sshProxyPort` instead.

## Configuring the gdb-server for remote

Some gdb servers require bare minimum configuration. Others like openocd may need quite a bit depending on your MCU

Note that the gdb-server will be started on the remote server where the debug probe is attached. Regardless of the type of remote (WSL, Docker, ssh, etc.) the server needs to be started properly and it has to find all the files it needs locally on the remote machine. We also need to know the path to the gdb-server.

:::note
- **The full path name to the gdb-server on the remote machine is needed** The `serverpath` in launch.json is needed because the remote server is not running in VSCode and does not have access to any VSCode settings.
- `serverpath` is not needed if the server executable is installed globally and accessible via `$PATH` env. variable. You can also use VSCode workspace (or global) settings for your specific gdb-server path
- Any files that the gdb-server needs need to be specified in terms of path-names on the remote
- In openocd case, the `searchDir` needs to be in terms of the remote paths
:::

To this end, we provide a way to synchronize files between the two machines. Any paths relative to the your launch.json `cwd` can be specified in the `syncFiles` and they will be copied to a temporary directory on the remote. Note that this is not meant to transport large amounts of data. It is currently limited to 20 files and no single file can exceed 10 MB. This file sizes have a very large impact on startup performance and our transport mechanism is not optimized for high throughput.

The following is a complex example of `syncFiles` because there is quite a bit that is non-standard.

```json
"serverpath": "<path-to-gdb-server-on-remote>",
"hostConfig": {
  "enabled": true,
  "type": "auto"
  "syncFiles": [
      {"local": "openocd.tcl"},
      // Following is not needed if the executable was an elf file since gdb can load that data directly
      // In this case, we are loading via openocd. Not a normal flow but this is an example of how things
      {"local": "build/last_config/mtb-example-hal-hello-world.hex"}
  ],
},
// Note how the hex file is reference in openocd launch commands
"overrideLaunchCommands": [
  "monitor program {build/last_config/mtb-example-hal-hello-world.hex}",
  "monitor reset run",
  "monitor psoc6 reset_halt sysresetreq"
],
```

### Rules for `syncFiles`

Please keep your `syncFiles` simple and small. An rsync or a network drive may be a better method

```typescript
/*
 * Sync files listed in hostConfig.syncFiles.
 *
 * Each entry has the shape:
 *   { local: string, remote?: string }
 *
 * local:
 * - A glob pattern (resolved from launch/attach configuration "cwd"), or
 * - A direct file path (absolute or relative).
 *
 * remote:
 * - Optional destination path on the remote side.
 * - Always interpreted relative to the proxy session root directory on the server.
 * - Must be a safe relative path (no absolute paths, no ".." traversal).
 * - The remote directory is randomly created and cannot be relied upon between sessions
 *
 * Destination behavior:
 * - If a matched local file is inside this.cwd:
 *   - Preserve its path relative to this.cwd.
 *   - If remote is provided, prepend remote as a base directory.
 * - If a matched local file is outside this.cwd:
 *   - If remote is provided and only one file is matched, remote is treated as the exact destination file path.
 *   - If remote is provided and multiple files are matched, remote is treated as a directory and each basename is appended.
 *   - If remote is omitted, fall back to the local basename at session root.
 *
 * Notes:
 * - Paths sent to the server always use forward slashes for cross-platform consistency.
 * - The server creates parent directories under the session root as needed.
 * - There are limits on the number (20) and size (10 MB) of files that can be synced to prevent abuse and performance issues.
 */
```

## How Remote Debugging Works

mcu-debug runs a small **proxy agent** on the machine where the probe is physically connected. The proxy:

- Starts and manages the gdb-server process
- Exposes a multiplexed TCP tunnel back to the debug adapter
- Handles GDB RSP and RTT traffic over the same tunnel

The debug adapter (running in VS Code or the CLI) connects to the proxy rather than directly to the gdb-server. Everything else — GDB, RTT, UART, the launch.json configuration — works identically to local debugging.

## VS Code Port Forwarding

:::caution
This affects **every** remote topology — WSL, Docker dev containers, and Remote-SSH. Configure it
once and it applies to all of them.
:::

During a remote session the debug adapter opens listeners on the **workspace** side — one per
gdb-server stream (gdb, tcl, telnet, SWO) plus one per serial view. GDB and the views connect to
them from that same machine. Nothing outside needs them.

VS Code's Remote extensions scan the remote for listening ports and automatically forward them
back to your local machine, then offer to open them in a browser. That is exactly right for a web
server, and wrong here:

- **It can break a running session.** Opening a gdb port in a browser sends `GET / HTTP/1.1` into
  the gdb-server's remote-serial-protocol parser. openocd may abort. The tcl and telnet ports are
  command interfaces and will act on whatever they manage to parse.
- **It exposes debug control.** A forwarded tcl or telnet port is full command access to the
  gdb-server, reachable from the machine it is forwarded to.

VS Code is not misbehaving. Forwarding loopback listeners *is* the feature — a dev server binds
`127.0.0.1:3000` for safety and you still want it in your browser — and nothing in a TCP listener
distinguishes "web server a human wants" from "debug endpoint that must stay put".

### Recommended settings

mcu-debug binds these listeners to `127.0.0.1` rather than to all interfaces, which is enough for
VS Code to leave them alone in a Docker dev container. If you see the prompts anyway — WSL and
Remote-SSH detect loopback listeners differently — add this to your **workspace or user
`settings.json`** (the one on the workspace side — inside
WSL, the container, or on the SSH host):

```json
{
  "remote.portsAttributes": {
    "2000-2099": {
      "label": "mcu-debug: gdb-server ports",
      "onAutoForward": "ignore"
    },
    "2200-2299": {
      "label": "mcu-debug: RTT channels",
      "onAutoForward": "ignore"
    },
    "2400-2499": {
      "label": "mcu-debug: consoles",
      "onAutoForward": "ignore"
    }
  }
}
```

`onAutoForward: "ignore"` means *do not forward at all*. Use it rather than `"silent"`, which still
forwards the port and only hides the notification.

The first block is the one that matters for safety — those are the gdb, tcl and telnet ports. The
other two only suppress noise.

`2000-2099` is room for about 25 cores' worth of gdb-server ports, which is far more than the two
or three probes a developer machine typically drives. Widen it if the prompts reappear: port
allocation skips ports that are already in use, so unrelated programs occupying part of the range
push our ports upward and eventually past the end of it.

If you use a dev container, the same keys work in `.devcontainer/devcontainer.json`, without the
`remote.` prefix:

```json
{
  "portsAttributes": {
    "2000-2099": { "onAutoForward": "ignore" }
  }
}
```

### Serial views use unpredictable ports

Serial views bind an OS-assigned port rather than one from the ranges above, so no range can cover
them. If the prompts bother you, or the remote is used only for embedded debugging, suppress
everything not explicitly listed:

```json
{
  "remote.otherPortsAttributes": { "onAutoForward": "ignore" }
}
```

That also stops VS Code forwarding a web server you *do* want. If you need both, change how ports
are discovered instead — this stops the scan for listening processes while still forwarding
anything that prints a URL in the terminal:

```json
{
  "remote.autoForwardPortsSource": "output"
}
```

## Prerequisites

- The `mcu-debug proxy` binary must be available on the host machine (the machine where the probe is connected). Using the `mcu-debug-proxy` extension in VSCode makes this simple. Note: We create version independent scripts in `~/.mcu-debug/bin` directory to access the proxy server but you have to load the `mcu-debug` extension into VSCode atleast once per version. It is totally transparent using the `mcu-debug proxy` extension
- For SSH mode: SSH access to the host (key-based authentication recommended)
- For WSL and Docker: the proxy may need to be started manually if not using VS Code Remote extensions. See [SSH configuration](ssh.md)
