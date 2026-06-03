
# Documentation plan

This is a plan for organizing external facing documentation. The links should be relatively stable as they may be referenced by people elsewhere. So be careful during the planning phase

1. Getting Started
   - Installation
   - Quick start
   - How mcu-debug works  ← here, before they hit problems
   - Migrating from Cortex-Debug

2. Configuration
   - launch.json overview
   - Variable substitution
   - GDB server settings
   - All properties (full reference)

3. GDB Servers
   - OpenOCD
   - JLink
   - pyOCD
   - STLink
   - ...

4. Debug Features
   - Normal debug features
   - Live Watch
   - Disassembly
   - Memory View
   - Multi-core
   - Peripheral View
   - RTOS Views
   - Memory View

5. Tracing
   - RTT
   - UART
   - SWO

6. Remote Debugging
   - WSL
   - Docker
   - SSH / Lab server

7. CLI Tool
   - Overview & installation
   - Configuration (launch.json outside VS Code)
   - Terminal mode
   - TUI mode
   - VS Code panel

8. AI Integration
   - Overview
   - Autonomous debugging
   - Hybrid mode (human + AI)
   - Session notes
   - Writing skills/prompts

9.  Troubleshooting
   - Startup failures
   - GDB server issues
   - Connection problems
   - FAQ

10. Reference
    - launch.json schema
    - CLI commands
    - Meta-commands

For stable links, use -- all lower case and follow this sceme for chapters

/getting-started/
/configuration/
/gdb-servers/
/tracing/
/remote/
/cli/
/ai/
/troubleshooting/
/reference/
