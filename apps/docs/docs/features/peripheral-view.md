---
sidebar_position: 5
title: Peripheral View
---

# Peripheral View

The Peripheral View displays the peripheral registers of your MCU in a tree structure, with each register's current value and the descriptions of its bitfields — sourced from the MCU vendor's SVD file.

## Setup

Add the `svdFile` property to your `launch.json`:

```json
{
  "type": "mcu-debug",
  "request": "launch",
  "name": "Debug",
  "servertype": "openocd",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "svdFile": "${workspaceFolder}/STM32F407.svd"
}
```

## Finding SVD Files

SVD (System View Description) files are provided by MCU vendors:

- **STM32**: included in STM32CubeIDE, or download from [st.com](https://www.st.com). Also available in the [cmsis-svd](https://github.com/cmsis-svd/cmsis-svd) repository.
- **Nordic**: included in nRF SDK
- **NXP, Microchip, etc.**: available from their respective IDEs and CMSIS packs

The `cmsis-svd` GitHub repository aggregates SVD files for hundreds of MCUs.

## Using the Peripheral View

The Peripheral View panel opens in the Run and Debug sidebar when a session is active and `svdFile` is configured.

- **Expand** a peripheral to see its registers
- **Expand** a register to see its bitfields
- Values update automatically when the target halts
- **Click a register value** to edit it — the write goes directly to the peripheral

## What the SVD Provides

| SVD Content | What it Enables |
|-------------|----------------|
| Peripheral base addresses | Register address calculation |
| Register offsets | Individual register addresses |
| Bitfield positions and widths | Bitfield decode in the view |
| Descriptions | Hover tooltips for each field |
| Access type (R/W/RO) | Prevents invalid writes |

## Limitations

- Values only update when the target is halted (not during live execution)
- Some vendor SVD files have errors — incorrect addresses or bitfield definitions. If a register shows unexpected values, cross-check with the datasheet.
- Very large SVD files (complex SoCs) may take a moment to parse on first open
