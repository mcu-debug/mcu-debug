## MCU Debug task list to get Cortex-Debug feature parity

Following are listed in no particular order. They are grouped by functionality. 

- [x] Lifecycle
  - [x] GDB Launch
  - [x] nm/objdump Launch
  - [x] Server Launch
  - [x] breakAfterReset
  - [x] stopAtEntryPoint
  - [x] Launch Request
  - [X] Attach Request
  - [X] Detach (properly, FW should continue on detach)
  - [X] Terminate (do total shutdown, only needed for some gdb servers)
  - [x] Reset (VSCode handles Restart, Reset is better, faster)
- [x] `New:` 64-bit support
  - [x] In Symbol table
  - [x] Move from objdump/nm to parsing elf files directly
- [x] Variables
  - [x] Local Variables
  - [x] Registers
  - [x] Globals
  - [x] Statics
  - [ ] Format control (hex vs. decimal)
- [x] Expressions 
  - [x] Watch, Hover
  - [x] REPL
  - [x] SetVariable
  - [x] SetExpr
- [ ] Debug/Trace
  - [x] SWO
  - [x] RTT
  - [x] `New:` Native RTT support
  - [x] `New:` Rust RTT support. Defmt-print support added. Add as a pre-decoder to rttConfig
- [ ] `New`: Rust Language support (debug works, but some things in Variable window could be better)
- [ ] General
   - [ ] `New:` Source Maps
   - [ ] `New:` Telemetry
- [x] Execution
  - [x] Pause
  - [x] Continue
  - [x] Step In
  - [x] Step Out
  - [x] Goto
- [ ] Breakpoints
  - [x] File:line breakpoints
  - [x] Function breakpoints
  - [x] Data breakpoints
    - [ ] Support a constant.
    - [ ] A general expression that may not be a variable
  - [ ] Logpoints
- [x] LiveWatch. This is a push/streaming design vs a pull design in Cortex-Debug
  - [x] Streaming Live Watch
  - [x] `New:` SetVar
  - [x] `New:` SetExpr
- [ ] Disassembly. Needs total overhaul, even more generic processor/ISA support
  - [x] Basic - True to source disassembly based of objdump.
  - [ ] GDB/Capstone based disassembly (or hybrid)
  - [x] `New:` 64-bit support
  - [ ] Instruction breakpoints
- [x] **Multi-core orchestration**
- [ ] **Remote Gdb-server support. New design, new feature. Better support for containers, wsl, remote labs**

 Testing:

 - [ ] All of the above
 - [ ] Test with all gdb-servers
 - [ ] C++ Testing
 - [ ] Test with RSIC-V
 - [ ] Test with Xtensa

Other Extensions
 - [ ] Memory View Compatibility. Especially in failure conditions
   - [ ] See if Memory view can be dynamic (update without pausing)
 - [ ] Peripheral View Compatibility
 - [ ] RTOS View Compatibility
   - [ ] See if RTOS view can be dynamic (update without pausing)
