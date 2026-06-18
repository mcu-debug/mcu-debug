---
sidebar_position: 3
title: Variable Substitution
---

# Variable Substitution

mcu-debug processes `launch.json` values through variable substitution before use. This lets you write portable configurations that work across machines and users. Most of the variable substiution is done by VSCode, except the variables that come from the `envFile`

## Supported Variables

| Variable                     | Source                                           | Example                                 |
| ---------------------------- | ------------------------------------------------ | --------------------------------------- |
| `${workspaceFolder}`         | Directory containing `.vscode/`                  | `/home/user/my-project`                 |
| `${workspaceFolderBasename}` | Base directory name of `workspaceFolder`         | `my-project`                            |
| `${userHome}`                | User home directory                              | `/home/user` or `C:\Users\user`         |
| `${pathSeparator}`           | Platform path separator                          | `/` on Linux/macOS, `\` on Windows      |
| `${platform}`                | name of the platform ("windows", "osx", "linux") | Use this as suffix for config variables |
| `${env:VAR}`                 | Environment variable or `envFile` entry          | `${env:TOOLCHAIN_PATH}/bin`             |
| `${config:mcu-debug.KEY}`    | VS Code setting value                            | `${config:mcu-debug.armToolchainPath}`  |

The variables above are supported in both CLI and VSCode environments. VSCode may support additional variables that are not available outside VSCode. `${pathSeparator}` is handled by vscode, but for CLI mode `${pathSeparator}` always resolves to `/`. For CLI mode, all the builtin variables like `workspaceFolder/userHome/cwd` will have forward slashes

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

The `envFile` is loaded before other variable substitution runs, so its values are available everywhere in the configuration. The rules are as follows:

### Quoting rules:

```
Unquoted  KEY=VALUE       — value is literal (trimmed); backslashes are NOT escape chars,
                            so Windows paths work as-is (e.g. C:\Users\test).
Double-quoted KEY="VALUE" — surrounding quotes are stripped; recognised escape sequences:
                            \\ → \   \" → "   \n → newline   \r → CR   \t → tab.
                            Any other \x passes through as x.
Single-quoted KEY='VALUE' — surrounding quotes are stripped; value is fully literal,
                             no escape processing of any kind.
```

### Comments

Lines whose first non-whitespace character is '#' are treated as comments and ignored. A '#' that appears after the '=' sign is part of the value, not a comment. Variable substitution `${env:VAR}` is not supported; use args.env in the launch configuration for dynamic values.

### Important: Environment Is Not Mutated

mcu-debug builds a local merged map of environment variables for substitution. It does **not** mutate `process.env`. This means:

- Variables from `envFile` do not leak into child processes unexpectedly
- The actual process environment is used as the base, with `envFile` values merged on top
- Variables defined only in `envFile` are not visible to subprocesses unless explicitly passed

## CLI Mode Differences

When running the CLI tool, variable substitution works the same way with one difference:

- `${workspaceFolder}` resolves to the current directory where the CLI tool is launched
- `${command:...}` is **not supported** in CLI mode — this requires the VS Code extension runtime. Expand these values manually.
- `${input:...}` is **not supported** in CLI mode — this requires VS Code UI prompts. Expand these values manually.
- `${config:...}` has **limited support** via a cli-option `--settings json-file` for providing the settings. You can use `.vscode/settings.json' for this purpose

## The `${config:mcu-debug.KEY}` Variable

This reads from VS Code workspace or user settings. For example:

```json
"armToolchainPath": "${config:mcu-debug.armToolchainPath}"
```

In CLI mode, this reads from `.vscode/settings.json` in the project, or `~/.vscode/settings.json` for user-level settings. See [Configuration Outside VS Code](../cli/configuration.md) for details.

## Tips

- Add `.env` to `.gitignore` and use `.env.example` to document which variables are needed
- If using CLI tools use `mcu-debug debug --dump-config -c ...` to verify how variables resolve before starting a session
- On Windows, use forward slashes in paths — they work everywhere and avoid escape issues
