---
sidebar_position: 1
title: CLI Tool Overview
---

# CLI Tool Overview

## Overview

The mcu-debug CLI tool provides the full debug experience outside of VS Code. Same `launch.json`, same gdb-server support, same RTT/UART tracing — just without the VS Code UI.

The CLI is the foundation for AI-assisted debugging and for headless workflows like CI/CD hardware-in-the-loop testing.

## Three Modes

The CLI automatically selects a mode based on the environment:

| Mode | When | How |
|------|------|-----|
| Terminal | stdout is not a TTY, or `--no-tui` is passed | Raw terminal, readline input, plain text tagged output |
| TUI | stdout is a TTY (default) | ratatui-based full-screen terminal UI |
| VS Code panel | Running inside VS Code | AI Cockpit WebviewPanel with xterm.js rendering |

**Auto-detection**: if stdout is a TTY, TUI mode starts automatically. If stdout is redirected (to a pipe, file, or AI subprocess), terminal mode activates. Running inside VS Code activates the VS Code panel mode.

## Installation

No install required for one-off use:

```sh
npx mcu-debug debug -c "My Config"
```

For regular use, install globally:

```sh
npm install -g mcu-debug
```

**Requirements**: Node.js >= 22. The mcu-debug VS Code extension installed provides the debug adapter binary that the CLI invokes.

## Starting a Session

```sh
# By configuration name
mcu-debug debug -c "Launch PSoC6 CM4"

# By index in launch.json
mcu-debug debug -c 0

# With explicit launch.json path
mcu-debug debug -c "Launch PSoC6 CM4" -j /path/to/launch.json

# Force terminal mode (no TUI)
mcu-debug debug -c "My Config" --no-tui
```

## Session Discovery

Running sessions are discoverable:

```sh
# List all active sessions
mcu-debug list

# Attach to a session (auto-discovers from .mcu-debug/sock.json)
mcu-debug attach

# Attach to a specific session by socket path
mcu-debug attach /path/to/session.sock
```

Sessions write a `sock.json` file to `.mcu-debug/` in the workspace directory. This file contains the socket path and session metadata.

## Documentation

| Topic | Description |
|-------|-------------|
| [Configuration Outside VS Code](./configuration.md) | Using launch.json standalone, variable resolution, `dump-config` |
| [Terminal Mode](./terminal-mode.md) | Raw output mode for pipes, AI tools, and CI |
| [TUI Mode](./tui-mode.md) | Full-screen ratatui interface |
| [VS Code Panel](./vscode-panel.md) | AI Cockpit WebviewPanel inside VS Code |
