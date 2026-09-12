---
sidebar_position: 3
title: Installation
---

# Installation

mcu-debug ships as **two** VS Code extensions:

| Extension | Where it runs | What it does |
| --- | --- | --- |
| [MCU-Debug](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug) | Wherever your workspace is | The debugger itself |
| [MCU-Debug Proxy Server](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug-proxy) | Always your local machine | Reaches a debug probe that is not attached to the machine your workspace lives on |

**For ordinary local debugging you only need the first one.** The proxy matters when your
workspace is somewhere else — WSL, a dev container, or a Remote-SSH host — because the USB probe
stays plugged into the machine in front of you. MCU-Debug offers to install it when a debug
configuration needs it, so you can ignore it until then.

## VS Code Marketplace

1. Open VS Code
2. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **mcu-debug**
4. Click **Install**

Or from the command line:

```sh
code --install-extension mcu-debug.mcu-debug
```

:::note Pre-release builds
mcu-debug is published on the **pre-release** channel. Choosing *Install Release Version* from
the dropdown reports that no release version exists — that is expected, not a broken listing. The
plain **Install** button gives you the pre-release, which is what you want.

The convention is an odd minor version for pre-release (`0.1.x`) and an even one for release
(`0.2.x`).
:::

## Installing from a VSIX

Use this for builds from the [GitHub releases](https://github.com/mcu-debug/mcu-debug/releases)
page, or when you need a specific version.

:::caution Install the proxy first
If you are installing both extensions by hand, install **MCU-Debug Proxy Server before
MCU-Debug**. The marketplace install handles ordering for you; a manual VSIX install does not.
:::

**From the UI:**

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Click the **…** menu at the top of the Extensions pane
3. Choose **Install from VSIX…**
4. Select the `.vsix` file

**From a terminal:**

```sh
code --install-extension path/to/mcu-debug-proxy-<version>.vsix
code --install-extension path/to/mcu-debug-<version>.vsix
```

If your workspace is in WSL, a dev container, or on a Remote-SSH host, install **MCU-Debug** on
that side as well — the marketplace install offers to do this for you, but a VSIX install cannot.
The proxy is only ever installed locally.

## Prerequisites

### GDB

mcu-debug requires GDB for your target architecture.

**Use your silicon vendor's toolchain if they ship one.** Vendors track security and errata
patches from Arm for their parts — Cortex-M55 is a current example — and they validate their
flow against a specific toolchain and C library. A generic toolchain of the same version number
is not necessarily the same toolchain.

Failing that:

- **Arm GNU Toolchain**: download from [developer.arm.com](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads). Provides `arm-none-eabi-gdb`.
- **xPack DevTools**: `npm install -g @xpack-dev-tools/arm-none-eabi-gcc`. Also other xpack architectures like `npm install -g @xpack-dev-tools/riscv-none-elf-gcc`
- Other GDB distributions work too (RISC-V, Xtensa, Zephyr, etc.). Just set `armToolchainPath`, `gdbPath` or `toolchainPrefix` appropriately. Setting `gdbPath` removes any guesswork

### Check GDB before anything else

Open a terminal — not VS Code's debug console, an actual shell — and run:

```sh
arm-none-eabi-gdb --version
```

**If that prints a version, you are done here.** If it does not, fix it before going further.
This one command is the single most common cause of a failed first session: a GDB that cannot
start because of a missing shared library reports nothing useful through the debugger, and
usually presents as a hang rather than an error. It was a Linux problem for years; it now happens
on Windows too.

The `gdbPath` or `toolchainPrefix` properties in `launch.json` let you point at GDB explicitly
when it is not on `PATH`.

### GDB Server

**Again, prefer your vendor's build if they ship one.** Vendor OpenOCD builds carry the target
config files and patches for their own parts. A generic or long-outdated OpenOCD is the second
most common cause of a session that will not start — usually missing or wrong config scripts for
a part that did not exist when that build was made.

Otherwise, choose the gdb-server that matches your debug probe:

| Probe                                         | Recommended Server                            |
| --------------------------------------------- | --------------------------------------------- |
| Most probes (ST-Link, CMSIS-DAP, JLink, etc.) | [OpenOCD](../gdb-servers/openocd.md)          |
| JLink probes                                  | [JLink GDB Server](../gdb-servers/jlink.md)   |
| CMSIS-DAP probes                              | [pyOCD](../gdb-servers/pyocd.md)              |
| ST-Link probes                                | [STLink GDB Server](../gdb-servers/stlink.md) |

See the [GDB Servers](../gdb-servers/index.md) section for installation instructions for each server.

### Node.js (for CLI features)

The mcu-debug CLI tool requires Node.js >= 22. Download from [nodejs.org](https://nodejs.org) and make sure it is in your system `PATH`.

The VS Code extension itself does not require Node.js to be on your `PATH` (it uses the Node.js runtime bundled with VS Code). However, to run the debugger from an external terminal or shell, Node.js must be installed on your system.

Once Node.js is installed:

1. Open VS Code.
2. Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).
3. Search for and execute the **MCU-Debug: Install CLI Tools** command.
4. Follow the interactive prompts in the integrated terminal to automatically update your shell profile or environment `PATH`.

## Verification

To verify the installation:

1. Open a firmware project folder in VS Code
2. Create `.vscode/launch.json` (see [Quick Start](./quick-start.md) for an example)
3. Open the **Run and Debug** panel (`Ctrl+Shift+D` / `Cmd+Shift+D`)
4. Your configuration should appear in the dropdown

The extension activates when a `launch.json` with `"type": "mcu-debug"` is opened.

If you are debugging a probe attached to a different machine than your workspace, run
**MCU-Debug Developer: Check MCU-Debug Proxy** from the Command Palette. It reports whether the
proxy is reachable and whether the two extension versions match.
