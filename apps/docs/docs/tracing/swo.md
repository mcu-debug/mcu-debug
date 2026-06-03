---
sidebar_position: 4
title: SWO
---

# SWO

:::caution
SWO support is limited and may not work with all targets. RTT is recommended as a more reliable alternative for most use cases.
:::

## Overview

SWO (Single Wire Output) uses the ITM (Instrumentation Trace Macrocell) and TPIU (Trace Port Interface Unit) peripherals built into Cortex-M3, M4, and M7 to output trace data over a dedicated SWO pin on the debug connector.

## Limitations

Before choosing SWO, consider these limitations:

- **Requires SWO pin exposure**: the debug connector must expose the SWO pin. Many PCBs omit this pin even when the MCU supports SWO. Many USB debug probes do not expose SWO even when the connector has it.
- **Requires correct CPU clock setup**: the SWD/SWO divider must be configured with the exact CPU clock frequency at session start. If the firmware changes the clock (e.g. PLL setup in `SystemInit`), SWO output may become garbled.
- **Vendor-specific peripheral map**: slight differences in ITM/TPIU memory map across vendors can prevent correct automatic setup.
- **Not supported on Cortex-M0/M0+**: these cores do not have ITM/TPIU.
- **Not compatible with multi-core configurations**: SWO is a single global channel.

## When to Use RTT Instead

RTT is strongly preferred for new projects:

| | RTT | SWO |
|-|-----|-----|
| Extra pins | None | SWO pin |
| Cortex-M0/M0+ | Yes | No |
| Multi-core | Yes | No |
| Throughput | High | Low |
| Clock dependency | None | Yes |
| Probe support | All | Probe and PCB dependent |

## launch.json Configuration

If SWO is the only option for your setup:

```json
"swoConfig": {
  "enabled": true,
  "cpuFrequency": 168000000,
  "swoFrequency": 2000000,
  "decoders": [
    {
      "type": "console",
      "label": "ITM",
      "port": 0
    }
  ]
}
```

### Key Properties

| Property | Description |
|----------|-------------|
| `cpuFrequency` | CPU clock in Hz at the time the debug session starts. Must match the actual running frequency. |
| `swoFrequency` | Desired SWO output frequency in Hz. Lower values are more reliable. |
| `decoders` | ITM stimulus port decoders — each ITM channel (0–31) can have its own decoder. |

## Firmware Setup

Enable ITM in firmware to use SWO:

```c
// Enable ITM stimulus port 0 for character output
CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
ITM->LAR = 0xC5ACCE55;  // unlock
ITM->TER = 0x1;         // enable port 0

// Write a character
ITM_SendChar('A');
```

Or use the `ITM_SendChar` function from CMSIS `core_cm4.h`.
