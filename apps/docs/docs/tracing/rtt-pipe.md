---
sidebar_position: 2.5
title: Pipe decoder & throughput
---

# The `pipe` decoder, and measuring RTT throughput

A `pipe` decoder sends an RTT channel's bytes to the standard input of any program you name, and
shows what that program writes to standard output. It also reports the channel's byte rate, which
makes it the tool for answering "how fast is this actually going?".

It works with **both** RTT implementations — the gdb-server's own RTT service and MCU Debug's
built-in RTT — because it attaches at the point where the two converge.

## The short version

```jsonc
"rttConfig": {
    "enabled": true,
    "decoders": [
        {
            "type": "pipe",
            "port": 0,
            "program": "defmt-print",
            "args": ["-e", "${executable}"]
        }
    ]
}
```

That opens a normal RTT terminal showing `defmt-print`'s output, and prints a rate line to the
debug console every five seconds.

## Options

| Option          | Default      | Meaning                                                                            |
| --------------- | ------------ | ---------------------------------------------------------------------------------- |
| `port`          | `0`          | RTT channel number.                                                                |
| `program`       | —            | Program to pipe through. **Omit it** and the bytes are counted and discarded.      |
| `args`          | `[]`         | Arguments. `${executable}` and `${workspaceFolder}` are substituted.               |
| `cwd`, `env`    | —            | Working directory and extra environment variables for the program.                 |
| `output`        | `"terminal"` | `"terminal"` opens an RTT terminal for the program's output. `"none"` discards it. |
| `stats`         | `true`       | Report the byte rate to the debug console.                                         |
| `statsInterval` | `5`          | Seconds between reports.                                                           |
| `label`         | —            | Name for the terminal.                                                             |

Keyboard input typed into the terminal goes to the **target**, down the RTT channel, not to the
program. The program is a decoder, not a shell.

## `pipe` versus `pre_decoder`

They overlap, and which you want depends on what you are doing:

- **`rttConfig.pre_decoder`** replaces the bytes for _every_ decoder on the channel. If you have a
  `console` and a `graph` on channel 0, both see the decoded output. Configured once, with an
  optional `channels` list.
- **A `pipe` decoder** is one more decoder among others. It can sit alongside a plain `console`
  decoder on the same channel, so you can watch raw and decoded output side by side — and only it
  can be told to produce no output at all.

## Measuring throughput

This is what the feature was built for. Three things matter:

**The rate is measured on the bytes going _in_,** at the last consumer — not on what the program
produces. `defmt-print` turns a few bytes of frame into a whole line of text, so its output rate
describes the log format rather than the probe. Measuring the input at the far end still catches
anything upstream that could not keep up: if a terminal falls behind and the socket backs up behind
it, fewer bytes per second arrive, which is exactly the effect worth seeing.

**`stats` works on `console` and `binary` decoders too**, so you can measure the same channel with
and without a terminal in the path and compare.

**An idle channel reports nothing** rather than reporting `0 B/sec`, and an idle gap is not averaged
into the following window. A channel that is quiet and then bursts reads at its burst rate.

### The ladder

Add one thing at a time and watch where the number drops:

| Configuration                          | What is in the path                     |
| -------------------------------------- | --------------------------------------- |
| `{ "type": "pipe", "output": "none" }` | socket read and a counter — the ceiling |
| `+ "program": "cat"`                   | a process and two pipe copies           |
| `+ "program": "defmt-print"`           | real decoding                           |
| `{ "type": "console", "stats": true }` | a terminal                              |

### Comparing gdb-servers

To compare the RTT services of OpenOCD, pyOCD, the ST-LINK gdb-server and J-Link, use
`"output": "none"` with no program, and set `engine` to `"gdb-server"` so the data comes from the
server. Note that only OpenOCD and J-Link can do this; pyOCD and the ST-LINK gdb-server have no RTT
we can drive, so there is nothing to compare for those two:

```jsonc
"rttConfig": {
    "enabled": true,
    "engine": "gdb-server",
    "decoders": [{ "type": "pipe", "port": 0, "output": "none", "stats": true }]
}
```

Two things to keep in mind when reading the numbers:

- **Run it from the CLI rather than from VS Code** if you can. The command-line driver attaches the
  same decoders to the same sources, without an extension host competing for the reads.
- **Built-in RTT is not a like-for-like comparison with a server's RTT.** A gdb-server's RTT port is
  connected to directly, while built-in RTT goes gdb → debug adapter memory polling → the adapter's
  own TCP port → the host. That is one more TCP hop and one more event loop. Comparing the _servers_
  against each other is clean; comparing built-in against a server needs the caveat stated.

Also remember that SWD clock, not software, is usually the ceiling — see the throughput note in
[Built-in RTT](./builtin-rtt.md).

## Diagnostics

Everything the pipe reports goes to the debug console:

- the command line it started, once;
- anything the program writes to **stderr**, prefixed — kept out of the terminal, where it would be
  indistinguishable from what the firmware printed;
- the program's exit code, if it exits early;
- a rate line per interval, and a session average when the channel closes.

A program that cannot be started is reported as an error and no terminal is opened, rather than
leaving you with an empty terminal and no explanation.
