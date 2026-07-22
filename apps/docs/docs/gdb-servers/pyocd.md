---
sidebar_position: 4
title: pyOCD
---

# pyOCD

pyOCD is a Python-based GDB server supporting CMSIS-DAP compatible debug probes. It is the official debugger for Mbed and Mbed-enabled boards, and works well with many evaluation boards.

## Installation

```sh
pip install pyocd
```

Or with pipx for isolated installation:

```sh
pipx install pyocd
```

Verify:

```sh
pyocd --version
```

### Device Support Packs

pyOCD uses CMSIS packs for device-specific support. Install a pack for your target:

```sh
pyocd pack install stm32f4
pyocd pack install nrf52
```

List available targets:

```sh
pyocd list --targets
```

## launch.json Configuration

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug (pyOCD)",
  "servertype": "pyocd",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "targetId": "stm32f407vg"
}
```

### Key Properties

| Property | Description |
|----------|-------------|
| `targetId` | pyOCD target identifier (e.g. `stm32f407vg`, `nrf52840`). Run `pyocd list --targets` for valid values. |
| `boardId` | Specific board to use when multiple are connected (the DAPLink board ID) |
| `serverpath` | Path to the `pyocd` binary if not on `PATH` |
| `serverArgs` | Extra command-line arguments to pyOCD |

## Connecting to a Specific Probe

If multiple CMSIS-DAP probes are connected:

```json
"serverArgs": ["--uid", "0240000034544e45001700068084e4e600000000097969900"]
```

Find UIDs with:

```sh
pyocd list
```

## Common Issues

### "No connected probes"

- Probe is not connected, not recognized, or requires udev rules (Linux)
- On Linux: install CMSIS-DAP udev rules. Many Linux distributions include them, or install the `libusb` dev package.

### Target not supported

```sh
pyocd pack install <target>
```

Or check the available targets:

```sh
pyocd pack find <partial-name>
```
