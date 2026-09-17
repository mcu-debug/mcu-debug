# MCU-Debug Telemetry

MCU-Debug collects a small amount of **anonymous** usage telemetry so we can see which features
and GDB-server types are actually used and prioritize accordingly. This page documents exactly
what is collected and how to turn it off. If in doubt, turn it off — we would rather have your
trust than your data.

> [!IMPORTANT]
> We request you to have telemetry enabled. It will give us enormous insight for improving our
> project and conserver our resources. Just the fact that people are using our project is enough
> for us to stay motivated.

## What we collect

Telemetry records the **shape** of a debug session, never its content.

Per debug session (`session-started` / `session-ended`):

- `origin` — how the session was started: `vscode-debug`, `vscode-panel`, `tui`, `headless`, or `terminal`
- `servertype` — e.g. `jlink`, `openocd`, `probe-rs`, `pyocd`, `stlink`, `qemu`, `external`
- `rtos` — the configured RTOS name, or `none`
- Feature flags, each present only when enabled: `swo`, `rtt`, `builtinRtt`, `graphing`,
  `serial`, `liveWatch`, `multicore` (set when `chainedConfigurations` is used)
- `remoteProbe` — `auto` or `ssh` when remote-probe support is used (never a host or address)
- `durationSec` — session length, on `session-ended`
- `mode` — `vscode` or `cli`

Common properties attached to every event:

- Extension version, VS Code version, OS name and version
- `remote` — the VS Code remote kind (`local`, `wsl`, `ssh-remote`, `dev-container`, …)
- `uiKind` (Desktop/Web), `appHost`
- An anonymous, non-reversible install id (VS Code's `machineId`)

## What we do **not** collect

- No file paths, workspace names, or source code
- No device/chip identifiers, ELF names, or symbol data
- No host names, IP addresses, ports, SSH targets, or tokens
- No personal data, and nothing that identifies you or your project

## Command-line usage

When you run the debugger from the command line, it has no network connection of its own. It
appends the same anonymous events to `~/.mcu-debug/telemetry.json`, and the VS Code extension
flushes that file the next time it starts — after re-checking the opt-out settings below. If you
only ever use the CLI, the data never leaves your machine.

## How to turn it off

Any one of these disables it:

- **Globally, for all extensions** — set VS Code's `telemetry.telemetryLevel` to `off`. MCU-Debug
  honors this automatically.
- **For MCU-Debug only** — set `mcu-debug.enableTelemetry` to `false` in Settings.
- **For the command-line tool** — set the environment variable `DO_NOT_TRACK=1`, or
  `MCU_DEBUG_TELEMETRY=0`. When telemetry is off, the extension deletes any queued CLI events
  instead of sending them.

## Where it goes

Events are sent to [PostHog](https://posthog.com). The key embedded in the extension is a
write-only project ingestion key: it can submit events but cannot read any data back.
