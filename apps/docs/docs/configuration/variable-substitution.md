---
sidebar_position: 3
title: Variable Substitution
---

# Variable Substitution

mcu-debug processes `launch.json` values through variable substitution before use. This lets you write portable configurations that work across machines and users.

## Supported Variables

| Variable | Source | Example |
|----------|--------|---------|
| `${workspaceFolder}` | Directory containing `.vscode/` | `/home/user/my-project` |
| `${env:VAR}` | Environment variable or `envFile` entry | `${env:TOOLCHAIN_PATH}/bin` |
| `${config:mcu-debug.KEY}` | VS Code setting value | `${config:mcu-debug.armToolchainPath}` |
| `${userHome}` | User home directory | `/home/user` or `C:\Users\user` |
| `${pathSeparator}` | Platform path separator | `/` on Linux/macOS, `\` on Windows |

## The `envFile` Property

The `envFile` property points to a file containing `NAME=VALUE` pairs. Variables defined in the file become available as `${env:NAME}`:

```sh
# .env (in your project root)
TOOLCHAIN=/opt/arm-none-eabi
GDB_PATH=${TOOLCHAIN}/bin/arm-none-eabi-gdb
OPENOCD_PATH=/usr/local/bin/openocd
```

```json
{
  "envFile": "${workspaceFolder}/.env",
  "gdbPath": "${env:GDB_PATH}",
  "serverPath": "${env:OPENOCD_PATH}"
}
```

The `envFile` is loaded before other variable substitution runs, so its values are available everywhere in the configuration.

### Important: Environment Is Not Mutated

mcu-debug builds a local merged map of environment variables for substitution. It does **not** mutate `process.env`. This means:

- Variables from `envFile` do not leak into child processes unexpectedly
- The actual process environment is used as the base, with `envFile` values merged on top
- Variables defined only in `envFile` are not visible to subprocesses unless explicitly passed

## CLI Mode Differences

When running the CLI tool, variable substitution works the same way with one difference:

- `${workspaceFolder}` resolves to the directory containing `launch.json` (not `.vscode/launch.json`'s parent — the `launch.json` file's own directory)
- `${command:...}` is **not supported** in CLI mode — this requires the VS Code extension runtime. Expand these values manually.
- `${input:...}` is **not supported** in CLI mode — this requires VS Code UI prompts. Expand these values manually.

## The `${config:mcu-debug.KEY}` Variable

This reads from VS Code workspace or user settings. For example:

```json
"toolchainPrefix": "${config:mcu-debug.armToolchainPath}"
```

In CLI mode, this reads from `.vscode/mcu-debug-settings.json` in the project, or `~/.mcu-debug/settings.json` for user-level settings. See [Configuration Outside VS Code](../cli/configuration.md) for details.

## Tips

- Add `.env` to `.gitignore` and use `.env.example` to document which variables are needed
- Use `mcu-debug dump-config` to verify how variables resolve before starting a session
- On Windows, use forward slashes in paths — they work everywhere and avoid escape issues
