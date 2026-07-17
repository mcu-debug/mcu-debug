---
sidebar_position: 2
title: OpenOCD
---

# OpenOCD

OpenOCD (Open On-Chip Debugger) is the most widely used open source gdb-server. It supports hundreds of targets and most common debug probes.

## Installation

- **macOS**: `brew install open-ocd`
- **Ubuntu/Debian**: `sudo apt install openocd`
- **Windows**: download from [openocd.org](https://openocd.org/pages/getting-openocd.html) or install via [xPack OpenOCD](https://xpack.github.io/dev-tools/openocd/)
- **From source**: see the [OpenOCD documentation](https://openocd.org/doc/html/index.html)

Verify installation:

```sh
openocd --version
```

## launch.json Configuration

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug (OpenOCD)",
  "servertype": "openocd",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "configFiles": [
    "interface/stlink.cfg",
    "target/stm32f4x.cfg"
  ],
  "searchDir": [],
}
```

### Key Properties

| Property      | Description                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `configFiles` | OpenOCD config files, in order. Relative paths are resolved against OpenOCD's scripts directory and `searchDir` entries. |
| `searchDir`   | Additional directories to search for config files. Add custom board config directories here.                             |
| `serverPath`  | Path to `openocd` binary if not on `PATH`.                                                                               |
| `serverArgs`  | Extra arguments to pass to OpenOCD.                                                                                      |

## Config Files

OpenOCD configuration is split into two parts:

1. **Interface config** (`interface/`): configures the probe. Examples: `interface/stlink.cfg`, `interface/jlink.cfg`, `interface/cmsis-dap.cfg`
2. **Target config** (`target/`): configures the MCU. Examples: `target/stm32f4x.cfg`, `target/nrf52.cfg`, `target/psoc6.cfg`

These files live in the OpenOCD scripts directory (e.g. `/usr/share/openocd/scripts/` on Linux). You can also write custom board config files and add their directory to `searchDir`.

### Board Config Files

Some boards have dedicated config files that combine interface and target config:

```json
"configFiles": ["board/st_nucleo_f4.cfg"]
```

Board configs are in the `board/` subdirectory of the OpenOCD scripts directory.

### Custom Config with openocd-helpers.tcl

mcu-debug ships an `openocd-helpers.tcl` file that provides common reset and flash helper procedures. This file is automatically sourced during sessions — you can call these procedures in `overrideLaunchCommands`.

## Common Issues

### "Error: unable to find JTAG device"

OpenOCD cannot find a probe. Check:
- Is the probe physically connected and recognized by the OS? (`lsusb` on Linux, Device Manager on Windows)
- Is the correct interface config file selected?
- Are OpenOCD udev rules installed on Linux? (usually required for USB access without root)

### "Error: couldn't bind tcl to socket"

The TCL port (default 55550) is already in use — another OpenOCD instance is running. But, since we generate new random ports, this may be a bug in the extension.

### "Error: open failed" for config file

OpenOCD cannot find the specified config file. Check:
- Spelling and capitalization of the config file path
- Add the directory containing your custom configs to `searchDir`
- Run OpenOCD manually with the same `-f` arguments to see the full error

### Selecting a Specific Probe

If multiple probes are connected:

```json
"serverArgs": ["-c", "hla_serial AABBCCDD1122"]
```

Replace `AABBCCDD1122` with your ST-Link serial number (visible in the OpenOCD output when it first connects).
