---
sidebar_position: 1
title: Debug Features
---

# Debug Features

mcu-debug extends basic GDB debugging with several features designed for embedded development. These go beyond run, pause, step, and breakpoints to give you visibility into your target's state while it is running.

## Feature Overview

| Feature | Description |
|---------|-------------|
| [Live Watch](./live-watch.md) | Monitor variable values in real time while the target runs — no halt required |
| [Disassembly](./disassembly.md) | View and step through ARM assembly interleaved with source code |
| [Memory View](./memory-view.md) | Inspect and modify any memory address, with hex/decimal/binary display |
| [Peripheral View](./peripheral-view.md) | Browse peripheral registers and bitfields using SVD files from your MCU vendor |
| [Multi-core](./multi-core.md) | Debug CM0+ and CM4 cores simultaneously on devices like PSoC6 |
| [RTOS Views](./rtos-views.md) | Thread-aware debugging via the rtos-views companion extension |

## Debug Output Channels

In addition to the features above, mcu-debug supports three channels for capturing debug output from the target while it runs. These are covered in the [Tracing](../tracing/index.md) section:

- **RTT** — bidirectional communication over the SWD debug connection, no extra pins
- **UART** — serial port output from a UART on the target
- **SWO** — ITM/TPIU trace output (limited support)
