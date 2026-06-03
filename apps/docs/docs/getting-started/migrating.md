---
sidebar_position: 5
title: Migrating from Cortex-Debug
---

# Migrating from Cortex-Debug

mcu-debug is the successor to **Cortex-Debug**, written by the same author. If you have existing projects using Cortex-Debug, this page explains what changed and what you need to update.

## Background

Cortex-Debug was the original VS Code embedded debug extension. mcu-debug is a ground-up rewrite that adds the CLI tool, AI integration, RTT server improvements, remote debugging support, and a cleaner architecture. Most `launch.json` configurations migrate with minimal changes.

## Extension ID

The most important change is the extension identifier:

|              | Extension ID           |
| ------------ | ---------------------- |
| Cortex-Debug | `marus25.cortex-debug` |
| mcu-debug    | `mcu-debug.mcu-debug`  |

In `launch.json`, the `type` field changes accordingly:

```json
// Cortex-Debug
"type": "cortex-debug"

// mcu-debug
"type": "mcu-debug"
```

Both extensions can be installed simultaneously. You can run Cortex-Debug configs from your old projects while migrating new projects to mcu-debug.

## Property Name Changes

Most properties carry over unchanged. The following table covers the common ones that changed or were added:

| Cortex-Debug Property    | mcu-debug Equivalent | Notes                                        |
| ------------------------ | -------------------- | -------------------------------------------- |
| `type: "cortex-debug"`   | `type: "mcu-debug"`  | Required change                              |
| `servertype`             | `servertype`         | Unchanged                                    |
| `executable`             | `executable`         | Unchanged                                    |
| `device` (JLink)         | `device`             | Unchanged                                    |
| `interface`              | `interface`          | Unchanged (swd/jtag)                         |
| `configFiles`            | `configFiles`        | Unchanged                                    |
| `svdFile`                | `svdFile`            | Unchanged                                    |
| `rtos`                   | `rtos`               | Unchanged                                    |
| `swoConfig`              | `swoConfig`          | Unchanged (not supported in CLI mode)        |
| `rttConfig`              | `rttConfig`          | Enhanced — see [RTT docs](../tracing/rtt.md) |
| `showDevDebugOutput`     | N/A                  | See [Debug Flags](#debug-flags)              |
| `showDevDebugTimestamps` | N/A                  |                                              |

## New Properties in mcu-debug

Properties that exist only in mcu-debug (no Cortex-Debug equivalent):

| Property     | Description                                               |
| ------------ | --------------------------------------------------------- |
| `uartConfig` | UART serial debug output — a first-class channel like RTT |
| `hostConfig` | Remote debugging configuration (WSL, Docker, SSH)         |
| `env`        | Specify additional environment variables for substituion  |
| `envFile`    | Load environment variables from a `.env` file             |
| `debugFlags` | Debug output controls (`gdbTraces`, etc.)                 |

## Debug Flags

Debug flags is now much more granular. These flags is to debug this extension itself. When issues arise, you can enable one or more flags to get more information. The flag `gdbTraces` is probably the most useful as you can see exactly which commands are sent to GDB and what GDB returns

```JSON
"debugFlags": {
    "gdbTraces": { type: "boolean", default: false, description: "Enable GDB MI trace output. Copy/Paste friendly." },
    "liveGdbTraces": { type: "boolean", default: false, description: "Enable live GDB MI trace output during polling (only applies to built-in liveWatch/RTT). Can be super verbose." },
    "vscodeRequests": { type: "boolean", default: false, description: "Enable VSCode Request/Response trace output" },
    "gdbTracesParsed": { type: "boolean", default: false, description: "Enable parsed GDB MI output. NOT Copy/Paste friendly." },
    "timestamps": { type: "boolean", default: false, description: "Show timestamps in debug output" },
    "debugDisassembly": { type: "boolean", default: false, description: "Show debug output from disassembly operations" },
    "pathResolution": { type: "boolean", default: false, description: "Show path resolution when reading symbols" },
    "disableGdbTimeouts": { type: "boolean", default: false, description: "Disable GDB command timeouts. Helpful for debugging extension" },
},
```

## Migration Steps

1. Install the mcu-debug extension from the marketplace
2. In each `launch.json`, change `"type": "cortex-debug"` to `"type": "mcu-debug"`
3. Test the configuration — most will work immediately

## Keeping Both Extensions

During a transition period, you can keep both extensions installed. Each extension only activates for its own `type` value, so there is no conflict. Old projects use `type: "cortex-debug"`, new ones use `type: "mcu-debug"`. You can even switch between the two just by editing the `type` value. With regards to settings, `cortex-debug.*` settings may still work but we recommend you switch those to `mcu-debug.*` (or make copies)
