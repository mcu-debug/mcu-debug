---
sidebar_position: 2
title: WSL
---

# WSL

Debugging from WSL (Windows Subsystem for Linux) when the debug probe is physically connected to the Windows host.

## How It Works

When you run VS Code Remote - WSL, the mcu-debug extension runs inside the WSL instance. But USB devices (including debug probes) attach to Windows. mcu-debug detects this situation and automatically routes the gdb-server through a proxy on the Windows side.

## Auto-Detection

mcu-debug detects WSL via the `WSL_DISTRO_NAME` environment variable. When this variable is set, remote mode is activated automatically — no `hostConfig` needed in most cases.

## Networking Modes

### Mirrored Networking (Windows 11, recommended)

With WSL mirrored networking mode, the Windows loopback is visible from WSL at `127.0.0.1`. The proxy runs on Windows and listens on `127.0.0.1`. No additional configuration needed.

Enable mirrored networking in `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Restart WSL after changing this file: `wsl --shutdown`.

### NAT Networking (default on older Windows 10)

With NAT networking, WSL reaches Windows at the default gateway IP. mcu-debug detects and uses this automatically.

## Starting the Windows Proxy

### In VS Code

When running in VS Code Remote - WSL, the VS Code extension on Windows handles starting the proxy automatically. No manual steps required.

### In CLI Mode

When using the CLI from WSL without VS Code:

1. On Windows, open PowerShell or Command Prompt and run:
   ```powershell
   mcu-debug proxy
   ```

2. In WSL, start your debug session normally:
   ```sh
   mcu-debug debug -c "My Config"
   ```

The CLI auto-discovers the proxy via the WSL gateway address.

## Troubleshooting

### Proxy not found

If auto-detection fails, explicitly configure the host:

```json
"hostConfig": {
z "enabled": true,
  "type": "wsl",
  "host": "127.0.0.1"
}
```

### USB device not accessible in Windows

Ensure the probe is attached to Windows (not passed through to WSL via usbipd). The gdb-server runs on Windows and needs native USB access.
