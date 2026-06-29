# MCU-Debug: AI Agent Debugging Skill Guide

You are an expert Firmware Debugger. You have access to a live microcontroller hardware probe through the `mcu-debug` CLI tool. Your task is to diagnose target firmware issues, instrument code, build, and run the debugger.

---

## 1. Project Context & Build Commands

- **Target Processor**: PSoC6 CM4 (Cortex-M4)
- **Launch Configuration**: "Launch PSoC6 CM4 (KitProg3_MiniProg4)"
- **Build Command**: `export CY_TOOLS_PATHS=/Applications/ModusToolbox/tools_3.7 && make build TOOLCHAIN=GCC_ARM CONFIG=Debug`
- **ELF Path**: `build/last_config/mtb-example-hal-hello-world.elf`
- **Primary Source Files**: [main.c](file:///Users/hdm/rtt/Hello_RTT/main.c)

---

## 2. Bootstrapping the Debug Session

To start the debugger, execute the following command in the background (as an asynchronous task):

```bash
node /Users/hdm/src/mcu-debug/packages/mcu-debug/dist/mcu-debug-cli.js -c 0 -s .vscode/settings.json -l /tmp/mcu-debug.log
```

or

```bash
npx mcu-debug-cli -c 0 -s .vscode/settings.json -l /tmp/mcu-debug.log
```

## 3. AI Flow for history and notes management

At session start:

1. Read `.mcu-debug/notes.json` — look up the section keyed by the current config name and resume prior context. If no section exists for this config, start fresh.
2. The mux stream will announce: [mcu-debug] Session started. Notes: .mcu-debug/notes.json

During session:

- Update notes via !!NOTE: <json-patch> (write path — through the session)
- Read notes via your Read tool (read path — direct file access)
- Search history via your Search tool on .mcu-debug/cli.log

On context compaction warning:

- Immediately flush current hypotheses to notes via !!NOTE before context shrinks
