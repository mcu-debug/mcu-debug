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

## Two ways to do this

There are two different arrangements, and they need opposite configuration. Decide which one you
are in before anything else.

| | Probe stays on Windows | Probe passed into WSL with `usbipd` |
| --- | --- | --- |
| gdb-server runs on | Windows | Inside WSL |
| Proxy extension | Required | **Not used** |
| `hostConfig` | `true` (or an object) | **Omit it entirely** |
| Tool paths in `launch.json` | Windows paths | Linux paths |

**If you use [usbipd-win](https://github.com/dorssel/usbipd-win) to attach the probe to WSL, stop
here.** Everything then lives on one machine: the probe, the gdb-server, GDB, and your source. To
mcu-debug that is an ordinary local session, and it needs no `hostConfig`, no proxy extension, and
no remote setup at all. Adding `hostConfig` in that situation actively breaks things, because it
sends the gdb-server to a Windows host that no longer has the probe.

The rest of this page covers the first column: the probe stays plugged into Windows.

## How It Works

When you run VS Code Remote - WSL, the mcu-debug extension runs inside the WSL instance. But USB devices (including debug probes) attach to Windows. mcu-debug detects this situation and routes the gdb-server through a proxy on the Windows side,
run by the companion **MCU-Debug Proxy Server** extension (the "UI extension"). MCU-Debug offers
to install it the first time a configuration needs it — you do not have to find it yourself.

## Auto-Detection

When being used inside VSCode, its APIs tell use if you are running in a WSL environment. For CLI mcu-debug detects WSL via the `WSL_DISTRO_NAME` environment variable. When this variable is set, remote mode is activated automatically — no complicated `hostConfig` needed in most cases. The bare minimum configuration required in your `launch.json` is

```json
"hostConfig": true
```

Do not forget to point your `serverpath` (or appropriate settings) to a valid path on Windows side.

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

In NAT mode the proxy cannot bind loopback only — WSL is in a separate network namespace and
would not be able to reach it — so it binds an address reachable from the guest. **Windows
Firewall will ask for permission for `mdbg.exe` the first time this happens, and you have to
allow it.** If you deny it the proxy still starts and looks healthy on the Windows side, but the
debug adapter in WSL cannot connect and the session times out with nothing obviously wrong.

Mirrored mode never asks, because a loopback bind is already reachable from the guest.

### Which mode am I in?

From inside WSL:

```sh
wslinfo --networking-mode
```

This needs WSL 2.2.4 or newer; on anything older the answer is NAT, which is all there was.
mcu-debug asks the same question the same way and adjusts on its own — you only need to know
when you are deciding on the port-forwarding settings below.

## Starting the Windows Proxy

### In VS Code

When running in VS Code Remote - WSL, the VS Code extension on Windows handles starting the proxy automatically. No manual steps required.

### In CLI Mode

When using the CLI from WSL without VS Code:

1. On Windows, install both extensions — `mcu-debug` and `mcu-debug-proxy`. Installing
   `mcu-debug` from the marketplace and letting it prompt you for the proxy is the easy path; if
   you are installing VSIX files by hand, install the proxy **first**.

2. On the WSL side, launch a VSCode session with a WSL workspace at least once per version and run `MCU Debug: Install CLI Tools` from the command pallete. This will make `mcu-debug` as a command on the WSL side. You may have to start a new shell for the PATH to get updated

3. In WSL, start your debug session normally:
   ```sh
   mcu-debug debug -c "My Config"
   ```

The CLI auto-discovers the proxy via the WSL gateway address and starts the proxy server if not already started

## VS Code Port Forwarding

A remote debug session opens a good number of listeners inside WSL — roughly three to five per
core (gdb, tcl, telnet, and friends), one per serial view, one per RTT channel. VS Code notices
every one of them and forwards it back to Windows.

Two things follow, and both are worth heading off:

- **VS Code may offer to open a forwarded port in a browser.** Do not accept for a gdb, tcl or
  telnet port. A browser sends `GET / HTTP/1.1`, the gdb-server tries to read it as its own
  protocol, and the session can die on the spot.
- **Past twenty forwarded ports VS Code changes your settings**, switching automatic forwarding
  from `process` to `hybrid` and telling you so. A single-core session sits around seventeen, so
  a second core or a few RTT channels crosses the line.

In **mirrored** mode these ports need no forwarding at all. Everything that connects to them —
GDB, the serial and RTT views — runs inside WSL alongside them, and the connection *out* to the
proxy does not depend on forwarding either. Tell VS Code to leave them alone, in your WSL
`settings.json`:

```json
"remote.portsAttributes": {
    "2000-2600": { "onAutoForward": "ignore", "label": "mcu-debug internal" }
}
```

That range is mcu-debug's documented port band, so it will not affect your other projects.

In **NAT** mode, prefer `"onAutoForward": "silent"` instead of `"ignore"`. It keeps the
forwarding in place while suppressing the notifications and the browser offer — the conservative
choice for a topology where we have not yet confirmed that nothing depends on it.

See [VS Code Port Forwarding](./index.md#vs-code-port-forwarding) for the general discussion.

## Troubleshooting

### USB device not accessible in Windows

Check that the probe is still attached to Windows. If it has been bound to WSL with `usbipd`,
Windows no longer sees it — and in that case you want the other arrangement entirely: drop
`hostConfig` and run everything inside WSL. See [Two ways to do this](#two-ways-to-do-this).

Detach it from WSL with `usbipd detach --busid <id>` if you meant to keep it on Windows.

### Could not launch gdb-server (openocd, stlink-gdb-server, etc)

Make sure the exectuables are in your PATH on Windows side or specified in your launch.json or VSCode settings on the WSL side.
