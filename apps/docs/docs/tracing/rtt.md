---
sidebar_position: 2
title: RTT (Real-Time Transfer)
---

# RTT (Real-Time Transfer)

## Overview

RTT (Real-Time Transfer) is SEGGER's protocol for bidirectional communication over the SWD debug connection. No extra pins are required — RTT uses the same two-wire SWD interface already used for debugging.

mcu-debug implements its own RTT server built directly into the debug adapter. It works with any gdb-server that supports multiple simultaneous GDB connections: OpenOCD, JLink, and pyOCD all qualify.

## Firmware Setup

Add an RTT library to your firmware. Options:

- **SEGGER RTT** (official): download from [segger.com](https://www.segger.com/products/debug-probes/j-link/technology/about-real-time-transfer/)
- **Any compatible implementation**: the protocol is documented and several open-source implementations exist

Key usage in C:

```c
#include "SEGGER_RTT.h"

// Simple printf-style output on channel 0
SEGGER_RTT_printf(0, "Hello World! counter=%d\n", counter);

// Low-level write
SEGGER_RTT_Write(0, data, length);
```

Channel 0 is the default console channel and is what most firmware uses.

## launch.json Configuration

```json
"rttConfig": {
  "enabled": true,
  "useBuiltinRTT": true,
  "decoders": [
    { "port": 0, "type": "console" }
  ]
}
```

Full example with multiple channels:

```json
"rttConfig": {
  "enabled": true,
  "useBuiltinRTT": true,
  "decoders": [
    { "port": 0, "type": "console", "label": "Console" },
    { "port": 1, "type": "console", "label": "Diagnostics" }
  ]
}
```

## Builtin RTT

`mcu-debug` has its own RTT service available that works as well or better than RTT support builtin to various gdb-servers. The requirement is that the gdb-server has to support multiple gdb connections. This is the same requirement for `liveWatch`. Known gdb-servers are (OpenOCD, pyOCD, JLink). The builtin decode is much more flexible and supports multiple channels with ease. [More about builtin RTT](builtin-rtt.md)

## Decoder Types

| Type              | Description                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| `"console"`       | UTF-8 text, displayed in the output panel. Default for most firmware.         |
| `"binary"`        | Raw bytes. Provides the raw data stream for custom processing.                |
| JavaScript plugin | Custom decoder via a JS file. Specify with `"decoder": "/path/to/plugin.js"`. |

## Pre-decoder

You can use the `pre_decoder` property to specify a custom decoder program written in any language. It should accept input on stdin and decode output to stdout. The output of this program can then become input to all the decoders.

## defmt Support

[defmt](https://defmt.ferrous-systems.com/) is a highly efficient deferred formatting logging framework for Rust embedded. mcu-debug has built-in defmt decoding.

To use defmt with RTT:

1. Use the `defmt-rtt` crate in your Rust firmware
2. You can use the `pre_decoder` option to process the defmt formatted stream that can then funnel to all the other decoders
3. Add at least one decoder to display the output of the pre_decoder

Example of using a `pre_decoder`

```json
"rttConfig": {
    "enabled": true,
    "address": "auto",
    "useBuiltinRTT": {
        "enabled": true,
        // "port": 9001
    },
    "pre_decoder": {
        "program": "defmt-print",
        "args": ["-e", "${executable}"],  // You can specify any ELF file here
        "channels": [0]         // You can have defmt on multiple channels
    },
    "decoders": [
        {
          "label": "Rust Logs",
          "port": 0,
          "type": "console"
        }
    ]
}
```

The ELF file provides the format string table — no separate parsing step or host-side tool is needed.

## Multiple Channels

RTT supports up to 16 up (firmware-to-host) channels and 16 down (host-to-firmware) channels. Each channel gets its own decoder configuration and its own tag in the output:

```
[RTT#0]   Console output from channel 0
[RTT#1]   Diagnostic output from channel 1
```

You can attach multiple decoders to one channel if you want both raw and decoded output.

## Bidirectional Communication

RTT channels are bidirectional. You can send data to the firmware's down-buffer from the CLI input line. This is useful for interactive debug menus embedded in firmware.

## Performance

- Default polling rate: 10ms
- Bottleneck: SWD bandwidth (not polling rate)
- Typical throughput: hundreds of KB/s at 4 MHz SWD clock
- No firmware blocking: RTT uses a ring buffer; the firmware writes even if the host isn't polling

## Common Issues

### RTT not receiving data

- Verify `rttConfig.enabled: true` in `launch.json`
- Ensure RTT is initialized in firmware **before** mcu-debug connects. Use `runToEntryPoint: "main"` so the firmware initializes before RTT polling starts.
- Verify the gdb-server supports multiple GDB connections (OpenOCD default: yes)

### Output appears garbled

- Check that the decoder type matches the firmware output format
- For binary protocols, switch to `"type": "binary"` and inspect the raw bytes
