# Change Log

## [Unreleased]

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
