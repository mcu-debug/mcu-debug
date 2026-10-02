---
sidebar_position: 2
title: RTT (Real-Time Transfer)
---

# RTT (Real-Time Transfer)

## Overview

RTT (Real-Time Transfer) is SEGGER's protocol for bidirectional communication over the SWD debug connection. No extra pins are required — RTT uses the same two-wire SWD interface already used for debugging.

mcu-debug implements its own RTT server built directly into the debug adapter. It works with any gdb-server that supports multiple simultaneous GDB connections: OpenOCD, JLink, and pyOCD all qualify.

## RTT: Two Modes

This project supports RTT in two ways. Most other debuggers only support the first.

**Standard mode (gdb-server TCP)**

- gdb-server (OpenOCD, JLink, etc.) handles RTT polling and exposes TCP ports.
- Limitations: JLink server allows only one channel; OpenOCD requires manual polling or a breakpoint to start RTT.

**Builtin - Alternate mode (GDB memory I/O)**

- mcu-debug adapter uses GDB to directly read/write the RTT control block in target memory.
- Bypasses the gdb-server for RTT data entirely.
- Supports up to 16 bidirectional RTT channels.
- Has an optional per-channel **pre-decoder** pipeline (e.g., `defmt-print` for Rust's defmt format).
- Performance bottleneck is the SWD interface, not the memory I/O round-trip; polling at 40 Hz is possible.

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
  "decoders": [
    { "port": 0, "type": "console" }
  ]
}
```

Full example with multiple channels:

```json
"rttConfig": {
  "enabled": true,
  "decoders": [
    { "port": 0, "type": "console", "label": "Console" },
    { "port": 1, "type": "console", "label": "Diagnostics" }
  ]
}
```

## Choosing an engine

`rttConfig.engine` selects which implementation reads RTT out of the target. You almost certainly
want the default.

| `engine`               | What it does                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `"auto"` (default)     | Our own engine, inside the Probe Agent. Falls back to the debug adapter's engine when the session has no Agent, and says so.                 |
| `"builtin-rust"`       | The Agent's engine, insisted upon. Fastest: it takes GDB and the MI text layer out of every memory read, which is where RTT throughput goes. |
| `"builtin-typescript"` | The debug adapter's own engine, polling through GDB. Slower, but the only option for an external gdb-server.                                 |
| `"gdb-server"`         | The gdb-server's own RTT. OpenOCD and J-Link only, and needs server-side setup.                                                              |

Never two at once. Each engine keeps its own idea of the ring buffer's read pointer, so a pair of
them would consume each other's bytes and corrupt the channel. Whichever one runs, you get the same
ports, the same decoders and the same terminals.

`"auto"` never selects `"gdb-server"`. Both built-in engines work with every supported gdb-server,
including ones with no RTT support of their own, and support multiple channels with ease.
[More about builtin RTT](builtin-rtt.md)

### Where the built-in server listens

`rttConfig.serve` applies to the built-in engines, which bind the TCP ports themselves:

```json
"rttConfig": {
  "enabled": true,
  "serve": {
    "hostName": "127.0.0.1",
    "tcpPort": 19021,
    "tcpPorts": { "1": 19100 }
  },
  "decoders": [
    { "port": 0, "type": "console" },
    { "port": 1, "type": "console" }
  ]
}
```

`tcpPort` is where to _start looking_ for a free port; a busy port yields the next one rather than
failing the session. `tcpPorts` insists on an exact port for the channels it names, and wins over
`tcpPort` for those. Channels you do not name are allocated normally.

:::note Replaces `useBuiltinRTT`
`rttConfig.useBuiltinRTT` has been removed. It packed two unrelated decisions into one field, so it
is not translated automatically -- a configuration still using it reports an error naming the
replacement. `useBuiltinRTT: false` becomes `"engine": "gdb-server"`;
`useBuiltinRTT: { implementation: "typescript" }` becomes `"engine": "builtin-typescript"`; anything
else can simply be deleted. `hostName` and `tcpPort` move under `serve`.
:::

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

1. Use the [`defmt-print`](https://crates.io/crates/defmt-print) crate in your Rust firmware
2. You can use the `pre_decoder` option to process the defmt formatted stream that can then funnel to all the other decoders
3. Add at least one decoder to display the output of the pre_decoder

Example of using a `pre_decoder`

```json
"rttConfig": {
    "enabled": true,
    "address": "auto",
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

### RTT data contains data from previous session

- This can happen because a soft reset does not clear memory and thus can have remnants of the old RTT data until RTT is re-initialized after a reset

### RTT missing data

- When the server (builtin or other) inspects the memory RTT may have alrady started and if in non-blocking mode, may have circled around in the ring buffer.

### Output appears garbled

- Check that the decoder type matches the firmware output format
- For binary protocols, switch to `"type": "binary"` and inspect the raw bytes

### If RTT misbehaves, change one thing at a time

The two switches below are not the same switch, and the difference matters when you are trying to
find out what went wrong.

| Symptom                              | Try                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| RTT output is wrong, missing or slow | `"engine": "builtin-typescript"` -- removes the Agent's RTT engine but **keeps** the RSP multiplexer |
| The debug session itself misbehaves  | `"debugFlags": { "rspMux": false }` -- takes the multiplexer out of the path entirely                |
| Neither helps, on OpenOCD or J-Link  | `"engine": "gdb-server"` -- hands RTT back to the gdb-server                                         |

Setting `rspMux: false` also forces the RTT engine to `builtin-typescript`, since the Agent's engine
reads target memory through the multiplexer. That is reported in the Debug Console rather than
applied silently: `rspMux: false` is normally set to isolate a problem, and quietly changing a second
thing at the same time would make the result meaningless.
