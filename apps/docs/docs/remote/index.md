---
sidebar_position: 1
title: Remote Debugging
---

# Remote Debugging

mcu-debug supports debugging scenarios where the debug probe is on a different machine or OS from your editor. This is common in Windows+WSL development workflows, Docker dev containers, and shared lab server setups.

## Supported Topologies

| Topology | Use Case | Setup |
|----------|----------|-------|
| [WSL](./wsl.md) | Linux dev environment, probe physically on Windows host | Auto-detected via `WSL_DISTRO_NAME`; minimal config |
| [Docker](./docker.md) | Dev container, probe on Docker host machine | Auto-detected via `/.dockerenv`; set `hostConfig.type: "auto"` |
| [SSH / Lab Server](./ssh.md) | Probe on remote server, developer on laptop | Explicit `hostConfig` with host name |

## The `hostConfig` Property

All remote topologies are configured via the `hostConfig` block in `launch.json`:

```json
"hostConfig": {
  "type": "auto"
}
```

For explicit SSH configuration:

```json
"hostConfig": {
  "type": "ssh",
  "host": "lab-server"
}
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
