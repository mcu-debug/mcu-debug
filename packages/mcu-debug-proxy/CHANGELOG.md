# Change Log

> **Pre-release:** there is no release version yet. Install via the dropdown beside **Install** and pick *Install Pre-Release Version*.

This extension's version tracks the main
[MCU-Debug](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug) extension so
that the two always install as a matched pair. Most entries here are version bumps with no
functional change on this side — when in doubt, the detail for a given version is in the main
extension's
[changelog](https://github.com/mcu-debug/mcu-debug/blob/main/packages/mcu-debug/CHANGELOG.md).

## [Unreleased]

## [v0.1.16] - 

- This extension ships the Probe Agent binary, and reinstalling a build over itself used to leave
  the previously running agent in place — the new install then talked to the old code. The agent
  now notices that its executable has been replaced and hands over gracefully, finishing any live
  debug sessions on the way out. See the main extension's
  [changelog](https://github.com/mcu-debug/mcu-debug/blob/main/packages/mcu-debug/CHANGELOG.md)
- Added a **MCU-Debug Proxy** output channel recording what happens on each launch: which agent
  answered, its version and port, the addresses it accepts on, and whether that is the agent this
  build shipped. Worth opening first when remote debugging does not behave
- Added an internal `proxyStatus` command so MCU-Debug can report on the Probe Agent running on
  this machine. It has to be asked from here: the agent's binary and its control port are both on
  this side, which in a remote window is a different machine from the workspace

## [v0.1.15] - 2026-09-11

- MCU-Debug no longer declares this extension as a dependency — that prevented MCU-Debug from
  activating at all in a remote workspace, since VS Code resolves dependencies on the workspace
  side while this extension has to run on the UI side. It is now detected at runtime instead,
  and you are prompted to install it when a configuration needs it. See the main extension's
  [changelog](https://github.com/mcu-debug/mcu-debug/blob/main/packages/mcu-debug/CHANGELOG.md)
- Added an internal `ping` command so MCU-Debug can detect this extension across extension
  hosts, which is something the VS Code extension API cannot otherwise do

## [v0.1.14] - 2026-09-10

- MCU-Debug now declares this extension as a dependency, so it installs automatically alongside
  MCU-Debug instead of having to be picked up separately
- Otherwise a version bump to stay in lockstep with `mcu-debug` v0.1.14

## [v0.1.12] - 2026-09-10

- Better error reporting from the proxy's memory read/write path, including `Busy` and
  `notStopped` status
- Listing metadata: added an icon, a display name, and the `Debuggers` category
- Otherwise a version bump to stay in lockstep with `mcu-debug` v0.1.12

## [v0.1.11] - 2026-08-29

- See the [GitHub releases](https://github.com/mcu-debug/mcu-debug/releases) for history prior
  to this changelog
