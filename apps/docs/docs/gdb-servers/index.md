---
sidebar_position: 1
title: GDB Servers
---

# GDB Servers

A gdb-server is a bridge between GDB and your hardware debug probe. It listens for GDB connections on a TCP port and translates them into the low-level commands your specific probe understands. The gdb-server may also provide services like RTT/SWO

The `servertype` property in `launch.json` selects which gdb-server mcu-debug manages.

## Supported GDB Servers

| Server                           | Probe Compatibility                                           | Best For                                            | Notes                                                |
| -------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| [OpenOCD](./openocd.md)          | Most probes (KitProg3, ST-Link, CMSIS-DAP, JLink, FTDI, etc.) | General purpose, open source, widest target support | Most commonly used; highly configurable via scripts  |
| [JLink GDB Server](./jlink.md)   | JLink probes only                                             | Maximum performance with JLink hardware             | Requires SEGGER JLink software; proprietary          |
| [pyOCD](./pyocd.md)              | CMSIS-DAP probes                                              | Python ecosystem, Mbed targets                      | Pip install; good for Mbed/ARM evaluation boards     |
| [STLink GDB Server](./stlink.md) | ST-Link probes                                                | STM32 targets with ST-Link                          | Ships with STM32CubeIDE; simpler config than OpenOCD |

## Choosing a GDB Server

- **Rule #1**: Use the gdb server provided by your silicon vendor even if it is openocd. They have customizations not available in public releases
- **If you have an KitProg3, ST-Link, JLink, CMSIS-DAP, or FTDI probe and need maximum target support**: use OpenOCD
- **If you have a JLink probe and performance is important**: use JLink GDB Server
- **If you have a CMSIS-DAP probe and prefer Python tooling**: use pyOCD
- **If you have an ST Nucleo/Discovery board and are using STM32CubeIDE**: use STLink GDB Server

When in doubt, start with OpenOCD — it supports the most hardware combinations and has the largest community.

## Multiple Probes

If you have multiple probes connected simultaneously, use the `serialNumber` property if using JLink/ST-Link/stutil. Otherwise, use `serverArgs` property to pass probe serial numbers or USB IDs to the gdb-server to select the correct one. See the individual server pages for details.
