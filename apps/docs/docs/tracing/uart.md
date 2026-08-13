---
sidebar_position: 3
title: UART
---

# UART

## Overview

UART serial output is supported as a first-class debug channel in mcu-debug, alongside RTT and SWO. It is useful for targets that already use UART for debug output, or in situations where RTT is not available.

UART output appears in the mcu-debug output stream with a source tag, interleaved with RTT and GDB output.

## launch.json Configuration

```json
"serialConfig": {
  "enabled": true,
  "uarts": [
    {
      "label": "Debug UART",
      "port": "/dev/ttyUSB0",
      "baud": 115200
    }
  ]
}
```

Multiple UARTs are supported:

```json
"serialConfig": {
  "enabled": true,
  "uarts": [
    {
      "label": "App",
      "port": "/dev/ttyUSB0",
      "baud": 115200
    },
    {
      "label": "Bootloader",
      "match": "kitprog3",    // Matches serial ports that has this sub-string in the deescrioption
      "baud": 9600
    }
  ]
}
```

## Port Naming

| Platform | Format                           | Example                |
| -------- | -------------------------------- | ---------------------- |
| Linux    | `/dev/ttyUSBn` or `/dev/ttyACMn` | `/dev/ttyUSB0`         |
| macOS    | `/dev/cu.usbmodem*`              | `/dev/cu.usbmodem1101` |
| Windows  | `COMn`                           | `COM3`                 |

**macOS note**: use `cu.*` ports, not `tty.*` ports. The `tty.*` variant hangs on open until a carrier is detected, which many USB-UART adapters never assert.

## Output Tags

The `label` property controls the output tag. Without a label, the tag is derived from the port name:

```
[UART:Debug UART]  Counter: 123      ← with label "Debug UART"
[UART:ttyUSB0]     Counter: 123      ← without label, on Linux
```

## Bidirectional Communication

UART channels are bidirectional. In TUI mode or the Glass Cockpit panel, you can type input and send it to the target's UART receive buffer. This is useful for interactive debug menus or command interfaces embedded in firmware.

In terminal mode, use the standard input line to send data to the target.

## Using Variables for Port Names

Use `envFile` to keep port names out of `launch.json` (since they vary by machine):

```sh
# .env
DEBUG_PORT=/dev/ttyUSB0
```

```json
"serialConfig": {
  "enabled": true,
  "uarts": [
    {
      "label": "Debug",
      "port": "${env:DEBUG_PORT}",
      "baud": 115200
    }
  ]
}
```

## Which Ports the Picker Shows

TBD: User interface for the Picker is not yet available. Coming soon

**MCU Debug: List Available Serial Ports** lists ports from every probe host mcu-debug is
currently connected to, each tagged with its source. Two things decide what appears:

1. **Your workspace's own probe host.** The command connects to it if it is not already
   connected, so the list works with no debug session running. For a local workspace that
   is your machine; from inside WSL or a Dev Container it is the *host* the workspace runs
   on, not the guest.
2. **Any probe host a running debug session reached.** Sessions register their connections,
   and the picker aggregates across all of them — so a lab server's ports appear once a
   session using it has started, and keep appearing while that connection lives.

The same device path on two hosts (two boards both at `/dev/ttyACM0`) stays distinct; the
source tag is what tells them apart.

:::note
There is no way to connect to an arbitrary probe host *without* a debug session. Remote
ports become visible once a session has opened the connection, and — because a serial view
outlives the session that created it — they stay visible afterwards. If you want a remote
host's ports available without debugging, start a session against it once.
:::

## Common Issues

### Permission denied (Linux)

Add your user to the `dialout` group:

```sh
sudo usermod -a -G dialout $USER
```

Log out and log back in for the group change to take effect.

### Port not found

- Disconnect and reconnect the USB-UART adapter
- On macOS: check for `cu.*` entries with `ls /dev/cu.*`
- On Windows: check Device Manager for the COM port number
