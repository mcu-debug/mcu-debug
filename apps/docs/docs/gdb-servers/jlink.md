---
sidebar_position: 3
title: JLink
---

# JLink GDB Server

SEGGER's JLink GDB Server provides excellent performance and reliability for JLink debug probes.

## Prerequisites

Download and install the [JLink Software and Documentation Pack](https://www.segger.com/downloads/jlink/) from SEGGER. This installs `JLinkGDBServerCLExe` (Linux/macOS) or `JLinkGDBServerCL.exe` (Windows).

Verify installation:

```sh
JLinkGDBServerCLExe --version   # Linux/macOS
JLinkGDBServerCL.exe --version  # Windows
```

## launch.json Configuration

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug (JLink)",
  "servertype": "jlink",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "device": "STM32F407VG",
  "interface": "swd",
  "serverpath": "/opt/SEGGER/JLink/JLinkGDBServerCLExe"
}
```

### Key Properties

| Property | Description |
|----------|-------------|
| `device` | The JLink device name (e.g. `STM32F407VG`, `nRF52840_xxAA`). Exact name must match SEGGER's device database. |
| `interface` | Debug interface: `"swd"` (default) or `"jtag"` |
| `serverpath` | Path to `JLinkGDBServerCLExe` if not on `PATH` |
| `serverArgs` | Extra arguments to the JLink GDB Server |

## Finding the Device Name

The device name must exactly match an entry in SEGGER's device database. To find yours:

1. Open J-Flash or J-Link Commander
2. Connect to your target and check the auto-detected device name
3. Or browse the [SEGGER device database](https://www.segger.com/supported-devices/)

Common examples:

| MCU | Device Name |
|-----|-------------|
| STM32F407VG | `STM32F407VG` |
| nRF52840 | `nRF52840_xxAA` |
| LPC1768 | `LPC1768` |
| ATSAM4S | `ATSAM4SD32C` |

## JLink Speed

Default SWD clock speed may be too high for some targets. Reduce it:

```json
"serverArgs": ["-speed", "1000"]
```

Speed is in kHz. Start with 1000 kHz and increase to find the maximum stable speed.

## License Notes

The JLink GDB Server is free to use with genuine SEGGER JLink probes. Using it with third-party probes that identify as JLink (clones) may require a license. See SEGGER's licensing terms for details.

## Common Issues

### "Cannot connect to target"

- Reduce SWD speed: `"serverArgs": ["-speed", "1000"]`
- Check that the correct `device` name is used
- Ensure JLink firmware is up to date (J-Link Commander: `connect` then check for firmware update prompt)
- Verify the device is powered and the debug connector is correct

### "No JLink found"

- JLink is not connected or not recognized
- On Linux: ensure JLink udev rules are installed (`/etc/udev/rules.d/99-jlink.rules`). SEGGER's installer does this automatically.
