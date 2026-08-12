---
sidebar_position: 2
title: WSL
---

# WSL

Debugging from WSL (Windows Subsystem for Linux) when the debug probe is physically connected to the Windows host.

```
┌──────── Engineer Machine ───────────────────────────────────────┐
│  VS Code UI process                                             │
│  mcu-debug UI extension  ──► spawns/manages Probe Agent         │
│  Probe Agent (mdbg proxy)  ◄─────────────────────-─┐            │
│  GDB Server (OpenOCD, J-Link, etc.)  ◄── USB ──► Probe/Target  ││
│                                                                ││
│  ┌── WSL / Dev Container / VS Code Remote SSH ───────────────┐ ││
│  │  VS Code Workspace Extension Host                         │ ││
│  │  mcu-debug DA (Debug Adapter)  ───────────────────────────┘ │|
│  │  GDB                                                        │|
│  │  Source code, ELF files                                     │|
│  └─────────────────────────────────────────────────────────────┘|
└─────────────────────────────────────────────────────────────────┘
```

## How It Works

When you run VS Code Remote - WSL, the mcu-debug extension runs inside the WSL instance. But USB devices (including debug probes) attach to Windows. mcu-debug detects this situation and automatically routes the gdb-server through a proxy on the Windows side via another helper extension "mch-debug-proxy also called the UI extension.

## Auto-Detection

When being used inside VSCode, its APIs tell use if you are running in a WSL environment. For CLI mcu-debug detects WSL via the `WSL_DISTRO_NAME` environment variable. When this variable is set, remote mode is activated automatically — no complicated `hostConfig` needed in most cases.

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

1. On Windows, there is nothing to do except installing both extensions - `mcu-debug` and `mcu-debug-proxy`.

2. On the WSL side, launch a VSCode session with a WSL workspace at least once per version and run `MCU Debug: Install CLI Tools` from the command pallete. This will make `mcu-debug` as a command on the WSL side. You may have to start a new shell for the PATH to get updated

3. In WSL, start your debug session normally:
   ```sh
   mcu-debug debug -c "My Config"
   ```

The CLI auto-discovers the proxy via the WSL gateway address and starts the proxy server if not already started

## Troubleshooting

### USB device not accessible in Windows

Ensure the probe is attached to Windows (not passed through to WSL via usbipd). The gdb-server runs on Windows and needs native USB access.

### Could not launch gdb-server (openocd, stlink-gdb-server, etc)

Make sure the exectuables are in your PATH on Windows side or specified in your launch.json or VSCode settings on the WSL side.
