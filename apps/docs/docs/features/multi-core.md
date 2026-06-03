---
sidebar_position: 6
title: Multi-core Debugging
---

# Multi-core Debugging

mcu-debug supports debugging multi-core MCUs where you need to inspect both cores simultaneously — for example, a PSoC6 with a CM0+ and a CM4.

## Overview

Each core gets its own GDB instance. The cores are launched as separate debug sessions linked via `chainedConfigurations`, which causes mcu-debug to start them together.

## Configuration

Use `numberOfProcessors`, `targetProcessor`, and `chainedConfigurations`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "mcu-debug",
      "request": "launch",
      "name": "PSoC6 CM4 (primary)",
      "servertype": "openocd",
      "executable": "${workspaceFolder}/build/cm4/firmware.elf",
      "configFiles": ["interface/kitprog3.cfg", "target/psoc6_2m.cfg"],
      "numberOfProcessors": 2,
      "targetProcessor": 1,
      "runToEntryPoint": "main",
      "chainedConfigurations": {
        "enabled": true,
        "waitOnEvent": "postInit",
        "configurations": [
          {
            "name": "PSoC6 CM0+ (secondary)",
            "folder": "${workspaceFolder}"
          }
        ]
      }
    },
    {
      "type": "mcu-debug",
      "request": "launch",
      "name": "PSoC6 CM0+ (secondary)",
      "servertype": "openocd",
      "executable": "${workspaceFolder}/build/cm0/firmware.elf",
      "configFiles": ["interface/kitprog3.cfg", "target/psoc6_2m.cfg"],
      "numberOfProcessors": 2,
      "targetProcessor": 0,
      "runToEntryPoint": "Cy_SysEnableCM4"
    }
  ]
}
```

### Key Properties

| Property | Description |
|----------|-------------|
| `numberOfProcessors` | Total number of CPU cores on the device |
| `targetProcessor` | Which core this configuration targets (0-indexed) |
| `chainedConfigurations` | Describes additional configurations to launch together |
| `chainedConfigurations.waitOnEvent` | When to start the secondary: `"postInit"` (after primary GDB connects) or `"postStart"` |

## How It Works

1. VS Code launches the primary configuration (CM4 in the example above)
2. mcu-debug connects GDB to the CM4 core
3. After the `waitOnEvent` condition is met, VS Code launches the secondary configuration (CM0+)
4. A separate GDB connects to the CM0+ core
5. Both sessions appear in the VS Code Call Stack panel — you can switch between cores

## Stepping Behavior

Each core is controlled independently. Stepping on CM4 does not affect CM0+. Use the session selector in the Call Stack panel to switch between cores.

## Breakpoints

Breakpoints are per-session (per-core). A breakpoint set in a CM4 source file affects only the CM4 GDB session. If both cores share code (e.g. common libraries), you may need to set breakpoints in both sessions.

## Supported Hardware

Multi-core debugging has been validated on:

- **PSoC6** (CM0+ / CM4) with OpenOCD
- **STM32H7** (Cortex-M7 / M4) with OpenOCD
- Other dual-core Cortex-M devices with gdb-server support for multi-target configs
