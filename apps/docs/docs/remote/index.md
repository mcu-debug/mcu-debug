---
sidebar_position: 1
title: Remote Debugging
---

# Remote Debugging

mcu-debug supports debugging scenarios where the debug probe is on a different machine or OS from your editor. This is common in Windows+WSL development workflows, Docker dev containers, and shared lab server setups.

:::note
For terminology, for example with WSL or Docker, `"remote"` is your host machine/OS and `"local"` is your WSL/Docker/Guest-VM environment. Local is where your files and build artifacts live. Remove is also where your debug probe is physically attached to.
:::

## Supported Topologies

| Topology                     | Use Case                                                | Setup                                                          |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| [WSL](./wsl.md)              | Linux dev environment, probe physically on Windows host | Auto-detected via `WSL_DISTRO_NAME`; minimal config            |
| [Docker](./docker.md)        | Dev container, probe on Docker host machine             | Auto-detected via `/.dockerenv`; set `hostConfig.type: "auto"` |
| [SSH / Lab Server](./ssh.md) | Probe on remote server, developer on laptop             | Explicit `hostConfig` with host name                           |

## The `hostConfig` Property

All remote topologies are configured via the `hostConfig` block in `launch.json`:

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

## Configuring the gdb-server for remote

Some gdb servers require bare minimum configuration. Others like openocd may need quite a bit depending on your MCU

Note that the gdb-server will be started on the remote server where the debug probe is attached. Regardless of the type of remote (WSL, Docker, ssh, etc.) the server needs to be started properly and it has to find all the files it needs locally on the remote machine. We also need to know the path to the gdb-server.

:::note
- **The full path name to the gdb-server on the remote machine is needed** The `serverpath` in launch.json is needed because the remote server is not running in VSCode and does not have access to any VSCode settings.
- `serverpath` is not needed if the server executable is installed globally and accessible via `$PATH` env. variable
- Any files that the gdb-server needs need to be specified in terms of path-names on the remote
- In openocd case, the `searchDir` needs to be in terms of the remote paths.
:::

To this end, we provide a way to synchronize files between the two machines. Any paths relaive to the your launch.json `cwd` can be specified in the `syncFiles` and they will be copied to a temporary directory on the remote. Note that this is not meant to transport large amounts of data. It is currently limited to 20 files and no single file can exceed 10 MB. This file sizes have a very large impact on startup performance and our transport mechanism is not optimized for high throughput.

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
  // Note how the hex file is reference in openocd launch commands
  "overrideLaunchCommands": [
      "monitor program {build/last_config/mtb-example-hal-hello-world.hex}",
      "monitor reset run",
      "monitor psoc6 reset_halt sysresetreq"
  ],
}
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

## Prerequisites

- The `mcu-debug proxy` binary must be available on the host machine (the machine where the probe is connected)
- For SSH mode: SSH access to the host (key-based authentication recommended)
- For WSL and Docker: the proxy may need to be started manually if not using VS Code Remote extensions
