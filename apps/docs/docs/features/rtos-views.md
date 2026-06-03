---
sidebar_position: 7
title: RTOS Views
---

# RTOS Views

Thread-aware debugging for embedded RTOS firmware is provided by the **rtos-views** companion extension.

## Installation

Install the rtos-views extension from the VS Code Marketplace:

1. Open the Extensions panel
2. Search for **rtos-views**
3. Install the extension published by **mcu-debug**

Or install from the CLI:

```sh
code --install-extension mcu-debug.rtos-views
```

The rtos-views extension is separate from mcu-debug so that RTOS support can be updated independently.

## Supported RTOSes

| RTOS | Support Level |
|------|--------------|
| FreeRTOS | Full (thread list, state, stack usage) |
| ThreadX / Azure RTOS | Full |
| Zephyr | Partial |
| Others | Community contributions welcome |

## Features

When a supported RTOS is detected in the firmware:

- **Thread list**: all threads with their current state (Running, Ready, Blocked, Suspended)
- **Stack usage**: current stack depth and stack watermark (if the RTOS tracks it)
- **Thread-aware backtrace**: view the call stack of any thread, not just the currently running one
- **Task names**: human-readable task names from the RTOS task control blocks

## Using RTOS Views

RTOS views appear automatically in the Run and Debug sidebar when:

1. mcu-debug is connected to a target
2. The target is halted (at a breakpoint or after stepping)
3. rtos-views recognizes an RTOS in the ELF file's symbol table

No special `launch.json` configuration is required — rtos-views reads the RTOS data structures from their known addresses in the ELF symbol table.

## GitHub

Source code and issue tracker: [github.com/mcu-debug/rtos-views](https://github.com/mcu-debug/rtos-views)
