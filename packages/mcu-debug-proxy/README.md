# MCU-Debug Proxy Server

> ### Pre-release software
>
> There is no release version yet. In VS Code, install using the dropdown beside **Install** and
> choose *Install Pre-Release Version* — plain **Install** reports that no release exists before
> offering you the pre-release, which is about the release channel rather than a broken listing.

Companion extension for [MCU-Debug](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug).
Install it on the machine your debug probe is **physically plugged into**, and MCU-Debug can drive
that probe from an editor running somewhere else — inside WSL, a dev container, or on another
machine over SSH.

> **This extension does nothing on its own.** It has no UI and no debug configuration of its own.
> It exists so that the main MCU-Debug extension can reach a probe that is not on the same machine
> as your source code.

## Do I need it?

| Your setup                                            | Do you use it? | Install it on  |
| ----------------------------------------------------- | -------------- | -------------- |
| Editor and probe on the same machine, no container    | No             | —              |
| Workspace in WSL, probe plugged into the Windows host | Yes            | Windows        |
| Workspace in a dev container, probe on the host       | Yes            | The host       |
| Workspace on your laptop, probe on a lab server       | Yes            | The lab server |

**You will have it installed either way, and that is fine.** MCU-Debug lists this extension as a
dependency, so VS Code installs it alongside MCU-Debug automatically. If you only ever debug with
the probe attached to the same machine you edit on, it simply sits there doing nothing — it has no
UI, and it costs you nothing at runtime.

> ⚠️ **Do not uninstall it** because you decided you do not need it. VS Code will not load
> MCU-Debug while a declared dependency is missing, so removing this extension disables your
> debugger until you reinstall it.

## How it works

Your workspace — source, compilers, `launch.json`, GDB — stays where it is. The probe stays where
it is. This extension runs next to the probe and presents it to the debug adapter as though it
were local.

```
   Workspace  (WSL / container / laptop)          Probe host  (Windows / lab server)
  ┌──────────────────────────────────┐          ┌──────────────────────────────────┐
  │  Source, compilers, launch.json  │          │  MCU-Debug Proxy Server          │
  │  MCU-Debug extension             │          │    (this extension)              │
  │  Debug Adapter                   │          │        │                         │
  │  GDB                             │          │        ▼                         │
  │  Views: RTT, SWO, UART,          │          │  gdb-server (OpenOCD, J-Link…)   │
  │         Memory, RTOS, SVD        │          │        │                         │
  │            │                     │          │        ▼                         │
  │       Proxy Client ──────────────┼──────────┼──▶  Debug Probe  ──▶  MCU        │
  └──────────────────────────────────┘          └──────────────────────────────────┘
```

The proxy owns the gdb-server lifecycle on the probe side and tunnels GDB, RTT, SWO and serial
traffic back to the workspace, so telemetry appears in your editor exactly as it would locally.

## Where it gets installed

VS Code decides this for you, and it is worth knowing why it looks backwards. This extension is
marked as a *UI* extension, so when you open a folder in WSL or a container, VS Code keeps it on
your host machine and copies only the main MCU-Debug extension into the remote environment. That
is the correct split: **the proxy has to run where the probe is.**

For WSL and dev containers, the connection is detected automatically. For a lab server, point
`hostConfig` at it in your `launch.json` and the extension deploys and starts what it needs over
SSH.

## Supported topologies

| Topology                                                                  | Use case                                         | Setup                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| [WSL](https://mcu-debug.github.io/mcu-debug/docs/remote/wsl)              | Linux dev environment, probe on the Windows host | Auto-detected; minimal config            |
| [Docker](https://mcu-debug.github.io/mcu-debug/docs/remote/docker)        | Dev container, probe on the Docker host          | Auto-detected; `hostConfig.type: "auto"` |
| [SSH / lab server](https://mcu-debug.github.io/mcu-debug/docs/remote/ssh) | Probe on a shared server, you on a laptop        | Explicit `hostConfig` with a host name   |

Full guide: [Remote Debugging](https://mcu-debug.github.io/mcu-debug/docs/remote).

## Commands

Normally you never invoke these — the main extension starts what it needs when a debug session
begins. They exist for diagnostics and for setups that need a proxy running ahead of time.

| Command                        | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `Start MCU Debug Proxy Server` | Start the proxy manually on this machine           |
| `Start Reverse Tunnel`         | Establish the tunnel back to the workspace machine |
| `Get Remote SSH Host`          | Report the SSH host VS Code is connected to        |

## Status

This extension is in preview and is versioned in lockstep with MCU-Debug, so the two always
install as a matched pair. Please report anything that misbehaves — remote setups vary enormously
and real-world reports are the most useful thing we can get.

- [Issues](https://github.com/mcu-debug/mcu-debug/issues)
- [Changelog](https://github.com/mcu-debug/mcu-debug/blob/main/packages/mcu-debug-proxy/CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](https://github.com/mcu-debug/mcu-debug/blob/main/LICENSE-APACHE).
