# CLI Configuration Resolution

How `mcu-debug` resolves `launch.json` outside of VS Code — where VS Code APIs, settings, and extension commands are unavailable.

Related: [cli-architecture.md](cli-architecture.md) (binary rename, no-DAP model, subcommands, topology detection), [AI-Angle.md §9](AI-Angle.md) (CLI deployment modes), [uart-management.md §10](uart-management.md) (UART config merge rules).

---

## The Problem

`launch.json` was designed for VS Code. It supports variable interpolation that leans on the VS Code runtime:

| Variable form | Source | CLI-resolvable? |
|---|---|---|
| `${workspaceFolder}` | Directory containing `launch.json` | **Yes** — trivial |
| `${workspaceFolder}/path/to/elf` | Same | **Yes** |
| `${env:VAR}` | Process environment or `envFile` | **Yes** |
| `${userHome}` | Well-known OS path | **Yes** |
| `${pathSeparator}` | Well-known | **Yes** |
| `${config:mcu-debug.armToolchainPath}` | VS Code settings | **Narrow bridge only — see below** |
| `${command:someExtension.someCommand}` | Extension runtime | **No** — never supported |

The `${config:...}` form was historically the gap — toolchain paths set in VS Code settings and referenced from `launch.json`. In practice this gap is largely closed by two things:

1. **Direct `launch.json` properties.** The extension converts all relevant VS Code settings to first-class `launch.json` properties and accepts both forms. Users who put `armToolchainPath` or `serverpath` directly in `launch.json` need no bridge at all — and this is the recommended approach for portable, VCS-friendly configs.

2. **`envFile`** (see below). Variables loaded from a file feed `${env:VAR}` substitution. Build systems and CMake can emit a fully-resolved env file rather than editing `launch.json`. Covers the "I want one file for my toolchain paths" use case without `${config:...}`.

`${config:...}` support via `mcu-debug-settings.json` (see below) remains as a migration path for existing VS Code users, not the primary story.

`${command:...}` is explicitly out of scope — requires an extension runtime, inherently interactive.

---

## `envFile` — Variable Source and GDB Environment

`envFile` is a `launch.json` property specifying one or more files in `name=value` format. It is the recommended way to factor out paths that vary by machine or toolchain installation.

```jsonc
{
  "envFile": "${workspaceFolder}/.env",

  // or layered — later files override earlier ones:
  "envFile": ["${workspaceFolder}/.env", "${workspaceFolder}/.env.local"],

  "armToolchainPath": "${env:TOOLCHAIN}/bin",
  "gdbPath": "${env:TOOLCHAIN}/bin/arm-none-eabi-gdb"
}
```

### File format

Plain `name=value`. No JSON. No quotes required (but accepted and stripped). Comments with `#`.

```sh
# Toolchain root — adjust for your installation
TOOLCHAIN=/usr/local/arm-none-eabi

# Derived paths — in-file substitution: ${VAR} references earlier lines
GDB=${TOOLCHAIN}/bin/arm-none-eabi-gdb
OBJDUMP=${TOOLCHAIN}/bin/arm-none-eabi-objdump
OPENOCD=/usr/local/bin/openocd
OPENOCD_SCRIPTS=/usr/local/share/openocd/scripts
```

### In-file substitution

Variables defined earlier in the file are available to later lines via `${VAR}`. This lets users factor out a base path and build derived paths from it — the most common real-world pattern.

Rules:
- Single pass, top-to-bottom
- `${VAR}` on the right-hand side: look up in earlier-in-file definitions first, then process environment
- No recursive expansion, no nested `${...}`, no shell arithmetic — WYSIWYG
- Unresolved `${VAR}` in the envFile: left as a literal string and reported as a warning (not fatal — the downstream `launch.json` resolution will catch it if it matters)

The no-recursion rule keeps the parser simple and the file predictable. Build systems generating the file write fully-resolved values and never need in-file substitution.

### What "envFile" actually does

The name matches the familiar dotenv convention. The semantics are precise:

1. **Variable substitution source.** Variables from `envFile` are available as `${env:VAR}` anywhere in `launch.json`. This is the primary use.

2. **GDB process environment.** Variables are also added to GDB's process environment. On native targets, GDB can propagate them to the inferior. On embedded MCU targets the inferior has no process environment — the MCU doesn't have one — so this is a no-op in practice, but it doesn't hurt and matches user expectations.

The extension does **not** promise that envFile variables reach the firmware running on the MCU. They reach GDB. What GDB does with them is GDB's concern.

### Precedence

```
${env:VAR} resolution order (highest → lowest):
  1. Shell / process environment (already set before mcu-debug starts)
  2. envFile entries — in array order, later files override earlier
```

Shell environment always wins. envFile cannot shadow a var the user explicitly set in their shell. This prevents surprises when CI sets `TOOLCHAIN` explicitly and the file has a different value.

### VS Code timing — `resolveDebugConfiguration`

The VS Code extension processes `envFile` in **`resolveDebugConfiguration`** — the hook that runs *before* VS Code performs its own variable substitution.

**We never inject into `process.env`.** The extension host's `process.env` is shared across all extensions in the host process. Mutating it would have unpredictable side effects on other extensions and is off the table.

Instead, we build a **local merged env map** in memory and do our own `${env:VAR}` substitution pass:

```
mergedEnv = { ...envFileVars, ...process.env }
//                             ^^^
//                             process.env overwrites same-named envFile vars
//                             (shell env always wins — no CI surprises)
```

Processing order:

1. `resolveDebugConfiguration` fires
2. Extension loads and parses `envFile`(s), performs in-file substitution, builds `mergedEnv`
3. Extension walks the config tree and substitutes **all** `${env:VAR}` references using `mergedEnv`, replacing them with their resolved string values
4. Extension also resolves `${config:KEY}` via `mcu-debug-settings.json` in the same pass
5. Returns the partially-resolved config (env and config vars already expanded, others left for VS Code)
6. VS Code performs its own substitution pass — finds no `${env:...}` references remaining (already resolved), handles `${workspaceFolder}`, `${input:...}`, and any other VS Code-specific vars unimpeded
7. `resolveDebugConfigurationWithSubstitutedVariables` fires → config is fully resolved

**Existing `launch.json` files that already use `${env:TOOLCHAIN}` work without any changes** — the var is resolved in step 3 from `mergedEnv` instead of from VS Code's substitution, with identical result. No double-substitution risk: once a `${env:VAR}` is replaced with its value string, VS Code's pass sees a plain string and leaves it alone.

### envFile and build systems

A CMake build or Makefile that knows the toolchain can emit an env file as a side-effect:

```cmake
# In CMakeLists.txt or a custom target:
file(WRITE "${CMAKE_BINARY_DIR}/debug.env"
  "TOOLCHAIN=${CMAKE_TOOLCHAIN_PREFIX_DIR}\n"
  "ELF=${CMAKE_BINARY_DIR}/${PROJECT_NAME}.elf\n"
)
```

```jsonc
// launch.json
{
  "envFile": "${workspaceFolder}/build/debug.env",
  "executable": "${env:ELF}"
}
```

The build system writes fully resolved values — no in-file substitution needed. The debug config stays generic and portable across machines.

---

## `mcu-debug-settings.json` — Migration Bridge for `${config:...}`

For users who already have `${config:mcu-debug.armToolchainPath}` in their `launch.json`, the CLI needs a way to resolve those references without VS Code's settings store.

`mcu-debug-settings.json` is a flat JSON file that mirrors the VS Code settings namespace. It is a **migration bridge**, not the primary story — new users should use `launch.json` properties or `envFile` directly.

### File locations (precedence order, highest first)

1. `.vscode/mcu-debug-settings.json` — workspace-scoped
2. `~/.mcu-debug/settings.json` — user-scoped global fallback

### Who writes it

**The VS Code extension writes it automatically** whenever the user saves workspace settings containing `mcu-debug.*` keys. The user never manually touches it in normal VS Code use.

```jsonc
{
  "mcu-debug.armToolchainPath": "/usr/local/arm-none-eabi/bin",
  "mcu-debug.openocdPath": "/usr/local/bin/openocd",
  "mcu-debug.openocdScriptsPath": "/usr/local/share/openocd/scripts"
}
```

For pure CLI users who have `${config:...}` in their config, the error message tells them exactly what to add:

```
error: unresolved variable ${config:mcu-debug.openocdPath}
  → add to ~/.mcu-debug/settings.json:
      { "mcu-debug.openocdPath": "/path/to/openocd" }
  → or set directly in launch.json as "openocdPath": "/path/to/openocd"
  → or use envFile: OPENOCD=/path/to/openocd  and  "openocdPath": "${env:OPENOCD}"
```

Three paths to resolution, ranked by preference.

---

## Full Resolution Algorithm

When the CLI loads a launch configuration:

```
1. Read launch.json. Select the named config.

2. Build mergedEnv (never touches process.env):
   a. Start with envFileVars = {}
   b. For each envFile in order:
        - Parse name=value lines (skip blank, skip # comments, strip optional quotes)
        - In-file substitution: ${VAR} on RHS → look up in envFileVars so far, then process.env
        - Merge into envFileVars (later files override earlier)
   c. mergedEnv = { ...envFileVars, ...process.env }
      // process.env wins — shell env cannot be overridden by envFile

3. Substitute all variable references in the config tree (our pass):
   a. ${env:VAR}            → mergedEnv lookup
   b. ${config:KEY}         → .vscode/mcu-debug-settings.json, then ~/.mcu-debug/settings.json
   (VS Code handles ${workspaceFolder}, ${userHome}, ${input:...} etc. in its own pass after us)

4. (VS Code only) Return config from resolveDebugConfiguration.
   VS Code performs its substitution pass on the remaining variables.
   (CLI skips this step — resolves ${workspaceFolder}, ${userHome}, ${pathSeparator} itself)

5. Collect all unresolved variables. If any remain:
   → Report ALL of them at once (not one at a time)
   → Show the three resolution paths for each (launch.json property / envFile / mcu-debug-settings.json)
   → Exit non-zero. Never run a partially-resolved config.

6. Proceed with the fully-resolved config.
```

---

## Config Dump Command

```sh
mcu-debug dump-config "My Config" launch.json
mcu-debug dump-config "My Config" launch.json --diff   # show what changed
```

Prints the fully-resolved config. Useful for diagnosing wrong paths, generating portable configs, and verifying that envFile and settings files contain the expected values.

---

## Relationship to UART Config

UART configuration follows the two-source model in [uart-management.md §10](uart-management.md). Variables are resolved first (this document), then UART configs are merged. `${workspaceFolder}/logs/uart.log` and `${env:ELF}` in UART entries resolve the same way as anywhere else in `launch.json`.
