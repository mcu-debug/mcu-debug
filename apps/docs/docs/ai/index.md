---
sidebar_position: 1
title: AI Integration Overview
---

# AI Integration Overview

## Overview

mcu-debug is designed from the ground up for AI-assisted debugging. AI tools like Claude Code and GitHub Copilot can control a live debug session, observe RTT/UART output, set breakpoints, inspect memory — all through the same CLI interface a human uses.

The design principle: an AI and a human should be able to collaborate on a debug session with the same interface, without special API wrappers or plugins. The CLI's tagged output stream is both human-readable and machine-parseable.

## Three Integration Modes

### Autonomous (AI Alone)

The AI spawns mcu-debug as a subprocess, controls stdin, reads stdout. Full session control with no human in the loop.

**Use case**: automated bug hunting, hardware-in-the-loop test suites, overnight investigation runs.

See [Autonomous Debugging](./autonomous.md).

### Hybrid (Human + AI)

The human runs the TUI session. The AI attaches to the same session via `mcu-debug attach`. Both see all output. Either can send commands.

**Use case**: interactive debugging where the AI provides analysis and the human provides physical-world observations (LED state, button presses, oscilloscope readings).

See [Hybrid Mode](./hybrid-mode.md).

### VS Code Cockpit

Full hybrid mode inside VS Code, with the AI Cockpit panel showing the live stream and the AI working in the chat panel alongside.

See [VS Code Panel](../cli/vscode-panel.md).

## How AI Communicates

- **GDB commands**: sent as plain text directly (e.g. `break main`, `print counter`, `x/16x 0x20000000`)
- **Meta-commands**: special commands starting with `!!` for session control (e.g. `!!SIGINT`, `!!RESET`)
- **Status query**: the `status` command returns a JSON summary of the current session state
- **Session notes**: the `!!NOTE` meta-command updates the persistent notes file for cross-session memory

See [Meta-Commands](../reference/meta-commands.md) for the full reference.

## Documentation

| Topic | Description |
|-------|-------------|
| [Autonomous Debugging](./autonomous.md) | AI runs the full session as a subprocess |
| [Hybrid Mode](./hybrid-mode.md) | Human + AI on the same session |
| [Session Notes](./session-notes.md) | Persistent working memory across sessions |
| [Writing Skills and Prompts](./writing-skills.md) | How to write effective AI skills for mcu-debug |
