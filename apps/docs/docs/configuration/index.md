---
sidebar_position: 1
title: Configuration Overview
---

# Configuration Overview

mcu-debug is configured via `.vscode/launch.json`. This file is VS Code's standard debug configuration file, extended with mcu-debug-specific properties.

## launch.json is the Single Source of Truth

The same `launch.json` works in VS Code and in the mcu-debug CLI tool. There is no separate config file for the CLI. If your launch config works in VS Code, it works in the CLI — with the exception of a few VS Code-specific variable types (see [Variable Substitution](./variable-substitution.md)).

## Configuration Topics

| Topic | Description |
|-------|-------------|
| [launch.json Overview](./launch-json.md) | File structure, required fields, and a complete example |
| [Variable Substitution](./variable-substitution.md) | Using `${workspaceFolder}`, `${env:VAR}`, `envFile`, and other variables |
| [All Properties](./properties.md) | Reference listing of every supported property, organized by category |

## Quick Reference

The minimum viable `launch.json` for mcu-debug:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "mcu-debug",
      "request": "launch",
      "name": "My Config",
      "servertype": "openocd",
      "executable": "${workspaceFolder}/build/firmware.elf",
      "configFiles": ["interface/stlink.cfg", "target/stm32f4x.cfg"]
    }
  ]
}
```

VS Code IntelliSense provides inline documentation and autocompletion for all properties when editing `launch.json`. Hover over any property name to see its description and valid values.
