---
sidebar_position: 3
title: Disassembly
---

# Disassembly

mcu-debug integrates with VS Code's built-in disassembly view to show ARM assembly for your firmware, interleaved with source code.

## Opening the Disassembly View

While paused at a breakpoint:

1. Right-click in the editor → **Open Disassembly View**
2. Or from the Command Palette: **Debug: Open Disassembly View**

The view shows assembly instructions with source lines interleaved where debug information is available.

## Stepping in Disassembly View

When the Disassembly View is focused:

- **Step Over** (F10): advances by one instruction, not one source line
- **Step Into** (F11): follows a branch instruction into the called function
- **Step Out** (Shift+F11): runs until the current function returns

This is useful for:
- Inspecting compiler-generated code around a suspicious source line
- Debugging interrupt handlers and startup code with no source
- Verifying that optimization-related issues are in the assembly, not the source

## ELF Parsing

mcu-debug uses the `da-helper` binary for fast ELF file parsing to extract symbol addresses and associate them with disassembly ranges. This avoids asking GDB to disassemble large regions (which can be slow).

## Limitations

- Thumb/Thumb-2 instructions are displayed with their decoded mnemonics
- Inline assembly in C is shown with surrounding compiled code
- If debug symbols are stripped or the optimization level is high, source-interleaving may be incomplete
