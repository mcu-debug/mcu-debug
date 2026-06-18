---
sidebar_position: 6
title: Multi-core Debugging
---

# Multi-core Debugging

mcu-debug supports debugging multi-core MCUs where you need to inspect both cores simultaneously — for example, a device with a CM33 and a CM55. You can also debug multiple boards as there is no requirement that all MCU cores be in the same chip

## Overview

Each core gets its own GDB instance. The cores are launched as separate debug sessions linked via `chainedConfigurations`, which causes mcu-debug to start them together. One good strategy to use is to launch your primary boot core in "launch" mode and have it program the entire device. Then chain other cores as secondary cores and connect with an "attach". It very much depends on your boot process and and how each core/MCU starts. You can use `loadFiles` to program multiple executables or a combined hex file

## Configuration

Use `numberOfProcessors`, `targetProcessor`, and `chainedConfigurations`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "mcu-debug",
      "request": "launch",
      "name": "CM33 (primary)",
      "servertype": "openocd",
      "executable": "${workspaceFolder}/build/CM33/firmware.elf",
      "configFiles": ["./openocd.tcl"],
      "numberOfProcessors": 2,
      "targetProcessor": 0,
      "runToEntryPoint": "main",
      "chainedConfigurations": {
        "enabled": true,
        "waitOnEvent": "postInit",
        "configurations": [
          {
            "name": "CM55 (secondary)",
            "folder": "${workspaceFolder}"
          }
        ]
      }
    },
    {
      "type": "mcu-debug",
      "request": "attach",
      "name": "CM55 (secondary)",
      "servertype": "openocd",
      "executable": "${workspaceFolder}/build/CM55/firmware.elf",
      "configFiles": ["./openocd.tcl"],
      "numberOfProcessors": 2,
      "targetProcessor": 1,
    }
  ]
}
```

### Key Properties

| Property                            | Description                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `numberOfProcessors`                | Total number of CPU cores on the device                                                 |
| `targetProcessor`                   | Which core this configuration targets (0-indexed)                                       |
| `chainedConfigurations`             | Describes additional configurations to launch together                                  |
| `chainedConfigurations.waitOnEvent` | When to start the secondary: `"postInit"` (after primary GDB connects) or `"postStart"` |

## How It Works

1. VS Code launches the primary configuration (CM55 in the example above)
2. mcu-debug connects GDB to the CM33 core
3. After the `waitOnEvent` condition is met, VS Code launches the secondary configuration (CM55)
4. A separate GDB connects to the CM55 core
5. Both sessions appear in the VS Code Call Stack panel — you can switch between cores

## Stepping Behavior

Each core is controlled independently. Stepping on CM55 does not affect CM33. Use the session selector in the Call Stack panel to switch between cores.

## Breakpoints

Breakpoints are per-session (per-core). A breakpoint set in a CM55 source file affects only the CM55 GDB session. If both cores share code (e.g. common libraries), breakpoints may get set in both sessions.

## Supported Hardware

Multi-core debugging has been validated on:

- **PSoC6** (CM0+ / CM4) with OpenOCD and JLink
- **STM32H7** (Cortex-M7 / M4) with OpenOCD
- Other dual-core Cortex-M devices with gdb-server support for multi-target configs
