---
sidebar_position: 1
title: Tracing Overview
---

# Tracing Overview

mcu-debug supports three channels for capturing debug output from your firmware while the target runs. All channels are active simultaneously and their output is interleaved in the debug output panel with source tags.

## Channels at a Glance

| Channel | Pins Required | Setup Complexity | Performance | Recommended |
|---------|--------------|-----------------|-------------|-------------|
| [RTT](./rtt.md) | None (uses SWD) | Easy | High (hundreds of KB/s) | Yes — for most projects |
| [UART](./uart.md) | One TX pin | Easy | Medium | Yes — when UART is already available |
| [SWO](./swo.md) | SWO pin | Complex | Low | Limited — see SWO page |

## Output Tagging

All channels produce tagged output in the mcu-debug output stream:

```
[RTT#0]    Hello from main loop, counter=42
[RTT#1]    [DEBUG] DMA transfer complete
[UART:Debug UART] NMEA: $GPGGA,120000.00,...
[SWO ch0]  0x42 0x43
```

Tags make it easy to filter by source in the output panel and in the CLI. In AI-assisted debugging, the tags give the AI complete context about which component generated each line.

## Enabling Multiple Channels

All three channels can be active in the same session:

```json
{
  "rttConfig": {
    "enabled": true,
    "decoders": [{ "port": 0, "type": "console" }]
  },
  "uartConfig": {
    "enabled": true,
    "uarts": [{ "label": "Debug UART", "port": "/dev/ttyUSB0", "baud": 115200 }]
  }
}
```

## Recommendations

For new projects: **use RTT**. It requires no extra pins, works on all Cortex-M variants, has the highest throughput, and is supported across all gdb-servers that mcu-debug uses.

UART is the right choice when you have existing firmware that already uses UART for debug output, or when you want to capture output from a target that doesn't have SWD exposed.

SWO is rarely needed and has significant limitations. See the [SWO page](./swo.md) for details.
