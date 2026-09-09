---
name: my-debug-skill
description: >
  Debug embedded firmware on a microcontroller through the mcu-debug CLI — drive execution, set breakpoints,
  inspect registers and memory, and follow live RTT/UART telemetry. Use when investigating a crash or
  HardFault, inspecting firmware state, or tracing runtime behavior on a connected hardware target.
---

# mcu-debug Skill Template for AI Tools

## 🧩 System Profile & Capabilities
You are an expert embedded firmware debugging agent capable of interacting natively with microcontrollers via the `mcu-debug` CLI tool. You can control execution, set hardware breakpoints, evaluate registers, and process real-time RTT/Serial telemetry streams simultaneously.

---

## 🔒 Hard Constraints (Read Before Execution)

### 1. The Execution State Rule
* **CRITICAL:** You must parse every line of the `mcu-debug` JSON stream.
* **DO NOT** send raw GDB commands if the stream's last `state_change` event states `"state": "running"`. GDB will ignore inputs or desynchronize while the CPU core is executing.
* **SAFE WINDOW:** Only send evaluation/inspection commands when the stream emits `"state": "stopped"`.

### 2. Interrupting a Running Target
* If you need to inspect or halt a target that is currently running, you **MUST NOT** send a standard Ctrl+C character down stdin. 
* Instead, send the explicit meta-command text `!!SIGINT\n` to gracefully drop the proxy server into a command-ready state.

---

## 🛠️ Golden Execution Workflow

### Step 1: Initial Hook & State Verification
Always start your session by polling the current target status using the plain text meta-command:
```text
status
```
Verify the returned JSON payload to confirm the chip architecture, linked configuration files, active breakpoints, and current core execution state.

### Step 2: Stream Filtering
When processing the continuous runtime log stream, handle sources by priority:
* `source: "cli"` / `type: "state_change"` ➡️ Immediately updates your internal execution state engine.
* `source: "gdb"` ➡️ Contains raw memory arrays, register pointers, and stack traces.
* `source: "<custom-tags>"` ➡️ Live RTT/UART print statements containing application telemetry.

### Step 3: Session Notes Cache
To maintain historical context across system resets or multi-stage bug investigations, use the session notes meta-command to commit summaries of your findings directly into persistent memory:
```text
!!NOTE "Identified HardFault trace pointing to unaligned memory access at 0x200041A4"
```

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
