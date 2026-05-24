# mcu-debug Cockpit

We want to create a TUI (using ratatui crate) that acts as a user interface for CLI mcu-debug. See `docs-internal/AI-Angle.md`

We already have an implementation in Typescript `packages/mcu-debug/src/webviews/cockpit/src/GlassCockpit.svelte` that is hosted inside a VSCode panel

The real debugger is `packages/mcu-debug/src/cli` packaged as a node application `packages/mcu-debug/dist/mcu-debug-cli.js`

The workflow is as follows

1. User launch the Rust program `mcu-debug debug`
2. if no --no-tui is specified, we simply launch the node application detached and the Rust program has no role to play
3. The Rust program has the same options as the cli version with the addition of --no-tui
4. Otherwise, we launch the node application and wait for a socket being available in the current dir. (.mcu-debug.sock.json file)
5. The TUI connects to the specified in the json file and away we go until the node program exits. Note that node program itself has no TTY, the Rust side pipes all the stdio and owns the TTY

IMPORTANT: For our purposes the Cockpit design should have the AI section as optional. So the top and bottom parts always exist but the middle part (AI) will be optional
