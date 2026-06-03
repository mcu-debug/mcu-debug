---
sidebar_position: 3
title: Hybrid Mode
---

# Hybrid Mode

## Overview

Hybrid mode connects an AI to an already-running human debug session. The human retains full visibility and control; the AI assists with analysis, hypothesis generation, and executing debug commands.

The fundamental advantage: the human can observe the physical world (LED state, oscilloscope waveforms, board behavior) that the AI cannot. The AI can process the debug stream faster and more systematically than a human can. Together they are more effective than either alone.

## Starting Hybrid Mode

**Step 1**: Human starts the debug session in TUI mode:

```sh
mcu-debug debug -c "My Config"
```

The TUI opens in the terminal.

**Step 2**: Human asks their AI assistant to help debug the problem.

**Step 3**: AI runs `mcu-debug attach` to connect to the session:

```sh
mcu-debug attach
```

The CLI auto-discovers the session from `.mcu-debug/sock.json`. If multiple sessions are running, specify the socket path:

```sh
mcu-debug attach /path/to/.mcu-debug/session.sock
```

**Step 4**: Both are now connected. All output is broadcast to all attached clients. Either can send commands.

## Communication Convention

Both human and AI share the same GDB session. To avoid command contention, use a simple convention:

- **AI sends GDB and meta-commands** for inspection and control
- **Human uses USER-REQUEST** to provide physical-world observations

```
USER-REQUEST: The blue LED is on but the green LED is not flashing as expected
```

The `USER-REQUEST:` prefix appears in the stream and is recognized by AI tools as physical-world context that takes priority over the AI's current hypothesis.

## What the AI Sees

The AI sees the full tagged output stream from the beginning of the current session (the attach streams the session backlog). This means the AI has complete context even if it attached after the problem occurred.

## Detaching

The AI client can exit cleanly:

```sh
# In the AI's attached session, just exit
exit
```

This disconnects the AI's view without killing the GDB session or disturbing the human's TUI.

## !!AI-REQUEST

When the AI needs physical-world input from the human, it uses the `!!AI-REQUEST` meta-command:

```
!!AI-REQUEST: Please press the USER button on the eval board while I watch the GPIO state
```

This displays prominently in the human's TUI. The human observes and responds with:

```
USER-REQUEST: I pressed the button. The blue LED lit briefly then went off.
```

When the AI has received the context it needed:

```
!!AI-REQUEST-CLEAR
```

This clears the request indicator in the TUI.
