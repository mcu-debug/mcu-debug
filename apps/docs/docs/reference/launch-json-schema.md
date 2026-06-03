---
sidebar_position: 2
title: launch.json Schema
---

# launch.json Schema

:::note
Full schema reference coming soon. The complete property list is being documented. For now, see [All Properties](../configuration/properties.md) for a categorized listing.
:::

## IntelliSense

VS Code provides inline documentation and autocompletion when editing `launch.json`. Hover over any property name to see its description, type, and valid values. Start typing to get autocompletion suggestions.

The IntelliSense schema is bundled with the mcu-debug extension and is always up to date with the installed version.

## JSON Schema File

The raw JSON Schema file is included in the extension package at:

```
<extension-dir>/schemas/mcu-debug.schema.json
```

You can use this schema for:
- Validation in editors other than VS Code
- Generating documentation
- Scripting that validates `launch.json` before use

Find the extension directory:
- Linux/macOS: `~/.vscode/extensions/mcu-debug.mcu-debug-<version>/`
- Windows: `%USERPROFILE%\.vscode\extensions\mcu-debug.mcu-debug-<version>\`

## Property Categories

Properties are organized into groups in the [All Properties](../configuration/properties.md) reference:

- Required properties
- GDB Server configuration
- GDB configuration
- Session behavior
- GDB command hooks
- Environment
- RTT, UART, SWO tracing
- Remote debugging
- Peripheral view and other features
