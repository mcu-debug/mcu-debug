---
sidebar_position: 5
title: STLink
---

# STLink GDB Server

The STLink GDB Server is ST Microelectronics' dedicated gdb-server for ST-Link probes. It provides a straightforward alternative to OpenOCD for STM32 targets when you are using an ST-Link probe (such as those built into Nucleo and Discovery boards).

## Prerequisites

Install one of:

- **STM32CubeIDE** (includes the GDB server): [st.com](https://www.st.com/en/development-tools/stm32cubeide.html)
- **ST-LINK Utility** (standalone): [st.com](https://www.st.com/en/development-tools/stsw-link004.html)
- **STM32CubeProgrammer** (also includes GDB server): [st.com](https://www.st.com/en/development-tools/stm32cubeprog.html)

The GDB server binary is typically `ST-LINK_gdbserver` or `ST-LINK_gdbserver.exe`.

## launch.json Configuration

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug (STLink)",
  "servertype": "stlink",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "serverPath": "/opt/st/stm32cubeide_1.14.0/plugins/com.st.stm32cube.ide.mcu.externaltools.stlink-gdb-server.linux64_2.1.200.202304270827/tools/bin/ST-LINK_gdbserver"
}
```

### Key Properties

| Property | Description |
|----------|-------------|
| `serverPath` | Full path to the `ST-LINK_gdbserver` binary. The path varies by installation and platform. |
| `serverArgs` | Extra arguments to the STLink GDB server |

## Limitations

Compared to OpenOCD, the STLink GDB Server:

- Supports only ST-Link probes (not CMSIS-DAP, JLink, FTDI, etc.)
- Has more limited target support (primarily STM32 family)
- Has less community documentation

For most STM32 development, OpenOCD with `interface/stlink.cfg` is equally capable and more widely documented.

## Common Issues

### Binary not found

The `serverPath` must point to the exact binary location. The path is deep inside the STM32CubeIDE installation directory and changes between versions. Use the `find` command or file manager to locate it:

```sh
find /opt/st -name "ST-LINK_gdbserver" 2>/dev/null
```

### Probe already in use

If VS Code's ST-LINK extension or STM32CubeProgrammer has the probe open, the STLink GDB server may fail to connect. Close other tools before starting a debug session.
