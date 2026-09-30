# SVD Commands in the CLI — Design

**Status:** design only; nothing is implemented. The command set and the rules in §3–§5 were
agreed on 2026-09-30. §6 is open and has to be decided first, because it determines how much of
the peripheral viewer the CLI reuses rather than copies.

**Goal:** give the CLI (terminal, TUI, socket, and `--batch`) the same register-level view of
peripherals that the SVD viewer gives VS Code, for inspecting and verifying. It is not meant as a
level to write applications at: real peripherals need sequences and dependencies ("enable the
clock, wait for the ready flag, don't touch this register while that bit is set"), and the SVD
does not describe them. The SVD is the reference for facts — addresses, bit positions, reset
values, access, side effects — which are exactly what a person or an AI most often gets wrong.

## 1. Where things stand

- The viewer is a separate extension, `mcu-debug/peripheral-viewer`. It reads through DAP
  `readMemory` (`memutils.ts`).
- It already refuses to read registers that have a `readAction` or are write-only
  (`peripheralregisternode.ts`, `avoidRead`). The CLI must follow the same rule, from the same
  code.
- `svd-parser.ts` does not import `vscode`, so it can be reused. The tree nodes cannot.
- The DA resolves `svdFile` from `launch.json` relative to `cwd` (`gdb-session.ts`), so the CLI
  already has the path. The extension's device → SVD registry (`registerSVDFile`) is VS Code
  only.

## 2. Naming and output

- Bare `svd …`, with a `!!svd` alias, the same way `status` / `!!status` work.
- Paths are dotted and case-insensitive: `GPIOA`, `GPIOA.MODER`, `GPIOA.MODER.MODER5`. Globs match
  on the whole path: `GPIOA.*`, `*.CR`.
- Output is a human-readable table, plus structured fields on the log record (as `!!send` does),
  so an AI gets `{path, address, raw, fields}` without parsing text.
- Every command resolves to success or failure, so a failure ends a `--batch` run with exit
  status 1.

## 3. Commands

| Command | Reads the target? | Does |
|---|---|---|
| `svd list [glob]` | no | Peripherals, or the registers and fields under a path |
| `svd info <path>` | no | Address, reset value, access, `readAction`, `modifiedWriteValues`, enumerated values, description. Works while the target runs |
| `svd read <path\|glob>` | yes | Decoded fields with enum names. One block read per peripheral, as the viewer does. Skips `readAction` and write-only registers unless `--force` |
| `svd write <reg\|field> <value>` | yes | Value as a number or an enum name: `svd write GPIOA.MODER.MODER5 Output` |
| `svd expect <path> <op> <value>` | yes | Fails when the comparison is false. For batch and CI |
| `svd sample <path\|glob> [action]` | yes, repeatedly | See §5 |

`svd expect` is the piece `--batch` lacks today. GDB's `if` … `end` cannot be sent to a script one
line at a time, so a batch script has no way to check a value. With it, a hardware-in-the-loop
test is: run the init, halt, assert the peripheral state.

## 4. Writing fields safely

`svd write` on a field is a read-modify-write, and writing back what was read is wrong in two
cases:

- **Write-1-to-clear fields** (`modifiedWriteValues` = `oneToClear` and similar). The read returns
  1 for a pending flag, and writing it back clears it. In the write-back, such fields are forced
  to their no-op value.
- **Write-only registers.** There is nothing to read. Field writes are refused; the whole register
  value has to be given.

The SVD carries both facts, so the tool can get this right every time.

## 5. `svd sample`

Polls through liveWatch; it is **not** a GDB watchpoint. The name was chosen so that it is not
confused with GDB's `watch`, which sets a hardware watchpoint.

```
svd sample <path|glob> [log | until <op> <value> [timeout] | pause]
svd sample list
svd sample stop <path|all>
```

| Action | Meaning | Returns |
|---|---|---|
| `log` (default) | Report each change: which fields, old → new, decoded | At once; the sample keeps running |
| `until <op> <value> [timeout]` | Wait for a condition | When it is true. A timeout is a failure |
| `pause` | Halt the target when the condition becomes true | At once |

Rules:

- **Never sample a `readAction` register, even with `--force`.** A one-off `svd read --force` is a
  deliberate single read. Sampling reads it several times a second and clears it each time, so the
  firmware would never see the flag. Refuse, and point to `svd read --force`. Write-only registers
  are refused too.
- **It is lossy, and says so.** At the default 4 samples a second, a flag set and cleared between
  two samples is never seen. Report the sample rate when a sample starts, and word changes as
  "between samples", not "at". Not seeing a change is not evidence that it didn't happen.
- **`pause` is late.** The halt comes up to one sample period after the change, plus the round
  trip, so the target shows what came after the change. For the exact moment, a hardware
  watchpoint is still the tool.
- **Samples keep running while the core is halted.** Timers, DMA and a receiving UART usually keep
  going unless the DBGMCU freeze bits stop them, so changes seen while halted are real.
- **Cost.** Samples are grouped into one block read per peripheral, and they share the probe with
  RTT. Many samples slow RTT down; the docs should say so.
- Change events go to the socket as structured records.

`until` fits with batch mode: `c&` then `svd sample RCC.CR.HSERDY until == Ready 500` runs until
the clock is ready, with no breakpoint needed.

## 6. Open: where the parser and model live

The CLI cannot load another VS Code extension, so the parser and a plain peripheral → register →
field model (with `access`, `readAction`, `modifiedWriteValues` and the skip rules) must be shared.

- **TypeScript, shared.** Move `svd-parser.ts` and the model into something both repos use (for
  example `packages/shared`), with `peripheral-viewer` depending on it. The least work. The skip
  rules move into the model, so the viewer and the CLI cannot drift apart.
- **Rust, in `mdbg`.** More work. It pays off if something else in Rust needs the SVD — for
  example the RSP multiplexer ([gdb-rsp.md](gdb-rsp.md)) doing sampling reads next to the probe,
  as it already does for RTT, instead of through the second GDB.

Either way, the skip rules belong in the shared model, not in the viewer's tree nodes.

## 7. Reading while the target runs

GDB in all-stop mode refuses memory reads while the target runs. `svd read`, `svd expect` and
`svd sample` therefore go through liveWatch's second GDB when the target is running, and through
the main GDB when it is halted.
