---
sidebar_position: 3
title: Terminal Mode
---

# Terminal Mode

## Overview

Terminal mode runs when stdout is not a TTY, or when `--no-tui` is explicitly passed. No terminal manipulation occurs — output is plain tagged text suitable for pipes, AI subprocesses, and CI/CD pipelines.

## When It Activates

Terminal mode activates in any of these conditions:

- stdout is redirected to a file or pipe: `mcu-debug debug ... > output.log`
- Running as a subprocess of an AI tool (Claude Code, GitHub Copilot)
- `--no-tui` flag is passed explicitly
- Headless CI environment without a terminal (no TTY allocated)

## Input

Type commands directly and press Enter. Commands are GDB commands or [meta-commands](../reference/meta-commands.md).

- **Ctrl-C**: sends SIGINT to the target (interrupt execution)
- **Ctrl-D**: graceful exit (disconnect GDB, stop gdb-server, exit)

## Output Format

All output is tagged by source. Each line is prefixed with the source in brackets:

```
[GDB]      Temporary breakpoint 1, main () at main.c:42
[GDB]      42        uint32_t counter = 0;
[RTT#0]    Hello World! counter=0
[RTT#0]    Hello World! counter=1
[UART:Debug UART]  Sensor: temp=23.4C
[mcu-debug] Session started. Config: "Launch PSoC6 CM4"
[mcu-debug] GDB connected. Target halted at main.c:42
```

The consistent tagging makes it easy to filter, grep, and parse output programmatically.

## For AI Tools

Terminal mode is the primary mode for AI-assisted debugging. The tagged stream provides complete context:

- `[GDB]` lines show debugger state and GDB responses
- `[RTT#N]` and `[UART:label]` lines show firmware debug output
- `[mcu-debug]` lines show session lifecycle events
- `[SWO]` lines show SWO trace output

The `status` command returns a JSON summary of the current session state — useful for an AI to orient at session start or after a reset:

```sh
status
```

Output:
```json
{
  "config": "Launch PSoC6 CM4",
  "state": "halted",
  "target": "PSoC6 CM4",
  "sources": ["RTT#0", "UART:Debug UART"],
  "sockPath": "/path/to/.mcu-debug/session.sock",
  "logFile": "/path/to/.mcu-debug/cli.log",
  "notesFile": "/path/to/.mcu-debug/notes.json"
}
```

## Forcing Terminal Mode

```sh
mcu-debug debug --no-tui -c "My Config"
```

This is useful when you want plain output even when running in a terminal (TTY), for example to capture to a log file while still having keyboard input.
