# Change Log

> **Pre-release:** there is no release version yet. Install via the dropdown beside **Install**
> and pick *Install Pre-Release Version*; see the README for why the plain button complains.

## [Unreleased]

## [v0.1.16] - 

### Session notes

- **Fixed a way to lose every note you had ever taken.** `.mcu-debug/notes.json` is the record
  an AI builds up across sessions, and it was rewritten by truncating the file and writing it
  again. A crash, a power cut, or the `kill -9` we tell you not to use, landing in that window,
  left it truncated — not this session's notes, all of them. It is now written to a temporary
  file and renamed into place, so the file on disk is always a complete one
- A `!!NOTE:` no longer discards notes taken by another session running in the same workspace.
  The whole file was rewritten from whatever was loaded at startup, so a second session on a
  different launch configuration would roll the first one back
- Bursts of notes are coalesced into a single write. `!!NOTE:` is issued by an AI, not typed by
  a person, so dozens can arrive at once — and each one used to rewrite the entire file twice
  while the debug session waited. Notes now reach disk within a quarter-second of the first one
  in a burst

### Housekeeping

- The `.mcu-debug` directory the CLI creates now gets a `.gitignore`, so session logs and notes
  stop showing up in `git status`. An existing one is left alone
- `.mcu-debug/archive` is pruned in the background: the 50 most recent sessions, or 64 MB of
  logs, whichever comes first. A session's log and its notes snapshot are removed together, so
  you never end up with evidence and no conclusions or the reverse. A gdb-server that loses its
  USB device can emit hundreds of errors a second, and one such afternoon could leave tens of
  megabytes behind

## [v0.1.15] - 2026-09-11

### Fixed: MCU-Debug would not start in a remote workspace

- **If you are on v0.1.14 and work in WSL, a dev container, or over Remote-SSH, upgrade.** In
  that release MCU-Debug declared
  [MCU-Debug Proxy Server](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug-proxy)
  as an extension dependency so VS Code would install it for you. That works locally, but VS
  Code resolves extension dependencies on the *workspace* side — and the proxy runs on the UI
  side, because it has to reach a debug probe attached to your local machine. In a remote
  window the requirement could therefore never be satisfied, and VS Code refused to activate
  MCU-Debug at all
- The declaration is gone. MCU-Debug now checks for the proxy at runtime, and only for
  configurations that actually need it — `hostConfig` with type `auto`. Local debugging never
  needs it, and `hostConfig.type: "ssh"` does not either, since that path starts its own agent
  over SSH
- If the proxy is missing when it is needed, you are told why and offered the install, rather
  than finding the extension silently inactive
- New command **MCU-Debug Developer: Check MCU-Debug Proxy** reports whether the proxy is
  reachable and which versions the two extensions are at. Worth running first if remote
  debugging misbehaves

### Serial and RTT are now two-way

- **New `!!send` meta-command writes to a serial port or RTT channel.** Until now those streams
  were read-only from a debug session: you could watch firmware print `Press 'Enter' to continue`
  and had no way to answer it, because stdin belongs to GDB. `!!send` addresses a stream by the
  same prefix that tags its output — `!!send [ttyACM0] help`, or just `!!send` to answer a bare
  Enter prompt. Serial menus and UART shells are now reachable from the session, and from an AI
  agent driving it. See
  [Meta-Commands](https://mcu-debug.github.io/mcu-debug/docs/reference/meta-commands)
- Messages you type to an attached AI agent (any other `!!` text) are now documented, and are no
  longer written straight to the console outside the normal output stream. They are seen by any
  AI attached to the session as user requests

### Target output fidelity

- **Lines from a serial port no longer arrive split.** The reassembly timer measured time since
  the first byte rather than silence on the port, so on a busy port it fired mid-line at fixed
  intervals and cut output at arbitrary places
- Blank lines and trailing spaces printed by firmware are preserved instead of being dropped —
  `printf("...\r\n\n")` now renders the way it was written
- Cursor movement and screen control from the target is stripped, keeping colour. Firmware that
  redraws a status line in place was overwriting the stream's prefix and producing garbled text,
  and a `\x1b[2J` at startup could clear the debug session's scrollback. In-place redraws now
  read as a scrolling transcript
- Lower latency on serial and RTT traffic, most noticeably to a probe on another machine
  (WSL, container, or SSH)

### TUI

- **The newest output is no longer hidden when a line wraps.** The output pane sized itself in
  lines rather than screen rows, so every wrapped line pushed one line off the bottom — on a
  narrow window the most recent output could be permanently invisible

### CLI

- Added `--nostdin` for running a session in the background, where reading the terminal would
  otherwise suspend the process. Implies `--wait-for-client`
- Meta-commands are now recognised regardless of case. `!!NOTE:` and `!!AI-REQUEST:` used to
  require exact capitalisation, and a lower-case variant was silently relayed as a message
  instead of being executed — losing the note
- An unrecognised meta-command is now reported as a warning rather than an informational line

## [v0.1.14] - 2026-09-10

- MCU-Debug now declares
  [MCU-Debug Proxy Server](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug-proxy)
  as an extension dependency, so VS Code installs it for you. The proxy is what lets MCU-Debug
  reach a debug probe attached to a different machine than your workspace — WSL, a dev container,
  or a lab server over SSH. If you only debug locally it sits idle and costs nothing, but do not
  uninstall it: VS Code will not load MCU-Debug while a declared dependency is missing

## [v0.1.12] - 2026-09-10

### AI / CLI

- Added a skill template for AI agents, shipped with the extension and published at
  [Writing Skills and Prompts](https://mcu-debug.github.io/mcu-debug/docs/ai/writing-skills).
  It documents the session lifecycle, the tagged output stream, meta-commands, and the
  troubleshooting cases that come up on real hardware
- **GDB commands are no longer blocked while the target is running.** The CLI used to silently
  discard any command sent while the core was executing — no error, no echo, nothing in the
  stream. Because mcu-debug drives GDB through the MI interface, plenty of commands are legal
  while running, and GDB itself rejects the ones that are not. Commands are now delivered
  whatever the state and GDB decides
- Commands sent while the target is running are now echoed to the log/socket stream
  (`user-input` / `socket-input`), as they always were when paused
- Session status notifications now carry machine-readable `status` and `reason` **fields**
  alongside the human-readable message, so consumers no longer have to parse prose. `status` is
  one of `not-started`, `starting`, `initialized`, `running`, `paused`, `terminated`
- The history replayed to a newly connected socket client now always begins at a whole line.
  Previously the ring buffer could wrap mid-record, so the first thing a client received was a
  truncated JSON fragment
- `mcu-debug attach` now exits when its stdin closes, instead of lingering with a half-dead
  connection. Detaching this way leaves the debug session running so it can be re-attached to
- **Breaking:** the `startedAt` field in `.mcu-debug/socket.json` is now `started`, matching
  what the Rust side has always expected. Anything parsing that file needs updating

### Live Watch

- Live watch can now lazy-start: registering a client connection starts the connection
  automatically rather than requiring it to be up front
- Added `always` vs `onReady` client modes for the live GDB connection
- Added client unregistration, and clean-up of GDB variables when children change
- `LiveConnectedEvent` now reports failure with a reason instead of failing silently

### Fixes

- Better error messages from memory read/write, including `Busy` and `notStopped` status

## [v0.1.11] - 2026-08-29

- See the [GitHub releases](https://github.com/mcu-debug/mcu-debug/releases) for history prior
  to this changelog
