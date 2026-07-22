---
sidebar_position: 6
title: How mcu-debug Works
---

# How mcu-debug Works

Understanding the architecture of mcu-debug helps you debug the debugger when things go wrong. This page explains each component in the chain and what it does.

## The Debug Chain

```
VS Code
  │  (Debug Adapter Protocol — JSON over stdio)
  ▼
mcu-debug (Debug Adapter)
  │  (GDB Machine Interface — MI commands over stdio)
  ▼
GDB  (arm-none-eabi-gdb)
  │  (GDB Remote Serial Protocol — TCP)
  ▼
gdb-server  (OpenOCD / JLink / pyOCD / STLink)
  │  (SWD or JTAG — over USB)
  ▼
Debug Probe  (ST-Link / JLink / CMSIS-DAP / etc.)
  │  (SWD/JTAG — 2 or 4 wire)
  ▼
Target MCU
```

## What Each Component Does

### VS Code

VS Code provides the user interface — the editor, the Run and Debug panel, breakpoint markers, the Variables and Watch panels, and the Debug Console. VS Code communicates with debug adapters using the **Debug Adapter Protocol (DAP)**, a JSON-based protocol over stdio.

VS Code knows nothing about GDB or embedded hardware. It only speaks DAP.

### mcu-debug (the Debug Adapter)

mcu-debug translates between VS Code's DAP and GDB's **Machine Interface (MI)** protocol. It is the bridge. It:

- Starts and manages the gdb-server process
- Starts and manages GDB
- Translates DAP requests (set breakpoint, step, evaluate expression) into GDB MI commands
- Translates GDB MI responses back into DAP events and responses
- Manages additional channels: RTT server, UART, SWO
- Handles variable substitution in `launch.json`

mcu-debug is implemented as a VS Code extension and also has a standalone CLI interface.

### GDB

GDB is the actual debugger. It understands the ELF binary format, DWARF debug symbols, source-level stepping, breakpoints, watchpoints, and memory inspection. GDB connects to the gdb-server over TCP using the **GDB Remote Serial Protocol (RSP)**.

mcu-debug does not replace GDB — it controls GDB.

### gdb-server

The gdb-server bridges GDB and the hardware. It listens for GDB RSP connections on a TCP port and translates them into the low-level debug commands that your specific probe understands. Different probes need different gdb-servers:

- **OpenOCD**: supports most probes, open source, highly configurable
- **JLink GDB Server**: SEGGER's server for JLink probes, excellent performance
- **pyOCD**: Python-based, supports CMSIS-DAP probes
- **STLink GDB Server**: for ST-Link probes, ships with STM32CubeIDE

### Debug Probe

The probe is a USB device that implements the SWD or JTAG protocol and communicates with the target MCU's debug port. Common probes: ST-Link (on most STM32 Nucleo boards), JLink (from SEGGER), CMSIS-DAP compatible probes.

### Target MCU

Your microcontroller. The CPU has a debug port (SWD or JTAG) that provides hardware breakpoints, watchpoints, halt/resume control, and memory access while the core is running.

## Why This Matters for Troubleshooting

When something fails, knowing which component failed tells you where to look:

| Symptom                             | Likely failing component                                        |
| ----------------------------------- | --------------------------------------------------------------- |
| "Failed to start GDB"               | GDB binary not found or not executable                          |
| "Server exited with code 1"         | gdb-server failed — wrong config file, probe not found          |
| "Remote target disconnected"        | gdb-server crashed or probe disconnected during session         |
| Breakpoints not resolving to source | GDB cannot find debug symbols — wrong ELF, missing `-g` flag    |
| Variables show optimized-out        | Compiler optimization removed the variable — rebuild with `-O0` |

## How `launch.json` Maps to the Chain

Each `launch.json` property configures a specific part of the chain:

| Property          | Configures                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| `servertype`      | Which gdb-server process to start                                        |
| `configFiles`     | Configuration passed to the gdb-server (e.g. OpenOCD board/target files) |
| `serverpath`      | Path to the gdb-server binary                                            |
| `executable`      | The ELF file passed to GDB as the debug target                           |
| `gdbPath`         | Path to the GDB binary                                                   |
| `toolchainPrefix` | Prefix for `<prefix>-gdb` — `arm-none-eabi` → `arm-none-eabi-gdb`        |
| `debuggerArgs`    | Extra arguments passed to GDB at startup                                 |

## What mcu-debug Does NOT Do

- **mcu-debug does not talk to hardware directly.** It relies entirely on GDB and the gdb-server.
- **mcu-debug does not replace GDB.** GDB is still the real debugger. mcu-debug just drives it.
- **mcu-debug is not a gdb-server.** It manages the gdb-server process but does not implement RSP.
- **mcu-debug does not flash firmware directly.** Flashing is typically done by GDB via the gdb-server's monitor commands (e.g. `monitor flash`), or by a separate `preLaunchTask`.
