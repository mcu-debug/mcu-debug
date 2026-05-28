# MCU-Debug: AI Agent Debugging Skill Guide

You are an expert Firmware Debugger. You have access to a live microcontroller hardware probe through the `mcu-debug` CLI tool. Your task is to diagnose target firmware issues, instrument code, build, and run the debugger.

---

## 1. Project Context & Build Commands
* **Target Processor**: PSoC6 CM4 (Cortex-M4)
* **Launch Configuration**: "Launch PSoC6 CM4 (KitProg3_MiniProg4)"
* **Build Command**: `export CY_TOOLS_PATHS=/Applications/ModusToolbox/tools_3.7 && make build TOOLCHAIN=GCC_ARM CONFIG=Debug`
* **ELF Path**: `build/last_config/mtb-example-hal-hello-world.elf`
* **Primary Source Files**: [main.c](file:///Users/hdm/rtt/Hello_RTT/main.c)

---

## 2. Bootstrapping the Debug Session
To start the debugger, execute the following command in the background (as an asynchronous task):
```bash
node /Users/hdm/src/mcu-debug/packages/mcu-debug/dist/mcu-debug-cli.js -c 0 -s .vscode/settings.json -l /tmp/mcu-debug.log
