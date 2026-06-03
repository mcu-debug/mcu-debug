---
sidebar_position: 1
title: Getting Started
---

# Getting Started with mcu-debug

Welcome to **mcu-debug** — a VS Code extension for debugging ARM Cortex-M microcontrollers and other embedded targets. It acts as a Debug Adapter (DA) sitting between VS Code and GDB, giving you a full graphical debugging experience backed by the power and flexibility of GDB.

## Key Features

- **GDB-based debugging** — full breakpoint, watchpoint, step, and inspect support via GDB and your choice of gdb-server
- **Live Watch** — monitor variables in real time while the target runs, without halting execution
- **RTT / UART / SWO tracing** — capture debug output over the SWD connection (RTT), a serial port (UART), or the SWO trace pin
- **Remote debugging** — debug over WSL, Docker, or SSH when the probe is on a different machine
- **CLI tool** — full debug sessions in a terminal (TUI or plain), suitable for headless and AI-driven workflows
- **AI integration** — designed for autonomous and hybrid AI-assisted debugging with Claude Code, GitHub Copilot, and similar tools
- **Multi-core support** — debug CM0+ and CM4 cores simultaneously on devices like PSoC6
- **Peripheral viewer** — inspect peripheral registers via SVD files

## Prerequisites

Before starting, you will need:

- **VS Code** 1.80 or later
- **GDB** for your target architecture (e.g. `arm-none-eabi-gdb` from the Arm GNU Toolchain)
- **A gdb-server** matching your debug probe — see [GDB Servers](../gdb-servers/index.md)
- **An ELF file** with debug symbols built from your firmware project

## Sections

| Section | Description |
|---------|-------------|
| [Installation](./installation.md) | Install the extension and required tooling |
| [Quick Start](./quick-start.md) | First debug session in five minutes |
| [How mcu-debug Works](./how-it-works.md) | The VS Code → DA → GDB → gdb-server → probe → target chain |
| [Migrating from Cortex-Debug](./migrating.md) | mcu-debug is the successor to Cortex-Debug — what changed |
