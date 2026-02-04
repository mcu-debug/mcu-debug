# MCU Debug Helper

Note to AI: This is my first Rust program. This project needs to be production quality while giving me a chance to learn Rust patterns.


This program adds to the MCU Debug's Debug Adapter. It performs some performance intensive operations. Besides performance which is not in itself a reason to have this program, it is also solve issues with GDB and Objdump to get accurate debug information from the ELF files. GDB does a terrible job for disassembly and for VSCode/DAP, we have to also create disassembly going in the reverse direction which is non trivial and problematic -- can easily get wrong results. Objdump does a pretty decent job but it also has limitations with line numbers (just one line is provided) and working with optimized code.

The intent of this program is to run alongside the DAP, with the same lifecycle and provide services on demand

Functionality/Services provided

1. Provide symbol table access (symboltable already exists in TS but the main client is the disassembler, so makes sense to move it there)
   - All Globals
   - All Statics for a given file
   - Individual symbol queries

2. On demand disassembly, the way the DAP protocol is organized. [See DAP protocol](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_Disassemble)

There is a risk that this gets too complicated and beyond scope. Rust is known to have a steep learning curve, but I will give it an honest try. Seems to have a good payoff.
