---
sidebar_position: 3
title: CLI Commands
---

# Installation

See [Installing the CLI](../cli/index.md#installation).

# CLI Commands

`mcu-debug` has five subcommands. `debug`, `attach` and `serial` are the ones you run directly;
`proxy` is normally started for you, and `da-helper` is an internal helper invoked by the debug
adapter.

## mcu-debug Subcommands

### debug

Start a debug session.

```sh
mcu-debug debug [options]
```

| Option                        | Description                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `-c, --config <name\|index>`  | Configuration from `launch.json`: a name, a zero-based index, or a glob matching **exactly one** configuration. Only `"type": "mcu-debug"` configurations are counted |
| `-j, --json <path>`           | Path to `launch.json` (default: `.vscode/launch.json`)                                |
| `-s, --settings <path>`       | Path to a settings file (default: `.vscode/settings.json`)                            |
| `-l, --log-file <path>`       | Override the log file path (default: `$CWD/.mcu-debug/cli.log`)                        |
| `-r, --script <path>`         | File of GDB commands and meta-commands to run once the session has started, as though typed. Without `--batch` the session stays open afterwards |
| `--batch`                     | Run commands one at a time like `gdb -batch`, then exit — see below. Implies `--no-tui` |
| `-d, --debug`                 | Verbose logging                                                                        |
| `--no-tui`                    | Skip the TUI and stream the tagged output to stdout. Applied automatically when stdout is not a TTY |
| `--wait-for-client`           | Do nothing until a client connects to the session socket — see below                  |
| `--nostdin`                   | Never read stdin; drive the session over the socket. Implies `--wait-for-client`. Required when backgrounding the process. Cannot be combined with the TUI |
| `--dump-config`               | Dump the resolved configuration and exit                                               |

An ambiguous `--config` glob is an error rather than a silent first-match.

```sh
mcu-debug debug -c "Launch PSoC6 CM4"
mcu-debug debug -c 0
mcu-debug debug -c "My Config" -j /project/launch.json
mcu-debug debug -c "My Config" --no-tui
```

#### `--script`

Runs a file of commands once the session is up: after the program has been loaded and after
`runToEntryPoint` or `breakAfterReset` have taken effect. Lines run in order, ahead of anything
typed while the session was starting. Blank lines are skipped.

On its own, `--script` is for setup. It runs, then the session stays open, in the TUI or terminal
mode, for you to carry on. This is the only way to preload commands into a TUI session, since the
TUI owns stdin. A command that fails stops the rest of the script, and you keep the session.

#### `--batch`

Runs a session unattended, the way `gdb -batch` does, and exits when the commands run out:

```sh
mcu-debug debug -c "Test Config" --batch --script tests/smoke.txt
mcu-debug debug -c "Test Config" --batch < tests/smoke.txt
cat tests/smoke.txt | mcu-debug debug -c "Test Config" --batch
```

Commands come from `--script` if one is given, in which case stdin is not read at all, and
otherwise from stdin. The three forms above are equivalent.

- **One command at a time.** Each line runs only when the one before it has finished. Without
  this, a piped file arrives all at once and every command races the one before it.
- **Execution commands wait for the target.** `continue` (`c`, `cont`, `run`), `step`, `next`,
  `stepi`, `nexti`, `finish`, `until`, `advance` and `jump` are finished when the target stops
  again, not when it starts running. A `continue` to a breakpoint that is never hit waits for
  good. Press Ctrl-C, or send `pause` from an attached client.
- **A trailing `&` does not wait.** `c&` finishes as soon as the target is running. See
  [Running without waiting](#running-without-waiting).
- **`pause` waits for the halt**, so the next line can read the halted core.
- **The first failure ends the session**, with exit status 1. A failure is a GDB error, a rejected
  request (such as `continue` while the target is running), an unknown meta-command, or a
  [`!!wait-stop`](./meta-commands.md#wait-stop) that times out. When every command succeeds, the
  exit status is 0.
- **Ctrl-C** interrupts a running target. A second Ctrl-C while halted ends the session with
  status 1.

`--batch` implies `--no-tui`, because the TUI would take over the stdin the commands arrive on.

With `runToEntryPoint`, start the script with `!!wait-stop` so that it begins once the target has
halted at the entry point:

```
!!wait-stop 5000
bt
c&
!!sleep 2000
pause
info registers pc
```

#### Running without waiting

End an execution command with `&` to make it finish as soon as the target is running, instead of
when it stops again. The space before the `&` is optional:

| Waits for the target to stop | Finishes once it is running |
| ---------------------------- | --------------------------- |
| `c` / `continue`             | `c&` / `continue &`         |
| `next`, `step`, `finish`, …  | `next&`, `step &`, `finish &`, … |

The spelling follows gdb's own background execution (`continue &`). The `&` is removed before the
command reaches GDB, and it only applies to the execution commands listed above. On any other
line it is left alone, so `print a & b` still means what it says.

This is how a batch looks at a target while it runs: resume without waiting, let it run with
[`!!sleep`](./meta-commands.md#sleep), then `pause`, which waits for the halt:

```
c&
!!sleep 2000
pause
bt
```

Outside `--batch` and `--script`, execution commands never wait for the target, so a trailing
`&` is accepted and makes no difference.

Commands arrive one line at a time, so GDB constructs that span several lines (`if` … `end`,
`define`, `commands`) cannot be typed into a script. Put them in a GDB command file and `source`
it instead.

#### `--wait-for-client`

With this flag nothing starts — no gdb-server, no GDB, no telemetry — until a client connects to
the session socket. It is intended for AI agents and scripts that want to observe the session from
its first byte rather than joining one already in progress.

Because the launch blocks, it has to be its own process and you connect from a second one. The
socket path is written to `.mcu-debug/socket.json` as soon as the server is listening, which
happens *before* the wait, so `mcu-debug attach` can always find it. The wait is announced on
stderr so a session that appears idle is identifiable.

If no client ever connects, the session waits indefinitely.

#### `--nostdin`

Add this whenever the session is not going to be typed into — most importantly when you background
it from an interactive shell:

```sh
mcu-debug debug --no-tui -c 0 --wait-for-client --nostdin &
mcu-debug attach
```

Without it, a background job that reads the controlling terminal is stopped by the OS (`SIGTTIN`)
and sits suspended until you `fg` it. The flag is the only way to express that intent — the
process cannot detect it, because stdin looks perfectly readable from the inside.

`--nostdin` implies `--wait-for-client`, since the socket becomes the only way to reach the
session. It is rejected together with the TUI, which drives the session through stdin.

Redirecting stdin instead (`< /dev/null`) also works and is detected: the session notices stdin
was already closed at startup and, if nothing can drive it, exits immediately with a message
naming these flags rather than running unattended.

---

### attach

Attach to a running debug session over its socket (Linux/macOS) or named pipe (Windows).

```sh
mcu-debug attach [options]
```

| Option                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `-s, --socket-path <path>` | Endpoint to attach to. Omit it to auto-discover from `.mcu-debug/socket.json` in the current directory |

```sh
cd <workspace-root> && mcu-debug attach
mcu-debug attach -s /tmp/mcu-debug-12345-0.sock
```

Auto-discovery reads `.mcu-debug/socket.json` relative to the **current directory** and picks the
right endpoint for the platform, so run it from the workspace root. Pass `-s` explicitly when the
session was started somewhere else.

Attaching replays roughly 10KB of recent session history, always starting at a whole line.

Closing `attach`'s stdin disconnects you. Whether the session survives depends on who is flying it:
a session started by a human in a terminal keeps running, because their stdin still owns it. A
session started with `--nostdin` ends when its last client disconnects — nobody is left to control
it, and an abandoned session would hold the probe and block the next one from starting.

---

### proxy

Start the probe agent — the component that runs on the machine the debug probe is physically
attached to. You rarely run this by hand: the `mcu-debug-proxy` extension starts it for WSL and
Docker, and SSH mode deploys and launches it for you.

```sh
mcu-debug proxy [options]
```

| Option                    | Description                                                                     |
| ------------------------- | ------------------------------------------------------------------------------- |
| `-H, --host <addr>`       | Additional address to bind, on top of loopback which is always bound. `0.0.0.0` binds every interface and cannot be added to a running proxy |
| `-p, --port <n>`          | TCP port (default: `0`, auto-assign)                                             |
| `-t, --token <token>`     | Auth token for client connections. A fresh random one is generated if omitted. Also settable via `MDBG_PROXY_TOKEN` |
| `--instance <name>`       | Named instance, so several proxies can coexist (default: `default`, env `MDBG_PROXY_INSTANCE`) |
| `--idle-timeout <secs>`   | Shut down after this long with no clients (env `MDBG_PROXY_IDLE_TIMEOUT`)        |
| `--status`                | Report the status of a running proxy and exit                                    |
| `--heartbeat`             | Emit periodic heartbeat output                                                   |
| `--log-dir <path>`        | Directory for proxy logs                                                         |
| `--log-stderr`            | Also log to stderr                                                               |
| `-d, --debug`             | Verbose logging                                                                  |

Prefer `MDBG_PROXY_TOKEN` over `--token`: a token on the command line is visible in `ps` and in
any `launch.json` under source control. The client reads the same variable, so one export
configures both ends.

---

### serial

Serial port utilities.

```sh
mcu-debug serial list [--all] [--json]
mcu-debug serial serve <device> [options]
```

| Command  | Description                            |
| -------- | -------------------------------------- |
| `list`   | List available serial ports            |
| `serve`  | Open a serial port and bridge it over TCP |

| Option    | Description                                                                       |
| --------- | --------------------------------------------------------------------------------- |
| `--all`   | Include ports normally filtered out, such as macOS `/dev/tty.*` callout variants   |
| `--json`  | Machine-readable output for `list`                                                 |

---

## In-Session Commands

During a debug session, in TUI or terminal mode, anything that is not recognised below is sent
straight to GDB. This includes while the target is **running** — mcu-debug drives GDB over the MI
interface, so GDB itself decides what is legal in the current state and returns an error for
commands that need a halted core.

| Command                       | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `status`                      | Session summary as JSON — config name, state, RTT/serial sources, file paths |
| `!!send [<prefix>] [text]`    | Write a line to a serial port or RTT channel — the only way to answer firmware that prompts for input. See [Meta-Commands](./meta-commands.md#send) |
| `continue` (`c`, `cont`, `run`) | Resume the target. In a script, `c&` resumes without waiting for the next stop — see [Running without waiting](#running-without-waiting) |
| `pause`                       | Halt a running target                                                       |
| `reset`                       | Reset the device                                                             |
| `restart`                     | Restart the debug session                                                    |
| `exit`                        | Graceful session exit — disconnect GDB, stop the gdb-server, clean up        |

`status`, `pause` and the meta-commands are safe to issue in any state. `!!send` in particular is
most useful while the target is **running** — that is when firmware is sitting at a prompt waiting
for a keypress.

Closing stdin of the `mcu-debug debug` process also ends the session, but `exit` is the reliable
way. Do not `kill -9` it — that leaves the gdb-server running and the probe claimed.

GDB commands can be any valid GDB command: `break`, `continue`, `step`, `next`, `print`, `x`,
`backtrace`, `info registers`, `monitor`, and so on.

Meta-commands start with `!!` — see [Meta-Commands](./meta-commands.md). Two of them exist for
scripts: [`!!sleep`](./meta-commands.md#sleep) and [`!!wait-stop`](./meta-commands.md#wait-stop).

Commands run one at a time, in the order they arrive, from any source: the keyboard, the socket,
or a script. The exceptions are `pause`, `!!sigint`, `status`, `exit` and the `!!ai`/`!!NOTE`
family typed interactively or sent over the socket. They act at once, even while another command
is still running, which is what makes `pause` usable at all.
