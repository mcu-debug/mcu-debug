---
sidebar_position: 5
title: Writing Skills and Prompts
---

# Writing Skills and Prompts

## Overview

A "skill" or "prompt" tells the AI how to use mcu-debug effectively. A well-written skill dramatically improves the AI's effectiveness as a debugging partner — it establishes protocol, sets expectations, and prevents common mistakes.

## Minimal Skill Template

```
You have access to mcu-debug, a firmware debugger for embedded systems.

## Session startup

On session start:
1. Run `status` to get session state, file locations, and connected sources
2. Read .mcu-debug/notes.json to resume prior context if the file exists

## Interacting with the target

Send GDB commands directly as plain text:
  break main
  continue
  print counter
  x/16x 0x20000000
  backtrace

Send meta-commands for session control:
  !!SIGINT       — interrupt a running target (prefer this over GDB "interrupt")
  !!RESET        — reset the target
  !!NOTE: [...]  — update notes.json with a JSON Patch (RFC 6902)
  !!AI-REQUEST: <message>  — display a request to the human operator in the TUI

## Output format

All output is tagged by source:
  [GDB]           — GDB MI output
  [RTT#0]         — RTT channel 0
  [UART:label]    — UART port output
  [mcu-debug]     — session lifecycle events

USER-REQUEST lines contain physical-world observations from the human engineer.
Prioritize USER-REQUEST context — it describes hardware behavior you cannot observe.

## Notes discipline

Update .mcu-debug/notes.json as you work:
- Update working_theory when your hypothesis changes
- Add to ruled_out when you eliminate a cause
- Add to breadcrumbs when you find something interesting
- Add to open_questions when you identify something to check

Update notes BEFORE context compaction occurs, not after.
```

## Key Principles

### Read notes.json first

Prior sessions may have already ruled out your first hypothesis. Starting from the notes rather than from scratch saves significant time in multi-session investigations.

### Update notes as you go

Context compaction will eventually truncate conversation history. Notes are the durable record. If your reasoning only exists in the conversation, it disappears at compaction. If it exists in `notes.json`, it survives indefinitely.

### Use `!!SIGINT` over GDB `interrupt`

The `!!SIGINT` meta-command is more reliable across different gdb-server topologies than GDB's built-in `interrupt` command. In remote debugging scenarios (SSH, WSL), `!!SIGINT` is routed correctly by the proxy.

### Search the log rather than relying on scrollback

```sh
grep "ERROR\|FAULT\|Hard fault\|assert" .mcu-debug/cli.log
```

The log file contains the complete session history without scrollback limits.

### Avoid breakpoints for timing-sensitive code

Breakpoints halt the CPU, which disrupts timing-sensitive code (motor control, communication protocols, real-time tasks). Use RTT logging and memory reads instead:

```c
SEGGER_RTT_printf(0, "state=%d at %u us\n", state, timer_us());
```

Then from GDB: `continue` and observe the RTT stream.

### Use memory reads for state inspection without halting

```gdb
# Read a global variable without halting
x/1uw &g_error_count
```

Combined with Live Watch, this gives you continuous visibility without disturbing execution.

## Advanced: Autonomous Investigation Script

For fully autonomous bug hunting, a skill can structure a systematic investigation:

```
You are debugging a firmware crash. Follow this process:

1. Orient: run `status`, read notes.json
2. Reproduce: run `continue` and observe for the crash
3. If crash occurs:
   a. Run `backtrace` to get the call stack
   b. Run `info registers` to capture CPU state
   c. Run `x/32x $sp` to inspect the stack
   d. Update notes with findings
4. Form a hypothesis about the crash cause
5. Add instrumentation (RTT logging) near the suspected location
6. Request a firmware rebuild from the user if needed
7. Repeat from step 2 with new instrumentation
8. When you identify the root cause, summarize in notes.json
```
