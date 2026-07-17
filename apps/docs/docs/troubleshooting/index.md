---
sidebar_position: 1
title: Troubleshooting
---

# Troubleshooting

## Before You Start

Read [How mcu-debug Works](../getting-started/how-it-works.md) first if you haven't. Understanding the VS Code → DA → GDB → gdb-server → probe → target chain tells you which component to investigate for a given error message.

### Enable Debug Output

Enable GDB trace logging in `launch.json`:

```json
"debugFlags": { "gdbTraces": true }
```

This shows all GDB MI transactions in the output panel. It is verbose but essential for diagnosing GDB-level issues.

---

## Startup Failures

### "ENOENT" or spawn failed

This means that the system could not find an exucutable to run. Depending the path make sure that your gdb or gdb-server paths are valid and can be run from the command-line successfully. Use the exact path shown in the error message when possible. Typos or missing settings are a frequent cause of this.

### "Server exited with code 1"

The gdb-server failed to start or connect to the probe. This is the most common first-run error.

**Check in order:**

1. Is the probe physically connected and recognized by the OS?
   - Linux: `lsusb` should show the probe
   - Windows: Device Manager should show it without a yellow warning
   - macOS: `system_profiler SPUSBDataType` or System Information

2. Is another instance of the gdb-server already running?
   - Check for stray OpenOCD processes: `pgrep openocd` / `tasklist | findstr openocd`
   - Kill any existing instances before starting a new session

3. Are the `configFiles` paths correct?
   - Run `mcu-debug dump-config "Your Config Name"` to see resolved paths
   - Try running OpenOCD manually with the same `-f` arguments

4. Check the gdb-server output — look for the server's own terminal tab in VS Code or the raw output in terminal mode

### "Failed to start GDB"

mcu-debug cannot find or run the GDB binary.

- Is `arm-none-eabi-gdb` on your `PATH`? Test: `arm-none-eabi-gdb --version`
- Is `toolchainPrefix` set correctly in `launch.json`? (e.g. `"toolchainPrefix": "arm-none-eabi"`)
- Is `gdbPath` pointing to an existing file?
- On Windows: is the path using forward slashes or escaped backslashes?

### Target Not Halting After Launch

The session starts but the target doesn't stop at `main` or the entry point.

- Check `runToEntryPoint` — is the symbol name correct for your firmware?
- Check `breakAfterReset` — if false, execution continues through startup
- For multi-core targets: verify `targetProcessor` is set to the core running your code
- Verify the ELF has debug symbols — build with `-g` and without `--strip` or `--strip-debug`

---

## GDB Server Issues

### OpenOCD: "Error: unable to find JTAG device"

OpenOCD found the probe but not the target MCU.

- Wrong target config file — verify the MCU model
- Wrong interface config file — verify the probe type  
- Check the SWD/JTAG connection: cable, connector orientation, target power
- Try running OpenOCD manually to see the full error output

### OpenOCD: "Error: couldn't bind tcl to socket"

The TCL port (default 55550) is already in use.

- Kill the existing OpenOCD: `pkill openocd` / `taskkill /IM openocd.exe /F`
- If you think this is a bug, please report this issue

### OpenOCD: "Error: open failed" for config file

Config file path is wrong or OpenOCD scripts directory is not found.

- Check `searchDir` includes the directory containing your custom board files
- On Windows: verify the OpenOCD scripts directory path is correct
- Try an absolute path in `configFiles` to rule out search path issues

### JLink: "Cannot connect to target"

- Reduce SWD clock speed: `"serverArgs": ["-speed", "1000"]`
- Verify the `device` name matches SEGGER's device database exactly
- Check JLink firmware is current (run J-Link Commander and check for firmware update prompt)

---

## Connection Problems

### Variables Show Wrong Values

- Verify you are halted at the right location (check source file and line number)
- High optimization (`-O2`, `-O3`) can eliminate or move variables. Build with `-O0` for debug builds.
- For multi-core: ensure `targetProcessor` points to the core running the code you are inspecting

### Breakpoints Show as Unverified

"Unverified" breakpoints mean GDB could not resolve the source location to an address. Usually this means:

- The ELF file was rebuilt and the session uses the old file — restart the debug session
- The source location is in a library without debug symbols
- Optimization inlined the function — the source line has no corresponding instruction

### Remote Target Disconnected

The gdb-server lost connection to the probe during the session.

- USB connection issue — check the cable
- Probe reset itself (watchdog, USB suspend)
- For JLink: long halt with the target powered down may cause a timeout. Configure JLink keep-alive settings.

---

## RTT Issues

### RTT Not Receiving Data

- Verify `rttConfig.enabled: true` in `launch.json`
- Ensure RTT is initialized in firmware **before** mcu-debug starts polling. Use `runToEntryPoint: "main"` to halt at `main` so RTT initialization code runs.
- Verify the gdb-server supports multiple GDB connections (OpenOCD: yes by default)
- Check that `SEGGER_RTT_Init()` is called (or equivalent) in firmware startup

### RTT Output Is Garbled

- Verify the decoder type matches the firmware output (text vs binary vs defmt)
- Check RTT buffer size — if the firmware writes faster than the host polls, the ring buffer may overflow and lose data

---

## FAQ

**Q: Can I use mcu-debug without VS Code?**
Yes — use the CLI tool. See [CLI Tool](../cli/index.md).

**Q: Does mcu-debug work with RISC-V targets?**
Experimental support. The Debug Adapter is architecture-agnostic (it drives GDB), but gdb-server support and SVD availability vary by target. OpenOCD has RISC-V support for many devices.

**Q: Can I use mcu-debug with a custom GDB server?**
Use `servertype: "external"` and start the gdb-server yourself before launching the session. Then connect with `request: "attach"`.

**Q: How do I file a bug?**
Open an issue on [GitHub](https://github.com/mcu-debug/mcu-debug/issues). Include:
- Your `launch.json` (redact sensitive paths if needed)
- The full debug output with `"debugFlags": {"gdbTraces": true}` enabled
- Your platform, VS Code version, and extension version

**Q: Why does the extension not activate?**
The extension activates when a workspace contains a `launch.json` with `"type": "mcu-debug"`. Check that your `launch.json` is in `.vscode/launch.json` at the workspace root.
