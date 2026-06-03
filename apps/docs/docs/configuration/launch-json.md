---
sidebar_position: 2
title: launch.json Overview
---

# launch.json Overview

## File Location and Structure

`launch.json` lives at `.vscode/launch.json` in your project root. It is a standard VS Code file that can contain multiple debug configurations and even from multiple debuggers:

```json
{
  "version": "0.2.0",
  "configurations": [
    { /* first config */ },
    { /* second config */ }
  ]
}
```

Each configuration in the `configurations` array is independent. You select which one to run from the dropdown in the Run and Debug panel.

## Required Fields

Every mcu-debug configuration must have these fields:

| Field        | Description                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `type`       | Must be `"mcu-debug"`                                                   |
| `request`    | `"launch"` or `"attach"` — see below                                    |
| `name`       | Display name in the VS Code configuration picker                        |
| `servertype` | Which gdb-server to use: `"openocd"`, `"jlink"`, `"pyocd"`, `"stlink"`  |
| `executable` | Path to the ELF file with debug symbols. You can also use `symbolFiles` |

## The `request` Field

- **`"launch"`**: mcu-debug starts the gdb-server, connects GDB, and typically flashes the firmware. Use this for most development workflows.
- **`"attach"`**: mcu-debug connects GDB to an already-running gdb-server. The target may already be executing. Use this when another tool manages the gdb-server, or when you want to attach to a running target without resetting it.

## Three Conceptual Sections

Properties fall into three groups:

1. **GDB Server config** — which server to start, how to start it, what board/target files to use
2. **GDB config** — which GDB binary, what arguments, what commands to run at startup
3. **Debug features config** — RTT, UART, SWO, multi-core, remote, peripheral view

## Complete OpenOCD Example

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "mcu-debug",
      "request": "launch",
      "name": "Debug STM32F4 (OpenOCD)",

      // GDB server
      "servertype": "openocd",
      "serverpath": "<path to openocd executable if not in your $PATH>"
      "configFiles": [
        "interface/stlink.cfg",
        "target/stm32f4x.cfg"
      ],
      "searchDir": [...],

      // GDB
      "executable": "${workspaceFolder}/build/firmware.elf",
      "debuggerArgs": [],
      // Custom session startup commands

      // Session behavior
      "runToEntryPoint": "main",
      "breakAfterReset": false,

      // Features
      "svdFile": "${workspaceFolder}/STM32F407.svd",
      "rttConfig": {
        "enabled": true,
        "decoders": [
          { "port": 0, "type": "console" }
        ]
      }

      // Live Watch
      "liveWatch": {
        "enabled": true
      }
    }
  ]
}
```

## Multiple Configurations

A single `launch.json` can contain configurations for different scenarios — different build targets, different probes, attach vs launch:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug (ST-Link)",
      "type": "mcu-debug",
      "request": "launch",
      "servertype": "openocd",
      "configFiles": ["interface/stlink.cfg", "target/stm32f4x.cfg"],
      "executable": "${workspaceFolder}/build/firmware.elf"
    },
    {
      "name": "Attach (ST-Link)",
      "type": "mcu-debug",
      "request": "attach",
      "servertype": "openocd",
      "configFiles": ["interface/stlink.cfg", "target/stm32f4x.cfg"],
      "executable": "${workspaceFolder}/build/firmware.elf"
    }
  ]
}
```

## GDB Server settings

Customizations based on server type is discussed in [GDB Servers](../gdb-servers/)
