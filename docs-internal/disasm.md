# Disassembler options

In Cortex-Debug, we used GDB and the symbol table from objdump to list the disassembly. We mostly got what we wanted but it was complicated to fetch things on demand, keep a cache and have gdb behave especially searching for instructions backwards. We got it wrong sometimes. Variable/long instruction sizes made this even more complicated.

Also, gdb did not interpret data mixed with code (common in ARM) very well. It produced what looks like code. So, your constants, data tables were interpreted like code.

We now have a chance to revisit this issue

## GDB

Pros:

- **Dynamic cases:** The pro's of using GDB is that it will work with any kind of system. It can read from memory and deode those bytes. In other words, I am assuming it can intepret a random set of bytes and no symbol table, and it will try to make some sense out of it....even if it is garbage. But, this may be a fringe case for us. Need to verify with G.
- **Performance**:The ELF is already loaded, so perhaps more performant

Cons:

- Does not handle data embedded in code very well. This is done by compilers for both time and space.
- Looks ugly

## Alternate

From what I have seen, objdump seems to be very well behaved and the assembly looks nice and more accurate. I've been told that it can also get confused by inlining. It seems to be true and a bug rather than a limitation of the DWARF debug info. Inlining is more common with -O3 and LTO. But if GDB can figure it out better than objdump, then maybe we have a chance. This assumptions relies on the fact that the `.debug_line` info in the ELF files are reliable.

Pros:

- The assembly looks much nicer and more accurate

Cons:

- It will be slow especially on large ELF files - assume a 2 MB exe.
- It is all or nothing. Not easy to make smaller requests because with every request, you have to invoke objdump again. This WILL NOT look realtime in human response times
- New infrastructure needed

## Mitigation

Lets do a couple of what-if's.

### Assembly Server

Lets say as the debug session starts we also spin up a disassembly server. It can be written in any language but for now, we will stick to TS.

1. Along with nm/objdump/gdb/gdb-server, we also start this server and we will connunicate over TCP.
2. It will invoke and gulp the disassembly WITHOUT source/lines. Note that we already have the symboo table in the DAP. Disassembly with source has two issues. It makes the output large with full path names repeated for every few instructions, and the line info has missing info. Also line info can be wrong due to inlining.
3. It will additionally read the binary .debug_line section and decode that info. Mechanics: Used readelf to extract the section?
   `objcopy --output-target=binary --only-section=.debug_line input.elf debug_line.bin`. Note that the debug_line can be compressed and objcopy can decompress it for us. Not sure it can write to stdout.
4. It will merge the line info with the disassembly (not literally but structurally).
5. Now, we have an in memory mapping of the disassembly.
6. The DAP can perform the same queries as it does with GDB. Except, the server can help with going backwards from a reference point


More thoughts
- In the debug server, we can also keep a byte stream that represents a function and compare that to what GDB reports. Not sure this is necessary....self modifying code, dynamically loaded code.
- All disassembly has a reference point -- usually the PC on the frame and previously disassembled instructions. If the reference point is outside of the servers knowledge, then we can rely on GDB or better yet, not provide disassembly.

I have seen multiple implementations of disassembly and nothing looks good to me. There is blind faith in GDB. According to Google, among the VSCode DAP adapters, MS's cpptools (cppdbg) is the best. Not sure how that can be. It is based on a sliding window of disassembly until the reference instruction is found. That is very weak and unreilable.

## Question:

Why am I putting this effort into disassembly. Others seem to just take what they get from GDB and run with it. No symbol table involved. Some don't even cache ... gdb is a good enough cache I guess. Note that VSCode itself asks for the same (overlapping) regions multiple times. Haven't looked into what kind of cache it has, but it seems to make an awful lot of calls. The very first call is for 400 instructions with a -200 offset (200 instructions on either side of the PC). After that, it requests 50 instructions in the direction of your scroll. It matters single stepping because it may invalidate VSCodes own cache.

In out case, the cache could live in the server but that means using GDB for some requests and the server for others might cause a bookkeeping headeach if we cache it in the DAP.
