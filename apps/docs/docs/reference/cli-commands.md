---
sidebar_position: 3
title: CLI Commands
---

# CLI Commands

## mcu-debug Subcommands

### debug

Start a debug session.

```sh
mcu-debug debug [options]
```

| Option                       | Description                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `-c, --config <name\|index>` | Configuration name or index from `launch.json` (required)                   |
| `-j, --json-file <path>`     | Path to `launch.json` (default: `.vscode/launch.json` in current directory) |
| `--no-tui`                   | Force terminal mode even when running on a TTY                              |
| `-s, --settings <path>`      | Path to mcu-debug settings file (alternative to `.vscode/settings.json`)    |
| `-l, --log <path>`           | Override default log file path                                              |
| `--script <path>`            | GDB script file to run at session start (for automated use)                 |

Examples:

```sh
mcu-debug debug -c "Launch PSoC6 CM4"
mcu-debug debug -c 0
mcu-debug debug -c "My Config" -j /project/launch.json
mcu-debug debug -c "My Config" --no-tui
```

---

### attach

Attach to a running debug session.

```sh
mcu-debug attach [socket-path]
```

Without `socket-path`: auto-discovers the session from `.mcu-debug/sock.json` in the current directory.

With `socket-path`: connects to the specified session socket.

```sh
mcu-debug attach
mcu-debug attach /path/to/.mcu-debug/session.sock
```

---

### list

List all active mcu-debug sessions discoverable from the current directory.

```sh
mcu-debug list
```

Output includes session config name, status, socket path, and start time.

---

### dump-config

Resolve and print a `launch.json` configuration with all variables substituted.

```sh
mcu-debug dump-config <config-name> [launch-json-path]
```

| Option   | Description                                            |
| -------- | ------------------------------------------------------ |
| `--diff` | Show which variables were substituted (before → after) |

```sh
mcu-debug dump-config "Launch PSoC6 CM4"
mcu-debug dump-config "Launch PSoC6 CM4" --diff
mcu-debug dump-config "Launch PSoC6 CM4" /project/launch.json
```

---

### proxy

Start the mcu-debug probe agent for remote debugging.

```sh
mcu-debug proxy [options]
```

| Option       | Description                                |
| ------------ | ------------------------------------------ |
| `--port <n>` | Port to listen on (default: auto-assigned) |
| `--daemon`   | Run as a background daemon                 |

The proxy binary is also deployed automatically by the SSH remote mode — you typically only run this manually for WSL and Docker setups where automatic deployment doesn't apply.

---

## In-Session Commands

During a debug session (in terminal mode or TUI mode), all GDB commands are accepted directly. Special session commands:

| Command  | Description                                                            |
| -------- | ---------------------------------------------------------------------- |
| `status` | Show session summary as JSON — config name, state, sources, file paths |
| `help`   | Show key bindings (TUI) or command reference (terminal)                |
| `exit`   | Graceful session exit — disconnect GDB, stop gdb-server, clean up      |
| `quit`   | Alias for `exit`                                                       |

GDB commands can be any valid GDB command: `break`, `continue`, `step`, `next`, `print`, `x`, `backtrace`, `info registers`, `monitor`, etc.

Meta-commands start with `!!` — see [Meta-Commands](./meta-commands.md).
