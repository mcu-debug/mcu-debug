---
sidebar_position: 3
title: Quick Start
---

# Quick Start

This guide walks through your first debug session using mcu-debug with OpenOCD. The whole process takes about five minutes once the prerequisites are installed.

## Step 1: Create `.vscode/launch.json`

In the root of your firmware project, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
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
      "runToEntryPoint": "main",
      "svdFile": "${workspaceFolder}/STM32F407.svd"
    }
  ]
}
```

Adjust the following for your hardware:

- **`executable`**: path to your built ELF file with debug symbols
- **`configFiles`**: OpenOCD config files for your interface (probe) and target (MCU). Files in the OpenOCD scripts directory can be referenced by relative path. See `openocd/scripts/interface/` and `openocd/scripts/target/` for available options.
- **`svdFile`**: optional but recommended — path to the SVD file for your MCU, enabling the Peripheral View

## Step 2: Open the Run and Debug Panel

Open the Run and Debug panel:
- Click the bug icon in the Activity Bar
- Or press `Ctrl+Shift+D` (Windows/Linux) / `Cmd+Shift+D` (macOS)

## Step 3: Select Your Configuration and Press F5

Select **Debug (OpenOCD)** from the dropdown at the top of the Run and Debug panel, then press **F5** (or click the green play button).

## What to Expect

When the session starts:

1. **OpenOCD starts** — you'll see server output in a Terminal tab named something like "OpenOCD"
2. **GDB connects** — mcu-debug launches GDB and connects it to OpenOCD
3. **Target halts** — the debugger halts at `main()` (because `runToEntryPoint` is set to `"main"`)
4. **VS Code shows the current line** — the yellow arrow appears in the editor at the first line of `main`

You can now:
- Press **F10** to step over, **F11** to step into, **F5** to continue
- Set breakpoints by clicking in the editor gutter
- Inspect variables in the **Variables** panel
- Evaluate expressions in the **Debug Console**

## Common First-Run Issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Server exited with code 1" | OpenOCD failed to connect to probe | Check probe is connected; check `configFiles` match your probe and MCU |
| "Failed to start GDB" | GDB not found | Check `arm-none-eabi-gdb --version` works; set `gdbPath` or `toolchainPrefix` |
| Halts at reset vector, not `main` | Wrong `runToEntryPoint` or missing symbols | Verify ELF has debug symbols (`-g` compiler flag); check `runToEntryPoint: "main"` |
| Peripheral View is empty | No `svdFile` or wrong path | Set `svdFile` to the correct SVD file for your MCU |

For more detail on diagnosing startup failures, see [Troubleshooting](../troubleshooting/index.md).
