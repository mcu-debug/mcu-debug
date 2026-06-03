---
sidebar_position: 4
title: Memory View
---

# Memory View

The Memory View lets you inspect and modify any memory region in your target while the debug session is active.

## Opening the Memory View

While a debug session is active:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type **Memory** and select **Debug: Open Memory View**

Or click the memory icon in the Variables panel next to a pointer variable.

## Entering an Address

Enter any of the following in the address field:

- Hex address: `0x20000000`
- Symbol name: `g_my_buffer`
- GDB expression: `&my_struct.field`
- Register: `$sp` (stack pointer)

## Display Formats

The Memory View supports multiple display formats:

| Format | Useful For |
|--------|-----------|
| Hex bytes | General memory inspection, protocol buffers |
| Hex 32-bit words | Register dumps, word-aligned data |
| Decimal | Numeric values in readable form |
| Binary | Bit-field inspection |
| ASCII | String buffers, text data |

## Writing Values

You can modify memory values directly in the Memory View:

1. Click on a byte or word
2. Type the new value
3. Press Enter to write

:::caution
Writing to peripheral register addresses has the same effect as the hardware write — it can trigger hardware actions. Be cautious when writing to control registers.
:::

## Common Use Cases

- **Stack inspection**: enter `$sp` to view the current stack contents
- **Peripheral registers**: enter the peripheral base address to inspect registers not in the SVD file (or before the SVD loads)
- **Buffer contents**: enter a buffer pointer to see raw contents during a protocol debug session
- **DMA buffers**: monitor DMA source/destination buffers while the target runs (if memory-mapped without cache issues)
