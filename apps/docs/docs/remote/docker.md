---
sidebar_position: 3
title: Docker
---

# Docker

Debugging from a Docker dev container when the debug probe is connected to the Docker host machine.

## How It Works

mcu-debug detects it is running inside Docker via `/.dockerenv`. The Docker host is reachable from the container at a known address. mcu-debug connects to a proxy running on the host.

## Configuration

Add `hostConfig` to your `launch.json`:

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug from Container",
  "servertype": "openocd",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "serverpath": "<path-to-gdb-server-on-remote>",
  "configFiles": ["interface/stlink.cfg", "target/stm32f4x.cfg"],
  "hostConfig": {
    "enabled": true,
    "type": "auto"
  }
}
```

With `"type": "auto"`, mcu-debug detects the container environment and chooses the right host address.

## Host Address Resolution

| Docker Setup                   | Host Address                                     |
| ------------------------------ | ------------------------------------------------ |
| Docker Desktop (macOS/Windows) | `host.docker.internal`                           |
| Linux Docker (no Desktop)      | Default gateway IP (detected from routing table) |

mcu-debug detects which situation applies and resolves the host address accordingly.

## Starting the Host Proxy

Before starting a debug session from the container, run the proxy on the host:

```sh
# On the Docker host machine
mcu-debug proxy
```

The proxy must be running and able to access the probe before the container session connects.

### Docker Desktop: Automatic Proxy Start

With Docker Desktop on macOS or Windows, if VS Code Dev Containers extension is in use, the VS Code extension on the host can start the proxy automatically.

## Dev Container Configuration

In your `.devcontainer/devcontainer.json`, no special probe forwarding is needed — the proxy handles routing. However, the container must be able to reach the host network:

```json
{
  "runArgs": ["--add-host=host.docker.internal:host-gateway"]
}
```

This is automatic on Docker Desktop but may need explicit configuration on Linux.

## Troubleshooting

### Cannot connect to proxy

- Verify `mcu-debug proxy` is running on the host
- Test connectivity from the container: `ping host.docker.internal`
- Check that port 55556 (default proxy port) is not firewalled between host and container
