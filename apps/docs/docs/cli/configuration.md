---
sidebar_position: 2
title: Configuration Outside VS Code
---

# Configuration Outside VS Code

## Using launch.json Standalone

The CLI reads the same `launch.json` as VS Code. Most configurations work without modification. The CLI looks for `launch.json` in `.vscode/launch.json` relative to the current directory, or at the path specified by the `-j` flag.

## Variable Resolution

Variables resolved by the CLI:

| Variable | Resolves to |
|----------|------------|
| `${workspaceFolder}` | Directory containing `launch.json` |
| `${env:VAR}` | Environment variable, or `envFile` entry |
| `${userHome}` | User home directory |
| `${pathSeparator}` | `/` on Linux/macOS, `\` on Windows |
| `${config:KEY}` | Value from `.vscode/mcu-debug-settings.json` or `~/.mcu-debug/settings.json` |

Variables **not** supported in CLI mode:

| Variable | Reason |
|----------|--------|
| `${command:...}` | Requires VS Code extension runtime. Expand manually before using. |
| `${input:...}` | Requires VS Code UI prompt. Expand manually before using. |

## envFile

The `envFile` property loads variables from a `name=value` file:

```sh
# .env
TOOLCHAIN=/usr/local/arm-none-eabi
GDB=${TOOLCHAIN}/bin/arm-none-eabi-gdb
OPENOCD=/usr/bin/openocd
```

```json
{
  "envFile": "${workspaceFolder}/.env",
  "gdbPath": "${env:GDB}",
  "serverPath": "${env:OPENOCD}"
}
```

The `envFile` is loaded first, so its variables are available throughout the configuration.

## mcu-debug-settings.json

For `${config:mcu-debug.KEY}` references, create `.vscode/mcu-debug-settings.json` in the project:

```json
{
  "mcu-debug.armToolchainPath": "/usr/local/arm-none-eabi/bin",
  "mcu-debug.openocdPath": "/usr/local/bin"
}
```

Then reference these in `launch.json`:

```json
{
  "gdbPath": "${config:mcu-debug.armToolchainPath}/arm-none-eabi-gdb",
  "serverPath": "${config:mcu-debug.openocdPath}/openocd"
}
```

When you save workspace settings in VS Code, the extension writes this file automatically, keeping CLI and VS Code settings in sync.

For user-global settings (not project-specific), create `~/.mcu-debug/settings.json` with the same format.

## Diagnosing Configuration

Print the fully-resolved configuration with all variables substituted:

```sh
mcu-debug dump-config "Launch PSoC6 CM4"
```

Show which variables were substituted (diff mode):

```sh
mcu-debug dump-config "Launch PSoC6 CM4" --diff
```

Use this to verify paths are resolving correctly before starting a session.
