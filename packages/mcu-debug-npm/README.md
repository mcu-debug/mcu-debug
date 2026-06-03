# mcu-debug

CLI tool for [mcu-debug](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug) — an embedded MCU debugger for VS Code.

Debug ARM Cortex-M firmware from a terminal, TUI, or AI tool using the same `launch.json` as your VS Code setup.

## Prerequisites

- [mcu-debug VS Code extension](https://marketplace.visualstudio.com/items?itemName=mcu-debug.mcu-debug) installed and activated
- Node.js >= 22
- A gdb-server for your probe (OpenOCD, JLink, pyOCD, etc.)

## Usage

```sh
# No install required
npx mcu-debug debug -c "My Config"

# Or install globally
npm install -g mcu-debug
mcu-debug debug -c "My Config"
```

## How it works

This package is a thin locator wrapper. All assets (the Rust binary, bundled scripts, NodeJS programs) live in the VS Code extension directory. The wrapper reads `~/.mcu-debug/config.json` — written by the extension on every activation — to find them.

If the extension is not installed, you will see a clear error with a marketplace link.

## Commands

```sh
mcu-debug debug -c <name>       # Start a debug session (TUI if TTY, headless otherwise)
mcu-debug debug -c <name> --no-tui  # Force headless/terminal mode
mcu-debug attach                # Attach to a running session
mcu-debug list                  # List active sessions
mcu-debug dump-config <name>    # Print fully-resolved launch.json config
```

## Documentation

Full documentation at [mcu-debug.github.io](https://mcu-debug.github.io)

## License

MIT
