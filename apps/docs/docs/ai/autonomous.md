---
sidebar_position: 2
title: Autonomous Debugging
---

# Autonomous Debugging

## Overview

In autonomous mode, the AI launches and fully controls the debug session. No human in the loop during the session. The AI spawns `mcu-debug` as a subprocess, controls stdin, and reads all output from stdout.

## Starting a Session

The AI spawns mcu-debug in terminal mode (stdout is redirected, so no-tui activates automatically):

```sh
mcu-debug debug -c "Launch PSoC6 CM4"
```

Or explicitly:

```sh
mcu-debug debug -c "Launch PSoC6 CM4" --no-tui
```

Stdout is the tagged mux stream. Stdin accepts GDB commands and meta-commands.

## Session Initialization

At session start, the AI should:

1. Wait for the `[mcu-debug] Target halted` message (or similar — check with `status`)
2. Run `status` to get the complete session state — socket path, log file, notes file location, connected sources
3. Read `.mcu-debug/notes.json` to resume any prior investigation context

```sh
status
```

## Reading Session Notes

```sh
# Read notes from a prior session
cat .mcu-debug/notes.json
```

If notes exist, start from the current working theory and ruled-out list rather than starting fresh.

## The Debug Loop

Typical autonomous AI debugging cycle:

1. Issue `status` to orient — understand current halt state, active sources
2. Read existing notes from `.mcu-debug/notes.json`
3. Run the target: `continue`
4. Observe tagged output stream for anomalies
5. Issue `!!SIGINT` to pause when interesting output appears
6. Inspect state with GDB commands: `backtrace`, `print variable`, `x/16x address`
7. Update notes via `!!NOTE` to record findings
8. Form a hypothesis, add instrumentation, rebuild firmware, restart session
9. Repeat

## CI/CD Use

In CI/CD pipelines, mcu-debug can be used for automated hardware-in-the-loop testing:

```sh
# Run a GDB script file
mcu-debug debug -c "Test Config" --script tests/run_tests.gdb
```

The GDB script can set breakpoints, run to completion, verify values, and exit with an appropriate exit code. The exit code propagates to the CI/CD pipeline result.

## Logging

All session output is written to `.mcu-debug/cli.log`. This provides a complete record for post-session analysis. The log file path is included in the `status` output.

```sh
grep "ERROR\|FAULT\|assert" .mcu-debug/cli.log
```
