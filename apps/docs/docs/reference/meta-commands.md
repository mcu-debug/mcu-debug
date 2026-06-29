---
sidebar_position: 4
title: Meta-Commands
---

# Meta-Commands

## Overview

Meta-commands are special strings that mcu-debug intercepts before they reach GDB. They control the debug session at a higher level than raw GDB commands.

All meta-commands start with `!!`.

Meta-commands work in all modes: terminal, TUI, and VS Code panel. They are also the primary interface for AI tools to control sessions.

---

## Command Reference

### !!SIGINT

Interrupt a running target. Equivalent to pressing Ctrl-C in GDB, but more reliable across different gdb-server topologies (including SSH and WSL remote sessions).

```
!!SIGINT
```

**Use this instead of GDB's `interrupt` command** — in remote topologies, `!!SIGINT` is routed through the proxy correctly.

---

### !!RESET

Reset the target via the gdb-server's monitor reset command. Does not require the target to be halted first.

```
!!RESET
```

This sends the appropriate monitor reset command for the configured gdb-server (e.g. `monitor reset halt` for OpenOCD). Reset commands are customizable in launch configuration. Reset does not re-program the device nor does it restart the gdb-server. The breakpoints remain as they are

---

### !!NOTE

Update the session notes file (`.mcu-debug/notes.json`) using a JSON Patch (RFC 6902). `notes.json` is workspace-wide, keyed by config name — mcu-debug scopes the patch to the active config's section automatically.

```
!!NOTE: [{"op":"replace","path":"/working_theory","value":"DMA IRQ not linked"}]
```

Multiple operations in one patch:

```
!!NOTE: [{"op":"replace","path":"/working_theory","value":"Stack overflow"},{"op":"add","path":"/ruled_out/-","value":"DMA channel config verified"}]
```

Common operations:

| Operation              | Example                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| Replace a string field | `[{"op":"replace","path":"/working_theory","value":"New theory"}]`     |
| Append to an array     | `[{"op":"add","path":"/ruled_out/-","value":"Clock config verified"}]` |
| Add a new field        | `[{"op":"add","path":"/custom_field","value":"some value"}]`           |
| Remove a field         | `[{"op":"remove","path":"/open_questions/0"}]`                         |

If the patch fails, mcu-debug reports:

```
[mcu-debug] NOTE: patch failed — <reason>
```

Both `.mcu-debug/notes.json` and the archive copy are updated atomically.

---

### !!AI-REQUEST

Post a request to the human operator. Displayed prominently in the TUI and VS Code AI Cockpit panel. Use when the AI needs physical-world input from the human.

```
!!AI-REQUEST: Please press the USER button on the eval board and tell me if the blue LED lights
```

The request appears as a highlighted banner in the human's TUI until cleared.

---

### !!AI-REQUEST-CLEAR

Clear the AI-REQUEST display area. Used after the AI has received and processed the human's response.

```
!!AI-REQUEST-CLEAR
```

---

## Using Meta-Commands from AI Tools

Meta-commands are sent via the same stdin as GDB commands. From an AI subprocess or `mcu-debug attach` session, send them exactly as shown:

```python
# Python example (subprocess)
process.stdin.write(b"!!SIGINT\n")
process.stdin.flush()

process.stdin.write(b'!!NOTE: [{"op":"add","path":"/breadcrumbs/-","value":"Fault at 0x08001A3C"}]\n')
process.stdin.flush()
```

---

## Meta-Command vs GDB Command Comparison

| Task                     | Meta-command        | GDB equivalent       | Notes                                        |
| ------------------------ | ------------------- | -------------------- | -------------------------------------------- |
| Interrupt running target | `!!SIGINT`          | `interrupt`          | Meta preferred in remote topologies          |
| Reset target             | `!!RESET`           | `monitor reset halt` | Correct command auto-selected per gdb-server |
| Update notes             | `!!NOTE: [...]`     | —                    | No GDB equivalent                            |
| Request human input      | `!!AI-REQUEST: ...` | —                    | No GDB equivalent                            |
