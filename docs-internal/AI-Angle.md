---

## **Project: AI-Agentic MCU Debugger (mcu-debug CLI)**
### **Core Objective**
To provide a high-bandwidth, autonomous debugging bridge that allows AI agents (Claude Code, Copilot, etc.) to interact directly with firmware via raw GDB, while allowing a human engineer to provide contextual "real-world" guidance.

---

### **1. System Architecture**
The system uses a **Node.js Orchestrator** to manage the lifecycle of the debug session, leveraging existing VS Code configurations.

* **Config Source:** Uses `launch.json` and `settings.json` as the Single Source of Truth (SSOT) for paths, toolchains, and GDB-server parameters.
* **Process Management:** Instead of `node-pty` (which adds ANSI complexity for AI), use `child_process.spawn` for raw, sequential data streams.
* **The Multiplexer (Mux):** All data sources are tagged and piped to a single `stdout` stream for the AI.
    * `[GDB]`: Standard GDB machine-interface or text output.
    * `[RTT#N]`: SEGGER Real-Time Transfer channels (default tag form; user labels override — see Section 11).
    * `[SWO]`: Single Wire Output telemetry.
    * `[UART:<port>]`: UART/serial sources (e.g. `[UART:ttyUSB0]`, `[UART:COM3]`). User labels override the default — see Section 11.
    * `[USER-REQUEST]`: Human-in-the-loop observations typed by the engineer.
    * `[AI-REQUEST]`: Reverse channel — requests from the AI to the human (see Section 6).

---

### **2. Interaction Models**
#### **The Hybrid Mode ("Glass Cockpit")**
* **Visualization:** A VS Code WebviewPanel hosts the Glass Cockpit UI (see Section 6).
* **Intervention:** The human types observations into the input line. The orchestrator prefixes them with `[USER-REQUEST]` so the AI "hears" the engineer.
* **Control:** The AI remains the "Master" of the GDB stdin to prevent command contention, but responds to user-driven pauses or pivots.

#### **Autonomous Loop ("The Lab Scientist")**
* **Cycle:** The AI can instrument code (add logs/toggles) $\rightarrow$ Rebuild (using `tasks.json`) $\rightarrow$ Flash/Program $\rightarrow$ Observe logs.
* **State Persistence:** The Node wrapper ensures that if the target resets, breakpoints and essential state are re-applied automatically.

---

### **3. Key Design Decisions**
* **Raw GDB over MI/MCP:** By avoiding high-level abstractions like the Model Context Protocol (MCP), the AI has full access to the power of GDB (scripts, watchpoints, etc.) without "translation tax."
* **Tee-to-File:** All RTT/SWO data is "teed" to a local log file.
    * *Reasoning:* Prevents the AI's context window from being overwhelmed by "runaway logs" while allowing the AI to use a "Search Tool" to scan the full history if a crash occurs. The display panel is throttled (see Section 6); the file is always complete and unthrottled.
* **Meta-Command Mapping:** Since agents can't "press keys," specific strings are mapped by the Node orchestrator to OS signals or GDB-server commands. Reserved meta-commands:
    * `!!SIGINT` — sends SIGINT to the target.
    * `!!RESET` — resets the target via the gdb-server.
    * `!!AI-REQUEST: <text>` — posts a request to the human in the Glass Cockpit panel.
    * `!!AI-REQUEST-CLEAR` — clears the AI-REQUEST panel section once the AI is satisfied.
    * `!!NOTE: <json-patch>` — patches the session notes sidecar file (see Section 7).

---

### **4. Implementation Roadmap**
1.  **Phase 1: CLI Foundation**
    * Build the Node wrapper to resolve `launch.json` paths.
    * Implement basic process spawning for GDB and the GDB-server (OpenOCD, J-Link, etc.).
2.  **Phase 2: The Skill Layer (`SKILL.md`)**
    * Define instructions for the AI on how to handle the muxed stream.
    * Set protocols for User-Requests and AI-Requests.
    * Define capability-discovery phase (see Section 8).
3.  **Phase 3: VS Code Extension Integration**
    * Implement the Glass Cockpit WebviewPanel with the three-section layout.
    * Wire AI-REQUEST meta-commands to the sticky panel section.

---

### **5. The "SKILL.md" Logic (Draft)**
> "You are an expert Firmware Engineer. You have access to a raw GDB stream.
> - **Input:** You receive `[GDB]` and `[RTT]` data.
> - **Priority:** `[USER-REQUEST]` tags contain physical-world observations. Prioritize these over your current hypothesis.
> - **Action:** If the target is running and you need to inspect state, send the `!!SIGINT` meta-command.
> - **Human requests:** If you need the human to perform a physical action (press a button, change a jumper, observe an LED), send `!!AI-REQUEST: <instruction>`. Clear it with `!!AI-REQUEST-CLEAR` once you have seen the expected response in the stream.
> - **Session notes:** Read `session-notes.json` at startup. Update it as you form or rule out hypotheses. This is your working memory across resets and context compactions."

---

### **6. Glass Cockpit Panel (WebviewPanel)**

The hybrid UI is a VS Code `WebviewPanel` using **xterm.js** (canvas renderer) for the output area and a plain HTML `<input>` for the engineer's single-line entry. It is **not** a `vscode.Terminal` — that API provides no layout control.

#### **Layout**

```
┌─────────────────────────────────────────┐
│  LIVE OUTPUT  (xterm.js, scrollable)    │  ← [GDB], [RTT#N], [SWO] — throttled
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ ⚑ AI REQUEST  (sticky, fixed height)   │  ← [AI-REQUEST] — persists until cleared
│  → Press SW2 to trigger the ISR         │
├─────────────────────────────────────────┤
│ > [USER-REQUEST input line]             │  ← engineer types here
└─────────────────────────────────────────┘
```

#### **Display Throttling**

RTT output volume can be extreme. The panel display is intentionally throttled; the tee file is always complete.

* The extension host buffers incoming data and flushes to the webview via `postMessage` at a configurable interval (default 500 ms, up to 2 s).
* A max-buffer-size safety valve (e.g. 32 KB) triggers an early flush to prevent a single message from overwhelming xterm.js.
* A badge ("**+1,243 lines**") or "▼ buffering" indicator informs the engineer that the display is intentionally behind the live stream.

```typescript
const FLUSH_INTERVAL_MS = 500;
const MAX_BUFFER_BYTES = 32_000;

let buffer = '';
let flushTimer: NodeJS.Timeout | null = null;

ptyProcess.onData(data => {
  teeToFile(data);                          // always, immediately
  buffer += data;
  if (buffer.length >= MAX_BUFFER_BYTES) flush();
  else scheduleFlush();
});
```
Extension side
```typescript
const panel = vscode.window.createWebviewPanel(
  'myConsole', 'My Console', vscode.ViewColumn.Two,
  { enableScripts: true, retainContextWhenHidden: true }
);

// pty data → webview
ptyProcess.onData(data => panel.webview.postMessage({ type: 'data', data }));

// input line → pty
panel.webview.onDidReceiveMessage(msg => {
  if (msg.type === 'input') ptyProcess.write(msg.text + '\r\n');
});
```
Webview HTML (simplified):
```html
<style>
  body { display: flex; flex-direction: column; height: 100vh; margin: 0; }
  #terminal { flex: 1; overflow: hidden; }
  #input-bar { display: flex; padding: 4px; background: var(--vscode-panel-background); }
  #input-bar input { flex: 1; background: transparent; color: inherit; border: none; outline: none; }
</style>

<div id="terminal"></div>
<div id="input-bar">
  <span>&gt;&nbsp;</span>
  <input id="cmd" type="text" autofocus />
</div>

<script src="xterm.js"></script>
<script>
  const term = new Terminal();
  term.open(document.getElementById('terminal'));

  window.addEventListener('message', e => {
    if (e.data.type === 'data') term.write(e.data.data);
  });

  document.getElementById('cmd').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      vscode.postMessage({ type: 'input', text: e.target.value });
      e.target.value = '';
    }
  });
</script>
```

#### **AI-REQUEST Section**

The AI-REQUEST area is a **sticky task board**, not a stream. It holds one or two pending physical-world requests from the AI (e.g. "Rotate the motor shaft by hand and observe"). It is:
* Set by the `!!AI-REQUEST: <text>` meta-command.
* Cleared by `!!AI-REQUEST-CLEAR` when the AI has observed the expected response — no explicit acknowledgement needed from the engineer.
* Visually distinct (highlighted border, icon) so it is never missed during a busy RTT burst.

---

### **7. Session Memory (AI Working Notes)**

The orchestrator creates a `session-notes.json` sidecar file at session start, alongside the tee log. Its path is injected into the AI's context via SKILL.md. This is the AI's working memory across target resets and context compactions.

```jsonc
// session-notes.json
{
  "working_theory": "DMA transfer completes but callback never fires",
  "ruled_out": [
    "Clock config — verified HFCLK stable",
    "IRQ priority — checked NVIC, no masking"
  ],
  "breadcrumbs": [
    "RTT showed counter increments but flag never set — line 247 suspect",
    "Hard fault at 0x0800_1A3C — still unresolved"
  ],
  "open_questions": [
    "Is the DMA IRQ handler even linked? Check map file."
  ]
}
```

**Lifecycle:**
* Created (empty scaffold) when the debug session starts.
* Read by the AI at startup to resume interrupted sessions.
* Updated by the AI via `!!NOTE: <json-patch>` meta-commands during the session.
* Archived (renamed with timestamp) when the session ends.

---

### **8. Capability Discovery & Non-Intrusive Debugging**

The debugger is a **platform tool** — it does not own the target firmware. The AI must discover what is available before choosing a strategy. SKILL.md should mandate a capability-discovery phase at session start:

```
On session start, determine:
1. What debug output is available? (RTT / SWO / UART / none)
2. Hardware or software breakpoints available? (some targets support only 2 HW)
3. Is timing sensitivity suspected? (engineer states this, or infer from symptoms)
```

#### **Timing-Sensitive / Zero-Breakpoint Mode**

Certain applications — motor control, high-frequency PWM, safety-critical loops — **cannot tolerate breakpoints**. Halting the CPU in these contexts corrupts state or causes hardware damage. In these cases the AI must operate entirely through non-intrusive means:

* **Prefer:** RTT instrumentation, hardware watchpoints (non-halting), SWO trace, memory reads at natural halt points.
* **Avoid:** Software breakpoints, single-stepping, any operation that halts the core mid-cycle.
* **Instrument instead:** Guide the engineer to add RTT log statements at key points and rebuild, rather than setting breakpoints.

The SKILL.md should include: *"If the engineer indicates a timing-sensitive application (e.g. motor control), treat all breakpoints as forbidden. Use only non-intrusive observation."*

> Note: Instrumentation itself can disturb timing. The AI should acknowledge this tradeoff and recommend the least-intrusive option available given the target's debug output capabilities.

---

### **9. CLI Deployment Modes**

The CLI tool serves three distinct scenarios. The same core binary handles all of them; only the attachment pattern differs. There is **no** "AI launches a terminal for the human" magic — that path was considered and rejected as over-complex and platform-fragile.

#### **Mode 1 — AI alone (headless)**

```
AI CLI (Claude, Copilot, etc.) spawns mcu-debug as a subprocess.
   stdin:  AI writes GDB commands and meta-commands.
   stdout: AI reads the tagged mux stream.
   tee:    Always-on log file for retrospective search.
```

No TUI. No human. Stream-only. This is auto-detected: when `stdout` is not a TTY, the CLI runs headless with no terminal manipulation. The AI's parent TUI (e.g. Claude's renderer) is never disturbed.

#### **Mode 2 — Human alone (interactive)**

```
Human runs mcu-debug directly in their own terminal.
   TUI:    Three-region layout (live output / AI-REQUEST / input).
   stdin:  Human types GDB commands directly.
```

No AI involved. The AI-REQUEST region stays empty. This is also the dogfooding path — the human can use the tool as a fancier terminal debugger with mux'd RTT/SWO and tee logging, with no AI in the loop at all.

#### **Mode 3 — Hybrid (human starts, AI attaches)**

The hybrid case is **always human-initiated**. Same model as `tmux`: one session, multiple attachers.

```
1. Human opens their terminal and runs:  mcu-debug
   → TUI appears.
   → Session socket created at ~/.mcu-debug/current.sock
     (and at /tmp/mcu-debug-<pid>.sock for explicit addressing).

2. Human asks their AI CLI to help debug.

3. AI runs:  mcu-debug attach
   → Auto-finds the active session via the well-known path.
   → AI gets the tagged stream on stdout, sends commands on stdin.

4. Both are now connected to the same session:
   → Human still sees the TUI and can inject [USER-REQUEST] lines.
   → AI sends GDB commands and meta-commands.
   → Both see all output (mux stream is broadcast to all attachers).
```

The AI never spawns terminals. The human was already in a terminal because that is how humans use computers. Multiple attachers are supported (a second human, a logger, a CI injector — all just attach to the socket).

#### **Mode 4 — CI/CD (scripted)**

```
mcu-debug --script test/integration.gdb \
          --expect "TEST_PASS" \
          --timeout 60s \
          --log results.log
```

Headless, no TTY required. Reads commands from a script file, watches output for expected patterns, exits with status code. The tee file becomes the CI artifact.

#### **Session Discovery**

For Mode 3, the AI needs to find the session:

* **Default (well-known path):** `~/.mcu-debug/current.sock` — symlinked to the most recently started session. `mcu-debug attach` with no args uses this. Works for the 99% case.
* **Explicit path:** `mcu-debug attach /tmp/mcu-debug-<pid>.sock` — for multi-session setups.
* **Listing:** `mcu-debug list` — enumerates active sessions if the user has more than one running.

The SKILL.md instruction for the AI is one line: *"To attach to a debug session, run `mcu-debug attach`. The active session is auto-discovered."*

---

### **10. Implementation Split (Node + Rust)**

The CLI reuses the existing TypeScript codebase for orchestration and delegates terminal rendering to the Rust helper binary that is already shipped.

| Component | Language | Responsibility |
|---|---|---|
| `mcu-debug` CLI orchestrator | Node/TS | GDB process management, mux logic, tee file, session socket, RTT/SWO handling, meta-command parsing — reuses existing DA code |
| `mcu-debug-helper attach` (new subcommand) | Rust + ratatui | TUI rendering, raw terminal handling, user input capture, socket client |

#### **Why this split**

* **Reuse:** The TypeScript DA already knows how to drive GDB, parse output, manage RTT pre-decoders, and handle the proxy. None of that needs to be rewritten.
* **TUI tooling:** Rust's `ratatui` is best-in-class for terminal UIs. Node's terminal libraries either require native modules (raw mode, key handling) or are less polished.
* **Already shipped:** `mcu-debug-helper` is pre-built per platform and checked in. Adding an `attach` subcommand costs nothing in distribution complexity. (Same pattern as the planned `serial` subcommand for UART.)
* **Clean separation:** Orchestrator runs headless and exposes a socket. The TUI is just the first attacher. AI attachers, second-human attachers, CI injectors all use the same protocol.

#### **Process model**

```
User runs `mcu-debug` in their terminal:
  ├─ Node orchestrator starts (manages GDB, mux, tee, socket)
  └─ Spawns `mcu-debug-helper attach <socket>` with stdio inherited
       → Helper takes over the terminal and renders the TUI
       → Helper exits → orchestrator shuts down (or persists if --detach)

AI runs `mcu-debug attach`:
  └─ Spawns `mcu-debug-helper attach <socket>` in headless mode (--no-tui)
       → Helper proxies socket I/O to/from stdio
       → AI sees the tagged stream on stdout
```

The orchestrator never touches the terminal directly. All terminal interaction lives in the Rust helper. This keeps the Node side portable and the Rust side focused on what it does well.

---

### **11. UART as a First-Class Mux Source**

UART is supported alongside RTT and SWO with the same model: tagged stream, bidirectional, configurable per source. Adding it to the VS Code extension lights up the CLI for free, since both consume the same `launch.json` (SSOT).

#### **`launch.json` schema**

```jsonc
"uartConfig": {
  "enabled": true,                     // master toggle — keep config when disabled
  "uarts": [
    {
      "label": "DebugUART",            // optional; default is the port basename
      "port": "/dev/ttyUSB0",          // or "COM3" on Windows
      "baud": 115200,
      "parity": "none",                // optional, default 8N1
      "stopBits": 1,
      "dataBits": 8,
      "direction": "both",             // "rx" | "tx" | "both" — default "both"
      "preDecoder": null               // optional, for binary protocols (future)
    }
  ]
}
```

#### **Default tag scheme**

Each medium uses the identifier most natural to it:

| Source | Default tag | User-labeled tag |
|---|---|---|
| RTT | `[RTT#0]`, `[RTT#1]` (channel number) | `[RTT:Console]` |
| UART | `[UART:ttyUSB0]`, `[UART:COM3]` (port basename) | `[UART:DebugUART]` |
| SWO | `[SWO]` (single source) | n/a |

Existing collision-resolution logic (already in place for RTT/SWO labels) handles the rare case of duplicate basenames (e.g. macOS `/dev/cu.X` and `/dev/tty.X`).

#### **Implementation**

* The Rust `mcu-debug-helper serial` subcommand opens the port and streams data — same pattern as `da_helper`, `proxy_helper`. No native Node modules required.
* `direction` controls whether the input dropdown in the Glass Cockpit / TUI offers this UART as a write target.
* Bidirectional model matches RTT — the human (or AI) can send menu selections, commands, etc. to interactive UART shells.

#### **Discovery helper (optional)**

`mcu-debug-helper serial list` enumerates available ports with VID/PID, useful when first authoring `uartConfig`. Not required to use UARTs, but lowers the "what port am I on?" friction.

---
