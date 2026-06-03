---
sidebar_position: 2
title: Live Watch
---

# Live Watch

Live Watch monitors variable values while the target is running, without halting execution. It provides a continuous stream of values from your firmware at debug time.

## How It Works

Live Watch uses a second GDB connection to the gdb-server to read memory while the first GDB connection is running the target. The target continues executing uninterrupted. Memory reads happen over the SWD debug port, which supports access while the CPU is running.

This is different from the standard VS Code Watch panel, which only updates when the target is halted.

## Using Live Watch

1. Start a debug session
2. Open the **Watch** panel in the Run and Debug sidebar (or Debug Console)
3. Add a variable expression — Live Watch activates automatically for supported expressions
4. Values update on each polling interval

The Watch panel in VS Code shows Live Watch values with a small "live" indicator when the target is running.

## Limitations

Live Watch only works reliably with:

- **Global variables** — fixed addresses in the `.data` or `.bss` section
- **Static local variables** — fixed addresses in the map file

**Stack (automatic) variables** have addresses that depend on the call stack at a given moment. Reading them while the target runs may give incorrect values since the stack frame may not be active. To monitor stack variables, use a hardware breakpoint and inspect when halted.

## Performance

The polling rate controls how often mcu-debug reads memory and updates values. Faster polling gives more responsive updates but increases SWD bus traffic.

:::note
Very high polling rates on heavily loaded systems may affect debug session responsiveness. The default rate is suitable for most use cases.
:::

## Supported Expressions

Any GDB expression that resolves to a fixed memory address works with Live Watch:

- Simple global: `my_global_counter`
- Structure member: `g_config.timeout_ms`
- Array element: `g_buffer[0]`
- Dereference: `*p_sensor` (if `p_sensor` is a global pointer)
- Arbitrary address: `*(uint32_t*)0x20000100`
