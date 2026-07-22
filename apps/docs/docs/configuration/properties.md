---
sidebar_position: 4
title: All Properties
---

# All Properties

This page lists all `launch.json` properties supported by mcu-debug, organized by category.

:::note
Full property reference coming soon. See the launch.json schema in the [Reference](../reference/launch-json-schema.md) section.
:::

VS Code IntelliSense provides inline documentation and autocompletion when editing `launch.json`. Hover over any property for its description and valid values.

## Required

| Property     | Description                                                                        |
| ------------ | ---------------------------------------------------------------------------------- |
| `type`       | Must be `"mcu-debug"`                                                              |
| `request`    | `"launch"` to start a fresh session, `"attach"` to connect to a running gdb-server |
| `servertype` | GDB server type: `"openocd"`, `"jlink"`, `"pyocd"`, `"stlink"`                     |
| `executable` | Path to the ELF file with debug symbols                                            |

## GDB Server (Common)

| Property      | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `serverpath`  | Path to the gdb-server binary; defaults to finding it on `PATH` |
| `serverArgs`  | Extra command-line arguments to pass to the gdb-server          |
| `searchDir`   | Additional directories to search for OpenOCD config files       |
| `configFiles` | OpenOCD config files (interface and target)                     |
| `device`      | JLink device name (JLink only)                                  |
| `targetId`    | pyOCD target ID (pyOCD only)                                    |
| `boardId`     | pyOCD board ID (pyOCD only)                                     |

## GDB

| Property          | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `gdbPath`         | Full path to the GDB binary                                          |
| `toolchainPrefix` | Prefix for `<prefix>-gdb`, e.g. `arm-none-eabi`                      |
| `debuggerArgs`    | Extra arguments passed to GDB at startup                             |
| `gdbTarget`       | GDB RSP target host:port; defaults to `localhost:<openocd-gdb-port>` |

## Session Behavior

| Property                | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `cwd`                   | Working directory for the debug session                     |
| `runToEntryPoint`       | Symbol name to run to after launch, e.g. `"main"`           |
| `breakAfterReset`       | If true, halt at the reset vector after a target reset      |
| `numberOfProcessors`    | Number of CPU cores to debug (multi-core targets)           |
| `targetProcessor`       | Which processor index to attach GDB to (multi-core targets) |
| `chainedConfigurations` | Launch additional debug configurations (for multi-core)     |

## GDB Commands

| Property                 | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `preLaunchCommands`      | GDB commands to run before connecting to target          |
| `postLaunchCommands`     | GDB commands to run after session is established         |
| `overrideLaunchCommands` | Replace the default launch sequence with custom commands |
| `preAttachCommands`      | GDB commands to run before attaching (attach mode)       |
| `postAttachCommands`     | GDB commands to run after attaching                      |
| `overrideAttachCommands` | Replace the default attach sequence                      |
| `overrideResetSequence`  | Custom GDB commands for target reset                     |

## Environment

| Property  | Description                                                   |
| --------- | ------------------------------------------------------------- |
| `envFile` | Path to a `.env` file with `NAME=VALUE` pairs                 |
| `env`     | Object with extra environment variables for the debug session |

## RTT

| Property             | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `rttConfig`          | RTT configuration block — see [RTT](../tracing/rtt.md) for full details |
| `rttConfig.enabled`  | Enable RTT (`true`/`false`)                                             |
| `rttConfig.decoders` | Array of decoder configurations (port, type, label)                     |

## UART

| Property             | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `uartConfig`         | UART configuration block — see [UART](../tracing/uart.md) for full details |
| `uartConfig.enabled` | Enable UART                                                                |
| `uartConfig.uarts`   | Array of UART port configurations (port, baud, label)                      |

## SWO

| Property                 | Description                                                             |
| ------------------------ | ----------------------------------------------------------------------- |
| `swoConfig`              | SWO configuration block — see [SWO](../tracing/swo.md) for full details |
| `swoConfig.enabled`      | Enable SWO                                                              |
| `swoConfig.cpuFrequency` | CPU frequency in Hz (required for SWO clock divider calculation)        |
| `swoConfig.swoFrequency` | Desired SWO output frequency in Hz                                      |
| `swoConfig.decoders`     | Array of ITM channel decoder configurations                             |

## Remote

| Property          | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `hostConfig`      | Remote host configuration — see [Remote Debugging](../remote/index.md) |
| `hostConfig.type` | `"auto"`, `"wsl"`, `"docker"`, `"ssh"`                                 |
| `hostConfig.host` | SSH hostname or alias (SSH mode only)                                  |

## Other

| Property     | Description                                     |
| ------------ | ----------------------------------------------- |
| `svdFile`    | Path to SVD file for Peripheral View            |
| `name`       | Configuration display name                      |
| `debugFlags` | Debug output flags (e.g. `{"gdbTraces": true}`) |
