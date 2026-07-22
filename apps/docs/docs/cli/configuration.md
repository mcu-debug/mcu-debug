---
sidebar_position: 2
title: Configuration Outside VS Code
---

# Configuration Outside VS Code

## Using launch.json Standalone

The CLI reads the same `launch.json` as VS Code. Most configurations work without modification. The CLI looks for `launch.json` in `.vscode/launch.json` relative to the current directory, or at the path specified by the `-j` flag.

## Variable Resolution

Variables resolved by the CLI:

| Variable                     | Resolves to                                      |
| ---------------------------- | ------------------------------------------------ |
| `${workspaceFolder}`         | Current working directory containing             |
| `${workspaceFolderBasename}` | Base directory name of `workspaceFolder`         |
| `${cwd}`                     | Same as `workspaceFolder`                        |
| `${platform}`                | name of the platform ("windows", "osx", "linux") |
| `${userHome}`                | User home directory                              |
| `${pathSeparator}`           | `/` on all platforms                             |
| `${env:VAR}`                 | Environment variable, or `envFile` entry         |
| `${config:KEY}`              | Value from `.vscode/settings.json`               |

Variables **not** supported in CLI mode:

| Variable         | Reason                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `${command:...}` | Requires VS Code extension runtime. Expand manually before using. |
| `${input:...}`   | Requires VS Code UI prompt. Expand manually before using.         |

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
  "serverpath": "${env:OPENOCD}"
}
```

The `envFile` is loaded first, so its variables are available throughout the configuration. See also [Variable Substitution](../configuration/variable-substitution.md)

## settings.json

For `${config:mcu-debug.KEY}` references, use your `.vscode/settings.json` in the project or create your own JSON file:

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
  "serverpath": "${config:mcu-debug.openocdPath}/openocd"
}
```

When you save workspace settings in VS Code, the extension writes this file automatically, keeping CLI and VS Code settings in sync.

For user-global settings (not project-specific), create `~/.mcu-debug/settings.json` with the same format.

## Diagnosing Configuration

Print the fully-resolved configuration with all variables substituted:

```sh
mcu-debug debug --dump-config -c "Launch PSoC6 CM4"
```

Show which variables were substituted (diff mode):

```sh
mcu-debug debug --dump-config -c "Launch PSoC6 CM4" --diff
```

Use this to verify paths are resolving correctly before starting a session.
