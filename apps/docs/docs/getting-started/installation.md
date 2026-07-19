---
sidebar_position: 4
title: Installation
---

# Installation

We are currently in Alpha stage. Please refer to [Alpha Installation](./alpha-installation.mdx) for instructions.

## VS Code Extension

Install mcu-debug from the VS Code Marketplace:

1. Open VS Code
2. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **mcu-debug**
4. Click **Install**

Or install from the command line:

```sh
code --install-extension mcu-debug.mcu-debug
```

## Prerequisites

### GDB

mcu-debug requires GDB for your target architecture. For ARM Cortex-M and other embedded targets:

- **Arm GNU Toolchain** (recommended): download from [developer.arm.com](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads). Provides `arm-none-eabi-gdb`.
- **xPack DevTools**: `npm install -g @xpack-dev-tools/arm-none-eabi-gcc`. Also other xpack architectures like `npm install -g @xpack-dev-tools/riscv-none-elf-gcc`
- You can use other gdb distributions as well (RISC-V, Xtensa, Zephyr, etc.). Just make sure you specify `armToolchainPath` or `gdbPath` or `toolchainPrefix` appropriately. Setting `gdbPath` removes any guesswork

After installation, verify GDB is accessible and that **you can run GDB from the commaind-line**:

```sh
arm-none-eabi-gdb --version
```

The `gdbPath` or `toolchainPrefix` properties in `launch.json` let you specify the path explicitly if GDB is not on `PATH`. Very often GDB installation is missing cricical libraries and causes a hang instead of a proper error message.

### GDB Server

Choose the gdb-server that matches your debug probe:

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
