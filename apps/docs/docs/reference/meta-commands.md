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

### !!send

Write a line to one of the target's own I/O streams — a serial port or an RTT channel. stdin belongs to GDB, so this is the only way to answer firmware that prompts for input ("Press 'Enter' to continue", a serial menu, a command shell on UART).

```
!!send [<prefix>] [text]
```

The prefix is the same tag that labels that stream's output, and `status` lists them under `serialPorts[].prefix` and `rtts[].prefix` — so the address is discoverable from the stream you are already reading.

**Brackets distinguish an address from payload:**

| Command                 | Goes to                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `!!send [ttyACM0] help` | that stream                                                               |
| `!!send help`           | the only stream; an error if the session has more than one                |
| `!!send`                | a bare newline to the only stream                                         |
| `!!send [] help`        | the only stream, stated explicitly — for text that itself starts with `[` |

A line terminator is always appended, which is why `!!send` on its own answers a bare "press Enter" prompt.

Everything after the address is sent verbatim, leading spaces included. Extra spaces *before* the address are ignored, so `!!send   [ttyACM0] hi` addresses the stream rather than sending its name as text.

Unbracketed text is never matched against the stream list. That keeps a command's meaning fixed: `!!send status` sends the word `status` to the target whether or not a stream happens to be named `status`, and it will not change meaning if a second stream appears later in the session.

Failures carry structured fields next to the message: `error` is one of `unknown-stream`, `ambiguous`, `not-connected`, `no-streams` or `bad-prefix`, and `available` lists the valid prefixes — so a wrong guess is correctable in one round trip.

:::note
Firmware that reads a single keypress without waiting for Enter will also receive the appended terminator as a second character. There is currently no form that sends text without one.
:::

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

### !!&lt;anything else&gt; — message the AI

Anything else beginning with `!!` and typed at the session's own keyboard is relayed to every attached client as a free-text message from the human. It is the mirror image of `!!AI-REQUEST`: that one is the AI asking the human for something, this one is the human asking the AI.

```
!!why is the DMA IRQ never firing?
```

The `!!` is stripped and the remainder is delivered as `source: "USER-REQUEST"`. The human sees a confirmation line; no GDB command is issued and the target is untouched.

This works **only from stdin** — the terminal, TUI, or VS Code panel. The same text arriving over the socket is reported as an unknown meta-command instead, since a client has no need to relay a message to itself.

:::caution
This is a catch-all: it matches any `!!` string that is not a recognised command. A mistyped meta-command therefore lands here and is relayed as a message rather than reported as an error — `!!sigin` becomes a note to the AI, not an interrupt. The recognised commands are matched case-insensitively so that capitalisation alone cannot trigger this, but a misspelling still can. If a command appears to do nothing, check that the confirmation line does not say it was sent to the AI.
:::

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

| Task                     | Meta-command        | GDB equivalent       | Notes                                                              |
| ------------------------ | ------------------- | -------------------- | ------------------------------------------------------------------ |
| Interrupt running target | `!!SIGINT`          | `interrupt`          | Meta preferred in remote topologies                                |
| Reset target             | `!!RESET`           | `monitor reset halt` | Builtin/Custom command per gdb-server                              |
| Answer a firmware prompt | `!!send [port] y`   | —                    | stdin goes to GDB; this is the only route to the target's UART/RTT |
| Update notes             | `!!NOTE: [...]`     | —                    | No GDB equivalent                                                  |
| Request human input      | `!!AI-REQUEST: ...` | —                    | No GDB equivalent                                                  |
| Message the AI           | `!!<free text>`     | —                    | Human → AI, stdin only. Catch-all: also swallows mistyped commands |
