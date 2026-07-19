---
sidebar_position: 4
title: SSH / Lab Server
---

# SSH / Lab Server

Debugging when the probe is physically connected to a remote server — for example, a shared lab server with embedded hardware, while you develop on a laptop.

> [!IMPORTANT]
> The remote SSH host must be running a Unix-based operating system (Linux or macOS). Windows is not supported as a remote SSH server for debugging due to shell command and architecture detection requirements.

## Configuration

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
    "host": "lab-server"
  }
}
```

The `host` value is an SSH hostname alias from `~/.ssh/config` (or a literal hostname/IP).

## SSH Config

Configure your SSH connection in `~/.ssh/config`:

```
Host lab-server
  HostName 192.168.1.100
  User engineer
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
```

Key-based authentication is strongly recommended over password authentication for automated connections.

## How mcu-debug Sets Up the Connection

When a session starts with SSH `hostConfig`, mcu-debug:

1. Opens an SSH connection to the host
2. Checks whether the `mdbg` binary is present (and up to date)
3. If not present or outdated: copies the binary to the host automatically
4. Starts `mdbg` on the host
5. Establishes an SSH port-forward tunnel for the proxy connection
6. Connects the local debug adapter through the tunnel

All of this happens automatically before GDB starts.

## Proxy Binary Deployment

mcu-debug deploys the proxy binary to `~/.mcu-debug/bin/mdbg` on the remote host. The binary is statically linked and requires no dependencies.

You can also install the binary manually on the host by downloading the pre-compiled `mdbg` binary for your platform from the [GitHub Releases](https://github.com/mcu-debug/mcu-debug/releases) page and placing it in `~/.mcu-debug/bin/`.

## Multi-User Lab Servers

On a shared lab server, each user runs their own proxy instance on a different port. mcu-debug negotiates the port automatically — no manual port assignment is needed.

## Latency Considerations

SSH tunneling adds latency to every GDB RSP packet. For typical embedded debugging this is negligible. For heavy use of memory read-intensive features (Live Watch, Memory View scanning), you may notice slower update rates compared to local debugging.

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

If the binary is missing or fails, copy the binary to the host manually or download it from the GitHub Releases page.
