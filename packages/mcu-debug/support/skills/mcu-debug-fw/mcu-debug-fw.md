---
name: mcu-debug-fw
description: >
  Debug embedded firmware on a microcontroller through the mcu-debug CLI — drive execution, set breakpoints,
  inspect registers and memory, and follow live RTT/UART telemetry. Use when investigating a crash or
  HardFault, inspecting firmware state, or tracing runtime behavior on a connected hardware target.
license: Apache-2.0
metadata:
  author: Haneef Mohammed (haneefdm)
---

# mcu-debug Skill Template for AI Tools

## 🧩 System Profile & Capabilities
You are an expert embedded firmware debugging agent capable of interacting natively with microcontrollers via the `mcu-debug` CLI tool. You can control execution, set hardware breakpoints, evaluate registers, and process real-time RTT/Serial telemetry streams simultaneously.

---

## 🔒 Hard Constraints (Read Before Execution)

### 1. The Execution State Rule
* **CRITICAL:** Track the most recent status-change notification — a JSON line with `"source":"DA"` and a `"status"` field. You do not need to parse every line of the stream; RTT/UART telemetry can be skimmed or ignored while you are waiting on state.
* **YOU MAY SEND COMMANDS WHILE RUNNING.** You are not required to halt the target before typing. Every command is delivered to GDB whatever the state, and **GDB is the authority** on what is legal right now.
* **WHAT NEEDS A HALTED CORE:** anything that touches the *target* — reading or writing memory and registers, local variables, expressions that dereference target memory, thread state, and setting or clearing breakpoints (which means writing to memory or to hardware breakpoint registers).
* **WHAT WORKS WHILE RUNNING:** anything GDB can answer from its own bookkeeping without going to the target — `info breakpoints` is the canonical example.
* **A REJECTION IS FREE.** If you guess wrong, GDB returns an error and *nothing else happens* — the session is not disturbed, the target keeps running, no state is corrupted. One wasted round trip is the entire cost. Prefer trying over halting the target on speculation.
* **TO INSPECT TARGET STATE:** send `!!SIGINT` and wait for `"status":"paused"`, then read what you need.
* **ALWAYS SAFE:** `status`, `!!SIGINT` and `!!NOTE:` are safe in any state, as is any conversation between AI and humans.
* **SINGLE CORE:** The cli-mode does not support debugging more than one core at a time. You can have a multi-core device but you can launch/attach to a single core (use `numberOfProcessors` and `targetProcessor` in debug configuration)

Do not maintain your own allow-list of "commands that work while running". The real boundary
depends on the target, the gdb-server and whether non-stop mode is available, so any list you
carry will be wrong somewhere. Send the command and read the response — a rejection costs you one
round trip and tells you the truth for *this* session.

> This works because mcu-debug drives GDB through the **MI interface**, not a terminal REPL.
> Scripting `gdb` directly in a terminal gives you no prompt at all while the target runs, so you
> cannot query anything until it stops. Here the channel is always open. If you are drawing on
> prior experience of driving GDB from a shell script, that instinct does not apply.

Read the machine-readable `status` and `reason` **fields**. Do not parse the `message` string — it is formatted for humans and its punctuation is not a contract.

```json
{"level":"info","message":"status: paused: Reason — breakpoint-hit","reason":"breakpoint-hit","source":"DA","status":"paused","timestamp":"2026-09-10T01:51:28.627Z"}
```

Where:
  `status` := not-started | starting | initialized | running | paused | terminated
  `reason` := reason reported by gdb, or `""` when there is none
  `source` := always "DA" (debug adapter) for status changes

Excerpt of a session run (from `grep '"status":' .mcu-debug/cli.log`). The same lines appear on the socket/pipe:
```json
{"level":"info","message":"status: initialized","reason":"","source":"DA","status":"initialized","timestamp":"2026-09-10T01:51:28.401Z"}
{"level":"info","message":"status: running","reason":"","source":"DA","status":"running","timestamp":"2026-09-10T01:51:28.516Z"}
{"level":"info","message":"status: paused: Reason — breakpoint-hit","reason":"breakpoint-hit","source":"DA","status":"paused","timestamp":"2026-09-10T01:51:28.627Z"}
{"level":"info","message":"status: terminated","reason":"","source":"DA","status":"terminated","timestamp":"2026-09-10T01:51:37.103Z"}
```

If you started the session yourself with `--no-tui` (Step 1a), the same status text is also written to **stderr** as a plain line (`status: running`), so you can track state without parsing JSON. The JSON form is only on the socket/pipe and the log file.

### 2. Interrupting a Running Target
* If you need to inspect or halt a target that is currently running, you **MUST NOT** send a standard Ctrl+C character down stdin. 
* Instead, send the explicit meta-command text `!!SIGINT\n` to gracefully drop the proxy server into a command-ready state.

### 3. This Skill Requires a Haltable Target

Everything above depends on being able to stop the core. If the debug configuration disables
halting — most commonly `"set remote interrupt-on-connect off"` in `preLaunchCommands` — **stop
and tell the user.** Do not proceed, and do not try to force the target to halt.

* The CLI cannot drive a never-halt session today. `liveWatch` (the non-stop inspection channel)
  is explicitly disabled in CLI mode, so there is no way to read state without halting.
* Waiting for `"status":"paused"` on such a target will wait forever.
* Forcing a halt may be **physically unsafe**. This configuration is used for motor control and
  similar real-time systems where stopping the core mid-operation can damage hardware or whatever
  it is driving. This is not a case where a workaround is better than stopping.

Say plainly that the configuration is outside this skill's scope and let the user decide how to
proceed.

---

## 🛠️ Golden Execution Workflow

### Step 1: Starting the debug session

Checklist:
- Installed the mcu-debug extension (and also the mcu-debug-proxy extension if using remote debugging with WSL/Docker/ssh)
- You must have a .vscode/launch.json or equivalent file to start a debug session. If the debug configuration was already known to work inside VSCode for GUI based debugging, that is a big bonus.
- For telemetry, add all your rttConfig/serialConfig in the launch configuration, with recognizable labels
- Make sure your settings to find the gdb-server and GNU toolchain are in the .vscode/settings.json or equivalent
- **Recommended:** set `"runToEntryPoint": "main"` (or `"breakAfterReset": true` to stop at reset) so the target halts before it starts running

**Recommended flow — be connected before anything happens, then release the target.** Two
independent mechanisms get you there, and they compose:

1. `--wait-for-client` (Step 1a) holds the whole session — gdb-server, gdb, telemetry, everything
   — until a client connects to the socket. Nothing happens before you are attached, so there is
   no history to reconstruct and the replay window is irrelevant.
2. `runToEntryPoint` (above) means that when the session does start, the target comes up stopped
   at `main` with RTT/serial configured but not yet flowing.

Use both. You end up connected from the first byte, with the target halted and quiet. Then run
`status` to confirm `"status":"paused"`, read `.mcu-debug/notes.json`, set whatever breakpoints
you need — and only then issue `continue` and let the telemetry spray. Every byte that follows is
history you were present for. Starting a free-running target and attaching afterwards means
arriving mid-flood with only a small replay window of context.

`--wait-for-client` is the more important of the two, because it does not depend on the target
being haltable — it works even where `runToEntryPoint` cannot be used.

This applies to `"request": "launch"` sessions. An `"request": "attach"` session joins a target
that may already be running, where the halted-first guarantee does not hold — treat that as the
advanced case and expect to `!!SIGINT` before you can inspect anything.

AI can either start a new debug session for totally autonomous debugging (1a), or join a user started session (1b). Even if you start with (1a), (1b) is still necessary

#### Step 1a: Start a new session

For Windows use the path `%USERPROFILE%\.mcu-debug\bin\mcu-debug.cmd` in all commands below

```bash
~/.mcu-debug/bin/mcu-debug debug --no-tui --config <name-of-configuration | index> [--json <path-to-launch.json>] [--settings <path-to-settings-file>] [--log-file <path-to-log-file>]
```
For `--config` you can use a full configuration name, or an index, or a glob pattern that matches **exactly one** configuration — an ambiguous glob is an error, not a silent first-match. Only configurations of `"type":"mcu-debug"` are considered. Indexing starts with 0 and does not include non mcu-debug configurations.

The optional arguments default to `--json .vscode/launch.json` and `--settings .vscode/settings.json`, and an omitted `--log-file` writes to `$CWD/.mcu-debug/cli.log`, so you rarely need to pass any of them. The simplest command you can issue would be `mcu-debug debug -c 0` at the root of the workspace, since `--no-tui` is auto triggered if STDOUT is not a TTY

##### Preferred: `--wait-for-client`

Add `--wait-for-client` and the session does nothing at all until a client connects to the
socket — no gdb-server, no gdb, no telemetry. You are then present for the entire session from
the first byte instead of joining one already in progress.

Because the launch blocks waiting for you, it has to run in the background and you connect from a
second command:

```bash
cd <workspace-root>
~/.mcu-debug/bin/mcu-debug debug --no-tui -c 0 --wait-for-client &
~/.mcu-debug/bin/mcu-debug attach
```

The socket is advertised in `.mcu-debug/socket.json` as soon as the server is listening, which
happens *before* the wait, so `attach` can always find it. If no client ever connects the session
waits indefinitely — it logs one error after 5 seconds and then keeps waiting, so a session that
appears hung with no output is usually a client that never arrived.

The above file will create/update the following files
```
.mcu-debug/
├── archive/        // Old sessions archived here
├── cli.log         // The default log-file location
├── notes.json      // Any notes taken so far. Absent if no notes taken
└── socket.json     // Current session information
```

The following is an example `.mcu-debug/socket.json` file, as written on Linux/Mac:
```json
{
  "pid": 745960,
  "socket": "/tmp/mcu-debug-745960-0.sock",
  "cwd": "/home/hdm/src/mtb37-p6h",
  "config": "Launch (OpenOCD)",
  "started": "2026-08-12T18:29:27.859Z",
  "logFile": "/tmp/mcu-debug.log"
}
```

`socket` and `pipe` are mutually exclusive. On Windows there is no `socket` entry; it is replaced by a `pipe` entry such as `"pipe": "\\\\.\\pipe\\mcu-debug-745960"`. Never expect both keys in the same file.

While the logfile provides a read-only view into the debug session, connecting to the socket/pipe will give AI bidirectional interaction. AI can supply gdb commands or meta-commands. For AI, the socket/pipe is highly recommended

There are a few other options that may be of help. For full help
```bash
~/.mcu-debug/bin/mcu-debug --help
~/.mcu-debug/bin/mcu-debug debug --help
```
#### Step 1b: Connecting to an already started session

A debug session should already be running. With or without TUI. TUI mode can help AI to interact with the user as well as GDB to form a 3-way conversation. This can also be done inside the VSCode's `MCU Debug` Panel's `AI- ockpit`. Regardless of how the session started, the rest of the procedure remains the same.

Run `attach` from the root of the workspace and it will find the session for you — it reads `.mcu-debug/socket.json` from the current directory and picks the right endpoint for the platform (`socket` on Linux/Mac, `pipe` on Windows). You do not need to parse the file yourself.

```bash
cd <workspace-root> && ~/.mcu-debug/bin/mcu-debug attach
```

Resolution is relative to the current directory, so this is the one thing that can fail — if the session was started somewhere else, pass the endpoint explicitly:

```bash
~/.mcu-debug/bin/mcu-debug attach -s <socket-or-pipe-path>
```

Either form gives you the existing session over stdio. You can also connect to the socket/pipe directly if you prefer to manage the connection yourself. When a connection is made to the socket/pipe, about 10KB of recent history is replayed to you, always starting at a whole line — you never receive a partial JSON record. This is a small recency window, not an archive: for anything older, `grep` the log file, which has the complete session with no limit.

### Step 2: Initial Hook & State Verification
Always start your session by querying the current target status using the plain text meta-command:
```text
status
```

When you first connect to a session, you should **always** check (`info breakpoints`) for what breakpoints are already set. This will let you know gdbs state.

You can run this anytime to get a JSON payload with the current session status along with a host of other information — it includes `status`, `cwd`, `pid`, `targetCwd`, `configName`, `serverType`, `configType`, `rtts`, `serialPorts`, `socketPath` and `logFile`.

Note that it arrives as a log line whose `message` field is the string `Session summary: {…}`, so it takes two steps: parse the stream line, then strip the `Session summary: ` prefix and parse the remainder.

### Step 3: Stream Filtering

Three sources carry almost everything you need: **`DA`** for execution state, **`GDB`** for command results, and **`RTT`/`serial`** for application telemetry. Route those first and treat the rest as context. Any message with no `source` comes from the debug infrastructure — those will be tagged in a future release.

Full source list:
* `source: "DA"` with a `status` field ➡️ Immediately update your internal execution state engine (see Hard Constraint #1).
* `source: "DA"` ➡️ Every other message from the debug adapter
* `source: "GDB"` ➡️ Contains messages from gdb responses to commands initiated by DA, AI, or humans
* `source: "GDB-MI"` ➡️ These are debug messages you should never see unless `debugFlags.gdbTraces === true` in the debug configuration
* `source: "GDB-SERVER"` ➡️ are messages from the gdb-server (openocd, jlink, etc.)
* `source: "AI"` ➡️ are messages from the socket/pipe, presumably from AI. An `!!AI-REQUEST:...` is asking the user to do something (like press a button) and `!!AI-REQUEST-CLEAR` is asking the GUI/UI to clear area displaying the last request. Seeing these messages is an acknowledgement that the message was processed by the DA
* `source: "USER-REQUEST"` ➡️ are messages from the user to AI
* `source: "user-input"` ➡️ Echoes what the user typed
* `source: "socket-input"` ➡️ Echoes what came over the socket, presumably from AI
* `source: "RTT"` ➡️ Live RTT print statements containing application telemetry
* `source: "serial"` ➡️ Live UART/serial print statements containing application telemetry

Note on telemetry labels: the label you set in `rttConfig`/`serialConfig` does **not** appear in `source` — it is prepended to the `message` text as a prefix. To tell one RTT channel or serial port from another, match the message prefix, not the source. TODO: Formalize per-label source tagging.

### Step 4: Session Notes Cache
To maintain historical context across system resets or multi-stage bug investigations, use the session notes meta-command to commit summaries of your findings directly into persistent memory:
```text
!!NOTE: [{"op":"add","path":"/resolved/-","value":"Identified HardFault trace pointing to unaligned memory access at 0x200041A4"}]
```

### Step 5: End or Reset a session

#### Reset
Reset: is a powerful feature. You can reset a device using the `!!RESET` command. This will perform a reset (using the builtin knowledge of the gdb-server or user controlled method in launch.json `overrideResetCommands`, `preResetCommands`, `postResetCommands`). Resetting does not involve re-compilation or re-flashing. Not all devices support a proper reset.

#### End session

Send the `exit` command. This properly ends the gdb-server and gdb processes and releases the
(USB) probe for the next session. This is the reliable way and the one you should use.

Closing stdin does **different things depending on which process you started**, so be deliberate:

When the session ends, any breakpoints are saved and then restored on the next session.

* Closing stdin of `mcu-debug debug` (Step 1a — the process hosting the session) ends the session.
* Closing stdin of `mcu-debug attach` (Step 1b) only disconnects *you*. The session keeps running,
  the probe stays claimed, and you or someone else can attach to it again. Use this when you want
  to leave a session running for a human to take over.

**DO NOT KILL** like `kill -9` the `mcu-debug` process as it will leave the gdb-server process
running - requiring manual intervention for the next session.

## Key Principles

### How to take session notes

Session notes are a persistent JSON file that serves as the AI's working memory across target resets, context compactions, and multiple sessions on the same project.

See https://mcu-debug.github.io/mcu-debug/docs/ai/session-notes for notes format and allowed operations

### Read .mcu-debug/notes.json first

Prior sessions may have already ruled out your first hypothesis. Starting from the notes rather than from scratch saves significant time in multi-session investigations. 

### Update notes as you go

Context compaction will eventually truncate conversation history. Notes are the durable record. If your reasoning only exists in the conversation, it disappears at compaction. If it exists in `.mcu-debug/notes.json`, it survives indefinitely.

### Use meta-command `!!SIGINT` over GDB `interrupt`

The `!!SIGINT` meta-command is more reliable across different gdb-server topologies than GDB's built-in `interrupt` command. In remote debugging scenarios (SSH, WSL), `!!SIGINT` is routed correctly by the proxy.

See https://mcu-debug.github.io/mcu-debug/docs/reference/meta-commands for a full list of all meta-commands

### Search the log rather than relying on scrollback

```sh
grep -i "ERROR\|FAULT\|Hard fault\|assert" .mcu-debug/cli.log
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

:::note
Most gdb-servers do not allow reading memory or other inspection, as they don't support `non-stop` mode. If your gdb server supports `non-stop` mode please enable it using `postLaunchCommands` or equivalent.
:::

TBD: Combined with Live Watch, this gives you continuous visibility without disturbing execution. We are trying to implement this at least with some gdb-servers

## Advanced: Autonomous Investigation Script

For fully autonomous bug hunting, you can structure a systematic investigation:

```
Example session: You are debugging a firmware crash. Follow this process:

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
8. When you identify the root cause, update your notes and that will be summarized in `.mcu-debug/notes.json`
```

## Troubleshooting

### GDB Remote Timeouts
If the AI stream or proxy pipeline drops due to communication latency, add this configuration block. It is rarely necessary to wait a full 15 seconds, but it provides a safe buffer for slow debug probes or multi-hop network boundaries (like SSH or WSL over NAT).
```json
"preLaunchCommands": [
    "set remotetimeout 15"
]
```

### Background Memory and RTT Failures
If automated skills or real-time inspection features (like Live Watch or RTT) fail to read memory while the core is running, your hardware target likely restricts background bus access by default (common on PSoC/Infineon devices). Add these directives to unlock the bus:
```json
"postLaunchCommands": [
    "set mem inaccessible-by-default off",
    "set remotetimeout 15"
]
```
*(Note: `set mem inaccessible-by-default off` instructs GDB to attempt reading unmapped or unkown memory regions rather than immediately rejecting the request).*

### Target Stalls or "notStopped"/"readMemory" Errors
If background memory monitoring causes erratic target lockups or slips into a persistent state of `readMemory failed..` or `Read memory error:` on what should be valid memory, your debug server may be colliding with high-speed hardware tasks (like active DMA or peripheral bus transactions). 
* **Fix:** Disable any high-frequency continuous streaming loops in your AI skill prompt, and rely on targeted on-demand reads using the `status` command or localized memory expressions instead.
